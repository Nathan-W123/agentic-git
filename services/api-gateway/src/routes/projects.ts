/**
 * Projects and the MCP servers a project offers its agents.
 *
 * Approving a server is the security decision here, which is why it is its
 * own route rather than a field on an update.
 *
 * Returns `true` when it answered the request. Order is behaviour: the first
 * branch that matches wins, exactly as it did when all of this was one
 * `if`-chain, and `server.ts` calls the groups in the order they were
 * written in.
 */

import type {
  McpServerRecord,
  McpServerScope,
} from "@coord/persistence";
import {
  type McpServerTransport,
  assertProjectPolicy,
  createId,
} from "@coord/shared-types";
import {
  AuthenticationError,
} from "../auth.js";
import {
  authorizeOrganization,
  authorizeProject,
} from "../authorization.js";
import {
  HttpError,
  assertMcpNamesDisjoint,
  booleanField,
  mcpArgsField,
  mcpCommandField,
  mcpRepositoryIdsField,
  mcpScopeField,
  mcpSecretsField,
  mcpServerNameField,
  mcpTransportField,
  mcpUrlField,
  mcpValuesField,
  objectBody,
  slugField,
  stringField,
} from "../field-validation.js";
import {
  matchPath,
} from "../gateway-util.js";
import {
  API_PREFIX,
} from "../http-util.js";
import type { ApiGateway } from "../server.js";
import type { AuthenticatedRouteRequest } from "./context.js";

export async function routeProjects(
  gw: ApiGateway,
  req: AuthenticatedRouteRequest,
): Promise<boolean> {
  const { context, request, response, url, method, path, principal } = req;

  const projectsMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/organizations/([^/]+)/projects$`, "u"),
  );
  if (projectsMatch !== undefined) {
    const organizationId = projectsMatch[0] ?? "";
    // Reading the project list is the one place a grant alone has to be
    // enough: somebody invited to a single repository has no organization
    // role, and without this they sign in successfully and can see nothing.
    // Everything beyond reading still requires a real organization role.
    let hasOrganizationRole = true;
    if (method === "GET") {
      try {
        await authorizeOrganization(
          gw.options.store,
          principal,
          organizationId,
          "view",
        );
      } catch (error) {
        hasOrganizationRole = false;
        const grants = await gw.options.store.listGrantsForUser(
          principal.user.id,
        );
        if (grants.length === 0) {
          throw error;
        }
      }
    } else {
      await authorizeOrganization(
        gw.options.store,
        principal,
        organizationId,
        "manage_project",
      );
    }
    if (method === "GET") {
      const projects = await gw.reachableProjects(
        principal,
        organizationId,
        hasOrganizationRole,
      );
      if (!hasOrganizationRole && projects.length === 0) {
        throw new AuthenticationError(
          "You do not have permission to perform this action",
          403,
          "forbidden",
        );
      }
      gw.sendJson(response, 200, { projects });
      return true;
    }
    if (method === "POST") {
      const body = objectBody(await gw.readJson(request));
      const slug = slugField(body["slug"]) ?? "";
      if (
        (await gw.options.store.listProjects(organizationId)).some(
          (project) => project.slug === slug,
        )
      ) {
        throw new HttpError(
          409,
          "slug_in_use",
          "Project slug is already in use",
        );
      }
      const description = stringField(body["description"], "description", {
        max: 2_000,
        optional: true,
      });
      const project = await gw.options.store.createProject({
        organizationId,
        slug,
        name: stringField(body["name"], "name", { max: 120 }) ?? "",
        ...(description === undefined ? {} : { description }),
      });
      await gw.options.store.appendAudit(undefined, {
        type: "project_changed",
        data: {
          organizationId,
          projectId: project.id,
          action: "created",
          actorId: principal.user.id,
        },
      });
      gw.sendJson(response, 201, { project });
      return true;
    }
  }

  const projectMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/projects/([^/]+)$`, "u"),
  );
  if (projectMatch !== undefined) {
    const projectId = projectMatch[0] ?? "";
    const authorized = await authorizeProject(
      gw.options.store,
      principal,
      projectId,
      method === "GET" ? "view" : "manage_project",
    );
    if (method === "GET") {
      gw.sendJson(response, 200, authorized);
      return true;
    }
    if (method === "PATCH") {
      const body = objectBody(await gw.readJson(request));
      const slug = slugField(body["slug"], { optional: true });
      if (
        slug !== undefined &&
        (
          await gw.options.store.listProjects(
            authorized.project.organizationId,
          )
        ).some(
          (project) => project.id !== projectId && project.slug === slug,
        )
      ) {
        throw new HttpError(
          409,
          "slug_in_use",
          "Project slug is already in use",
        );
      }
      const name = stringField(body["name"], "name", {
        max: 120,
        optional: true,
      });
      const description = stringField(body["description"], "description", {
        max: 2_000,
        optional: true,
      });
      const archived = booleanField(body["archived"], "archived");
      let policy: Record<string, unknown> | null | undefined;
      if ("policy" in body) {
        const value = body["policy"];
        if (value === null) {
          policy = null;
        } else {
          try {
            assertProjectPolicy(value);
          } catch (error) {
            throw new HttpError(
              400,
              "invalid_policy",
              error instanceof Error
                ? error.message
                : "Project policy is invalid",
            );
          }
          policy = value as unknown as Record<string, unknown>;
        }
      }
      const project = await gw.options.store.updateProject(projectId, {
        ...(slug === undefined ? {} : { slug }),
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(archived === undefined ? {} : { archived }),
        ...(policy === undefined ? {} : { policy }),
      });
      await gw.options.store.appendAudit(undefined, {
        type: "project_changed",
        data: {
          organizationId: project.organizationId,
          projectId,
          action: "updated",
          actorId: principal.user.id,
        },
      });
      gw.sendJson(response, 200, { project });
      return true;
    }
  }

  // A project's MCP servers: what its agents are handed as tools.
  //
  // Three patterns rather than one with optional groups, because matchPath
  // decodes every group and an absent one arrives as the string
  // "undefined". Reads need `view`; everything that changes a row needs
  // `manage_project`, and everything that stores or arms one also needs
  // the deployment switch and a sealer — see `requireMcpServers`.
  const mcpServersMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/projects/([^/]+)/mcp-servers$`, "u"),
  );
  const mcpServerMatch = matchPath(
    path,
    new RegExp(`^${API_PREFIX}/projects/([^/]+)/mcp-servers/([^/]+)$`, "u"),
  );
  const mcpApprovalMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/mcp-servers/([^/]+)/approval$`,
      "u",
    ),
  );
  // Its own route beside `approval`, and for the same reason `approval` is
  // not part of `PATCH`: this is a security decision with its own answer,
  // and one thing to grep for when asking who opened a server to editors.
  const mcpEditorAccessMatch = matchPath(
    path,
    new RegExp(
      `^${API_PREFIX}/projects/([^/]+)/mcp-servers/([^/]+)/editor-access$`,
      "u",
    ),
  );
  if (
    mcpServersMatch !== undefined ||
    mcpServerMatch !== undefined ||
    mcpApprovalMatch !== undefined ||
    mcpEditorAccessMatch !== undefined
  ) {
    const projectId =
      mcpServersMatch?.[0] ??
      mcpServerMatch?.[0] ??
      mcpApprovalMatch?.[0] ??
      mcpEditorAccessMatch?.[0] ??
      "";
    const serverId =
      mcpServerMatch?.[1] ?? mcpApprovalMatch?.[1] ?? mcpEditorAccessMatch?.[1];
    const { project } = await authorizeProject(
      gw.options.store,
      principal,
      projectId,
      method === "GET" ? "view" : "manage_project",
    );
    const audit = async (
      action: string,
      server: McpServerRecord,
    ): Promise<void> => {
      await gw.options.store.appendAudit(undefined, {
        type: "project_changed",
        data: {
          organizationId: project.organizationId,
          projectId,
          action,
          serverId: server.id,
          name: server.name,
          actorId: principal.user.id,
        },
      });
    };
    // Looked up by id and then checked against the project in the path,
    // so a server id from one project answers 404 under another rather
    // than being edited across the boundary the path was meant to draw.
    const existing = async (): Promise<McpServerRecord> => {
      const server =
        serverId === undefined
          ? undefined
          : await gw.options.store.getMcpServer(serverId);
      if (server === undefined || server.projectId !== projectId) {
        throw new HttpError(404, "not_found", "MCP server was not found");
      }
      return server;
    };
    const validateRepositories = async (
      repositoryIds: readonly string[],
    ): Promise<void> => {
      for (const repositoryId of repositoryIds) {
        if (
          !(await gw.options.store.projectHasRepository(
            projectId,
            repositoryId,
          ))
        ) {
          throw new HttpError(
            400,
            "unknown_repository",
            `${repositoryId} is not a repository of this project`,
          );
        }
      }
    };
    /** A repository-scoped server with no repositories attaches nowhere. */
    const assertScopeAttaches = (
      scope: McpServerScope,
      repositoryIds: readonly string[],
    ): void => {
      if (scope === "repository" && repositoryIds.length === 0) {
        throw new HttpError(
          400,
          "invalid_request",
          "a repository-scoped server needs at least one repositoryId",
        );
      }
    };
    const assertTransportComplete = (
      transport: McpServerTransport,
      command: string | undefined,
      url: string | undefined,
    ): void => {
      if (transport === "stdio" && command === undefined) {
        throw new HttpError(
          400,
          "invalid_request",
          "a stdio server needs a command",
        );
      }
      if (transport === "http" && url === undefined) {
        throw new HttpError(400, "invalid_request", "an http server needs a url");
      }
    };

    if (mcpServersMatch !== undefined && method === "GET") {
      const servers = await gw.options.store.listMcpServers(projectId);
      gw.sendJson(response, 200, {
        servers,
        // Whether anything here will reach an agent: the switch and the
        // sealer together, so a screen can say "configured but off" rather
        // than let somebody approve a server that will never start.
        enabled: gw.mcpServersAvailable(),
      });
      return true;
    }
    if (mcpServerMatch !== undefined && method === "GET") {
      gw.sendJson(response, 200, { server: await existing() });
      return true;
    }
    if (mcpServerMatch !== undefined && method === "DELETE") {
      // Allowed with the switch off: removing a row is the one write that
      // can only leave less armed than before.
      const server = await existing();
      await gw.options.store.deleteMcpServer(server.id);
      await audit("mcp_server_deleted", server);
      response.writeHead(204).end();
      return true;
    }

    const sealer = gw.requireMcpServers();
    const ownHosts = gw.ownHosts();

    if (mcpServersMatch !== undefined && method === "POST") {
      const body = objectBody(await gw.readJson(request));
      const name = mcpServerNameField(body["name"]);
      // Required on create — the field refuses an absent transport above —
      // so the fallback only narrows the type, never a request.
      const transport = mcpTransportField(body["transport"], false) ?? "stdio";
      const command = mcpCommandField(body["command"]) ?? undefined;
      const args = mcpArgsField(body["args"]);
      const url = mcpUrlField(body["url"], ownHosts) ?? undefined;
      const values = mcpValuesField(body["values"]);
      const secrets = mcpSecretsField(body["secrets"], { allowNull: false });
      const scope = mcpScopeField(body["scope"]) ?? "project";
      const repositoryIds = mcpRepositoryIdsField(body["repositoryIds"]) ?? [];
      assertTransportComplete(transport, command, url);
      assertMcpNamesDisjoint(values, secrets);
      assertScopeAttaches(scope, repositoryIds);
      await validateRepositories(repositoryIds);
      const sealed = Object.fromEntries(
        Object.entries(secrets ?? {}).map(([key, plaintext]) => [
          key,
          sealer.seal(plaintext ?? ""),
        ]),
      );
      let server: McpServerRecord;
      try {
        server = await gw.options.store.createMcpServer({
          id: createId("mcp"),
          projectId,
          name,
          transport,
          ...(command === undefined ? {} : { command }),
          ...(args === undefined ? {} : { args }),
          ...(url === undefined ? {} : { url }),
          ...(values === undefined ? {} : { values }),
          secrets: sealed,
          scope,
          repositoryIds,
          createdBy: principal.user.id,
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        if (error instanceof Error && /already/u.test(error.message)) {
          throw new HttpError(
            409,
            "name_taken",
            `This project already has an MCP server named ${name}`,
          );
        }
        throw error;
      }
      await audit("mcp_server_created", server);
      gw.sendJson(response, 201, { server });
      return true;
    }

    if (mcpServerMatch !== undefined && method === "PATCH") {
      const current = await existing();
      const body = objectBody(await gw.readJson(request));
      const name =
        body["name"] === undefined
          ? undefined
          : mcpServerNameField(body["name"]);
      const transport = mcpTransportField(body["transport"], true);
      // Fixed at creation. The stores keep it that way — a secret sealed
      // as a header must not turn up in a child process's environment
      // because somebody flipped one field — so accepting the change here
      // and dropping it there would answer 200 to an edit that never
      // happened. Said outright instead.
      if (transport !== undefined && transport !== current.transport) {
        throw new HttpError(
          400,
          "transport_fixed",
          `This server is ${current.transport}; to change how it is reached, ` +
            "remove it and create it again",
        );
      }
      const command = mcpCommandField(body["command"]);
      const args = mcpArgsField(body["args"]);
      const url = mcpUrlField(body["url"], ownHosts);
      const values = mcpValuesField(body["values"]);
      const secrets = mcpSecretsField(body["secrets"], { allowNull: true });
      const scope = mcpScopeField(body["scope"]);
      const repositoryIds = mcpRepositoryIdsField(body["repositoryIds"]);
      // Validated as the row will be after the edit, not as the edit alone:
      // switching transport without supplying what the new one needs, or
      // clearing the command a stdio server runs, leaves a row nothing can
      // start.
      const effectiveTransport = current.transport;
      const effectiveCommand =
        command === null ? undefined : (command ?? current.command);
      const effectiveUrl = url === null ? undefined : (url ?? current.url);
      assertTransportComplete(
        effectiveTransport,
        effectiveCommand,
        effectiveUrl,
      );
      assertMcpNamesDisjoint(values ?? current.values, secrets);
      assertScopeAttaches(
        scope ?? current.scope,
        repositoryIds ?? current.repositoryIds,
      );
      if (repositoryIds !== undefined) {
        await validateRepositories(repositoryIds);
      }
      const sealed =
        secrets === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(secrets).map(([key, plaintext]) => [
                key,
                plaintext === null ? null : sealer.seal(plaintext),
              ]),
            );
      let server: McpServerRecord;
      try {
        server = await gw.options.store.updateMcpServer(current.id, {
          ...(name === undefined ? {} : { name }),
          ...(command === undefined ? {} : { command }),
          ...(args === undefined ? {} : { args }),
          ...(url === undefined ? {} : { url }),
          ...(values === undefined ? {} : { values }),
          ...(sealed === undefined ? {} : { secrets: sealed }),
          ...(scope === undefined ? {} : { scope }),
          ...(repositoryIds === undefined ? {} : { repositoryIds }),
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (error instanceof Error && /already/u.test(error.message)) {
          throw new HttpError(
            409,
            "name_taken",
            `This project already has an MCP server named ${name ?? ""}`,
          );
        }
        throw error;
      }
      // An edit to an enabled server disarms it. What was approved is no
      // longer what is stored, and the approval — a decision about a
      // specific command line with specific secrets — does not carry over
      // to a different one. Said in the response so the screen can ask
      // for it again rather than leave the row looking approved.
      const reapprovalRequired = current.enabled;
      if (reapprovalRequired) {
        server = await gw.options.store.setMcpServerApproval(server.id, {
          enabled: false,
          approvedBy: principal.user.id,
          approvedAt: new Date().toISOString(),
        });
        await audit("mcp_server_disabled", server);
      }
      await audit("mcp_server_updated", server);
      gw.sendJson(response, 200, { server, reapprovalRequired });
      return true;
    }

    if (mcpApprovalMatch !== undefined && method === "POST") {
      const current = await existing();
      const body = objectBody(await gw.readJson(request));
      const enabled = booleanField(body["enabled"], "enabled", false) ?? false;
      const server = await gw.options.store.setMcpServerApproval(
        current.id,
        {
          enabled,
          approvedBy: principal.user.id,
          approvedAt: new Date().toISOString(),
        },
      );
      await audit(
        enabled ? "mcp_server_enabled" : "mcp_server_disabled",
        server,
      );
      gw.sendJson(response, 200, { server });
      return true;
    }
    if (mcpEditorAccessMatch !== undefined && method === "POST") {
      const current = await existing();
      const body = objectBody(await gw.readJson(request));
      const enabled = booleanField(body["enabled"], "enabled", false) ?? false;
      if (enabled && current.transport !== "http") {
        // Refused up front rather than stored and silently ignored. A
        // stdio server is a process, and the control plane starting one
        // chosen by a project admin is what this whole architecture keeps
        // out; there is no way to honour this switch for one.
        throw new HttpError(
          400,
          "invalid_request",
          `${current.name} runs as a command on the machine that uses it, ` +
            "so Kumi cannot offer it to an editor. Only servers reached " +
            "over a URL can be shared this way.",
        );
      }
      let server: McpServerRecord;
      try {
        server = await gw.options.store.setMcpServerEditorAccess(
          current.id,
          enabled,
          new Date().toISOString(),
        );
      } catch (error) {
        throw new HttpError(
          409,
          "not_approved",
          error instanceof Error
            ? error.message
            : "That server could not be opened to editors",
        );
      }
      await audit(
        enabled ? "mcp_server_editor_opened" : "mcp_server_editor_closed",
        server,
      );
      gw.sendJson(response, 200, { server });
      return true;
    }
    throw new HttpError(405, "method_not_allowed", "Method not allowed");
  }

  return false;
}
