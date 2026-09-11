/**
 * Repository selector — the landing screen once a session exists.
 *
 * The product is cloud-based: a repository is attached to the control plane
 * once and everyone works against that same canonical copy. So this screen
 * lists what the project already has and offers the three ways to add one —
 * a new empty repository, one imported from GitHub, and a copy of a folder
 * from the machine in front of you. It deliberately has no clone or per-user
 * fetch affordance. The one remote operation it does offer is "Sync from
 * GitHub", and that is repository management rather than a working-copy pull:
 * it moves the shared canonical copy up to date with the origin it was
 * imported from, which is what unblocks pushing after pull requests merge on
 * GitHub.
 */

import {
  addConnectedAgentsToRepository,
  api,
  collaborators,
  currentUserName,
  isFavourite,
  loadContext,
  persist,
  repositoryLabel,
  state,
  uploadRepositoryArchive,
} from "./data.js";
import { parsePatch, renderUnified } from "./code-view.js";
import {
  $,
  $$,
  addTile,
  avatarStack,
  esc,
  hueFor,
  icon,
  iconButton,
  emptyState,
  relativeTime,
  searchBox,
  segmented,
  selectBox,
  showModal,
  toast,
} from "./ui.js";

const REPO_ICONS = ["code", "layers", "database", "cpu", "globe", "bolt"];

function repoGlyph(id) {
  const text = String(id ?? "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33 + text.charCodeAt(index)) >>> 0;
  }
  return REPO_ICONS[hash % REPO_ICONS.length];
}

/** Newest promotion touching this repository, as its "updated" stamp. */
function lastActivity(repositoryId) {
  const run = state.runs.find((entry) => entry.repositoryId === repositoryId);
  const task = state.tasks.find((entry) => entry.repositoryId === repositoryId);
  return (
    run?.finishedAt ??
    run?.startedAt ??
    task?.completedAt ??
    task?.submittedAt ??
    undefined
  );
}

function visibleRepositories() {
  const query = state.repoQuery.trim().toLowerCase();
  const rows = state.repositories
    .map((repo) => ({ ...repo, updatedAt: lastActivity(repo.id) }))
    .filter(
      (repo) =>
        query === "" ||
        repo.id.toLowerCase().includes(query) ||
        repositoryLabel(repo.id).toLowerCase().includes(query) ||
        String(repo.branch ?? "").toLowerCase().includes(query),
    );
  if (state.repoSort === "name") {
    rows.sort((left, right) => left.id.localeCompare(right.id));
  } else {
    rows.sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")),
    );
  }
  // Favourites first within whichever order was chosen: marking one is a
  // request to see it sooner, which a star that only changed colour would not
  // honour.
  rows.sort(
    (left, right) =>
      Number(isFavourite(right.id)) - Number(isFavourite(left.id)),
  );
  return rows;
}

function repositoryCard(repo) {
  const people = collaborators();
  return `<article class="repo-card">
    <div class="rc-head">
      <span class="repo-tile" style="background:${hueFor(repo.id)}">${icon(
        repoGlyph(repo.id),
      )}</span>
      <div style="min-width:0;flex:1">
        <div class="rc-name">
          <!-- What it is called, which is its id until somebody renames it.
               The id stays the title: it is what every task and API path
               addresses, so a renamed repository is still identifiable. -->
          <span title="${esc(repo.id)}">${esc(repositoryLabel(repo.id))}</span>
          <button class="star${isFavourite(repo.id) ? " on" : ""}"
            data-act="star" data-value="${esc(repo.id)}"
            aria-pressed="${isFavourite(repo.id)}"
            title="${isFavourite(repo.id) ? "Remove from favourites" : "Add to favourites"}"
            >${icon("star")}</button>
        </div>
        <div class="rc-branch">${icon("branch")}${esc(repo.branch ?? "main")}</div>
      </div>
      <span class="rc-more">${iconButton("dots", {
        act: "repo-menu",
        value: repo.id,
        title: "Repository actions",
        small: true,
      })}</span>
    </div>
    <div class="rc-updated">${
      repo.updatedAt === undefined
        ? "No runs yet"
        : `Updated ${esc(relativeTime(repo.updatedAt))}`
    }</div>
    <div class="rc-foot">
      ${avatarStack(people, 4, 26)}
      <span style="flex:1"></span>
      <button class="btn btn-sm" data-act="open-repo" data-value="${esc(repo.id)}">
        Open ${icon("chevronRight")}
      </button>
    </div>
  </article>`;
}

/* ------------------------------------------------------------ actions ---- */

export async function createRepository(rerender) {
  const values = await showModal({
    title: "Create new repository",
    subtitle:
      "A new canonical repository is created on the control plane with an initial commit.",
    confirm: "Create repository",
    body: `<label class="field">
        <span>Repository name</span>
        <input class="input" name="name" placeholder="new-product" required>
      </label>
      <label class="field">
        <span>Default branch</span>
        <input class="input" name="branch" value="main">
      </label>`,
  });
  if (values === undefined || !values.name?.trim()) {
    return;
  }
  try {
    const asked = values.name.trim();
    const created = await api(
      `/projects/${encodeURIComponent(state.projectId)}/repositories`,
      {
        method: "POST",
        body: {
          id: asked,
          mode: "create",
          branch: values.branch?.trim() || "main",
        },
      },
    );
    // The name somebody types is not always the id they get: another project
    // on this control plane may already hold it, in which case the server
    // registers a numbered variant rather than refusing. Report the id that
    // actually exists, because that is what every other screen addresses it by.
    const id = created?.repository?.id ?? asked;
    const createdMessage =
      id === asked
        ? `Created ${asked}`
        : `Created ${id} — the name ${asked} was already taken`;
    await loadContext();
    const failedAgents = await addConnectedAgentsToRepository(id);
    toast(
      failedAgents.length === 0
        ? createdMessage
        : `${createdMessage}, but some agents could not be added`,
      failedAgents.length === 0 ? "ok" : "error",
    );
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function connectRepository(rerender) {
  const values = await showModal({
    title: "Import from GitHub",
    subtitle:
      "The repository and its history are imported into Kumi. Credentials stay in the control plane, never the browser.",
    confirm: "Import",
    body: `<label class="field">
        <span>GitHub repository</span>
        <input class="input" name="remote" placeholder="owner/name or https://github.com/owner/name" required>
      </label>
      <label class="field">
        <span>Local id</span>
        <input class="input" name="id" placeholder="core">
      </label>
      <label class="field">
        <span>Branch</span>
        <input class="input" name="branch" placeholder="Default branch">
      </label>`,
  });
  if (values === undefined || !values.remote?.trim()) {
    return;
  }
  try {
    // Importing has its own route. Posting to `/repositories` with a `mode`
    // field looked like it worked — nothing reads `mode`, so the request fell
    // through to plain creation and answered 201 with a brand new *empty*
    // repository, one "Initial commit" on `main` and none of the remote's
    // history. The symptom was a connected repository with no files in it.
    const imported = await api(
      `/projects/${encodeURIComponent(state.projectId)}/repositories/github`,
      {
        method: "POST",
        body: {
          repository: values.remote.trim(),
          ...(values.id?.trim() ? { id: values.id.trim() } : {}),
          ...(values.branch?.trim() ? { branch: values.branch.trim() } : {}),
        },
      },
    );
    const importedId = imported?.repository?.id;
    const importedMessage =
      importedId === undefined
        ? "Repository imported"
        : `Repository imported as ${importedId}`;
    await loadContext();
    const failedAgents =
      importedId === undefined
        ? []
        : await addConnectedAgentsToRepository(importedId);
    toast(
      failedAgents.length === 0
        ? importedMessage
        : `${importedMessage}, but some agents could not be added`,
      failedAgents.length === 0 ? "ok" : "error",
    );
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * The ceiling the upload route enforces, restated so the browser can refuse a
 * folder before spending five minutes sending it.
 */
const MAX_REPOSITORY_ARCHIVE_BYTES = 200 * 1024 * 1024;

/**
 * CRC-32, because a ZIP entry carries one and nothing in a browser computes
 * it for you.
 *
 * The table is the standard reflected polynomial, built once on first use.
 * Fifteen lines of arithmetic against a dependency and a supply chain for a
 * checksum that has not changed since 1975.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A file's own timestamp, in the two 16-bit words a ZIP entry holds. */
function dosTimestamp(millis) {
  const when = new Date(millis || Date.now());
  const year = Math.max(1980, when.getFullYear());
  return {
    time:
      (when.getHours() << 11) |
      (when.getMinutes() << 5) |
      (Math.floor(when.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/**
 * Compresses one entry, where the browser can.
 *
 * `CompressionStream` is in every current browser and in none of the old
 * ones, and a repository that uploads three times larger is still a
 * repository that uploads — so its absence falls back to storing the bytes
 * rather than refusing the folder.
 */
async function deflateRaw(bytes) {
  if (typeof window.CompressionStream !== "function") {
    return undefined;
  }
  try {
    const compressed = new Blob([bytes])
      .stream()
      .pipeThrough(new window.CompressionStream("deflate-raw"));
    const packed = new Uint8Array(await new Response(compressed).arrayBuffer());
    // A file that grows under compression is stored instead. Small files
    // routinely do, and an entry is not worth making bigger to compress.
    return packed.length < bytes.length ? packed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A folder the person picked, as one ZIP.
 *
 * Written here rather than asking them to zip it themselves, because "pick
 * your project folder" is the whole feature and "now go and compress it
 * first" is most of the way back to not having it. The format is the same one
 * the control plane already reads, so nothing on the other end knows or cares
 * that this archive was made in a browser.
 *
 * Hidden files come along, `.git` most of all — it is the reason the history
 * survives the trip rather than arriving as a single commit of the current
 * state.
 */
async function zipFolder(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const encoder = new TextEncoder();
  for (const file of files) {
    const name = encoder.encode(file.webkitRelativePath || file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const checksum = crc32(bytes);
    const packed = await deflateRaw(bytes);
    const body = packed ?? bytes;
    const method = packed === undefined ? 0 : 8;
    const stamp = dosTimestamp(file.lastModified);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    // Bit 11: the name is UTF-8, which is the only thing a `TextEncoder`
    // produces and the only thing the reader on the other side expects.
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, method, true);
    local.setUint16(10, stamp.time, true);
    local.setUint16(12, stamp.date, true);
    local.setUint32(14, checksum, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, body);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, method, true);
    entry.setUint16(12, stamp.time, true);
    entry.setUint16(14, stamp.date, true);
    entry.setUint32(16, checksum, true);
    entry.setUint32(20, body.length, true);
    entry.setUint32(24, bytes.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const directory = central.reduce((total, chunk) => total + chunk.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directory, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], {
    type: "application/zip",
  });
}

/**
 * Copies a repository from this machine into the control plane.
 *
 * The third way in, and the one for a project that has never been pushed
 * anywhere: there is no remote to import from, so the folder itself travels.
 * Either a folder chosen directly — zipped here, on the way out — or a `.zip`
 * somebody already made, which is what the browsers without a folder picker
 * leave people with.
 *
 * Whatever `.git` is inside comes with it. That is the difference between
 * this and creating an empty repository and pasting files into it: the
 * history arrives too, and so does the branch it was on.
 */
export async function uploadRepository(rerender) {
  const values = await showModal({
    title: "Copy from this computer",
    subtitle:
      "The folder is copied into Kumi as a new canonical repository. If it " +
      "is already a Git repository its history comes with it; uncommitted " +
      "changes do not, so commit them first.",
    confirm: "Copy repository",
    body: `<label class="field">
        <span>Folder</span>
        <input class="input" type="file" name="folder" webkitdirectory
          directory multiple>
      </label>
      <p class="modal-hint">No folder picker in this browser? Choose a
        <code>.zip</code> of the folder instead.</p>
      <label class="field">
        <span>Or a .zip of the folder</span>
        <input class="input" type="file" name="archive"
          accept=".zip,application/zip,application/x-zip-compressed">
      </label>
      <label class="field">
        <span>Name</span>
        <input class="input" name="id" placeholder="Taken from the folder">
      </label>
      <label class="field">
        <span>Branch</span>
        <input class="input" name="branch"
          placeholder="The branch the folder is on">
      </label>`,
  });
  if (values === undefined) {
    return;
  }
  const chosen = [...(values.archive ?? [])];
  const folder = [...(values.folder ?? [])];
  if (chosen.length === 0 && folder.length === 0) {
    toast("Choose a folder, or a .zip of one", "error");
    return;
  }
  const total = [...chosen, ...folder].reduce(
    (bytes, file) => bytes + file.size,
    0,
  );
  // Refused here as well as by the route, because the alternative is somebody
  // watching a 900 MB upload run to completion and then be turned away.
  if (total > MAX_REPOSITORY_ARCHIVE_BYTES) {
    toast(
      `That folder is ${Math.round(total / (1024 * 1024))} MB, and the limit ` +
        `is ${Math.round(MAX_REPOSITORY_ARCHIVE_BYTES / (1024 * 1024))} MB. ` +
        "Push it to GitHub and import it from there instead.",
      "error",
    );
    return;
  }
  try {
    toast(
      chosen.length > 0 ? "Uploading…" : "Packing the folder up…",
    );
    const archive = chosen[0] ?? (await zipFolder(folder));
    const uploaded = await uploadRepositoryArchive(archive, {
      id: values.id?.trim(),
      branch: values.branch?.trim(),
    });
    const uploadedId = uploaded?.id;
    const message =
      uploadedId === undefined
        ? "Repository copied"
        : `Repository copied as ${uploadedId}`;
    await loadContext();
    const failedAgents =
      uploadedId === undefined
        ? []
        : await addConnectedAgentsToRepository(uploadedId);
    toast(
      failedAgents.length === 0
        ? message
        : `${message}, but some agents could not be added`,
      failedAgents.length === 0 ? "ok" : "error",
    );
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function syncRepositoryFromGitHub(
  repositoryId,
  rerender,
  resolve,
  afterSync,
  /**
   * `perFile` is the answer a person gave after reading the differences, one
   * side per clashing file. `force` says an answer was already given and a
   * second refusal must not reopen the dialog — the loop that used to be.
   */
  { perFile, force } = {},
) {
  toast("Syncing from GitHub…");
  const answered = resolve !== undefined || perFile !== undefined || force === true;
  try {
    const result = await api(
      `/projects/${encodeURIComponent(state.projectId)}/repositories/${encodeURIComponent(repositoryId)}/sync`,
      {
        method: "POST",
        body:
          perFile !== undefined
            ? { resolveFiles: perFile }
            : resolve === undefined
              ? {}
              : { resolve },
      },
    );
    const sync = result.sync ?? {};
    const moved = `${String(sync.previousRevision ?? "").slice(0, 8)} → ${String(
      sync.revision ?? "",
    ).slice(0, 8)}`;
    const settled = sync.resolved?.files?.length ?? 0;
    toast(
      sync.status === "already_current"
        ? "Already up to date with GitHub"
        : sync.status === "fast_forwarded"
          ? `Synced from GitHub (${moved})`
          : settled > 0
            ? `Synced — ${settled} clashing file${settled === 1 ? "" : "s"} took ` +
              `${
                sync.resolved.side === "remote"
                  ? "GitHub's"
                  : sync.resolved.side === "local"
                    ? "this project's"
                    : "the side you picked for each"
              } side (${moved})`
            : `Synced from GitHub — local work and GitHub's merged (${moved})`,
      "ok",
    );
    await loadContext();
    rerender();
    await afterSync?.();
  } catch (error) {
    // A collision is a question, not a failure: the same files changed on
    // both sides, and only a person can say which version survives. Asked
    // here rather than reported, because the alternative — the remedies the
    // refusal used to list — is not reachable from a phone at all.
    //
    // Asked once. A refusal that comes back *after* an answer was given is
    // not the same question again, it is that answer failing, and reopening
    // the dialog on it is an infinite loop with no way out — which is
    // exactly what it was: the same files, the same two buttons, forever.
    if (error.code === "sync_conflict" && !answered) {
      // The refusal carries each clashing file and how the two sides differ,
      // read from the merge that just refused. That is what turns "pick a
      // side" from a gamble into a decision.
      await chooseSyncSide(
        repositoryId,
        rerender,
        { message: error.message, files: error.details?.files ?? [] },
        afterSync,
      );
      return;
    }
    if (error.code === "sync_conflict") {
      // A refusal *after* an answer is that answer failing, not the same
      // question again — most often because somebody pushed between the
      // dialog opening and Sync being pressed, so the answer no longer
      // covers what clashes. Reopening on it is the loop with no way out
      // that this used to be, so it is said once and left to the person.
      toast(
        `That did not settle it — what clashes has changed since you chose. ` +
          `${error.message} Sync again to see it.`,
        "error",
      );
      return;
    }
    toast(error.message, "error");
  }
}

/**
 * Asks the one question a conflicting merge cannot answer for itself.
 *
 * Kept shared by the repository Sync control and `/push`: the command first
 * discovers the collision while trying to synchronize, then resumes its push
 * through `afterSync` once this choice has made the merge possible.
 */
async function chooseSyncSide(repositoryId, rerender, conflict, afterSync) {
  const files = Array.isArray(conflict?.files) ? conflict.files : [];
  if (files.length === 0) {
    // Nothing to show. The server could not describe the collision — an old
    // deployment, or a describe that failed — and the choice is still worth
    // offering, just without the pictures. One answer for all of them is all
    // that can honestly be asked for when nobody can see them.
    const blanket = await showModal({
      title: "Both sides changed the same files",
      subtitle:
        "The differences could not be read. Pick which side wins for the " +
        "files that clash; everything else merges normally, and the side " +
        "you do not pick stays in the history.",
      confirm: "Take GitHub's version",
      cancel: "Keep Kumi's version",
      body: `<p class="modal-hint">${esc(conflict?.message ?? "")}</p>`,
    });
    await syncRepositoryFromGitHub(
      repositoryId,
      rerender,
      blanket === undefined ? "prefer-local" : "prefer-remote",
      afterSync,
      { force: true },
    );
    return;
  }

  const answer = showModal({
    title: `${String(files.length)} file${files.length === 1 ? "" : "s"} changed on both sides`,
    subtitle:
      "Pick which version wins for each one. Everything else merges " +
      "normally, and the version you do not pick stays in the history.",
    confirm: "Sync",
    cancel: "Cancel",
    body: conflictBody(files),
  });
  // `showModal` builds its DOM before it returns, so the rows exist by the
  // time this runs. The shortcuts and the diffs have to be wired here rather
  // than written into the markup: the body is an HTML string, and a page
  // whose script-src carries no 'unsafe-inline' runs no handler written into
  // an attribute.
  wireConflictBody(files);
  const values = await answer;
  if (values === undefined) {
    toast("Nothing was changed", "ok");
    return;
  }
  const perFile = {};
  files.forEach((file, index) => {
    const side = values[`conflict-${String(index)}`];
    if (side === "local" || side === "remote") {
      perFile[file.path] = side;
    }
  });
  if (Object.keys(perFile).length !== files.length) {
    // Cannot happen while Sync stays disabled until every row is answered,
    // and is checked anyway: a partial map is refused by the server, and a
    // refusal a person cannot act on is worse than a sentence saying what is
    // missing.
    toast("Pick a side for every file first", "error");
    return;
  }
  await syncRepositoryFromGitHub(repositoryId, rerender, undefined, afterSync, {
    perFile,
  });
}

/** What each clashing file is, and the two ways it can go. */
function conflictBody(files) {
  const rows = files
    .map((file, index) => {
      const name = `conflict-${String(index)}`;
      const rendered =
        typeof file.patch === "string" && file.patch.length > 0
          ? `<details class="conflict-diff">
               <summary>See the difference</summary>
               <div class="code-body">${renderUnified(parsePatch(file.patch))}</div>
             </details>`
          : `<p class="conflict-note">${esc(
              file.note ?? "Both sides changed this file.",
            )}</p>`;
      return `<li class="conflict-file" data-conflict-row="${String(index)}">
          <div class="conflict-head">
            <span class="conflict-path" title="${esc(file.path)}">${esc(file.path)}</span>
            <span class="conflict-sides">
              <label class="conflict-side">
                <input type="radio" name="${name}" value="local">
                <span>Kumi</span>
              </label>
              <label class="conflict-side">
                <input type="radio" name="${name}" value="remote">
                <span>GitHub</span>
              </label>
            </span>
          </div>
          ${rendered}
        </li>`;
    })
    .join("");
  return `<div class="conflict-list">
      <div class="conflict-bulk">
        <button type="button" class="btn" data-conflict-all="local">Keep Kumi's for all</button>
        <button type="button" class="btn" data-conflict-all="remote">Take GitHub's for all</button>
      </div>
      <ul class="conflict-files">${rows}</ul>
    </div>`;
}

/**
 * The dialog's behaviour: the two shortcuts, and a Sync that stays out of
 * reach until every file has been answered.
 *
 * Nothing is pre-selected on purpose. A default is an answer given on
 * somebody's behalf to the one question this whole screen exists to stop
 * being answered blindly — and whichever way it defaulted would be the way
 * most files went.
 */
function wireConflictBody(files) {
  const dialog = $("#modal");
  if (dialog === null) {
    return;
  }
  const confirm = $('button[value="confirm"]', dialog);
  const settle = () => {
    if (confirm === null) {
      return;
    }
    const answered = files.filter(
      (_file, index) =>
        $(`input[name="conflict-${String(index)}"]:checked`, dialog) !== null,
    ).length;
    confirm.disabled = answered !== files.length;
    confirm.textContent =
      answered === files.length
        ? `Sync ${String(files.length)} file${files.length === 1 ? "" : "s"}`
        : `${String(files.length - answered)} still to choose`;
  };
  for (const button of $$("[data-conflict-all]", dialog)) {
    button.addEventListener("click", () => {
      const side = button.dataset.conflictAll;
      for (const input of $$(`input[type="radio"][value="${side}"]`, dialog)) {
        input.checked = true;
      }
      settle();
    });
  }
  dialog.addEventListener("change", settle);
  settle();
}

/** Completes the push whose first synchronization opened the choice above. */
async function pushAfterSync(repositoryId, rerender, messageId) {
  toast("Pushing to GitHub…");
  try {
    const response = await api(
      `/projects/${encodeURIComponent(state.projectId)}/repositories/${encodeURIComponent(repositoryId)}/push`,
      {
        method: "POST",
        body: messageId === undefined ? {} : { messageId },
      },
    );
    const push = response.push ?? {};
    if (push.detail?.syncConflict === true) {
      await chooseSyncSide(
        repositoryId,
        rerender,
        push.explanation ?? "GitHub changed again before the push could finish.",
        async () => await pushAfterSync(repositoryId, rerender, messageId),
      );
      return;
    }
    toast(
      push.explanation ??
        (push.outcome === "done" ? "Pushed to GitHub" : "Nothing was pushed"),
      push.outcome === "done" ? "ok" : "error",
    );
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * Opens the sync choice encoded in a channel command response, if there is
 * one. Ordinary messages and successful pushes take no browser-side action.
 */
export function handleChannelCommandResult(
  repositoryId,
  response,
  rerender,
  messageId,
) {
  const push = response?.command?.name === "push"
    ? response.command.result
    : undefined;
  if (push?.detail?.syncConflict !== true) {
    return false;
  }
  void chooseSyncSide(
    repositoryId,
    rerender,
    push.explanation,
    async () => await pushAfterSync(repositoryId, rerender, messageId),
  );
  return true;
}

export function openRepository(repositoryId, navigate) {
  state.repositoryId = repositoryId;
  persist("ag.repo", repositoryId);
  state.openTabs = [];
  state.activeTab = "";
  state.files = [];
  state.workspace = undefined;
  navigate("code");
}
