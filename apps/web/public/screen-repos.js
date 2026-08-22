/**
 * Repository selector — the landing screen once a session exists.
 *
 * The product is cloud-based: a repository is attached to the control plane
 * once and everyone works against that same canonical copy. So this screen
 * lists what the project already has and offers the two ways to add one; it
 * deliberately has no clone or per-user fetch affordance. The one remote
 * operation it does offer is "Sync from GitHub", and that is repository
 * management rather than a working-copy pull: it moves the shared canonical
 * copy up to date with the origin it was imported from, which is what
 * unblocks pushing after pull requests merge on GitHub.
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
} from "./data.js";
import {
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

export function renderRepositories() {
  const repositories = visibleRepositories();
  const region = state.health?.region ?? "control plane";
  const secure = window.location.protocol === "https:";

  return `<div class="scroll"><div class="page">
    <div class="page-head">
      <div>
        <h1>Connect to a repository</h1>
        <p>Work in the same live codebase as your team and agents.</p>
      </div>
    </div>

    <div class="repo-actions">
      <button class="repo-action accent" data-act="repo-create">
        <span class="ra-icon">${icon("cloud")}</span>
        <span>
          <b>Create new repository</b>
          <span>Create a new cloud repository and start coding.</span>
        </span>
        <span class="ra-chev">${icon("chevronRight")}</span>
      </button>
      <button class="repo-action accent-2" data-act="repo-connect">
        <span class="ra-icon">${icon("link")}</span>
        <span>
          <b>Import from GitHub</b>
          <span>Import an existing GitHub repository and its history.</span>
        </span>
        <span class="ra-chev">${icon("chevronRight")}</span>
      </button>
    </div>

    <div class="filter-row">
      ${searchBox("Search repositories...", state.repoQuery, "repo-search")}
      ${selectBox(
        "repo-sort",
        [
          // "Last opened" was a lie: nothing records opens, and this orders by
          // the newest run or task the repository has.
          { value: "recent", label: "Recent activity" },
          { value: "name", label: "Name" },
        ],
        state.repoSort,
      )}
      ${segmented(
        "repo-view",
        [
          { value: "grid", label: "Grid view", iconName: "grid" },
          { value: "list", label: "List view", iconName: "list" },
        ],
        state.repoView,
      )}
    </div>

    <h2 class="section-title">Your connected repositories</h2>
    ${
      repositories.length === 0
        ? emptyState(
            "folder",
            state.repositories.length === 0
              ? "No repositories yet"
              : "Nothing matches that search",
            state.repositories.length === 0
              ? "Create a cloud repository, or connect one you already have. Everyone on the project works against the same canonical copy."
              : "Try a different name or branch.",
          )
        : `<div class="repo-grid ${state.repoView === "list" ? "list" : ""}">
            ${repositories.map(repositoryCard).join("")}
            ${
              // The same trailing tile the agent deck ends with: the grid says
              // what it holds and how to add one more to it, rather than
              // sending the reader back up to the buttons above.
              state.repoView === "list"
                ? ""
                : addTile({
                    title: "Add repository",
                    subtitle: "Create one, or import from GitHub",
                    act: "repo-create",
                  })
            }
          </div>`
    }

    <div class="info-strip">
      <div class="is-cell">
        <span class="is-icon">${icon("globe")}</span>
        <span><div class="is-label">Region</div>
        <div class="is-value">${esc(region)}</div></span>
      </div>
      <div class="is-cell">
        <span class="is-icon">${icon("shield")}</span>
        <span><div class="is-label">Security</div>
        <div class="is-value">${secure ? "Encrypted" : "Loopback"}</div></span>
      </div>
      <div class="is-cell">
        <span class="is-icon">${icon("sync")}</span>
        <span><div class="is-label">Sync status</div>
        <div class="is-value">Real-time</div></span>
      </div>
    </div>
  </div></div>`;
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
      "The repository and its history are imported into Lattice. Credentials stay in the control plane, never the browser.",
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

export async function syncRepositoryFromGitHub(repositoryId, rerender, resolve) {
  toast("Syncing from GitHub…");
  try {
    const result = await api(
      `/projects/${encodeURIComponent(state.projectId)}/repositories/${encodeURIComponent(repositoryId)}/sync`,
      { method: "POST", body: resolve === undefined ? {} : { resolve } },
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
              `${sync.resolved.side === "remote" ? "GitHub's" : "this project's"} side (${moved})`
            : `Synced from GitHub — local work and GitHub's merged (${moved})`,
      "ok",
    );
    await loadContext();
    rerender();
  } catch (error) {
    // A collision is a question, not a failure: the same files changed on
    // both sides, and only a person can say which version survives. Asked
    // here rather than reported, because the alternative — the remedies the
    // refusal used to list — is not reachable from a phone at all.
    if (error.code === "sync_conflict") {
      const choice = await showModal({
        title: "Both sides changed the same files",
        subtitle:
          "Pick which version wins for those files. Everything else merges " +
          "normally, and the version you don't pick stays in the history.",
        confirm: "Take GitHub's version",
        cancel: "Keep this project's",
        body: `<p class="modal-hint">${esc(error.message)}</p>`,
      });
      if (choice === undefined) {
        // Cancel is the second answer here, not a way out — the dialog's
        // two buttons are the two sides. Nothing has changed yet either way.
        const keep = await showModal({
          title: "Keep this project's version?",
          subtitle: "For the clashing files only.",
          confirm: "Keep this project's version",
          body: `<p class="modal-hint">GitHub's version of those files stays
            in the history and in the merge, but this project's content is
            what the files hold afterwards.</p>`,
        });
        if (keep !== undefined) {
          await syncRepositoryFromGitHub(repositoryId, rerender, "prefer-local");
        }
        return;
      }
      await syncRepositoryFromGitHub(repositoryId, rerender, "prefer-remote");
      return;
    }
    toast(error.message, "error");
  }
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

export function repositoryOwnerLabel() {
  return currentUserName();
}
