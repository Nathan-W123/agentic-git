/**
 * Lattice — control room entry point.
 *
 * The shell, the router, and the one delegated event listener live here;
 * every screen is a module that returns markup. Rendering is whole-screen and
 * synchronous: state changes, the router re-renders, and nothing has to
 * remember which nodes it owns. The screens are small enough that this is
 * cheaper than tracking mutations, and it removes an entire class of
 * stale-DOM bug.
 */

import {
  PALETTE,
  api,
  closeSocket,
  connectSocket,
  currentRepository,
  currentUserId,
  currentUserName,
  loadContext,
  loadHealth,
  loadProviders,
  markRead,
  myAccent,
  myAgentColor,
  myAgents,
  notifications,
  persist,
  isFavourite,
  channelAgentsFor,
  activeChannelId,
  closeChannelFile,
  loadChannelFile,
  saveChannelFile,
  ensureChannelMessages,
  ensureChannelRoster,
  ensureRepositoryGrants,
  refreshChannelMessages,
  addChannelAgent,
  removeChannelAgent,
  removeChannelAgentForUser,
  renameChannelAgent,
  setChannelAgentSetting,
  deleteRepository,
  leaveRepository,
  setRepositoryGrant,
  revokeRepositoryGrant,
  state,
  toggleChannelReaction,
  toggleFavourite,
  unreadCount,
} from "./data.js";
import {
  $,
  $$,
  agentDoodle,
  agentLabelOf,
  avatar,
  brandMark,
  esc,
  icon,
  iconButton,
  emptyState,
  closePopover,
  showMenu,
  showPopover,
  badge,
  relativeTime,
  showModal,
  toast,
} from "./ui.js";
import { ensureAgentOptions, scrollThread, sendChat } from "./chat.js";
import {
  connectRepository,
  createRepository,
  openRepository,
} from "./screen-repos.js";
import {
  closeFile,
  codeHistoryHtml,
  ensureCodeData,
  invalidateCode,
  openFile,
  openWorkspace,
  runTests,
  setDiffMode,
  summaryPopoverHtml,
  toggleChat,
  toggleDirectory,
} from "./screen-code.js";
import {
  cancelTask,
  connectAgent,
  renderAgents,
  retryTask,
  selectAgent,
} from "./screen-agents.js";
import {
  readAll,
  readOne,
  renderNotifications,
} from "./screen-notifications.js";
import {
  INVITE_ROLES,
  acceptInvitation,
  applyProviderSetting,
  createInvitation,
  invitationLink,
  loadInvitations,
  readInvitation,
  revokeInvitation,
  saveAppearance,
} from "./data.js";
import {
  channelInfoPopoverHtml,
  handleComposerKeydown,
  openChannel,
  pickMention,
  renderChats,
  restoreChannelScroll,
  submitComposerMessage,
  submitThreadReply,
  updateComposerInput,
} from "./screen-chats.js";

/* ---------------------------------------------------------- formatting ---- */

function formatDate(value, options = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  if (options.short === true) {
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function shortId(value, length = 10) {
  const text = String(value ?? "");
  return text.length <= length ? text : `${text.slice(0, length)}…`;
}

/* ------------------------------------------------------------- policy ---- */

/**
 * Turns the project policy form into a request body.
 *
 * Every field is optional in the stored policy, and an absent field means
 * "use the built-in default" — so the form has to distinguish empty from
 * zero, and clearing everything must send `null` rather than an empty policy
 * object. Storing `{version: 1}` would look identical in the UI while pinning
 * the project against every future change to those defaults.
 *
 * Kept self-contained deliberately: it is the one piece of this screen with a
 * wire contract behind it, and it is tested by lifting it straight out of
 * this file.
 */
function policyPayload(input) {
  const defaultRiskLevels = ["high", "critical"];
  const approvalsEnabled = input.approvalsEnabled !== false;
  const requireSchemaReview = input.requireSchemaReview !== false;
  const minutes = (raw, label) => {
    const text = String(raw ?? "").trim();
    if (text === "") {
      return undefined;
    }
    const parsed = Number.parseInt(text, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new Error(`${label} must be a whole number of minutes above zero`);
    }
    return parsed * 60000;
  };

  const riskLevels = [...new Set(input.riskLevels ?? [])];
  const protectedPaths = String(input.protectedPaths ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const approvalTimeoutMs = minutes(
    input.approvalTimeoutMinutes,
    "Approval timeout",
  );
  const maxTaskRuntimeMs = minutes(
    input.maxTaskRuntimeMinutes,
    "Max runtime per task",
  );
  const maxProjectRuntimeMsPerDay = minutes(
    input.maxProjectRuntimeMinutesPerDay,
    "Max runtime per day",
  );

  const sameAsDefault =
    riskLevels.length === defaultRiskLevels.length &&
    defaultRiskLevels.every((level) => riskLevels.includes(level));
  const approvals = approvalsEnabled
    ? {
        ...(!requireSchemaReview ? { requireSchemaReview: false } : {}),
        ...(input.requireChangesetReview
          ? { requireChangesetReview: true }
          : {}),
        ...(riskLevels.length > 0 && !sameAsDefault ? { riskLevels } : {}),
        ...(protectedPaths.length > 0 ? { protectedPaths } : {}),
        ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
      }
    : { enabled: false };
  const budgets = {
    ...(maxTaskRuntimeMs === undefined ? {} : { maxTaskRuntimeMs }),
    ...(maxProjectRuntimeMsPerDay === undefined
      ? {}
      : { maxProjectRuntimeMsPerDay }),
  };
  const policy = {
    version: 1,
    ...(Object.keys(approvals).length > 0 ? { approvals } : {}),
    ...(Object.keys(budgets).length > 0 ? { budgets } : {}),
  };
  return Object.keys(policy).length === 1 ? { policy: null } : { policy };
}

/** Milliseconds are the stored unit; minutes are the one people reason in. */
function minutesValue(milliseconds) {
  return typeof milliseconds === "number" && Number.isFinite(milliseconds)
    ? String(Math.round(milliseconds / 60000))
    : "";
}

/* --------------------------------------------------------------- auth ---- */

let authMode = "login";

/**
 * The screen somebody lands on when they open an invite link.
 *
 * Rendered on the auth shell because the recipient usually has no account
 * yet — that is what an invitation is for — so it has to work before there is
 * anything to sign in to.
 */
function renderInvite() {
  const invite = state.invite;
  if (invite === undefined) {
    return `<main class="auth-shell"><div class="auth-box">
      <div class="auth-mascot">${brandMark(54)}
        <div><h1>Checking your invitation…</h1></div></div>
    </div></main>`;
  }
  if (invite.error !== undefined || invite.status !== "pending") {
    const reason =
      invite.error ??
      {
        accepted: "This invitation has already been used.",
        revoked: "This invitation was revoked.",
        expired: "This invitation has expired.",
      }[invite.status] ??
      "This invitation is no longer valid.";
    return `<main class="auth-shell"><div class="auth-box">
      <div class="auth-mascot">${brandMark(54)}
        <div><h1>That link will not work</h1><p>${esc(reason)}</p></div></div>
      <p class="auth-foot">Ask whoever invited you to send a new one.</p>
    </div></main>`;
  }
  return `<main class="auth-shell">
    <div class="auth-box">
      <div class="auth-mascot">${brandMark(54)}
        <div>
          <h1>Join ${esc(invite.organizationName)}</h1>
          <!-- Both names, always. The headline is the team you are joining,
               which is a name somebody chose and may be anything at all — an
               organization called after a product reads as that product
               unless the product says so itself. -->
          <p>You have been invited to
            <b>${esc(invite.organizationName)}</b> on Lattice as a
            ${esc(invite.role)}. Choose a password and you are in.</p>
        </div>
      </div>
      <form class="auth-card" data-act="invite-accept">
        <label class="field">
          <span>Email address</span>
          <input class="input" value="${esc(invite.email)}" disabled>
        </label>
        <label class="field">
          <span>Your name</span>
          <input class="input" name="displayName" autocomplete="name" required>
        </label>
        <label class="field">
          <span>Choose a password</span>
          <input class="input" name="password" type="password" minlength="12"
            autocomplete="new-password" required placeholder="••••••••••••">
        </label>
        <button class="btn btn-primary btn-wide" type="submit">
          Accept and join
        </button>
        <p class="form-msg" id="auth-msg" role="alert"></p>
      </form>
    </div>
  </main>`;
}

function renderAuth() {
  const setupRequired = state.health?.setupRequired === true;
  const bootstrap = authMode === "bootstrap";
  const register = authMode === "register";
  return `<main class="auth-shell">
    <div class="auth-box">
      <div class="auth-mascot">
        ${brandMark(54)}
        <div>
          <h1>${
            bootstrap
              ? "Set up your control room"
              : register
                ? "Create your account"
                : "Sign in to Lattice"
          }</h1>
          <p>${
            bootstrap
              ? "Create the first owner for this control plane."
              : register
                ? "You get your own team and project to start building in."
                : "One live codebase, coordinated across your team and their agents."
          }</p>
        </div>
      </div>

      <form class="auth-card" data-act="${
        bootstrap ? "bootstrap" : register ? "register" : "login"
      }">
        ${
          bootstrap
            ? `<label class="field"><span>Bootstrap token</span>
                 <input class="input" name="token" type="password" required
                   placeholder="Printed by the control plane at startup"></label>
               <label class="field"><span>Your name</span>
                 <input class="input" name="displayName" autocomplete="name" required></label>
               <label class="field"><span>Team name</span>
                 <input class="input" name="organizationName" value="Local team" required></label>`
            : register
              ? `<label class="field"><span>Your name</span>
                   <input class="input" name="displayName" autocomplete="name" required></label>
                 <label class="field"><span>Team name <span class="field-optional">optional</span></span>
                   <input class="input" name="organizationName"
                     placeholder="Defaults to your name"></label>`
              : ""
        }
        <label class="field">
          <span>Email address</span>
          <input class="input" name="email" type="email" autocomplete="username"
            placeholder="you@company.com" required>
        </label>
        <label class="field">
          <span>Password</span>
          <input class="input" name="password" type="password" minlength="12"
            autocomplete="${bootstrap || register ? "new-password" : "current-password"}"
            placeholder="••••••••••••" required>
        </label>

        ${
          bootstrap || register
            ? ""
            : // No "remember me": sessions run to a fixed server-side lifetime and
              // there is no per-login control over it, so the checkbox could
              // only ever have been decoration.
              `<p class="auth-hint">Forgotten your password? Your organization
                owner can reset it.</p>`
        }

        <button class="btn btn-primary btn-wide" type="submit">
          ${
            bootstrap
              ? "Create control room"
              : register
                ? "Create account"
                : "Sign in"
          }
        </button>

        <p class="form-msg" id="auth-msg" role="alert"></p>
      </form>

      <p class="auth-foot">${
        setupRequired && !bootstrap
          ? `This control plane has no owner yet. <a class="link-muted" href="#" data-act="auth-mode" data-value="bootstrap">Run first-time setup</a>.`
          : bootstrap
            ? `Already have an account? <a class="link-muted" href="#" data-act="auth-mode" data-value="login">Sign in</a>.`
            : register
              ? `Already have an account? <a class="link-muted" href="#" data-act="auth-mode" data-value="login">Sign in</a>.`
              : `New here? <a class="link-muted" href="#" data-act="auth-mode" data-value="register">Create an account</a>.`
      }</p>
    </div>
  </main>`;
}

async function submitLogin(form) {
  const data = new FormData(form);
  try {
    await api("/auth/login", {
      method: "POST",
      body: {
        email: String(data.get("email") ?? ""),
        password: String(data.get("password") ?? ""),
      },
    });
    await boot();
  } catch (error) {
    $("#auth-msg").textContent = error.message;
  }
}

async function submitBootstrap(form) {
  const data = new FormData(form);
  try {
    // The one-time token authenticates the request itself, so it travels as a
    // header rather than as part of the record being created.
    await api("/auth/bootstrap", {
      method: "POST",
      headers: { "X-Bootstrap-Token": String(data.get("token") ?? "") },
      body: {
        displayName: String(data.get("displayName") ?? ""),
        organizationName: String(data.get("organizationName") ?? ""),
        email: String(data.get("email") ?? ""),
        password: String(data.get("password") ?? ""),
      },
    });
    authMode = "login";
    await boot();
  } catch (error) {
    $("#auth-msg").textContent = error.message;
  }
}

/**
 * Signs somebody up and drops them straight inside.
 *
 * The response sets the session cookie, so there is no second login step: the
 * point of registering is to arrive, and sending a person who has just chosen
 * a password back to a form asking for it is the kind of seam that makes an
 * app feel unfinished. `boot()` then lands them on their own — empty — project,
 * which is where creating a repository starts.
 */
async function submitRegister(form) {
  const data = new FormData(form);
  const organizationName = String(data.get("organizationName") ?? "").trim();
  try {
    await api("/auth/register", {
      method: "POST",
      body: {
        displayName: String(data.get("displayName") ?? ""),
        email: String(data.get("email") ?? ""),
        password: String(data.get("password") ?? ""),
        // Omitted rather than sent empty, so the server picks its default
        // instead of naming a team the empty string.
        ...(organizationName === "" ? {} : { organizationName }),
      },
    });
    authMode = "login";
    window.location.hash = "#chats";
    await boot();
  } catch (error) {
    $("#auth-msg").textContent = error.message;
  }
}

/* -------------------------------------------------------------- shell ---- */

const NAV = [
  // Chats is the landing view now, so its icon — a chat bubble rather than a
  // house — is the leftmost, primary item in the rail.
  { route: "chats", label: "Chats", iconName: "chatBubble" },
  { route: "agents", label: "My Agents", iconName: "robot" },
  { route: "notifications", label: "Notifications", iconName: "bell" },
  { route: "settings", label: "Settings", iconName: "gear" },
];

function sidebar() {
  const repository = currentRepository();
  const unread = unreadCount();
  const user = currentUserName();
  const email = state.principal?.user?.email ?? "";

  return `<aside class="sidebar">
    <a class="brand" href="#chats">
      ${brandMark(34)}
      <span class="brand-text"><b>Lattice</b><span>Coordinator</span></span>
    </a>

    ${
      repository === undefined
        ? "<div></div>"
        : `<button class="repo-switch" data-act="repo-switch">
            ${icon("cloud")}
            <span class="rs-body">
              <span class="rs-name">${esc(repository.id)}</span>
              <span class="rs-branch">${icon("branch")}${esc(
                repository.branch ?? "main",
              )}</span>
            </span>
            ${icon("chevronDown")}
          </button>`
    }

    <nav class="nav">
      ${NAV.filter(
        (item) => item.needsRepo !== true || repository !== undefined,
      )
        .map(
          (item) => `<a class="nav-item${
            state.route === item.route ? " active" : ""
          }" href="#${item.route}" data-act="nav" data-value="${item.route}">
            ${icon(item.iconName)}
            <span>${esc(item.label)}</span>
            ${
              item.route === "notifications" && unread > 0
                ? `<span class="count">${unread}</span>`
                : ""
            }
          </a>`,
        )
        .join("")}
    </nav>

    <div class="sidebar-foot">
      <button class="user-card" data-act="user-menu">
        ${avatar(user, 32)}
        <span class="uc-body">
          <span class="uc-name">${esc(user)}</span>
          <span class="uc-mail">${esc(email)}</span>
        </span>
        ${icon("chevronDown")}
      </button>
      <div class="plan-card">
        ${icon("cloud")}
        <span class="pc-body">
          <span class="pc-title">${esc(state.project?.name ?? "Project")}</span>
          <span class="pc-sub">Cloud mode</span>
        </span>
        <span class="pc-star">${icon("star")}</span>
      </div>
      <button class="nav-item" data-act="invite" style="margin-bottom:4px">
        ${icon("users")}<span>Invite someone</span>
      </button>
      <div class="sys-line">
        <span class="dot ${state.health === undefined ? "grey" : "green"}"></span>
        ${state.health === undefined ? "Control plane unreachable" : "All systems operational"}
      </div>
    </div>
  </aside>`;
}

function topbar() {
  const unread = unreadCount();
  const user = currentUserName();
  return `<header class="topbar">
    <button class="icon-btn menu-btn" data-act="nav-toggle" title="Menu"
      aria-label="Menu">${icon("menu")}</button>
    <span class="spacer"></span>
    <span class="health"><span class="dot green pulse"></span>All systems operational</span>
    <button class="icon-btn bell" data-act="nav" data-value="notifications"
      title="Notifications" aria-label="Notifications">
      ${icon("bell")}${unread > 0 ? `<span class="dot-badge">${unread}</span>` : ""}
    </button>
    <button data-act="user-menu" title="${esc(user)}">${avatar(user, 32)}</button>
  </header>`;
}

/* ----------------------------------------------------------- settings ---- */

function settingsScreen() {
  const project = state.project;
  const policy = project?.policy ?? {};
  const approvals = policy.approvals ?? {};
  const budgets = policy.budgets ?? {};
  const repository = currentRepository();
  return `<div class="scroll"><div class="page">
    <div class="page-head">
      <span class="ph-icon">${icon("gear")}</span>
      <div><h1>Settings</h1><p>Project policy, repository, and your account.</p></div>
    </div>

    <div class="settings-grid">
      ${invitationsCard()}

      ${appearanceCard()}

      <section class="card">
        <div class="panel-head"><div><h3>Approval policy</h3>
          <p>What must stop for a person before it reaches canonical</p></div></div>
        <form data-act="policy-save">
          <div class="set-row">
            <span class="sr-body">
              <div class="sr-title">Human approval</div>
              <div class="sr-sub">Gate risky plans and changesets on a reviewer.</div>
            </span>
            <span class="sr-ctl">
              <button type="button" class="switch${
                approvals.enabled === false ? "" : " on"
              }" data-act="toggle" data-field="approvalsEnabled"
                aria-label="Human approval"></button>
              <input type="hidden" name="approvalsEnabled"
                value="${approvals.enabled === false ? "false" : "true"}">
            </span>
          </div>
          <div class="set-row">
            <span class="sr-body">
              <div class="sr-title">Review schema changes</div>
              <div class="sr-sub">Pause whenever a plan touches a schema.</div>
            </span>
            <span class="sr-ctl">
              <button type="button" class="switch${
                approvals.requireSchemaReview === false ? "" : " on"
              }" data-act="toggle" data-field="requireSchemaReview"
                aria-label="Review schema changes"></button>
              <input type="hidden" name="requireSchemaReview"
                value="${approvals.requireSchemaReview === false ? "false" : "true"}">
            </span>
          </div>
          <div class="set-row">
            <span class="sr-body">
              <div class="sr-title">Protected paths</div>
              <div class="sr-sub">One glob per line. Changes here always need review.</div>
            </span>
          </div>
          <div style="padding:0 17px 14px">
            <textarea class="input" name="protectedPaths" rows="3"
              placeholder="infrastructure/**">${esc(
                (approvals.protectedPaths ?? []).join("\n"),
              )}</textarea>
          </div>
          <div class="set-row">
            <span class="sr-body">
              <div class="sr-title">Approval timeout</div>
              <div class="sr-sub">Minutes before an unanswered request expires.</div>
            </span>
            <span class="sr-ctl">
              <input class="input" name="approvalTimeoutMinutes" style="width:110px"
                value="${esc(minutesValue(approvals.approvalTimeoutMs))}"
                placeholder="Default">
            </span>
          </div>
          <div class="set-row">
            <span class="sr-body">
              <div class="sr-title">Task runtime budget</div>
              <div class="sr-sub">Minutes one task may run before it is stopped.</div>
            </span>
            <span class="sr-ctl">
              <input class="input" name="maxTaskRuntimeMinutes" style="width:110px"
                value="${esc(minutesValue(budgets.maxTaskRuntimeMs))}"
                placeholder="Unlimited">
            </span>
          </div>
          <div class="set-row">
            <span class="sr-ctl"><button class="btn btn-primary" type="submit">
              Save policy</button></span>
          </div>
        </form>
      </section>

      <section class="card">
        <div class="panel-head"><div><h3>Repository</h3>
          <p>Canonical state is owned by the control plane</p></div></div>
        <div class="set-row">
          <span class="sr-body">
            <div class="sr-title">${esc(repository?.id ?? "No repository open")}</div>
            <div class="sr-sub">${esc(
              repository?.remoteUrl ?? "No remote recorded",
            )}. Publishing canonical to a remote branch is a CLI operation;
            there is no HTTP route for it, so this is not a button.</div>
          </span>
          <span class="sr-ctl">
            <code class="hint-code">coord repo push</code>
          </span>
        </div>
        <div class="set-row">
          <span class="sr-body">
            <div class="sr-title">Canonical branch</div>
            <div class="sr-sub">Git commits remain in Repository History; there is no
              direct branch or reset access outside the pipeline.</div>
          </span>
          <span class="sr-ctl">${esc(repository?.branch ?? "—")}</span>
        </div>
      </section>

      <section class="card">
        <div class="panel-head"><div><h3>Your agents</h3>
          <p>Personal connections; other collaborators cannot see them</p></div></div>
        ${
          state.providers.length === 0
            ? `<div class="set-row"><span class="sr-body">
                <div class="sr-sub">No provider connections are available on this
                deployment.</div></span></div>`
            : state.providers
                .map(
                  (provider) => {
                    // "Connected" has meant two different things here, and the
                    // difference is the whole point of per-user accounts: a
                    // provider reads as connected whenever *this machine's*
                    // CLI is signed in, which is somebody else's account for
                    // everyone but the person who set the host up. Offering
                    // "Disconnect" in that state hid the connect flow behind a
                    // button that did the opposite — there was no way to
                    // attach your own account at all.
                    //
                    // So the control follows the user's own credential, not
                    // the machine's, and the subtitle says which is in use.
                    const mine = provider.ownCredential !== undefined;
                    const hostAccount = provider.connected && !mine;
                    // Stored is not the same as working. A sign-in that has
                    // stopped authenticating still sits in the vault, so
                    // without this the row said "connected" while every task
                    // the agent was given failed.
                    const broken = provider.ownCredential?.unusableReason;
                    return `<div class="set-row">
                    <span class="sr-body">
                      <div class="sr-title">${esc(provider.name ?? provider.id)}</div>
                      <div class="sr-sub">${esc(
                        broken !== undefined && broken !== ""
                          ? broken
                          : mine
                            ? (provider.model ?? "Connected as you")
                            : hostAccount
                              ? "Using this machine's account — connect your own"
                              : "Not connected",
                      )}</div>
                    </span>
                    <span class="sr-ctl">
                      <button class="btn btn-sm" data-act="${
                        mine && (broken === undefined || broken === "")
                          ? "agent-disconnect"
                          : "agent-connect"
                      }" data-value="${esc(provider.id)}">
                        ${
                          broken !== undefined && broken !== ""
                            ? "Reconnect"
                            : mine
                              ? "Disconnect"
                              : hostAccount
                                ? "Connect yours"
                                : "Connect"
                        }
                      </button>
                    </span>
                  </div>`;
                  },
                )
                .join("")
        }
      </section>

      <section class="card">
        <div class="panel-head"><div><h3>Account</h3></div></div>
        <div class="set-row">
          <span class="sr-body">
            <div class="sr-title">${esc(currentUserName())}</div>
            <div class="sr-sub">${esc(state.principal?.user?.email ?? "")}</div>
          </span>
          <span class="sr-ctl">
            <button class="btn btn-sm" data-act="logout">${icon("logout")} Sign out</button>
          </span>
        </div>
      </section>
    </div>
  </div></div>`;
}

/**
 * Colour choices.
 *
 * Two separate decisions that happen to share a picker. The interface accent
 * is a personal preference and changes nothing for anyone else. The agent
 * colour is an identity: it is stored on the account, travels with every one
 * of that person's agents, and is what colleagues read on the coordinator's
 * shared views — so the copy has to say so, or people will assume it is
 * decoration and pick the same colour as everyone else.
 */
function appearanceCard() {
  const accent = myAccent();
  const agentColor = myAgentColor();
  const swatches = (act, current) =>
    PALETTE.map(
      (entry) => `<button type="button" class="swatch${
        entry.value === current ? " on" : ""
      }" data-act="${act}" data-value="${esc(entry.value)}"
        style="--swatch:${esc(entry.value)}" title="${esc(entry.label)}"
        aria-pressed="${entry.value === current}"
        aria-label="${esc(entry.label)}"></button>`,
    ).join("");

  return `<section class="card">
    <div class="panel-head"><div><h3>Appearance</h3>
      <p>How Lattice looks to you, and how your agents look to everyone</p></div></div>

    <div class="set-row">
      <span class="sr-body">
        <div class="sr-title">Primary colour</div>
        <div class="sr-sub">Accents, highlights, and the active state across the
          interface. Only you see this.</div>
      </span>
    </div>
    <div style="padding:0 17px 16px">
      <div class="swatches">${swatches("set-accent", accent)}</div>
    </div>

    <div class="set-row">
      <span class="sr-body">
        <div class="sr-title">Your agents' colour</div>
        <div class="sr-sub">Every agent you connect is drawn in this colour, on
          shared views too — so your teammates can tell your agents from
          theirs. The doodle says which agent; the colour says whose.</div>
      </span>
    </div>
    <div style="padding:0 17px 16px">
      <div class="swatches">${swatches("set-agent-color", agentColor)}</div>
      <div class="doodle-preview" style="color:${esc(agentColor)}">
        ${["anthropic", "cursor", "openai", "google", "xai", "deepseek"]
          .map(
            (kind) => `<span class="doodle-chip">
              <span class="doodle">${agentDoodle(kind)}</span>
              <b>${esc(agentLabelOf(kind))}</b>
            </span>`,
          )
          .join("")}
      </div>
    </div>
  </section>`;
}

async function saveAppearanceChoice(patch) {
  try {
    await saveAppearance(patch);
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

/* -------------------------------------------------------- invitations ---- */

/**
 * Inviting somebody onto the project.
 *
 * Worth being plain about what this grants: access is held at the
 * organization level, not per repository, so an invitation admits someone to
 * every repository this project has rather than to the one they were invited
 * from. Saying so in the dialog is the difference between a considered choice
 * and a surprise.
 */
/**
 * @param rerender Redraws once the invitation exists.
 * @param repositoryId Named when the invite was started from inside a
 *   channel. That channel *is* the answer to "which repository", so the
 *   picker is replaced by a statement of fact — asking again is asking
 *   somebody to repeat themselves.
 */
async function inviteSomebody(rerender, repositoryId) {
  const fixed = typeof repositoryId === "string" && repositoryId.length > 0;
  const preselected = repositoryId ?? currentRepository()?.id ?? "";
  const values = await showModal({
    title: fixed ? `Invite someone to #${repositoryId}` : "Invite someone to collaborate",
    subtitle: fixed
      ? `They will get access to ${repositoryId}, and nothing else in this project.`
      : "Access is granted per repository. Pick the one to share, or share " +
        "everything if they are joining the team properly.",
    confirm: "Create invite link",
    body: `<label class="field">
        <span>Email address</span>
        <input class="input" name="email" type="email" required
          placeholder="colleague@company.com">
      </label>
      ${
        fixed
          ? `<input type="hidden" name="repositoryId" value="${esc(repositoryId)}">`
          : `<label class="field">
        <span>Repository</span>
        <select class="input" name="repositoryId">
          ${state.repositories
            .map(
              (repo) => `<option value="${esc(repo.id)}"${
                repo.id === preselected ? " selected" : ""
              }>${esc(repo.id)}</option>`,
            )
            .join("")}
          <option value=""${preselected === "" ? " selected" : ""}>
            Every repository in ${esc(state.project?.name ?? "this project")}
          </option>
        </select>
      </label>`
      }
      <label class="field">
        <span>Role</span>
        <select class="input" name="role">
          ${INVITE_ROLES.map(
            (role) => `<option value="${esc(role.value)}">${esc(role.label)} — ${esc(
              role.detail,
            )}</option>`,
          ).join("")}
        </select>
      </label>`,
  });
  if (values === undefined || !values.email?.trim()) {
    return;
  }
  try {
    const created = await createInvitation(
      values.email.trim(),
      values.role,
      values.repositoryId,
    );
    rerender();
    await showInviteLink(created.token, values.email.trim(), values.repositoryId);
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * The link, shown once.
 *
 * The secret is not stored recoverably, so this dialog is the only chance to
 * copy it — which the copy has to say, or somebody will close it and assume
 * they can find it again later.
 */
async function showInviteLink(token, email, repositoryId) {
  const link = invitationLink(token);
  await showModal({
    title: "Send this link",
    subtitle: `${email} will get ${
      repositoryId ? repositoryId : "every repository in this project"
    }. The link works once, within seven days, and is not stored — so this is
      the only time it can be copied.`,
    confirm: "Copy link",
    cancel: "Done",
    body: `<div class="invite-link"><code>${esc(link)}</code></div>`,
  }).then((choice) => {
    if (choice !== undefined) {
      void navigator.clipboard
        ?.writeText(link)
        .then(() => toast("Invite link copied", "ok"))
        .catch(() => toast("Could not copy — select the link instead", "error"));
    }
  });
}

/**
 * Leaving a repository's chat — self-service, and only offered at all when
 * access here is a per-repository grant (see `canLeaveRepository` in
 * data.js). Destructive and hard to undo without someone re-granting access,
 * so it goes through the same confirm-modal shape as deletion below rather
 * than firing on a single click.
 */
async function leaveRepositoryAction(repositoryId) {
  const confirmed = await showModal({
    title: "Leave this chat?",
    subtitle: `You will lose access to ${repositoryId} until someone grants it back.`,
    confirm: "Leave",
  });
  if (confirmed === undefined) {
    return;
  }
  try {
    await leaveRepository(repositoryId);
    closePopover();
    toast(`Left ${repositoryId}`, "ok");
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * Deleting a repository outright.
 *
 * Irreversible: cascades the repository's own channel and grants, and is
 * refused server-side while a task or run still references it. The
 * confirmation says so, rather than reading like an ordinary remove.
 */
async function deleteRepositoryAction(repositoryId) {
  const confirmed = await showModal({
    title: "Delete this repository?",
    subtitle: `This permanently deletes ${repositoryId}, its chat history, and its repository-scoped grants. This cannot be undone.`,
    confirm: "Delete repository",
  });
  if (confirmed === undefined) {
    return;
  }
  try {
    await deleteRepository(repositoryId);
    closePopover();
    toast(`Deleted ${repositoryId}`, "ok");
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * Promoting an existing organization member to repository-scoped co-owner —
 * the same capabilities the repository's creator has there, without
 * touching the member's organization-wide role.
 */
async function promoteRepositoryOwnerAction(repositoryId) {
  const candidates = state.members.filter(
    (member) => member.userId !== currentUserId(),
  );
  if (candidates.length === 0) {
    toast("There is no other organization member to promote.", "error");
    return;
  }
  const values = await showModal({
    title: "Promote a member to co-owner",
    subtitle:
      `Gives full capabilities on ${repositoryId} only — the same the ` +
      `repository's creator has there — without changing their ` +
      "organization-wide role.",
    confirm: "Promote",
    body: `<label class="field">
        <span>Member</span>
        <select class="input" name="userId">
          ${candidates
            .map(
              (member) =>
                `<option value="${esc(member.userId)}">${esc(
                  member.user?.displayName ?? member.user?.email ?? member.userId,
                )}</option>`,
            )
            .join("")}
        </select>
      </label>`,
  });
  if (values === undefined) {
    return;
  }
  try {
    await setRepositoryGrant(repositoryId, values.userId, "owner");
    toast("Promoted to repository co-owner", "ok");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    void ensureRepositoryGrants(repositoryId, refreshChannelInfoPopover);
    refreshChannelInfoPopover();
  }
}

/** Revoking a repository-scoped grant on someone else's behalf. */
async function revokeRepositoryGrantAction(repositoryId, userId) {
  try {
    await revokeRepositoryGrant(repositoryId, userId);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    void ensureRepositoryGrants(repositoryId, refreshChannelInfoPopover);
    refreshChannelInfoPopover();
  }
}

/** Pending and spent invitations, for the Settings screen. */
function invitationsCard() {
  const rows = state.invitations ?? [];
  return `<section class="card">
    <div class="panel-head">
      <div><h3>People</h3><p>Invitations into ${esc(
        state.project?.name ?? "this project",
      )}</p></div>
      <span class="spacer"></span>
      <button class="btn btn-sm btn-primary" data-act="invite">
        ${icon("users")} Invite
      </button>
    </div>
    ${
      rows.length === 0
        ? `<div class="set-row"><span class="sr-body"><div class="sr-sub">
            No invitations yet. An invitation grants one repository by
            default, so sharing something does not hand over everything.
            </div></span></div>`
        : rows
            .map(
              (invite) => `<div class="set-row">
                <span class="sr-body">
                  <div class="sr-title">${esc(invite.email)}</div>
                  <div class="sr-sub">${esc(invite.role)} on ${esc(
                    invite.repositoryId ?? "every repository",
                  )} · invited ${esc(relativeTime(invite.createdAt))}</div>
                </span>
                <span class="sr-ctl">
                  ${badge(invite.status)}
                  ${
                    invite.status === "pending"
                      ? `<button class="btn btn-sm" data-act="invite-revoke"
                          data-value="${esc(invite.id)}">Revoke</button>`
                      : ""
                  }
                </span>
              </div>`,
            )
            .join("")
    }
  </section>`;
}

async function savePolicy(form) {
  const data = new FormData(form);
  try {
    const body = policyPayload({
      approvalsEnabled: data.get("approvalsEnabled") === "true",
      requireSchemaReview: data.get("requireSchemaReview") === "true",
      requireChangesetReview: data.get("requireChangesetReview") === "true",
      protectedPaths: String(data.get("protectedPaths") ?? ""),
      approvalTimeoutMinutes: String(data.get("approvalTimeoutMinutes") ?? ""),
      maxTaskRuntimeMinutes: String(data.get("maxTaskRuntimeMinutes") ?? ""),
    });
    await api(`/projects/${encodeURIComponent(state.projectId)}/policy`, {
      method: "PATCH",
      body,
    });
    toast("Policy saved", "ok");
    await loadContext();
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

/* -------------------------------------------------------------- theme ---- */

/**
 * Pushes the accent into the stylesheet's custom properties.
 *
 * Every accent-coloured surface already reads `--accent`, so one assignment
 * re-themes the whole interface without any component knowing a colour
 * changed. The lighter and washed variants are derived here rather than stored,
 * so a chosen colour cannot drift out of step with its own tints.
 */
function applyTheme() {
  const accent = myAccent();
  const root = document.documentElement.style;
  root.setProperty("--accent", accent);
  root.setProperty("--accent-bright", mix(accent, "#ffffff", 0.32));
  root.setProperty("--accent-dim", mix(accent, "#000000", 0.22));
  root.setProperty("--accent-wash", withAlpha(accent, 0.12));
  root.setProperty("--accent-wash-strong", withAlpha(accent, 0.2));
  root.setProperty("--accent-line", withAlpha(accent, 0.38));
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", accent);
}

function channels(hex) {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
}

function mix(hex, towards, amount) {
  const from = channels(hex);
  const to = channels(towards);
  const parts = from.map((value, index) =>
    Math.round(value + (to[index] - value) * amount),
  );
  return `#${parts.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function withAlpha(hex, alpha) {
  const [red, green, blue] = channels(hex);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/* ------------------------------------------------------------- router ---- */

const ROUTES = new Set([
  "chats",
  "agents",
  "notifications",
  "settings",
]);

function currentAgent() {
  const agents = myAgents();
  return agents.find((agent) => agent.id === state.selectedAgent) ?? agents[0];
}

function screen() {
  switch (state.route) {
    case "agents":
      return renderAgents();
    case "notifications":
      return renderNotifications();
    case "settings":
      return settingsScreen();
    default:
      return renderChats();
  }
}

/**
 * A refresh that failed, said permanently.
 *
 * Everything on screen is a snapshot from the last successful load. When a
 * refresh fails the data silently goes stale, and a toast that clears itself
 * leaves no sign that what you are reading is old.
 */
function banner() {
  if (state.refreshing === true && state.loadError === undefined) {
    return `<div class="banner banner-busy" role="status">
      ${icon("refresh")}<span>Refreshing…</span></div>`;
  }
  if (state.loadError === undefined) {
    return "";
  }
  return `<div class="banner" role="status">
    ${icon("alert")}
    <span>Showing the last data that loaded — this refresh failed:
      ${esc(state.loadError)}</span>
    <span class="spacer"></span>
    <button class="btn btn-sm" data-act="retry-load">Try again</button>
  </div>`;
}

/** Screens that bring their own header do not also get the global topbar. */
const BARE = new Set(["code", "coordinator", "chats"]);

/* --------------------------------------------------------- panel width ---- */

const PANEL_WIDTH_KEY = "ag.panelWidth";
const PANEL_DEFAULT = 340;
const PANEL_MIN = 280;
/**
 * What the conversation keeps no matter how far the panel is pulled open.
 *
 * Nothing. Reserving a strip for the transcript meant the panel stopped short
 * of the window while there was visibly room left, which reads as a bug rather
 * than a guard rail — and somebody reading a long file wants the whole width,
 * not most of it. The channel list stays put, so there is always a way back,
 * and double-clicking the edge restores the default.
 */
const MAIN_MIN = 0;

/**
 * How wide the side panel is allowed to get, right now.
 *
 * Measured rather than assumed, because the channel sidebar collapses on a
 * narrow window and the panel should be allowed to claim the space that frees
 * up rather than stay bounded by a number written for a wide one.
 */
function panelMax() {
  const shell = $(".chats-shell");
  const sidebar = $(".chan-sidebar");
  const available =
    (shell?.clientWidth ?? window.innerWidth) - (sidebar?.offsetWidth ?? 0);
  return Math.max(PANEL_MIN, available - MAIN_MIN);
}

/**
 * Set the panel width on the document element, not the panel.
 *
 * The panel is destroyed and rebuilt on every render — and a render happens on
 * every keystroke, every arriving message, every poll. A width stored on it
 * survives none of those; a custom property on `<html>` survives all of them,
 * and costs no render to change.
 */
function setPanelWidth(px) {
  const clamped = Math.round(Math.min(Math.max(px, PANEL_MIN), panelMax()));
  document.documentElement.style.setProperty("--panel-w", `${clamped}px`);
  return clamped;
}

function rememberPanelWidth(px) {
  try {
    window.localStorage.setItem(PANEL_WIDTH_KEY, String(px));
  } catch {
    /* A browser refusing storage should not break the drag. */
  }
}

function restorePanelWidth() {
  const saved = Number.parseInt(
    window.localStorage.getItem(PANEL_WIDTH_KEY) ?? "",
    10,
  );
  if (Number.isFinite(saved)) {
    document.documentElement.style.setProperty("--panel-w", `${saved}px`);
  }
}

restorePanelWidth();

/**
 * Dragging the panel edge.
 *
 * The move and release listeners go on the window rather than the grip: a
 * render arriving mid-drag replaces the grip, and listeners bound to it would
 * go with it — leaving the pointer captured, the body unselectable, and the
 * drag dead. The window outlives every render this app does.
 */
document.addEventListener("pointerdown", (event) => {
  const grip = event.target.closest?.(".panel-grip");
  if (!grip) {
    return;
  }
  const panel = grip.closest(".thread-panel");
  if (panel === null) {
    return;
  }
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = panel.offsetWidth;
  let latest = startWidth;
  document.body.classList.add("resizing-panel");

  const move = (moveEvent) => {
    // The panel is on the right, so dragging left widens it.
    latest = setPanelWidth(startWidth + (startX - moveEvent.clientX));
  };
  const done = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", done);
    window.removeEventListener("pointercancel", done);
    document.body.classList.remove("resizing-panel");
    rememberPanelWidth(latest);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", done);
  window.addEventListener("pointercancel", done);
});

/** Double-clicking the edge puts it back, for when a drag went too far. */
document.addEventListener("dblclick", (event) => {
  if (event.target.closest?.(".panel-grip")) {
    rememberPanelWidth(setPanelWidth(PANEL_DEFAULT));
  }
});

/* The separator answers the keyboard too, since dragging is not available to
   everyone who needs the panel wider. */
document.addEventListener("keydown", (event) => {
  const grip = event.target.closest?.(".panel-grip");
  if (!grip) {
    return;
  }
  const step = event.shiftKey ? 80 : 20;
  const current = grip.closest(".thread-panel")?.offsetWidth ?? PANEL_DEFAULT;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    rememberPanelWidth(setPanelWidth(current + step));
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    rememberPanelWidth(setPanelWidth(current - step));
  } else if (event.key === "Home") {
    event.preventDefault();
    rememberPanelWidth(setPanelWidth(PANEL_DEFAULT));
  }
});

/**
 * The editor's own keys: indent with Tab, save with Ctrl/Cmd-S.
 *
 * Tab inserting indentation traps the keyboard inside the textarea, so Escape
 * lets it out again — the pair is what makes a code textarea usable without
 * making it a dead end.
 */
document.addEventListener("keydown", (event) => {
  const editor = event.target.closest?.("[data-act='chan-file-edit']");
  if (!editor) {
    return;
  }
  if (event.key === "Escape") {
    editor.blur();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveChannelFile(render).then((saved) => {
      if (saved) {
        invalidateCode();
        render();
      }
    });
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value = `${editor.value.slice(0, start)}  ${editor.value.slice(end)}`;
    editor.selectionStart = start + 2;
    editor.selectionEnd = start + 2;
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }
});

/* A window that got narrower can leave a stored width with nowhere to go. */
window.addEventListener("resize", () => {
  if (state.route === "chats" && $(".thread-panel") !== null) {
    setPanelWidth($(".thread-panel").offsetWidth);
  }
});

/**
 * Unsaved text is worth one question before it disappears.
 *
 * Returns false when the reader decides to keep editing, and the caller then
 * does nothing at all — closing the panel and switching to the diff both throw
 * the draft away.
 */
/**
 * Where the caret was in the editor, across a render it did not ask for.
 *
 * Typing does not re-render, but arriving messages do, and a message landing
 * while somebody edits a file must not move their cursor to the end of it.
 */
function captureEditor() {
  const editor = $("[data-act='chan-file-edit']");
  if (editor === null || document.activeElement !== editor) {
    return undefined;
  }
  return {
    start: editor.selectionStart,
    end: editor.selectionEnd,
    top: editor.scrollTop,
  };
}

function restoreEditor(saved) {
  if (saved === undefined) {
    return;
  }
  const editor = $("[data-act='chan-file-edit']");
  if (editor === null) {
    return;
  }
  editor.focus();
  editor.setSelectionRange(saved.start, saved.end);
  editor.scrollTop = saved.top;
}

function confirmDiscardEdit() {
  if (
    state.chanFileMode !== "edit" ||
    state.chanFileDraft === undefined ||
    state.chanFileDraft === state.chanFileBase
  ) {
    return true;
  }
  return window.confirm(
    `Discard your unsaved changes to ${state.chanFileView}?`,
  );
}

export function render() {
  const root = $("#app-root");
  if (state.principal === undefined) {
    return;
  }
  applyTheme();
  if (!state.loaded) {
    root.innerHTML = `<div class="app"><div class="main">
      <div class="page">${emptyState(
        "cloud",
        "Loading your control room",
        "Fetching projects, repositories, and the coordination stream.",
      )}</div></div></div>`;
    return;
  }
  if (state.projectId === "") {
    root.innerHTML = `<div class="app no-sidebar"><div class="main">
      <div class="scroll"><div class="page">${emptyState(
        "folder",
        "No project yet",
        "This control plane has no project you can see. Ask an owner for access, or create one from the CLI.",
      )}</div></div></div></div>`;
    return;
  }

  const classes = ["app"];
  if (state.navOpen) {
    classes.push("nav-open");
  }
  const editorCaret = captureEditor();
  root.innerHTML = `<div class="${classes.join(" ")}">
    ${sidebar()}
    <div class="main${BARE.has(state.route) ? " bare" : ""}${
      state.loadError === undefined ? "" : " has-banner"
    }">
      ${banner()}
      ${BARE.has(state.route) ? "" : topbar()}
      ${screen()}
    </div>
    ${state.navOpen ? '<div class="nav-scrim" data-act="nav-close"></div>' : ""}
  </div>`;

  // Chats owns this now: the inline file and diff blocks in the transcript are
  // the only place code is read, so the channel has to load its own changeset
  // rather than inherit one a separate Code screen happened to fetch first.
  if (state.route === "chats") {
    // The transcript is replaced on every render, which resets it to the top.
    // Put it back where the reader had it before anything else runs.
    restoreChannelScroll();
    restoreEditor(editorCaret);
    void ensureCodeData(render);
    scrollThread();
  }
  void ensureAgentOptions(state.selectedAgent, () => {
    if (state.route === "code" || state.route === "agents") {
      render();
    }
  });
  if (state.route === "chats") {
    // `activeChannelId`, not the raw field: the screen falls back to the
    // first repository when nothing has been picked, and loading against an
    // empty id meant a channel that rendered fine and never read a single
    // message back from the server.
    void ensureChannelMessages(activeChannelId(), () => {
      if (state.route === "chats") {
        render();
      }
    });
    void ensureChannelRoster(activeChannelId(), () => {
      if (state.route === "chats") {
        render();
      }
    });
    // The roster's model/effort pickers read the same real options My Agents
    // and Code load — loaded here too, rather than invented for this screen.
    for (const agent of channelAgentsFor(state.repositoryId)) {
      if (agent.mine) {
        void ensureAgentOptions(agent.id, () => {
          if (state.route === "chats") {
            render();
          }
        });
      }
    }
  }
}

function navigate(route) {
  // A link or a stored route from before Code and Coordinator were folded into
  // the channel lands here; chats is the landing view, so it is the fallback.
  if (!ROUTES.has(route)) {
    route = "chats";
  }
  state.route = route;
  state.navOpen = false;
  closePopover();
  if (window.location.hash !== `#${route}`) {
    window.location.hash = `#${route}`;
  }
  render();
}

function applyHash() {
  const route = window.location.hash.replace(/^#/u, "") || "chats";
  if (ROUTES.has(route) && route !== state.route) {
    state.route = route;
    render();
  }
}

/* -------------------------------------------------------------- events ---- */

/**
 * Re-renders the channel info popover in place, if it is the one currently
 * open. `showPopover` injects static HTML outside the main app's render
 * tree (see its comment in ui.js), so the whole-screen `render()` a
 * membership change also triggers does not touch it — without this, adding
 * or removing an agent would leave the popover showing a stale roster until
 * it was closed and reopened.
 */
function refreshChannelInfoPopover() {
  const pop = $(".popover");
  if (pop !== null && state.repositoryId) {
    pop.innerHTML = channelInfoPopoverHtml(state.repositoryId);
  }
}

function actionOf(event) {
  const node = event.target.closest("[data-act]");
  return node === null ? undefined : { node, act: node.dataset.act, value: node.dataset.value };
}

document.addEventListener("click", (event) => {
  const found = actionOf(event);
  if (found === undefined) {
    return;
  }
  const { node, act, value } = found;

  /* Anything that is not a link navigation should not also submit a form. */
  if (node.tagName === "BUTTON" && node.type !== "submit") {
    event.preventDefault();
  }

  switch (act) {
    case "nav":
      event.preventDefault();
      navigate(value);
      return;
    case "nav-toggle":
      state.navOpen = !state.navOpen;
      render();
      return;
    case "nav-close":
      state.navOpen = false;
      render();
      return;
    case "auth-mode":
      event.preventDefault();
      authMode = value;
      $("#auth-root").innerHTML = renderAuth();
      return;
    case "forgot":
      event.preventDefault();
      toast("Ask your organization owner to reset the password.");
      return;
    case "logout":
      void api("/auth/logout", { method: "POST", body: {} })
        .catch(() => undefined)
        .then(() => window.location.reload());
      return;

    /* Repositories */
    case "repo-create":
      void createRepository(render);
      return;
    case "repo-connect":
      void connectRepository(render);
      return;
    case "open-repo":
      invalidateCode();
      openRepository(value, navigate);
      return;
    case "repo-switch":
      navigate("chats");
      return;
    case "repo-view":
      state.repoView = value;
      render();
      return;
    case "star":
      toggleFavourite(value);
      render();
      return;
    case "user-menu":
      showMenu(node, [
        { act: "nav", value: "settings", label: "Settings", iconName: "gear" },
        { separator: true },
        { act: "logout", label: "Sign out", iconName: "logout" },
      ]);
      return;
    case "repo-menu":
      showMenu(node, [
        { act: "open-repo", value, label: "Open", iconName: "arrowRight" },
        { act: "invite-repo", value, label: "Invite to this repository…", iconName: "users" },
        {
          act: "star",
          value,
          label: isFavourite(value) ? "Remove from favourites" : "Add to favourites",
          iconName: "star",
        },
        { separator: true },
        { act: "copy-id", value, label: "Copy repository id", iconName: "file" },
      ]);
      return;
    /* Chats */
    case "channel-new":
      showMenu(node, [
        { act: "repo-create", label: "Create new repository", iconName: "cloud" },
        { act: "repo-connect", label: "Connect external repository", iconName: "link" },
      ]);
      return;
    case "channel-open":
      openChannel(value, render);
      return;
    case "channel-mention-key": {
      const input = $("[data-act='channel-input']");
      if (input === null) {
        return;
      }
      const at = input.selectionStart ?? input.value.length;
      state.chatDraft = `${input.value.slice(0, at)}@${input.value.slice(at)}`;
      state.mentionActive = true;
      state.mentionQuery = "";
      state.mentionIndex = 0;
      render();
      const next = $("[data-act='channel-input']");
      next?.focus();
      next?.setSelectionRange(at + 1, at + 1);
      return;
    }
    case "channel-mention-pick":
      pickMention(value, render);
      return;
    case "channel-react":
      toggleChannelReaction(state.repositoryId, value, "👍");
      render();
      return;
    case "channel-thread-open":
      // One panel, one owner: opening a thread puts away an open file.
      if (!confirmDiscardEdit()) {
        return;
      }
      state.activeChannelThread = value;
      closeChannelFile();
      render();
      return;
    case "channel-thread-close":
      state.activeChannelThread = undefined;
      render();
      return;
    // Expanding a file happens where it is read — in the transcript — so this
    // only toggles which paths are open, with no route change to lose the
    // reader's place in the conversation.
    case "chan-file-open":
      // Beside the conversation, not inside it. Opening a file used to expand
      // it in the transcript, which pushed the messages explaining the change
      // off the screen.
      state.chanFileView = value;
      state.activeChannelThread = undefined;
      // Opening a file opens it editable. Making Edit a second click meant the
      // answer to "can I fix this here" was no until you found a tab, which is
      // the wrong default for a file you are already looking at. The diff is
      // still one click away, and is where a file falls back to if it cannot
      // be read from the workspace.
      state.chanFileMode = "edit";
      state.chanFileBase = undefined;
      state.chanFileDraft = undefined;
      state.chanFileError = undefined;
      render();
      void loadChannelFile(value, render);
      return;
    case "chan-file-close":
      if (!confirmDiscardEdit()) {
        return;
      }
      closeChannelFile();
      render();
      return;
    case "chan-file-mode": {
      const mode = node.dataset.mode ?? "diff";
      if (mode === state.chanFileMode) {
        return;
      }
      if (mode === "diff" && !confirmDiscardEdit()) {
        return;
      }
      state.chanFileMode = mode;
      if (mode === "diff") {
        state.chanFileBase = undefined;
        state.chanFileDraft = undefined;
        state.chanFileError = undefined;
        render();
        return;
      }
      render();
      void loadChannelFile(state.chanFileView, render);
      return;
    }
    case "chan-file-reload":
      void loadChannelFile(state.chanFileView, render);
      return;
    case "chan-file-revert":
      state.chanFileDraft = state.chanFileBase;
      render();
      return;
    case "chan-file-save":
      void saveChannelFile(render).then((saved) => {
        if (saved) {
          // The changeset on screen is now out of date by exactly this edit.
          invalidateCode();
          render();
        }
      });
      return;
    case "chan-files-toggle":
      state.chanFilesOpen = !state.chanFilesOpen;
      return;
    case "chan-file-toggle": {
      const open = state.chanOpenFiles ?? [];
      state.chanOpenFiles = open.includes(value)
        ? open.filter((path) => path !== value)
        : [...open, value];
      render();
      return;
    }
    case "channel-rename-toggle":
      state.chatRenamingId = state.chatRenamingId === value ? undefined : value;
      render();
      if (state.chatRenamingId === value) {
        const input = $("[data-act='channel-rename-input']");
        input?.focus();
        input?.select();
      }
      return;
    case "channel-settings-toggle":
      state.chatSettingsOpenId = state.chatSettingsOpenId === value ? undefined : value;
      render();
      return;
    case "channel-info":
      showPopover(node, channelInfoPopoverHtml(value));
      // Grants are fetched lazily, unlike the roster: the panel that reads
      // them only ever shows for someone who can already manage the
      // repository, so most opens of this popover need nothing here.
      void ensureRepositoryGrants(value, refreshChannelInfoPopover);
      return;
    case "channel-agent-add":
      addChannelAgent(state.repositoryId, value);
      render();
      refreshChannelInfoPopover();
      return;
    case "channel-agent-remove":
      removeChannelAgent(state.repositoryId, value);
      render();
      refreshChannelInfoPopover();
      return;
    case "channel-agent-remove-any": {
      // `value` is `${userId}:${provider}` — see `rosterRow` in
      // screen-chats.js, which mints it from the same pair
      // `channelAgentsFor` already attaches to every non-mine entry.
      const separatorIndex = value.indexOf(":");
      removeChannelAgentForUser(
        state.repositoryId,
        value.slice(0, separatorIndex),
        value.slice(separatorIndex + 1),
      );
      render();
      refreshChannelInfoPopover();
      return;
    }
    case "channel-leave":
      void leaveRepositoryAction(value);
      return;
    case "channel-delete-repo":
      void deleteRepositoryAction(value);
      return;
    case "channel-grant-promote":
      void promoteRepositoryOwnerAction(value);
      return;
    case "channel-grant-revoke": {
      // `value` is `${repositoryId}:${userId}` — see `coOwnerPanelHtml` in
      // screen-chats.js.
      const separatorIndex = value.indexOf(":");
      void revokeRepositoryGrantAction(
        value.slice(0, separatorIndex),
        value.slice(separatorIndex + 1),
      );
      return;
    }
    case "channel-msg-search-toggle":
      state.chanMsgSearchOpen = !state.chanMsgSearchOpen;
      if (!state.chanMsgSearchOpen) {
        state.chanMsgQuery = "";
      }
      render();
      if (state.chanMsgSearchOpen) {
        $("[data-act='channel-msg-search']")?.focus();
      }
      return;

    case "files-menu":
      showMenu(node, [
        { act: "files-refresh", label: "Refresh files", iconName: "refresh" },
        { act: "tree-collapse", label: "Collapse all folders", iconName: "chevronUp" },
      ]);
      return;
    case "code-menu":
      showMenu(node, [
        {
          act: "chat-toggle",
          label: state.chatOpen ? "Hide agent chat" : "Show agent chat",
          iconName: "robot",
        },
        {
          act: "diff-mode",
          value: state.diffMode === "split" ? "unified" : "split",
          label: state.diffMode === "split" ? "Unified diff" : "Split diff",
          iconName: "columns",
        },
        { separator: true },
        { act: "files-refresh", label: "Reload from the control plane", iconName: "refresh" },
      ]);
      return;
    case "copy-id":
      void navigator.clipboard
        ?.writeText(value)
        .then(() => toast("Repository id copied", "ok"))
        .catch(() => toast("Could not copy to the clipboard", "error"));
      closePopover();
      return;
    case "tree-collapse":
      state.expanded.clear();
      closePopover();
      render();
      return;
    case "workspace-open":
      void openWorkspace(render);
      return;
    case "retry-load":
      void refresh();
      return;
    case "files-refresh":
      closePopover();
      invalidateCode();
      void refresh();
      return;

    /* Code */
    case "tree-dir":
      toggleDirectory(value, render);
      return;
    case "tree-file":
    case "tab-open":
      openFile(value, render);
      return;
    case "tab-close":
      event.stopPropagation();
      closeFile(value, render);
      return;
    case "diff-mode":
      setDiffMode(value, render);
      return;
    case "code-summary":
      showPopover(node, summaryPopoverHtml(currentAgent()));
      return;
    case "code-history":
      showPopover(
        node,
        `<div class="pop-head"><h3>Repository history</h3><span class="spacer"></span>
          ${iconButton("close", { act: "pop-close", title: "Close", small: true })}</div>
         ${codeHistoryHtml()}`,
        { width: 360 },
      );
      return;
    case "code-search":
      state.treeQuery = state.treeQuery === undefined ? "" : undefined;
      render();
      if (state.treeQuery !== undefined) {
        $("[data-act='tree-search']")?.focus();
      }
      return;
    case "pop-close":
      closePopover();
      return;
    case "sum-tests":
      closePopover();
      void runTests();
      return;
    case "sum-terminal":
      closePopover();
      toast("Terminal commands run in your sandboxed overlay workspace.");
      return;
    case "sum-diff":
      closePopover();
      setDiffMode("split", render);
      return;
    case "chat-close":
    case "chat-toggle":
      toggleChat(render);
      return;

    /* Agents */
    case "agent-pick":
      selectAgent(value, render);
      return;
    case "agent-tab":
      state.agentTab = value;
      render();
      return;
    case "agent-filter":
      state.agentFilter = value;
      render();
      return;
    case "agent-connect":
      void connectAgent(value, render);
      return;
    case "agent-add": {
      // Which agent to connect is the user's decision. Silently picking the
      // first unconnected provider made "Add Agent" a lottery on a screen
      // whose whole subject is which agents are yours.
      // Offered on whether *you* have connected it, not on whether the host
      // machine happens to be signed in. Filtering on `connected` hid every
      // provider the host was logged into, which on a developer's own machine
      // is usually all of them — so "Add agent" reported that everything was
      // already connected while the user had connected nothing.
      const choices = state.providers.filter(
        (entry) => entry.ownCredential === undefined,
      );
      if (choices.length === 0) {
        toast("You have connected every available agent.");
        return;
      }
      showMenu(
        node,
        choices.map((entry) => ({
          act: "agent-connect",
          value: entry.id,
          label: entry.connected
            ? `Connect your own ${agentLabelOf(entry.id)}`
            : `Connect ${agentLabelOf(entry.id)}`,
          iconName: "robot",
        })),
      );
      return;
    }
    case "agent-disconnect":
      void api(`/chat/providers/${encodeURIComponent(value)}`, {
        method: "DELETE",
      })
        .then(() => loadProviders())
        .then(() => {
          toast("Disconnected", "ok");
          render();
        })
        .catch((error) => toast(error.message, "error"));
      return;
    case "agent-switch":
    case "agent-menu": {
      // Was folded in with the navigation cases below, so the three dots on
      // an agent row did nothing except change screen — including on the
      // Agents screen itself, where it changed nothing at all.
      const agent = myAgents().find((entry) => entry.id === value);
      const provider = state.providers.find((entry) => entry.id === value);
      const mine = provider?.ownCredential !== undefined;
      showMenu(node, [
        ...(mine
          ? [
              {
                act: "agent-disconnect",
                value,
                label: `Disconnect ${agentLabelOf(value)}`,
                iconName: "logout",
              },
            ]
          : []),
        {
          act: "agent-connect",
          value,
          label: agent?.needsReconnect === true
            ? `Reconnect ${agentLabelOf(value)}`
            : mine
              ? `Reconnect ${agentLabelOf(value)}`
              : `Connect ${agentLabelOf(value)}`,
          iconName: "robot",
        },
        { act: "agent-usage", value, label: "Usage", iconName: "chart" },
      ]);
      return;
    }
    case "agent-info":
    case "agent-usage":
    case "agent-all":
      navigate("agents");
      return;
    case "task-cancel":
      void cancelTask(value, render);
      return;
    case "task-retry":
      void retryTask(value, render);
      return;

    /* Coordinator */
    case "coord-tab":
      state.coordinatorTab = value;
      render();
      return;
    case "go-notifications":
      navigate("notifications");
      return;
    case "go-code":
      navigate("code");
      return;
    case "go-settings":
      navigate("settings");
      return;

    /* Notifications */
    case "notif-filter":
      state.notificationFilter = value;
      render();
      return;
    case "notif-read-all":
      readAll(render);
      return;
    case "notif-open":
      readOne(value, render);
      return;

    /* People */
    case "invite":
      closePopover();
      void inviteSomebody(render);
      return;
    case "invite-repo":
      closePopover();
      void inviteSomebody(render, value);
      return;
    // The menu on a channel row. Everything in it is already scoped to that
    // channel, which is the point: inviting somebody from inside a room
    // should not then ask which room.
    case "channel-menu":
      showMenu(node, [
        {
          act: "invite-repo",
          value,
          label: `Invite someone to #${value}`,
          iconName: "users",
        },
        { act: "channel-open", value, label: "Open this channel", iconName: "chatBubble" },
      ]);
      return;
    case "invite-revoke":
      void revokeInvitation(value)
        .then(() => {
          toast("Invitation revoked", "ok");
          render();
        })
        .catch((error) => toast(error.message, "error"));
      return;

    /* Settings */
    case "set-accent":
      void saveAppearanceChoice({ accent: value });
      return;
    case "set-agent-color":
      void saveAppearanceChoice({ agentColor: value });
      return;
    case "toggle": {
      const field = node.dataset.field;
      const input = node.parentElement?.querySelector(`input[name="${field}"]`);
      const on = node.classList.toggle("on");
      if (input !== null && input !== undefined) {
        input.value = on ? "true" : "false";
      }
      return;
    }

    /* Composer affordances */
    case "chat-mention": {
      const input = $("[data-act='chat-input']");
      if (input === null) {
        return;
      }
      const at = input.selectionStart ?? input.value.length;
      input.value = `${input.value.slice(0, at)}@${input.value.slice(at)}`;
      input.focus();
      input.setSelectionRange(at + 1, at + 1);
      return;
    }
    default:
  }
});

document.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-act]");
  if (form === null) {
    return;
  }
  event.preventDefault();
  switch (form.dataset.act) {
    case "login":
      void submitLogin(form);
      return;
    case "bootstrap":
      void submitBootstrap(form);
      return;
    case "register":
      void submitRegister(form);
      return;
    case "policy-save":
      void savePolicy(form);
      return;
    case "invite-accept": {
      const data = new FormData(form);
      void acceptInvitation(
        state.inviteToken,
        String(data.get("displayName") ?? ""),
        String(data.get("password") ?? ""),
      )
        .then(async () => {
          state.invite = undefined;
          state.inviteToken = undefined;
          window.location.hash = "#chats";
          await boot();
          toast("Welcome aboard", "ok");
        })
        .catch((error) => {
          const message = $("#auth-msg");
          if (message !== null) {
            message.textContent = error.message;
          }
        });
      return;
    }
    case "chat-submit": {
      const input = $("[data-act='chat-input']", form);
      const agent = currentAgent();
      if (agent === undefined || input === null) {
        return;
      }
      const text = input.value;
      input.value = "";
      void sendChat(agent.id, text, render);
      return;
    }
    case "channel-submit":
      submitComposerMessage(render);
      return;
    case "channel-thread-submit":
      submitThreadReply(render);
      return;
    case "channel-rename-form": {
      const input = $("[data-act='channel-rename-input']", form);
      if (input !== null) {
        renameChannelAgent(state.repositoryId, form.dataset.value, input.value);
      }
      const roleInput = $("[data-act='channel-role-input']", form);
      if (roleInput !== null) {
        setChannelAgentSetting(state.repositoryId, form.dataset.value, "role", roleInput.value.trim());
      }
      state.chatRenamingId = undefined;
      render();
      return;
    }
    default:
  }
});

document.addEventListener("change", (event) => {
  const found = actionOf(event);
  if (found === undefined) {
    return;
  }
  const { node, act } = found;
  switch (act) {
    case "repo-sort":
      state.repoSort = node.value;
      render();
      return;
    case "chat-model":
    case "chat-effort": {
      const agent = currentAgent();
      if (agent === undefined) {
        return;
      }
      const field = act === "chat-model" ? "model" : "effort";
      void applyProviderSetting(agent.id, field, node.value)
        .then(() => render())
        .catch((error) => toast(error.message, "error"));
      return;
    }
    case "channel-agent-model":
    case "channel-agent-effort": {
      // Scoped to the channel rather than calling `applyProviderSetting`: see
      // the comment on `renameChannelAgent` in data.js — this is how the
      // agent presents itself in this room, which is allowed to differ from
      // its account-wide connection settings.
      const agentId = node.closest("[data-agent]")?.dataset.agent;
      if (!agentId) {
        return;
      }
      const field = act === "channel-agent-model" ? "model" : "effort";
      setChannelAgentSetting(state.repositoryId, agentId, field, node.value);
      render();
      return;
    }
    default:
  }
});

document.addEventListener("input", (event) => {
  const found = actionOf(event);
  if (found === undefined) {
    return;
  }
  const { node, act } = found;
  if (act === "repo-search") {
    state.repoQuery = node.value;
    const focused = document.activeElement === node;
    render();
    if (focused) {
      const next = $("[data-act='repo-search']");
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    }
    return;
  }
  if (act === "agent-search") {
    state.agentQuery = node.value;
    const focused = document.activeElement === node;
    render();
    if (focused) {
      const next = $("[data-act='agent-search']");
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    }
    return;
  }
  if (act === "tree-search") {
    state.treeQuery = node.value;
    const focused = document.activeElement === node;
    render();
    if (focused) {
      const next = $("[data-act='tree-search']");
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    }
    return;
  }
  if (act === "chat-input") {
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 148)}px`;
  }
  if (act === "channel-search") {
    state.chatQuery = node.value;
    const focused = document.activeElement === node;
    render();
    if (focused) {
      const next = $("[data-act='channel-search']");
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    }
    return;
  }
  if (act === "channel-msg-search") {
    state.chanMsgQuery = node.value;
    const focused = document.activeElement === node;
    render();
    if (focused) {
      const next = $("[data-act='channel-msg-search']");
      next?.focus();
      next?.setSelectionRange(next.value.length, next.value.length);
    }
    return;
  }
  if (act === "channel-input") {
    updateComposerInput(node, render);
    return;
  }
  if (act === "chan-file-edit") {
    // Deliberately no render. Every other input on this screen rebuilds the
    // whole screen and puts the caret back afterwards, which is affordable for
    // a search box and not for a source file — a thousand-line textarea would
    // be thrown away and re-parsed on each keystroke. The only thing a
    // keystroke changes here is whether there is anything to save, so that is
    // the only thing touched.
    state.chanFileDraft = node.value;
    const dirty = state.chanFileDraft !== state.chanFileBase;
    const panel = node.closest(".file-panel");
    panel?.classList.toggle("dirty", dirty);
    const label = panel?.querySelector(".fp-state");
    if (label !== null && label !== undefined) {
      label.textContent = dirty ? "Unsaved changes" : "No changes";
    }
    for (const button of panel?.querySelectorAll(
      "[data-act='chan-file-save'], [data-act='chan-file-revert']",
    ) ?? []) {
      button.disabled = !dirty;
    }
    return;
  }
  if (act === "channel-thread-input") {
    state.threadDraft = node.value;
    const focused = document.activeElement === node;
    const selStart = node.selectionStart;
    render();
    if (focused) {
      const next = $("[data-act='channel-thread-input']");
      next?.focus();
      next?.setSelectionRange(selStart, selStart);
    }
  }
});

/* Rows that are divs for markup reasons still have to answer the keyboard. */
document.addEventListener("keydown", (event) => {
  const row = event.target.closest?.('[role="button"][data-act]');
  if (row !== null && row !== undefined && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    row.click();
    return;
  }
});

/* Enter sends; Shift+Enter is a newline. */
document.addEventListener("keydown", (event) => {
  const node = event.target;
  if (node?.dataset?.act !== "chat-input") {
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    node.closest("form")?.requestSubmit();
  }
});

/* The channel composer additionally steers the @mention dropdown, so its
   Enter/arrow handling lives with the rest of that feature in screen-chats.js
   rather than duplicating a second "Enter sends" block here. */
document.addEventListener("keydown", (event) => {
  if (event.target?.dataset?.act === "channel-input") {
    handleComposerKeydown(event, render);
  }
});

/* Enter sends a thread reply the same way it sends a channel message. */
document.addEventListener("keydown", (event) => {
  const node = event.target;
  if (node?.dataset?.act !== "channel-thread-input") {
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    node.closest("form")?.requestSubmit();
  }
});

/**
 * Enter commits an in-progress agent rename or role edit, same as blurring
 * the field — both live in the same form (see `rosterRow` in
 * screen-chats.js), so both are handled here.
 */
document.addEventListener("keydown", (event) => {
  const node = event.target;
  const act = node?.dataset?.act;
  if (
    (act === "channel-rename-input" || act === "channel-role-input") &&
    event.key === "Enter"
  ) {
    event.preventDefault();
    node.closest("form")?.requestSubmit();
  }
});

/**
 * A rename or role edit also commits on blur, not only Enter — clicking away
 * from the field should not discard what was typed. `focusout` bubbles where
 * `blur` does not, so this is the one place delegation can catch it.
 *
 * Checked against `relatedTarget` (the element gaining focus) so tabbing
 * from the name field to the role field within the same form does not itself
 * read as "left the form" — without that check, moving focus from one field
 * to the other inside a two-field form would close the form before the
 * second field could ever be edited.
 */
document.addEventListener("focusout", (event) => {
  const node = event.target;
  const act = node?.dataset?.act;
  if (act !== "channel-rename-input" && act !== "channel-role-input") {
    return;
  }
  const form = node.closest("form");
  if (form !== null && form.contains(event.relatedTarget)) {
    return;
  }
  const agentId = node.dataset.value;
  if (state.repositoryId && agentId && state.chatRenamingId === agentId) {
    const nameInput = form === null ? null : $("[data-act='channel-rename-input']", form);
    const roleInput = form === null ? null : $("[data-act='channel-role-input']", form);
    if (nameInput !== null) {
      renameChannelAgent(state.repositoryId, agentId, nameInput.value);
    }
    if (roleInput !== null) {
      setChannelAgentSetting(state.repositoryId, agentId, "role", roleInput.value.trim());
    }
    state.chatRenamingId = undefined;
    render();
  }
});

window.addEventListener("hashchange", applyHash);

/* ---------------------------------------------------------------- boot ---- */

function showAuth() {
  closeSocket();
  $("#app-root").hidden = true;
  $("#auth-root").hidden = false;
  $("#auth-root").innerHTML = renderAuth();
}

function showApp() {
  $("#auth-root").hidden = true;
  $("#app-root").hidden = false;
}

/** Refreshes context, then re-renders whatever screen is showing. */
async function refresh({ quiet = false } = {}) {
  if (!quiet) {
    state.refreshing = true;
    render();
  }
  try {
    await loadContext();
    await loadInvitations();
    invalidateCode();
    render();
  } catch (error) {
    if (error.status === 401) {
      state.principal = undefined;
      showAuth();
      return;
    }
    // Recorded as well as announced: the toast says it happened, the banner
    // keeps saying the screen is stale until a load succeeds.
    state.loadError = error.message;
    render();
    toast(error.message, "error");
  } finally {
    state.refreshing = false;
  }
}

/**
 * An invite link, if this is one.
 *
 * Checked before anything else: somebody arriving with a link has a specific
 * intention, and dropping them on a sign-in form for an account they do not
 * have yet would strand them.
 */
async function handleInviteLink() {
  const match = /^#invite\/(.+)$/u.exec(window.location.hash);
  if (match === null) {
    return false;
  }
  state.inviteToken = match[1];
  state.invite = undefined;
  showInvite();
  try {
    const response = await readInvitation(state.inviteToken);
    state.invite = response.invitation;
  } catch (error) {
    state.invite = { error: error.message, status: "invalid" };
  }
  showInvite();
  return true;
}

function showInvite() {
  closeSocket();
  $("#app-root").hidden = true;
  $("#auth-root").hidden = false;
  $("#auth-root").innerHTML = renderInvite();
}

async function boot() {
  if (await handleInviteLink()) {
    return;
  }
  await loadHealth();
  if (state.health?.setupRequired === true && state.principal === undefined) {
    authMode = "bootstrap";
  }
  try {
    await loadContext();
  } catch (error) {
    if (error.status === 401) {
      state.principal = undefined;
      showAuth();
      return;
    }
    state.loadError = error.message;
  }
  showApp();
  applyHash();
  render();

  void loadProviders().then(() => render());
  void loadInvitations().then(() => {
    if (state.route === "settings") {
      render();
    }
  });

  connectSocket((frame) => {
    // A channel event for the repository currently open gets its own
    // immediate reconcile, including the echo of this browser's own posts —
    // see `refreshChannelMessages` in data.js. This is what makes a second
    // tab watching the same channel see a message appear without a refresh.
    const channelRepositoryId =
      frame?.type === "audit" && String(frame.event?.type ?? "").startsWith("channel_")
        ? frame.event?.data?.repositoryId
        : undefined;
    if (
      channelRepositoryId !== undefined &&
      // `activeChannelId`, for the third time and the same reason: the screen
      // falls back to the first repository, so a channel can be open and
      // addressed while this field is still empty. Comparing against the raw
      // field meant an event for the channel on screen matched nothing, the
      // reconcile never ran, and anything the server appended after the
      // sender's own message — an agent's reply, or the system message
      // explaining why it could not dispatch — simply never arrived.
      channelRepositoryId === activeChannelId() &&
      state.route === "chats"
    ) {
      void refreshChannelMessages(channelRepositoryId).then(() => render());
    }
    // The stream tells us something changed; the store stays the source of
    // truth, so re-read rather than patching state from the frame.
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => void refresh({ quiet: true }), 400);
  });

  window.clearInterval(state.poll);
  state.poll = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      void refresh({ quiet: true });
    }
  }, 30_000);
}

void boot();

export { formatDate, shortId, policyPayload, minutesValue, navigate };
