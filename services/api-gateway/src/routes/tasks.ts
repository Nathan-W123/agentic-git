/**
 * Tasks, runs, versions, attachments, previews and workspaces.
 *
 * The work itself: what was asked for, what happened, what changed, and the
 * two ways to look at the result - a diff, or the app running.
 *
 * Returns `true` when it answered the request. Order is behaviour: the first
 * branch that matches wins, exactly as it did when all of this was one
 * `if`-chain, and `server.ts` calls the groups in the order they were
 * written in.
 */

import {
  createId,
} from "@coord/shared-types";
import {
  authorizeProject,
  authorizeRepository,
} from "../authorization.js";
import {
  HttpError,
  objectBody,
  stringField,
} from "../field-validation.js";
import {
  matchPath,
  narrowToRepositories,
} from "../gateway-util.js";
import {
  API_PREFIX,
} from "../http-util.js";
import {
  previewBaseHref,
} from "../preview-proxy.js";
import {
  MAX_ATTACHMENT_BYTES,
  SIMPLIFY_TIMEOUT_MS,
  TASK_STATUSES,
} from "../gateway-util.js";
import type { ApiGateway } from "../server.js";
import type { AuthenticatedRouteRequest } from "./context.js";

export async function routeTasks(
  gw: ApiGateway,
  req: AuthenticatedRouteRequest,
): Promise<boolean> {
  const { context, request, response, url, method, path, principal } = req;

  const tasksMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/projects/([^/]+)/tasks$`, "u"),
  );
  if (tasksMatch !== undefined) {
    const projectId = tasksMatch[0] ?? "";
    const authorized = await authorizeProject(
      gw.options.store,
      principal,
      projectId,
      method === "GET" ? "view" : "submit_task",
    );
    if (method === "GET") {
      const statusValue = url.searchParams.get("status") ?? undefined;
      const status =
        statusValue === undefined
          ? undefined
          : TASK_STATUSES.find((entry) => entry === statusValue);
      if (statusValue !== undefined && status === undefined) {
        throw new HttpError(
          400,
          "invalid_status",
          `Task status must be one of ${TASK_STATUSES.join(", ")}`,
        );
      }
      // A worker that dies mid-task leaves its lease behind it, and the
      // task it was holding stays `claimed` — read everywhere as an agent
      // working — until somebody expires that lease. Every other caller of
      // this is a worker route, so the one case it matters in is the one
      // case nothing ran: the worker is gone. Reading the task list is what
      // always happens while somebody is looking at that dot, so the sweep
      // happens here too. It is the same idempotent call the worker routes
      // make, and it must never be able to fail a read.
      await gw.expireLeasesAndSay(new Date().toISOString());
      const tasks = await gw.options.store.listSubmittedTasks({
        projectId,
        ...(status === undefined ? {} : { status }),
      });
      gw.sendJson(response, 200, {
        tasks: narrowToRepositories(tasks, authorized.repositories),
      });
      return true;
    }
    if (method === "POST") {
      const body = objectBody(await gw.readJson(request));
      const repositoryId =
        stringField(body["repositoryId"], "repositoryId", { max: 128 }) ?? "";
      if (
        !(await gw.options.store.projectHasRepository(
          projectId,
          repositoryId,
        )) ||
        // Reaching the project is not permission to put work into a
        // repository inside it. Same answer either way, so a probe cannot
        // tell "not linked" from "not yours".
        (authorized.repositories !== undefined &&
          !authorized.repositories.has(repositoryId))
      ) {
        throw new HttpError(
          404,
          "repository_not_found",
          "Repository is not linked to this project",
        );
      }
      const agentId = stringField(body["agentId"], "agentId", {
        max: 128,
        optional: true,
      });
      const task = await gw.performOperation(
        "task_submission_failed",
        async () =>
          await gw.options.operations.submitTask({
            projectId,
            repositoryId,
            objective:
              stringField(body["objective"], "objective", { max: 10_000 }) ??
              "",
            ...(agentId === undefined ? {} : { agentId }),
            actorId: principal.user.id,
          }),
      );
      gw.notifyWorkers(projectId);
      await gw.options.store.appendAudit(undefined, {
        type: "task_submitted",
        taskId: task.id,
        data: {
          projectId,
          repositoryId,
          actorId: principal.user.id,
          objective: task.objective,
        },
      });
      gw.sendJson(response, 201, { task });
      return true;
    }
  }

  const taskActionMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/tasks/([^/]+)/(retry|cancel|pause|resume)$`, "u"),
  );
  if (taskActionMatch !== undefined && method === "POST") {
    const [taskId = "", action = ""] = taskActionMatch;
    const task = (
      await gw.options.store.listSubmittedTasks()
    ).find((entry) => entry.id === taskId);
    if (task === undefined || task.projectId === undefined) {
      throw new HttpError(404, "not_found", "Task was not found");
    }
    await authorizeProject(
      gw.options.store,
      principal,
      task.projectId,
      "run_task",
    );
    const runKey = `${task.projectId}\0${task.repositoryId}`;
    if (action === "retry") {
      if (gw.activeRuns.has(runKey)) {
        throw new HttpError(
          409,
          "run_in_progress",
          "Task retry is unavailable while its repository run is active",
        );
      }
      gw.sendJson(response, 200, {
        task: await gw.options.store.retrySubmittedTask(taskId),
      });
      return true;
    }
    if (action === "pause" || action === "resume") {
      gw.sendJson(
        response,
        200,
        await gw.pauseOrResumeTask(task, action, principal.user.id),
      );
      return true;
    }
    const cancelOperation = gw.options.operations.cancelTasks;
    if (cancelOperation === undefined) {
      // Store-only cancel cannot reach a live run, so refusing during one
      // is the honest answer — the row would flip while the agent worked
      // on, which is the silence this button exists to end.
      if (gw.activeRuns.has(runKey)) {
        throw new HttpError(
          409,
          "run_in_progress",
          "Task cancel is unavailable while its repository run is active",
        );
      }
      const updated = await gw.options.store.cancelSubmittedTask(taskId);
      await gw.options.store.appendAudit(undefined, {
        type: "task_cancelled",
        taskId,
        data: {
          projectId: task.projectId,
          actorId: principal.user.id,
        },
      });
      gw.sendJson(response, 200, { task: updated });
      return true;
    }
    // The full stop — row, live session, lease, audit — which is exactly
    // what pressing cancel during a run means, so no run guard here.
    const { cancelled } = await cancelOperation({
      projectId: task.projectId,
      repositoryId: task.repositoryId,
      taskIds: [taskId],
      reason: "Stopped from the dashboard",
      actorId: principal.user.id,
    });
    if (cancelled.length === 0) {
      throw new HttpError(
        409,
        "not_cancellable",
        `Task ${taskId} has already finished`,
      );
    }
    const updated = (
      await gw.options.store.listSubmittedTasks({
        repositoryId: task.repositoryId,
      })
    ).find((entry) => entry.id === taskId);
    gw.sendJson(response, 200, { task: updated ?? task });
    return true;
  }

  const runMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/run$`,
      "u",
    ),
  );
  if (runMatch !== undefined && method === "POST") {
    const [projectId = "", repositoryId = ""] = runMatch;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "run_task",
    );
    if (
      !(await gw.options.store.projectHasRepository(projectId, repositoryId))
    ) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    const key = `${projectId}\0${repositoryId}`;
    if (gw.activeRuns.has(key)) {
      throw new HttpError(
        409,
        "run_in_progress",
        "A run is already active for this repository",
      );
    }
    gw.activeRuns.add(key);
    const operationId = createId("operation");
    void gw.options.operations
      .runRepository({
        projectId,
        repositoryId,
        actorId: principal.user.id,
      })
      .catch(async (error: unknown) => {
        await gw.options.store.appendAudit(undefined, {
          type: "task_failed",
          data: {
            projectId,
            repositoryId,
            operationId,
            stage: "run_start",
            error: error instanceof Error ? error.message : String(error),
          },
        });
      })
      .finally(() => {
        gw.activeRuns.delete(key);
      });
    gw.sendJson(response, 202, { operationId, status: "accepted" });
    return true;
  }

  const runCommentsMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/runs/([^/]+)/comments$`, "u"),
  );
  if (runCommentsMatch !== undefined) {
    const runId = runCommentsMatch[0] ?? "";
    const detail = await gw.options.store.getRun(runId);
    if (detail === undefined || detail.run.projectId === undefined) {
      throw new HttpError(404, "not_found", "Run was not found");
    }
    if (method === "GET") {
      await authorizeProject(
        gw.options.store,
        principal,
        detail.run.projectId,
        "view",
      );
      gw.sendJson(response, 200, {
        comments: await gw.options.store.listChangesetComments({ runId }),
      });
      return true;
    }
    if (method === "POST") {
      // Reviewing is its own permission: a viewer reads the diff, a
      // reviewer writes on it.
      await authorizeProject(
        gw.options.store,
        principal,
        detail.run.projectId,
        "review",
      );
      const body = objectBody(await gw.readJson(request));
      const changeSetId = stringField(body["changeSetId"], "changeSetId", {
        max: 200,
      });
      const text = stringField(body["body"], "body", { max: 10_000 });
      if (changeSetId === undefined || text === undefined || text.length === 0) {
        throw new HttpError(
          400,
          "invalid_request",
          "changeSetId and body are required",
        );
      }
      const changeSet = detail.changeSets.find(
        (entry) => entry.id === changeSetId,
      );
      if (changeSet === undefined) {
        throw new HttpError(404, "not_found", "Changeset was not found");
      }
      const filePath = stringField(body["filePath"], "filePath", {
        max: 1_000,
        optional: true,
      });
      if (
        filePath !== undefined &&
        !changeSet.patches.some((patch) => patch.path === filePath)
      ) {
        throw new HttpError(
          400,
          "invalid_request",
          "filePath is not part of this changeset",
        );
      }
      const comment = await gw.options.store.addChangesetComment({
        runId,
        changeSetId,
        taskId: changeSet.taskId,
        authorId: principal.user.id,
        body: text,
        ...(filePath === undefined ? {} : { filePath }),
      });
      gw.sendJson(response, 201, { comment });
      return true;
    }
    throw new HttpError(405, "method_not_allowed", "Unsupported method");
  }

  const resolveCommentMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/comments/([^/]+)/resolve$`, "u"),
  );
  if (resolveCommentMatch !== undefined && method === "POST") {
    const commentId = resolveCommentMatch[0] ?? "";
    const comment = await gw.options.store.getChangesetComment(commentId);
    if (comment === undefined) {
      throw new HttpError(404, "not_found", "Comment was not found");
    }
    const detail = await gw.options.store.getRun(comment.runId);
    if (detail?.run.projectId === undefined) {
      throw new HttpError(404, "not_found", "Comment was not found");
    }
    await authorizeProject(
      gw.options.store,
      principal,
      detail.run.projectId,
      "review",
    );
    gw.sendJson(response, 200, {
      comment: await gw.options.store.resolveChangesetComment(
        commentId,
        principal.user.id,
        new Date().toISOString(),
      ),
    });
    return true;
  }

  const versionsMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/versions$`,
      "u",
    ),
  );
  if (versionsMatch !== undefined && method === "GET") {
    const [projectId = "", repositoryId = ""] = versionsMatch;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "view",
    );
    if (
      !(await gw.options.store.projectHasRepository(projectId, repositoryId))
    ) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    const operation = gw.options.operations.repositoryVersions;
    if (operation === undefined) {
      throw new HttpError(
        501,
        "not_supported",
        "This deployment does not expose canonical history",
      );
    }
    const limit = Math.min(
      200,
      Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10)),
    );
    gw.sendJson(response, 200, {
      versions: await operation({ projectId, repositoryId, limit }),
    });
    return true;
  }

  // Rewriting one summary as briefly as it can be put.
  //
  // A separate reply rather than an edit of the original: the full account
  // is what the agent actually said and what the audit trail refers to, and
  // replacing it with a shortened paraphrase would quietly make the record
  // something nobody wrote.
  const simplifyMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/channel/replies/([^/]+)/simplify$`,
      "u",
    ),
  );
  if (simplifyMatch !== undefined && method === "POST") {
    const [projectId = "", repositoryId = "", replyId = ""] = simplifyMatch;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "view",
    );
    // `authorizeRepository` proves the caller may reach this repository; it
    // does not prove the repository is under the project in the path. An
    // organization member reaches every repository their organization has,
    // so without this the pair is unchecked and the id is simply resolved
    // globally further down. Every other `/channel/*` route carries it.
    if (
      !(await gw.options.store.projectHasRepository(projectId, repositoryId))
    ) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    const body = objectBody(await gw.readJson(request));
    const text = stringField(body["text"], "text", { max: 20_000 }) ?? "";
    if (text.trim().length === 0) {
      throw new HttpError(400, "invalid_request", "There is nothing to simplify");
    }
    // Whoever is already answering in this room. A simplification is a
    // rewrite of text that is already on the screen, so it needs no
    // repository access and no agent of its own.
    const [candidate] = await gw.resolveChannelMentionCandidates(
      projectId,
      repositoryId,
    );
    if (candidate === undefined) {
      throw new HttpError(
        409,
        "no_agent",
        "No agent is connected to this channel to rewrite it",
      );
    }
    const answer = await gw.askAgent(
      candidate,
      "Rewrite the following so somebody in a hurry gets the point. " +
        "Plain words, no jargon, and nothing that was not in the original " +
        "— do not soften a failure or invent a result. Lead with what " +
        "happened, then anything the reader has to do. A few short lines " +
        "at most, and fewer if the original says little.\n\n" +
        `---\n${text}\n---`,
      SIMPLIFY_TIMEOUT_MS,
    );
    if (answer.text === undefined) {
      throw new HttpError(
        502,
        "simplify_failed",
        answer.error ?? "The agent did not answer",
      );
    }
    gw.sendJson(response, 200, { replyId, text: answer.text.trim() });
    return true;
  }

  // Images in a channel. Scoped to a repository so the permission question
  // is the one already answered for everything else in that room: whoever
  // may read the channel may read what was posted into it.
  // One pattern per shape rather than an optional trailing group: `matchPath`
  // maps every group through `decodeURIComponent`, so a group that did not
  // participate comes back as the *string* "undefined" and no branch tests
  // true. Every other route here is written this way for the same reason.
  const attachmentMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/attachments$`,
      "u",
    ),
  );
  const attachmentItemMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/attachments/([^/]+)$`,
      "u",
    ),
  );
  if (attachmentMatch !== undefined || attachmentItemMatch !== undefined) {
    const [projectId = "", repositoryId = "", attachmentId] =
      attachmentItemMatch ?? attachmentMatch ?? [];
    const operations = gw.options.operations;
    if (
      operations.attachmentSave === undefined ||
      operations.attachmentRead === undefined
    ) {
      throw new HttpError(
        501,
        "not_supported",
        "This deployment cannot store images",
      );
    }
    if (method === "POST" && attachmentItemMatch === undefined) {
      await authorizeRepository(
        gw.options.store,
        principal,
        projectId,
        repositoryId,
        "run_task",
      );
      const contentType = request.headers["content-type"] ?? "";
      const bytes = await gw.readBinary(request, MAX_ATTACHMENT_BYTES);
      const id = await gw.performOperation(
        "attachment_rejected",
        async () => await operations.attachmentSave!({ bytes, contentType }),
      );
      gw.sendJson(response, 200, { id });
      return true;
    }
    if (method === "GET" && attachmentId !== undefined) {
      await authorizeRepository(
        gw.options.store,
        principal,
        projectId,
        repositoryId,
        "view",
      );
      const found = await operations.attachmentRead(attachmentId);
      if (found === undefined) {
        throw new HttpError(404, "not_found", "That image was not found");
      }
      // `nosniff` matters more here than anywhere else in this API: the
      // content type is derived from an allowlist rather than from the
      // uploader, and this is what stops a browser overriding it and
      // treating the bytes as something executable.
      response.setHeader("Content-Type", found.contentType);
      response.setHeader("Content-Length", String(found.bytes.length));
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Disposition", "inline");
      response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      response.writeHead(200);
      response.end(found.bytes);
      return true;
    }
  }

  // Looking at the running app, through here rather than at its own port.
  //
  // The preview binds loopback and no port is opened, which on a hosted
  // deployment made it unreachable — correct, and useless where the product
  // is actually used. Proxying it puts it behind the session and the same
  // permission the button needs, so it is reachable by exactly the people
  // who could have started it and by nobody else. No port is opened and
  // nothing is added to the attack surface: the code was already running
  // in this container, because every task already runs here.
  const previewAppMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/preview/app(/.*)?$`,
      "u",
    ),
  );
  if (previewAppMatch !== undefined) {
    const [projectId = "", repositoryId = "", matched = "/"] = previewAppMatch;
    // `matchPath` maps every group through `decodeURIComponent`, so a group
    // that did not participate arrives as the *string* "undefined" — which
    // was handed to the app as a request for `/undefined`. Opening the
    // preview without its trailing slash therefore served the app's 404
    // rather than its front page.
    const rest = matched === "undefined" || matched === "" ? "/" : matched;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "run_task",
    );
    const status = (await gw.options.operations.previewStatus?.({
      projectId,
      repositoryId,
    })) as { url?: string; exited?: unknown } | undefined;
    if (
      status === undefined ||
      typeof status.url !== "string" ||
      status.exited !== undefined
    ) {
      throw new HttpError(
        409,
        "not_running",
        "No preview is running for this repository",
      );
    }
    await gw.proxyToPreview(
      request,
      response,
      status.url,
      rest,
      url.search,
      previewBaseHref(projectId, repositoryId),
    );
    return true;
  }

  // Running the repository's app to look at it. Gated on `run_task` rather
  // than `manage_project`: starting a preview spends a little of this
  // machine and changes nothing about the repository, which is much closer
  // to submitting work than to administering the project.
  const previewMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/preview$`,
      "u",
    ),
  );
  if (previewMatch !== undefined) {
    const [projectId = "", repositoryId = ""] = previewMatch;
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "run_task",
    );
    if (
      !(await gw.options.store.projectHasRepository(projectId, repositoryId))
    ) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    const operations = gw.options.operations;
    if (
      operations.previewStart === undefined ||
      operations.previewStatus === undefined ||
      operations.previewStop === undefined
    ) {
      throw new HttpError(
        501,
        "not_supported",
        "This deployment cannot run previews",
      );
    }
    if (method === "POST") {
      const preview = await gw.performOperation("preview_failed", async () =>
        await operations.previewStart!({ projectId, repositoryId }),
      );
      gw.sendJson(response, 200, { preview });
      return true;
    }
    if (method === "GET") {
      const preview = await operations.previewStatus({
        projectId,
        repositoryId,
      });
      // `null` rather than a 404: "no preview is running" is an answer about
      // this repository, not a missing route, and the caller renders a
      // start button either way.
      gw.sendJson(response, 200, { preview: preview ?? null });
      return true;
    }
    if (method === "DELETE") {
      await operations.previewStop({ projectId, repositoryId });
      gw.sendJson(response, 200, { stopped: true });
      return true;
    }
    if (method === "PUT") {
      // Writes deployment configuration, so it needs more than the
      // `run_task` that starting one does. Somebody who can run work here
      // is not necessarily somebody who decides how this repository boots.
      await authorizeRepository(
        gw.options.store,
        principal,
        projectId,
        repositoryId,
        "manage_project",
      );
      if (operations.previewConfigure === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "This deployment cannot remember preview commands",
        );
      }
      const body = objectBody(await gw.readJson(request));
      const command = stringField(body["command"], "command", { max: 500 });
      if (command === undefined || command.trim().length === 0) {
        throw new HttpError(
          400,
          "invalid_request",
          "A start command is required",
        );
      }
      await gw.performOperation("preview_configure_failed", async () => {
        await operations.previewConfigure!({
          projectId,
          repositoryId,
          command,
        });
      });
      gw.sendJson(response, 200, { configured: true });
      return true;
    }
  }

  const rollbackMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/rollback$`,
      "u",
    ),
  );
  if (rollbackMatch !== undefined && method === "POST") {
    const [projectId = "", repositoryId = ""] = rollbackMatch;
    // Reverting canonical wholesale is a project-management act, not
    // ordinary task work, so it needs more than the run_task a developer
    // carries.
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      "manage_project",
    );
    if (
      !(await gw.options.store.projectHasRepository(projectId, repositoryId))
    ) {
      throw new HttpError(404, "not_found", "Repository was not found");
    }
    const operation = gw.options.operations.rollbackRepository;
    if (operation === undefined) {
      throw new HttpError(
        501,
        "not_supported",
        "This deployment does not support rollback",
      );
    }
    const body = objectBody(await gw.readJson(request));
    // Two ways to say where to go back to. `targetRevision` is the precise
    // one and stays the contract. `taskId` is what somebody looking at a
    // task in the channel actually has — they mean "undo this piece of
    // work", and only the log knows which revision that was. Resolving it
    // here rather than on the client is what stops a stale page from
    // reverting to a revision that has since been superseded.
    const taskId = stringField(body["taskId"], "taskId", {
      max: 200,
      optional: true,
    });
    let targetRevision = stringField(
      body["targetRevision"],
      "targetRevision",
      { max: 200, optional: true },
    );
    if (targetRevision === undefined && taskId !== undefined) {
      const resolved = await gw.revisionsForTask(repositoryId, taskId);
      if (resolved === undefined) {
        throw new HttpError(
          404,
          "not_found",
          "That task has no recorded canonical advance to undo",
        );
      }
      // Reverting to the state before this task discards everything that
      // landed after it too. Refused rather than done quietly: the button
      // says "undo this task", and silently undoing three others as well
      // would be a different act than the one offered.
      const head = await gw.options.operations.canonicalHead?.({
        projectId,
        repositoryId,
      });
      if (head !== undefined && head !== resolved.revision) {
        gw.sendJson(response, 200, {
          rollback: {
            status: "blocked",
            explanation:
              "Canonical has moved on since this task landed, so undoing " +
              "it would discard the work that followed. Revert the newest " +
              "change first, or roll back to an explicit revision.",
          },
        });
        return true;
      }
      targetRevision = resolved.previousRevision;
    }
    if (targetRevision === undefined || targetRevision.length === 0) {
      throw new HttpError(
        400,
        "invalid_request",
        "targetRevision or taskId is required",
      );
    }
    const reason = stringField(body["reason"], "reason", {
      max: 2_000,
      optional: true,
    });
    const result = await operation({
      projectId,
      repositoryId,
      targetRevision,
      actorId: principal.user.id,
      ...(reason === undefined ? {} : { reason }),
    });
    // A rollback that was refused is a legitimate answer, not a transport
    // error, so the outcome travels in the body with a 200.
    if (result.status === "integrated" && taskId !== undefined) {
      // Recorded before the summary is cleared, because clearing it is not
      // durable on its own: a thread with no file list is exactly what the
      // backfill in `withChangedFileSummaries` goes looking for, and it
      // would rebuild the list from the very events this revert undid. The
      // event is what tells it not to.
      await gw.options.store
        .appendAudit(undefined, {
          type: "task_reverted",
          taskId,
          data: { projectId, repositoryId, revision: targetRevision },
        })
        .catch(() => undefined);
      await gw.forgetThreadChangedFiles(repositoryId, taskId);
    }
    gw.sendJson(response, 200, { rollback: result });
    return true;
  }

  // ---- Overlay workspaces (dashboard editor + sandboxed terminal) -------
  // One user's isolated worktree of one repository. The user id in scope
  // is always the authenticated principal's, so no request can address
  // another user's overlay. Editing requires submit_task (the same right
  // needed to put work into the queue); running terminal commands requires
  // run_task. Canonical is untouched by everything here except `submit`,
  // which goes through the ordinary integration pipeline.
  // Matched in two steps because matchPath decodes every group and an
  // absent optional group must stay absent rather than become "undefined".
  const workspaceBaseMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/workspace$`,
      "u",
    ),
  );
  const workspaceActionMatch =
    workspaceBaseMatch === undefined
      ? matchPath(
          path,
          new RegExp(
            `^${API_PREFIX}/projects/([^/]+)/repositories/([^/]+)/workspace` +
              `/(files|file|reset|exec|submit)$`,
            "u",
          ),
        )
      : undefined;
  const workspaceMatch = workspaceBaseMatch ?? workspaceActionMatch;
  if (workspaceMatch !== undefined) {
    const [projectId = "", repositoryId = ""] = workspaceMatch;
    const action = workspaceActionMatch?.[2];
    const workspaceOperations = gw.options.operations.workspace;
    if (workspaceOperations === undefined) {
      throw new HttpError(
        501,
        "not_supported",
        "This deployment does not support overlay workspaces",
      );
    }
    await authorizeRepository(
      gw.options.store,
      principal,
      projectId,
      repositoryId,
      action === "exec" ? "run_task" : "submit_task",
    );
    const scope = {
      projectId,
      repositoryId,
      userId: principal.user.id,
    };
    // Overlay implementations throw errors carrying an HTTP status and
    // code; anything else stays an internal error.
    const perform = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        const code = (error as { code?: unknown }).code;
        if (
          error instanceof Error &&
          typeof status === "number" &&
          typeof code === "string"
        ) {
          throw new HttpError(status, code, error.message);
        }
        throw error;
      }
    };

    if (action === undefined) {
      if (method === "GET") {
        gw.sendJson(response, 200, {
          workspace: await perform(() => workspaceOperations.status(scope)),
        });
        return true;
      }
      if (method === "POST") {
        gw.sendJson(response, 200, {
          workspace: await perform(() => workspaceOperations.open(scope)),
        });
        return true;
      }
      if (method === "DELETE") {
        await perform(() => workspaceOperations.discard(scope));
        gw.sendJson(response, 200, { discarded: true });
        return true;
      }
    }
    if (action === "reset" && method === "POST") {
      gw.sendJson(response, 200, {
        workspace: await perform(() => workspaceOperations.reset(scope)),
      });
      return true;
    }
    if (action === "files" && method === "GET") {
      gw.sendJson(response, 200, {
        files: await perform(() => workspaceOperations.listFiles(scope)),
      });
      return true;
    }
    if (action === "file" && method === "GET") {
      const filePath = stringField(
        url.searchParams.get("path") ?? undefined,
        "path",
        { max: 1_000 },
      );
      gw.sendJson(response, 200, {
        file: await perform(() =>
          workspaceOperations.readFile({ ...scope, path: filePath ?? "" }),
        ),
      });
      return true;
    }
    if (action === "file" && method === "POST") {
      const body = objectBody(await gw.readJson(request));
      const filePath = stringField(body["path"], "path", { max: 1_000 });
      const content = body["content"];
      if (typeof content !== "string") {
        throw new HttpError(
          400,
          "invalid_request",
          "content must be a string",
        );
      }
      await perform(() =>
        workspaceOperations.writeFile({
          ...scope,
          path: filePath ?? "",
          content,
        }),
      );
      gw.sendJson(response, 200, { saved: true });
      return true;
    }
    if (action === "move" && method === "POST") {
      const body = objectBody(await gw.readJson(request));
      const from = stringField(body["from"], "from", { max: 1_000 }) ?? "";
      const to = stringField(body["to"], "to", { max: 1_000 }) ?? "";
      if (from === "" || to === "") {
        throw new HttpError(
          400,
          "invalid_request",
          "from and to are both required",
        );
      }
      await perform(() => workspaceOperations.moveFile({ ...scope, from, to }));
      // The same shape a save answers with: the caller's next move is to
      // refresh the changeset either way.
      gw.sendJson(response, 200, { moved: true });
      return true;
    }
    if (action === "exec" && method === "POST") {
      const body = objectBody(await gw.readJson(request));
      const command =
        stringField(body["command"], "command", { max: 4_000 }) ?? "";
      gw.sendJson(response, 200, {
        result: await perform(() =>
          workspaceOperations.exec({ ...scope, command }),
        ),
      });
      return true;
    }
    if (action === "submit" && method === "POST") {
      const body = objectBody(await gw.readJson(request));
      const objective =
        stringField(body["objective"], "objective", {
          max: 2_000,
          optional: true,
        }) ?? "";
      gw.sendJson(response, 200, {
        result: await perform(() =>
          workspaceOperations.submit({ ...scope, objective }),
        ),
      });
      return true;
    }
    throw new HttpError(405, "method_not_allowed", "Unsupported method");
  }

  return false;
}
