/**
 * The Code screen: files, editor, diff, and the private agent panel.
 *
 * Files, the editor, and the diff are one view rather than three pages.
 * Reviewing a change and reading the file it changed are the same activity,
 * and splitting them costs a navigation every time someone wants to check
 * what a line looked like before.
 *
 * The diff shown is the unified patch the coordinator recorded for the
 * changeset — the same bytes that went through validation and promotion —
 * so what a reviewer reads is what the pipeline acted on.
 */

import {
  api,
  apiOptional,
  currentRepository,
  persist,
  state,
} from "./data.js";
import {
  FLAG_FOR_STATUS,
  buildTree,
  changeSetStats,
  languageOf,
  parsePatch,
  patchStats,
  renderSource,
  renderSplit,
  renderUnified,
} from "./code-view.js";
import { chatPanel } from "./chat.js";
import {
  agentFace,
  clockTime,
  searchBox,
  elapsed,
  esc,
  icon,
  iconButton,
  emptyState,
  segmented,
  toast,
} from "./ui.js";

/* -------------------------------------------------------------- data ---- */

/**
 * Loads what the Code screen needs, tolerating a deployment without overlay
 * workspaces: the changeset alone is enough to review, and the workspace only
 * adds the untouched files around it.
 */
export async function ensureCodeData(rerender) {
  const repository = currentRepository();
  if (repository === undefined || state.codeLoading) {
    return;
  }
  if (state.codeRepo === repository.id && state.codeLoaded) {
    return;
  }
  state.codeLoading = true;
  state.codeRepo = repository.id;
  try {
    const run = state.runs.find(
      (entry) => entry.repositoryId === repository.id && entry.id,
    );
    if (run !== undefined) {
      const detail = await apiOptional(
        `/runs/${encodeURIComponent(run.id)}`,
        { run: undefined },
      );
      const changeSets = detail.run?.changeSets ?? [];
      state.changeSet = changeSets[changeSets.length - 1];
      state.runDetail = detail.run;
    } else {
      state.changeSet = undefined;
      state.runDetail = undefined;
    }

    const project = encodeURIComponent(state.projectId);
    const repo = encodeURIComponent(repository.id);
    const status = await apiOptional(
      `/projects/${project}/repositories/${repo}/workspace`,
      { workspace: undefined },
    );
    state.workspace = status.workspace;
    if (state.workspace?.exists === true) {
      const files = await apiOptional(
        `/projects/${project}/repositories/${repo}/workspace/files`,
        { files: [] },
      );
      state.files = files.files ?? [];
    } else {
      state.files = [];
    }

    if (state.openTabs.length === 0) {
      // Open the substantive files first. Landing on a README diff technically
      // shows "a change", but not the one anyone came to look at.
      const ranked = [...(state.changeSet?.patches ?? [])].sort(
        (left, right) => rank(left.path) - rank(right.path),
      );
      if (ranked.length > 0) {
        state.openTabs = ranked.slice(0, 3).map((patch) => patch.path);
        state.activeTab = ranked[0].path;
      }
    }
    state.codeLoaded = true;
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.codeLoading = false;
    rerender();
  }
}

/** Source before schema before docs, so the first tab is worth reading. */
function rank(path) {
  if (/\.(md|txt)$/iu.test(path)) {
    return 3;
  }
  if (/\.(sql|ya?ml|json)$/iu.test(path)) {
    return 2;
  }
  if (/(^|\/)tests?\//iu.test(path)) {
    return 1;
  }
  return 0;
}

export function invalidateCode() {
  state.codeLoaded = false;
  state.codeRepo = undefined;
}

function patchFor(path) {
  return (state.changeSet?.patches ?? []).find((entry) => entry.path === path);
}

function flagFor(path) {
  const patch = patchFor(path);
  return patch === undefined ? undefined : FLAG_FOR_STATUS[patch.status] ?? "M";
}

/** Narrows the tree to a query, matching on the whole path. */
function matchesQuery(path) {
  const query = String(state.treeQuery ?? "").trim().toLowerCase();
  return query === "" || path.toLowerCase().includes(query);
}

/** Every path worth showing: changed files first, then the rest of the tree. */
function treeEntries() {
  const seen = new Map();
  for (const patch of state.changeSet?.patches ?? []) {
    seen.set(patch.path, {
      path: patch.path,
      flag: FLAG_FOR_STATUS[patch.status] ?? "M",
    });
  }
  for (const file of state.files) {
    if (!seen.has(file.path)) {
      seen.set(file.path, { path: file.path });
    }
  }
  return [...seen.values()]
    .filter((entry) => matchesQuery(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/* -------------------------------------------------------------- tree ---- */

function treeNode(node, depth) {
  const rows = [];
  const directories = [...node.dirs.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const directory of directories) {
    const open = state.expanded.has(directory.path);
    rows.push(`<button class="tree-row" data-act="tree-dir"
      data-value="${esc(directory.path)}" style="padding-left:${8 + depth * 12}px">
      ${icon("chevronRight", `class="caret${open ? " open" : ""}"`)}
      <span class="tw-icon">${icon("folder")}</span>
      <span class="tw-name">${esc(directory.name)}</span>
    </button>`);
    if (open) {
      rows.push(treeNode(directory, depth + 1));
    }
  }
  const files = [...node.files].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const file of files) {
    const active = file.path === state.activeTab;
    rows.push(`<button class="tree-row${active ? " active" : ""}"
      data-act="tree-file" data-value="${esc(file.path)}"
      style="padding-left:${8 + depth * 12 + 14}px" title="${esc(file.path)}">
      <span class="tw-icon">${icon("file")}</span>
      <span class="tw-name">${esc(file.name)}</span>
      ${file.flag ? `<span class="tw-flag flag-${file.flag}">${file.flag}</span>` : ""}
    </button>`);
  }
  return rows.join("");
}

function treePane() {
  const entries = treeEntries();
  return `<aside class="tree-pane${state.treeQuery === undefined ? "" : " filtering"}">
    <header class="tree-head">
      <span>Files</span>
      <span class="spacer"></span>
      ${iconButton("plus", { act: "file-new", title: "New file", small: true })}
      ${iconButton("folderPlus", { act: "folder-new", title: "New folder", small: true })}
      ${iconButton("refresh", { act: "files-refresh", title: "Refresh", small: true })}
      ${iconButton("dots", { act: "files-menu", title: "More", small: true })}
    </header>
    ${
      state.treeQuery === undefined
        ? ""
        : `<div class="tree-search">${searchBox(
            "Filter files...",
            state.treeQuery,
            "tree-search",
          )}</div>`
    }
    <div class="tree-body">${
      entries.length === 0
        ? emptyTree()
        : treeNode(buildTree(entries), 0)
    }</div>
  </aside>`;
}

/**
 * What the tree says when it has nothing to show.
 *
 * A repository with no runs has no changeset, and the canonical tree is not
 * reachable over HTTP — only a workspace is. Rather than leave a dead panel or
 * quietly materialise a worktree nobody asked for, the empty state offers the
 * action and says what it does.
 */
function emptyTree() {
  if (state.treeQuery) {
    return `<p class="tree-empty">No file matches that filter.</p>`;
  }
  if (state.workspace?.exists === true) {
    return `<p class="tree-empty">This workspace is empty.</p>`;
  }
  if (state.workspace === undefined) {
    return `<p class="tree-empty">This deployment does not provide browsable
      workspaces, so only files touched by a changeset appear here.</p>`;
  }
  return `<div class="tree-empty">
    <p>No changeset has been collected for this repository yet.</p>
    <button class="btn btn-sm" data-act="workspace-open"${
      state.workspaceOpening === true ? " disabled" : ""
    }>${icon("folder")} ${
      state.workspaceOpening === true ? "Opening…" : "Browse repository files"
    }</button>
    <p class="tree-empty-note">Opens your own workspace on the current
      canonical revision. Nothing is shared until you submit.</p>
  </div>`;
}

/** Materialises this user's overlay workspace so the tree has something. */
export async function openWorkspace(rerender) {
  const repository = currentRepository();
  if (repository === undefined || state.workspaceOpening === true) {
    return;
  }
  state.workspaceOpening = true;
  rerender();
  try {
    const project = encodeURIComponent(state.projectId);
    const repo = encodeURIComponent(repository.id);
    const opened = await api(
      `/projects/${project}/repositories/${repo}/workspace`,
      { method: "POST", body: {} },
    );
    state.workspace = opened.workspace;
    const files = await apiOptional(
      `/projects/${project}/repositories/${repo}/workspace/files`,
      { files: [] },
    );
    state.files = files.files ?? [];
    toast(`Workspace ready — ${state.files.length} files`, "ok");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.workspaceOpening = false;
    rerender();
  }
}

/* ------------------------------------------------------------ toolbar ---- */

function toolbar() {
  const stats = changeSetStats(state.changeSet);
  return `<div class="code-toolbar">
    <h2>Code</h2>
    ${
      stats.files === 0
        ? `<span class="stat-inline">No pending changes</span>`
        : `<span class="stat-inline">${stats.files} file${
            stats.files === 1 ? "" : "s"
          } changed</span>
           <span class="delta-add">+${stats.additions}</span>
           <span class="delta-del">-${stats.deletions}</span>`
    }
    <span class="spacer"></span>
    <button class="btn btn-sm" data-act="code-search">${icon("search")} Search</button>
    <button class="btn btn-sm" data-act="code-history">${icon("history")} History</button>
    <button class="btn btn-sm btn-primary" data-act="code-summary" id="summary-btn">
      ${icon("sparkle")} Summary
    </button>
    <button class="icon-btn${state.chatOpen ? " on" : ""}" data-act="chat-toggle"
      title="${state.chatOpen ? "Hide" : "Show"} agent chat"
      aria-pressed="${state.chatOpen}">${icon("robot")}</button>
    ${iconButton("dots", { act: "code-menu", title: "More actions" })}
  </div>`;
}

function tabStrip() {
  return `<div class="code-tabs">
    ${state.openTabs
      .map((path) => {
        const flag = flagFor(path);
        const name = path.split("/").pop();
        return `<div class="code-tab${path === state.activeTab ? " active" : ""}"
          data-act="tab-open" data-value="${esc(path)}" title="${esc(path)}">
          <span>${esc(name)}</span>
          ${flag ? `<span class="ct-flag flag-${flag}">${flag}</span>` : ""}
          <span class="ct-close" data-act="tab-close" data-value="${esc(path)}"
            role="button" aria-label="Close ${esc(name)}">${icon("close")}</span>
        </div>`;
      })
      .join("")}
  </div>`;
}

function breadcrumb() {
  const parts = String(state.activeTab ?? "").split("/").filter(Boolean);
  const crumbs = parts
    .map((part, index) =>
      index === parts.length - 1
        ? `<span class="crumb-last">${esc(part)}</span>`
        : `<span>${esc(part)}</span><span class="crumb-sep">›</span>`,
    )
    .join("");
  return `<div class="code-crumb">
    ${crumbs || '<span class="crumb-last">No file open</span>'}
    <span class="spacer"></span>
    ${segmented(
      "diff-mode",
      [
        { value: "unified", label: "Unified" },
        { value: "split", label: "Split" },
      ],
      state.diffMode,
    )}
  </div>`;
}

function editorBody() {
  const path = state.activeTab;
  if (!path) {
    return `<div class="code-body">${emptyState(
      "file",
      "No file open",
      "Pick a file from the tree, or open one of the files this changeset touched.",
    )}</div>`;
  }
  const patch = patchFor(path);
  if (patch !== undefined) {
    const rows = parsePatch(patch.patch);
    if (state.diffMode === "split") {
      return `<div class="code-body split">${renderSplit(rows)}</div>`;
    }
    return `<div class="code-body">${renderUnified(rows)}</div>`;
  }
  const cached = state.fileCache.get(path);
  if (cached === undefined) {
    return `<div class="code-body"><div class="dline ctx"><span class="ln"></span><span class="ln"></span><span class="src">Loading ${esc(
      path,
    )}…</span></div></div>`;
  }
  if (cached.binary) {
    return `<div class="code-body">${emptyState(
      "file",
      "Binary file",
      "This file has no textual representation to show.",
    )}</div>`;
  }
  return `<div class="code-body">${renderSource(cached.content)}</div>`;
}

function statusBar() {
  const stats = changeSetStats(state.changeSet);
  const path = state.activeTab;
  return `<div class="code-status">
    <span class="legend"><b class="flag-M">M</b> Modified</span>
    <span class="legend"><b class="flag-A">A</b> Added</span>
    <span class="legend"><b class="flag-D">D</b> Deleted</span>
    <span class="spacer"></span>
    ${path ? `<span>${esc(languageOf(path))}</span><span>Spaces: 2</span>` : ""}
    <span class="delta-add">+${stats.additions} additions</span>
    <span class="delta-del">-${stats.deletions} deletions</span>
  </div>`;
}

/* -------------------------------------------------------------- view ---- */

export function renderCode(agent) {
  const repository = currentRepository();
  if (repository === undefined) {
    return `<div class="scroll"><div class="page">${emptyState(
      "folder",
      "No repository selected",
      "Open a repository from the repository screen to start working in it.",
    )}</div></div>`;
  }
  const classes = ["code-shell"];
  if (!state.chatOpen) {
    classes.push("no-chat");
  }
  if (state.treeOpen) {
    classes.push("tree-open");
  }
  return `<div class="${classes.join(" ")}">
    ${treePane()}
    <div class="code-main">
      ${toolbar()}
      ${tabStrip()}
      ${breadcrumb()}
      ${editorBody()}
      ${statusBar()}
    </div>
    ${state.chatOpen ? chatPanel(agent) : ""}
  </div>`;
}

/* ------------------------------------------------------------ summary ---- */

/**
 * The Summary popover.
 *
 * Anchored over the editor rather than routed to, because a summary is read
 * *about* what is on screen. Everything in it comes from the recorded
 * changeset: the counts, the file list, the agent's own explanation, and the
 * validation commands that ran.
 */
export function summaryPopoverHtml(agent) {
  const changeSet = state.changeSet;
  if (changeSet === undefined) {
    return `<div class="pop-head"><h3>Summary</h3><span class="spacer"></span>
      ${iconButton("close", { act: "pop-close", title: "Close", small: true })}</div>
      <p class="pop-block" style="color:var(--text-3);font-size:12px">
        No changeset has been collected for this repository yet.
      </p>`;
  }
  const stats = changeSetStats(changeSet);
  const run = state.runDetail?.run;
  const runtime =
    run?.startedAt === undefined
      ? "—"
      : elapsed(
          new Date(run.finishedAt ?? Date.now()).getTime() -
            new Date(run.startedAt).getTime(),
        );
  const tests = changeSet.tests ?? [];
  const passed = tests.filter((test) => test.status === "passed").length;
  const failed = tests.filter((test) => test.status === "failed").length;
  // Validation runs during integration, after the changeset is recorded, so
  // the results live on the integration rather than on the changeset.
  const commands =
    (changeSet.commandsRun ?? []).length > 0
      ? changeSet.commandsRun
      : (state.runDetail?.integrations ?? []).flatMap(
          (integration) => integration.validation ?? [],
        );

  return `<div class="pop-head">
      <h3>Summary</h3>
      <span class="spacer"></span>
      ${iconButton("close", { act: "pop-close", title: "Close", small: true })}
    </div>

    <div class="sum-tiles">
      <div class="sum-tile">
        <div class="stl">${icon("git")} Changes</div>
        <div class="stv"><span class="delta-add">+${stats.additions}</span>
          <span class="delta-del">-${stats.deletions}</span></div>
      </div>
      <div class="sum-tile">
        <div class="stl">${icon("file")} Files changed</div>
        <div class="stv">${stats.files}</div>
      </div>
      <div class="sum-tile">
        <div class="stl">${icon("robot")} Agent</div>
        <div class="stv" style="font-size:12px">${
          agent === undefined ? "" : agentFace(agent, 28)
        }${esc(agent?.name ?? changeSet.taskId ?? "—")}</div>
      </div>
      <div class="sum-tile">
        <div class="stl">${icon("clock")} Time elapsed</div>
        <div class="stv">${esc(runtime)}</div>
      </div>
    </div>

    <div class="pop-block">
      <h4>Change overview</h4>
      <p>${esc(changeSet.agentExplanation || "No explanation was recorded.")}</p>
    </div>

    <div class="pop-block">
      <h4>Files changed</h4>
      ${changeSet.patches
        .slice(0, 8)
        .map((patch) => {
          const flag = FLAG_FOR_STATUS[patch.status] ?? "M";
          const each = patchStats(patch.patch);
          return `<div class="sum-file">
            <b class="flag-${flag}">${flag}</b>
            <span class="sf-name" title="${esc(patch.path)}">${esc(
              patch.path.split("/").pop(),
            )}</span>
            <span class="sf-kind"><span class="delta-add">+${each.additions}</span>
              <span class="delta-del">-${each.deletions}</span></span>
          </div>`;
        })
        .join("")}
      ${
        changeSet.patches.length > 8
          ? `<div class="sum-file"><span class="sf-kind">+${
              changeSet.patches.length - 8
            } more</span></div>`
          : ""
      }
    </div>

    <div class="pop-block">
      <h4>Tests</h4>
      ${
        tests.length === 0 && commands.length === 0
          ? `<p>No validation has run for this changeset yet.</p>`
          : `<p>
              ${
                tests.length > 0
                  ? `<span class="delta-add">${passed} passed</span>
                     <span class="delta-del" style="margin-left:10px">${failed} failed</span>`
                  : commands
                      .map(
                        (command) =>
                          `<span class="${
                            command.exitCode === 0 ? "delta-add" : "delta-del"
                          }" style="margin-right:10px">${esc(
                            command.command?.label ?? "command",
                          )}</span>`,
                      )
                      .join("")
              }
            </p>`
      }
    </div>

    <div class="sum-actions">
      <button class="btn btn-sm" data-act="sum-tests">${icon("play")} Run tests</button>
      <button class="btn btn-sm" data-act="sum-terminal">${icon("terminal")} Open terminal</button>
      <button class="btn btn-sm" data-act="sum-diff">${icon("columns")} View full diff</button>
    </div>`;
}

/* ------------------------------------------------------------ actions ---- */

export function openFile(path, rerender) {
  if (!state.openTabs.includes(path)) {
    state.openTabs = [...state.openTabs, path];
  }
  state.activeTab = path;
  rerender();
  if (patchFor(path) === undefined && !state.fileCache.has(path)) {
    void loadFile(path, rerender);
  }
}

export function closeFile(path, rerender) {
  const index = state.openTabs.indexOf(path);
  state.openTabs = state.openTabs.filter((entry) => entry !== path);
  if (state.activeTab === path) {
    state.activeTab =
      state.openTabs[Math.min(index, state.openTabs.length - 1)] ?? "";
  }
  rerender();
}

async function loadFile(path, rerender) {
  const repository = currentRepository();
  if (repository === undefined) {
    return;
  }
  const project = encodeURIComponent(state.projectId);
  const repo = encodeURIComponent(repository.id);
  const response = await apiOptional(
    `/projects/${project}/repositories/${repo}/workspace/file?path=${encodeURIComponent(
      path,
    )}`,
    { file: undefined },
  );
  state.fileCache.set(
    path,
    response.file ?? {
      content: "This file is not available in your workspace.",
      binary: false,
    },
  );
  rerender();
}

export function toggleDirectory(path, rerender) {
  if (state.expanded.has(path)) {
    state.expanded.delete(path);
  } else {
    state.expanded.add(path);
  }
  rerender();
}

export function setDiffMode(mode, rerender) {
  state.diffMode = mode;
  persist("ag.diffMode", mode);
  rerender();
}

/** Runs the project's validation commands in the user's sandboxed overlay. */
export async function runTests() {
  const repository = currentRepository();
  if (repository === undefined) {
    return;
  }
  // The commands live on the control-plane host's project config, which the
  // browser never sees; the ones a run already executed are the real record.
  const recorded = (state.runDetail?.integrations ?? []).flatMap(
    (integration) => integration.validation ?? [],
  );
  const first = recorded[0]?.command;
  if (first === undefined) {
    toast("No validation command has run for this repository yet", "error");
    return;
  }
  const line = [first.executable, ...(first.args ?? [])].join(" ");
  toast(`Running ${first.label ?? line}…`);
  try {
    const project = encodeURIComponent(state.projectId);
    const repo = encodeURIComponent(repository.id);
    const response = await api(
      `/projects/${project}/repositories/${repo}/workspace/exec`,
      { method: "POST", body: { command: line } },
    );
    const result = response.result ?? {};
    toast(
      result.exitCode === 0
        ? `${first.label ?? "Validation"} passed`
        : `${first.label ?? "Validation"} exited ${result.exitCode}`,
      result.exitCode === 0 ? "ok" : "error",
    );
  } catch (error) {
    toast(error.message, "error");
  }
}

export function toggleChat(rerender) {
  state.chatOpen = !state.chatOpen;
  persist("ag.chatOpen", state.chatOpen);
  rerender();
}

export function codeHistoryHtml() {
  const runs = state.runs
    .filter((run) => run.repositoryId === currentRepository()?.id)
    .slice(0, 10);
  if (runs.length === 0) {
    return `<p style="color:var(--text-3);font-size:12.5px">No promotions recorded yet.</p>`;
  }
  return `<div>${runs
    .map(
      (run) => `<div class="act-row">
        <span class="act-time">${esc(clockTime(run.startedAt))}</span>
        <span class="act-icon" style="color:var(--accent-bright)">${icon("git")}</span>
        <span><div class="act-title">${esc(run.scenario ?? "Run")}</div>
        <div class="act-sub">${esc(run.status ?? "")}</div></span>
        <span></span>
      </div>`,
    )
    .join("")}</div>`;
}
