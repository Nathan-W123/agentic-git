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
  api,
  collaborators,
  currentUserName,
  isFavourite,
  loadContext,
  persist,
  state,
} from "./data.js";
import {
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
          <span>${esc(repo.id)}</span>
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
      <button class="repo-action" data-act="repo-connect">
        <span class="ra-icon">${icon("link")}</span>
        <span>
          <b>Connect external repository</b>
          <span>Connect a GitHub, GitLab, or Bitbucket repository.</span>
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
          { value: "grid", label: "▦" },
          { value: "list", label: "☰" },
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
    await api(
      `/projects/${encodeURIComponent(state.projectId)}/repositories`,
      {
        method: "POST",
        body: {
          id: values.name.trim(),
          mode: "create",
          branch: values.branch?.trim() || "main",
        },
      },
    );
    toast(`Created ${values.name.trim()}`, "ok");
    await loadContext();
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function connectRepository(rerender) {
  const values = await showModal({
    title: "Connect external repository",
    subtitle:
      "The repository is imported once into canonical. Credentials come from the control plane's environment, never the browser.",
    confirm: "Connect",
    body: `<label class="field">
        <span>Repository</span>
        <input class="input" name="remote" placeholder="owner/name or https://…" required>
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
    await api(
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
    toast("Repository connected", "ok");
    await loadContext();
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function syncRepositoryFromGitHub(repositoryId, rerender) {
  toast("Syncing from GitHub…");
  try {
    const result = await api(
      `/projects/${encodeURIComponent(state.projectId)}/repositories/${encodeURIComponent(repositoryId)}/sync`,
      { method: "POST", body: {} },
    );
    const sync = result.sync ?? {};
    const moved = `${String(sync.previousRevision ?? "").slice(0, 8)} → ${String(
      sync.revision ?? "",
    ).slice(0, 8)}`;
    toast(
      sync.status === "already_current"
        ? "Already up to date with GitHub"
        : sync.status === "fast_forwarded"
          ? `Synced from GitHub (${moved})`
          : `Synced from GitHub — local work and GitHub's merged (${moved})`,
      "ok",
    );
    await loadContext();
    rerender();
  } catch (error) {
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
