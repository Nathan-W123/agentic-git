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
  ensureSocketAlive,
  TYPING_SWEEP_MS,
  noteAgentBusy,
  noteDirectMessage,
  ensureDirectMessages,
  loadChannelStats,
  bannerLineForAudit,
  loadDmThread,
  sendDirectMessage,
  noteTyping,
  sendTyping,
  currentRepository,
  currentUserId,
  currentUserName,
  disconnectGitHub,
  loadContext,
  loadGitHub,
  loadHealth,
  loadProviders,
  phoneLayout,
  markRead,
  myAccent,
  myAgentColor,
  myAvatar,
  setMyAvatar,
  myTheme,
  setMyTheme,
  myAgents,
  notifications,
  persist,
  isFavourite,
  channelAgentsFor,
  activeChannelId,
  canLeaveRepository,
  canManageRepository,
  closeChannelFile,
  loadChannelFile,
  moveChannelFile,
  saveChannelFile,
  ensureChannelMessages,
  ensureChannelRoster,
  freeAgentCodeName,
  ensureProviderUsage,
  ensureRepositoryGrants,
  refreshChannelMessages,
  addChannelAgent,
  removeChannelAgent,
  removeChannelAgentForUser,
  renameChannelAgent,
  setChannelAgentSetting,
  deleteRepository,
  leaveRepository,
  channelMessagesFor,
  deleteAllChannelThreads,
  deleteChannelThread,
  loadPreview,
  rollbackTask,
  setAuditorPaused,
  setPreviewCommand,
  simplifySummary,
  startPreview,
  uploadAttachment,
  stopPreview,
  setRepositoryGrant,
  revokeRepositoryGrant,
  state,
  toggleChannelMessagePin,
  toggleChannelReaction,
  toggleFavourite,
  unreadCount,
} from "./data.js";
import {
  $,
  $$,
  vendorMark,
  agentLabelOf,
  avatar,
  brandMark,
  esc,
  icon,
  iconButton,
  imeComposing,
  emptyState,
  closePopover,
  showMenu,
  showPopover,
  badge,
  relativeTime,
  showModal,
  toast,
  banner as popupBanner,
} from "./ui.js";
import { ensureAgentOptions, scrollThread, sendChat } from "./chat.js";
import {
  connectRepository,
  createRepository,
  openRepository,
  syncRepositoryFromGitHub,
} from "./screen-repos.js";
import {
  closeFile,
  codeHistoryHtml,
  ensureCodeData,
  invalidateCode,
  openFile,
  openWorkspace,
  resetWorkspace,
  runTests,
  setDiffMode,
  summaryPopoverHtml,
  toggleChat,
  toggleDirectory,
} from "./screen-code.js";
import {
  cancelTask,
  connectAgent,
  connectGitHubAccount,
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
  handleTerminalKeydown,
  nudgeTerminalHeight,
  openChannel,
  pickMention,
  pickSlashCommand,
  renderChats,
  restoreChannelScroll,
  runTerminalCommand,
  startTerminalResize,
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
/** Pending re-render that takes stale typing dots down once their TTL passes. */
let typingSweep;

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
            ? `${
                // Only asked for when the deployment actually requires one.
                // A required field that cannot be filled in correctly is a
                // locked door with no key, which is what this was.
                state.health?.bootstrapTokenRequired === false
                  ? ""
                  : `<label class="field"><span>Bootstrap token</span>
                 <input class="input" name="token" type="password" required
                   placeholder="COORD_BOOTSTRAP_TOKEN"></label>`
              }
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
    //
    // Trimmed because this field is only ever filled by pasting, and a
    // trailing newline picked up from a hosting provider's variable editor is
    // invisible in the box and fatal to the comparison. The server trims too;
    // this side also matters because a header cannot carry a newline at all —
    // `fetch` rejects the whole request before the server sees it, which
    // surfaces as a network error rather than as "invalid token".
    await api("/auth/bootstrap", {
      method: "POST",
      headers: { "X-Bootstrap-Token": String(data.get("token") ?? "").trim() },
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
  // No "My Agents" here. Connecting an agent is an account-level act, not a
  // place to spend time, and it now sits in Settings beside the other things
  // that belong to the account. Talking to your own agent moved to the channel
  // panel, which is where it was wanted.
  //
  // The route is deliberately still reachable by URL — the Task, Files and
  // Metrics views live there and nothing has replaced them yet, so this drops
  // the item without deleting the screen behind it.
  // No "Notifications" here. The banner says the news when it happens, the
  // topbar bell holds the unread count and the record, and the per-agent
  // history panel (see docs/handoff/agent-identity-and-history.md) is where
  // the tab's job is going. Route stays reachable through the bell.
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
      <span class="brand-text"><b>Lattice</b></span>
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
        ${avatar(user, 32, user, myAvatar())}
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
      <!-- No "invite someone" here. An invitation names one repository, so
           asking for one from under the project meant asking which repository
           first; the channel's own header is where somebody already knows the
           answer. -->
      ${
        // Silent while everything works. "All systems operational" was a line
        // that never changed, which is a line nobody reads — and it cost a
        // permanent row at the bottom of the sidebar to say nothing.
        //
        // The failure half stays. Losing the control plane is the one thing
        // this corner knew that the rest of the screen cannot show, and a
        // deployment that has gone unreachable failing silently would be worse
        // than the noise this removes.
        state.health === undefined
          ? `<div class="sys-line">
              <span class="dot grey"></span>Control plane unreachable
            </div>`
          : ""
      }
    </div>
  </aside>`;
}

function topbar() {
  const unread = unreadCount();
  const user = currentUserName();
  return `<header class="topbar">
    ${
      // Off the Chats screen there is no channel sidebar and so no brand to
      // click home with — this is the way back.
      state.route === "chats"
        ? ""
        : `<button class="icon-btn" data-act="nav" data-value="chats"
             title="Back to chats" aria-label="Back to chats">${icon("chatBubble")}</button>`
    }
    <span class="spacer"></span>
    ${
      // Same reasoning as the sidebar's line: a status that is always the same
      // is not a status. Only the failure is worth the space.
      state.health === undefined
        ? `<span class="health"><span class="dot grey"></span>Control plane unreachable</span>`
        : ""
    }
    <button data-act="user-menu" title="${esc(user)}">${avatar(user, 32, user, myAvatar())}</button>
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
      ${agentsCard()}

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

      ${githubCard()}

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
 * The user's own GitHub connection, beside their agents because it is the
 * same kind of thing: a personal identity a task of theirs spends. When an
 * agent is asked to push, the push authenticates as this token — as this
 * person, reaching only what they can reach — and until one is connected an
 * asked-for push is refused by name. There is deliberately no
 * deployment-wide token behind it.
 */
function githubCard() {
  const github = state.github;
  if (github === null) {
    // The deployment answered that it offers no GitHub connections; a card
    // for a thing that cannot be done here would only invite a dead click.
    return "";
  }
  const credential = github?.credential;
  const broken = credential?.unusableReason;
  const connected = github?.connected === true;
  return `<section class="card">
    <div class="panel-head"><div><h3>GitHub</h3>
      <p>The account a push of your tasks runs as</p></div></div>
    <div class="set-row">
      <span class="sr-body">
        <div class="sr-title">${
          connected
            ? `Connected as ${esc(github.login ?? "you")}`
            : "Not connected"
        }</div>
        <div class="sr-sub${broken ? " sr-warn" : ""}">${esc(
          broken
            ? broken
            : connected
              ? `Personal access token ending …${credential?.hint ?? ""}. ` +
                "Pushes an agent runs for you authenticate as this token."
              : github === undefined
                ? "Checking…"
                : "When an agent pushes for you, it pushes as you. Connect " +
                  "your GitHub account to make that possible.",
        )}</div>
      </span>
      <span class="sr-ctl">
        <button class="btn btn-sm" data-act="${
          connected && !broken ? "github-disconnect" : "github-connect"
        }">
          ${broken ? "Reconnect" : connected ? "Disconnect" : "Connect"}
        </button>
      </span>
    </div>
  </section>`;
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
/**
 * Connecting agents, in Settings rather than on a screen of its own.
 *
 * A connection belongs to the account, not to a repository: the credential is
 * stored against the user (`/chat/providers/{id}/credential` names no project
 * or repository), and putting an agent into a particular channel is a separate
 * act done from that channel. Keeping the two apart here is the point — sign
 * in once, then tick the agent into whichever channels want it, rather than
 * connecting the same vendor over and over.
 */
function agentsCard() {
  const agents = myAgents();
  return `<section class="card">
    <div class="panel-head"><div><h3>Agents</h3>
      <p>Signed in to your account, and usable in every channel you join them
        to</p></div></div>
    ${
      agents.length === 0
        ? `<div class="set-row"><span class="sr-body">
             <div class="sr-sub">No agent providers are configured on this
               deployment.</div></span></div>`
        : agents
            .map((agent) => {
              const label = agent.name.replace(/\s*\(.*\)$/u, "");
              // Three states, not two: a credential that has stopped
              // authenticating is stored but useless, and saying "connected"
              // about it is what let every task it was given fail in silence.
              const state_ = agent.needsReconnect
                ? { text: "Sign-in expired", cls: " sr-warn" }
                : agent.connected
                  ? { text: "Connected", cls: "" }
                  : { text: "Not connected", cls: "" };
              return `<div class="set-row">
                <span class="sr-body">
                  <div class="sr-title">${esc(label)}</div>
                  <div class="sr-sub${state_.cls}">${esc(state_.text)}${
                    agent.detail ? ` — ${esc(agent.detail)}` : ""
                  }</div>
                </span>
                <span class="sr-ctl">
                  ${
                    agent.connected
                      ? `<button type="button" class="btn btn-sm"
                          data-act="agent-disconnect"
                          data-value="${esc(agent.id)}">Disconnect</button>`
                      : `<button type="button" class="btn btn-sm btn-primary"
                          data-act="agent-connect"
                          data-value="${esc(agent.id)}">${
                            agent.needsReconnect ? "Reconnect" : "Connect"
                          }</button>`
                  }
                </span>
              </div>`;
            })
            .join("")
    }
  </section>`;
}

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
        <div class="sr-title">Theme</div>
        <div class="sr-sub">Light inverts the surfaces and keeps your accent.
          Stored in this browser.</div>
      </span>
      <span class="sr-ctl">
        ${
          // `switch`, not `toggle`. There has never been a `.toggle` rule in
          // the stylesheet, so this button had no size, no track and no knob —
          // it rendered as an empty inline element and the only way to reach
          // light mode was to guess where to click. Every other switch on this
          // screen already used the styled class.
          `<button type="button" class="switch${myTheme() === "light" ? " on" : ""}"
            data-act="theme-toggle" role="switch"
            aria-checked="${myTheme() === "light"}"
            aria-label="Light theme"></button>`
        }
      </span>
    </div>

    <div class="set-row">
      <span class="sr-body">
        <div class="sr-title">Profile picture</div>
        <div class="sr-sub">Shown wherever your initials appear. Stored in this
          browser only — the account has no field for a picture yet, so it will
          not follow you to another machine.</div>
      </span>
      <span class="sr-action avatar-pick">
        ${avatar(currentUserName(), 40, currentUserName(), myAvatar())}
        <label class="btn btn-quiet">
          Choose…
          <input type="file" accept="image/*" data-act="avatar-pick" hidden>
        </label>
        ${
          myAvatar() === undefined
            ? ""
            : `<button type="button" class="btn btn-quiet" data-act="avatar-clear">Remove</button>`
        }
      </span>
    </div>

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
          theirs. The mark says which vendor; the colour says whose.</div>
      </span>
    </div>
    <div style="padding:0 17px 16px">
      <div class="swatches">${swatches("set-agent-color", agentColor)}</div>
      <div class="doodle-preview" style="color:${esc(agentColor)}">
        ${["anthropic", "cursor", "openai", "google", "xai", "deepseek"]
          .map(
            (kind) => `<span class="doodle-chip">
              <span class="doodle">${vendorMark(kind)}</span>
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
/**
 * Asks for a name when every call sign in the channel is spoken for.
 *
 * Only reachable once the list is exhausted, which takes seventy agents in
 * one channel — but the alternative is minting "Vesper 2", and a name nobody
 * chose that also reads as a duplicate is worse than a question. Empty means
 * they would rather keep the default, which is a legitimate answer.
 */
async function promptForAgentName(repositoryId, agentId) {
  const values = await showModal({
    title: "Every call sign is taken",
    subtitle:
      "This channel is using all of them, so this agent needs a name of " +
      "your choosing. It has to be one nobody here already answers to.",
    confirm: "Name this agent",
    body: `<label class="field">
        <span>Name</span>
        <input class="input" name="name" maxlength="120" placeholder="e.g. Vesper II">
      </label>`,
  });
  const chosen = String(values?.name ?? "").trim();
  if (chosen === "") {
    return;
  }
  // `renameChannelAgent` refuses a duplicate and says so, so this does not
  // need to check again — the same guard serves the form and this.
  renameChannelAgent(repositoryId, agentId, chosen);
  render();
}

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
 * Deleting a thread, and clearing a channel.
 *
 * Both ask first. A thread is the only account of what an agent did — its
 * reasoning, what it changed, what a person approved — and none of that is
 * recoverable afterwards. Clearing the channel asks harder, and says how many
 * threads it is about to take, because "delete all" is easy to reach for and
 * impossible to walk back.
 */
async function deleteThreadAction(repositoryId, messageId) {
  const confirmed = await showModal({
    title: "Delete this thread?",
    subtitle:
      "Everything in it goes — the agent's reasoning, what it changed, and " +
      "any approvals. This cannot be undone.",
    confirm: "Delete",
  });
  if (confirmed === undefined) {
    return;
  }
  try {
    await deleteChannelThread(repositoryId, messageId);
    if (state.activeChannelThread === messageId) {
      state.activeChannelThread = undefined;
    }
    toast("Thread deleted", "ok");
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function clearThreadsAction(repositoryId) {
  const threads = channelMessagesFor(repositoryId).filter(
    (entry) => (entry.replies ?? []).length > 0,
  ).length;
  const confirmed = await showModal({
    title: `Delete all ${String(threads)} thread${threads === 1 ? "" : "s"}?`,
    subtitle:
      "This clears the whole channel — every message and every thread in it. " +
      "There is no undo.",
    confirm: "Delete everything",
  });
  if (confirmed === undefined) {
    return;
  }
  try {
    const removed = await deleteAllChannelThreads(repositoryId);
    state.activeChannelThread = undefined;
    toast(`Deleted ${String(removed)} message${removed === 1 ? "" : "s"}`, "ok");
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * Turning auditing off, or back on.
 *
 * Switching off is silent — it is a cost decision and needs no ceremony.
 * Switching on says what it is about to do, because it starts spending
 * immediately and the person who flicked it is owed that much warning.
 */
/**
 * Undoes one task's landed work, after asking.
 *
 * The confirm is not ceremony. Everything else in this channel adds; this is
 * the one control that takes away, and it takes away something a person may
 * have waited several minutes of agent time for.
 *
 * A refusal comes back as an ordinary result with a reason — canonical having
 * moved on is the common one — so it is reported as plainly as a success.
 * Reverting is itself a normal run: it is planned, validated and promoted like
 * any other change, so the channel narrates it and there is nothing to render
 * here beyond saying it started.
 */
/**
 * Starts the repository's app and says where it went.
 *
 * The URL is not opened for the reader. A dev server takes a moment to bind
 * and a tab opened the instant the process spawns shows a connection error —
 * which reads as "it did not work" for something that is about to work. The
 * link stays in the header for them to click when they are ready.
 */
/**
 * Fetches a shorter version of one summary and shows it.
 *
 * Kept beside the original rather than replacing it: the full account is what
 * the agent actually said, and a reader who finds the short version too short
 * has to be able to get back to it in one click.
 */
/**
 * The first line of the message being answered, shaped for a composer.
 *
 * A quote rather than a mechanism: replying is typing into the composer the
 * thread already has, and this only saves the reader scrolling back to say
 * which message they meant. Truncated hard because the quote is an address,
 * not a reprint — the full text is right there in the transcript.
 */
function replyQuote(content) {
  const line =
    String(content ?? "")
      .split(/\n/u)
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  if (line === "") {
    return "";
  }
  const excerpt = line.length > 80 ? `${line.slice(0, 77)}…` : line;
  return `> ${excerpt}\n\n`;
}

async function simplifySummaryAction(repositoryId, replyId) {
  if (state.simplifying[replyId] === true) {
    return;
  }
  const source = channelMessagesFor(repositoryId)
    .flatMap((message) => message.replies ?? [])
    .find((reply) => reply.id === replyId);
  if (source === undefined) {
    return;
  }
  state.simplifying[replyId] = true;
  render();
  try {
    const text = await simplifySummary(repositoryId, replyId, source.content);
    if (text.trim().length === 0) {
      toast("The agent had nothing shorter to say", "error");
      return;
    }
    state.simplified[replyId] = text;
    state.simplifyShown[replyId] = true;
  } catch (error) {
    toast(error.message, "error");
  } finally {
    delete state.simplifying[replyId];
    render();
  }
}

/**
 * Puts images in the draft, as the reference a message carries.
 *
 * Uploaded one at a time and appended as they land, so a slow one does not
 * hold up the others and a failure loses only itself. The draft is written
 * through `state` and re-rendered because the textarea is rebuilt on render
 * anyway — this is one of the few places a composer render is the point
 * rather than the cost.
 */
async function attachChannelImages(files) {
  const repositoryId = activeChannelId();
  const images = files.filter((file) => file.type.startsWith("image/"));
  if (repositoryId === undefined || images.length === 0) {
    if (files.length > 0) {
      toast("Only images can be attached.", "error");
    }
    return;
  }
  state.attaching += images.length;
  render();
  for (const file of images) {
    try {
      const id = await uploadAttachment(repositoryId, file);
      const alt = file.name.replace(/\.[^.]+$/u, "").slice(0, 60);
      const draft = state.chatDraft ?? "";
      state.chatDraft = `${draft}${
        draft === "" || draft.endsWith("\n") ? "" : "\n"
      }![${alt}](attachment:${id})\n`;
    } catch (error) {
      toast(error.message ?? "That image could not be attached.", "error");
    } finally {
      state.attaching -= 1;
      render();
    }
  }
  $("[data-act='channel-input']")?.focus();
}

async function startPreviewAction(repositoryId, asked = false) {
  toast("Starting…", "ok");
  try {
    const preview = await startPreview(repositoryId);
    toast(
      preview === null
        ? "Started"
        : `Running at ${preview.url} — ${preview.label}`,
      "ok",
    );
    render();
  } catch (error) {
    // Detection knows Node and it knows a page. Everything else is a question
    // with exactly one right answer, held by whoever built the repository —
    // so it is asked once and remembered, rather than guessed at forever.
    //
    // `asked` stops the loop: a command that was just supplied and still did
    // not work is reported, not re-requested.
    if (!asked && /could not be started/u.test(error.message ?? "")) {
      const command = window.prompt(
        `${error.message}\n\nHow is this app started? For example: npm run dev, ` +
          `python3 serve.py, go run .`,
        "",
      );
      if (command !== null && command.trim().length > 0) {
        try {
          await setPreviewCommand(repositoryId, command.trim());
        } catch (saveError) {
          toast(saveError.message, "error");
          return;
        }
        await startPreviewAction(repositoryId, true);
        return;
      }
    }
    toast(error.message, "error");
  }
}

async function stopPreviewAction(repositoryId) {
  try {
    await stopPreview(repositoryId);
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function revertTaskAction(repositoryId, taskId) {
  if (
    !window.confirm(
      "Revert this task?\n\nThe repository goes back to the state it was in " +
        "before this work landed. The revert runs through validation like any " +
        "other change, and is itself undoable.",
    )
  ) {
    return;
  }
  try {
    const result = await rollbackTask(repositoryId, taskId);
    const status = result?.status;
    if (status === "blocked" || status === "noop" || status === "policy_failed") {
      toast(result?.explanation ?? "The revert was refused", "error");
      return;
    }
    toast("Reverting — the channel will report how it goes", "ok");
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function toggleAuditingAction(repositoryId, paused) {
  try {
    const resumed = await setAuditorPaused(repositoryId, paused);
    toast(
      paused
        ? "Auditing paused"
        : resumed === "audited"
          ? "Auditing on — reviewing everything merged since it was paused"
          : resumed === "nothing_to_audit"
            ? "Auditing on — nothing new to review"
            : "Auditing on",
      "ok",
    );
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
      <!-- No invite button here. An invitation names one repository, so
           starting one from a project-wide screen meant being asked which
           repository first — and the channel header, where somebody already
           knows the answer, is where the button belongs. This card is the
           record of what has been sent, which is a different question. -->
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
  const light = myTheme() === "light";
  const root = document.documentElement.style;
  root.setProperty("--accent", accent);
  // "Bright" means "stands out from the ground", not "closer to white".
  //
  // Every one of these was derived for a dark ground and used on both themes,
  // which is why the highlights washed out the moment light was switched on.
  // `--accent-bright` carries accent-coloured *text* — tab labels, counts, the
  // active file, the thread's own name — and lightening a purple by a third
  // puts it a shade or two off cream: the same move that makes it legible on
  // #141414 makes it vanish on #e8e2d4. Measured, the default accent went from
  // 5.9:1 on dark to 2.0:1 on light, and a chosen yellow or green reached
  // 1.1:1, which is not a faint highlight but an invisible one.
  //
  // Darkening by a fixed amount does not fix it either, because the shortfall
  // depends on the accent's own lightness rather than on the theme: the same
  // -30% that lands purple at 5.7:1 leaves yellow at 2.6:1. So the light value
  // is searched for instead — darkened until it clears 4.5:1 against `--bg`,
  // the page ground and the surface most accent text sits on. Every hue then
  // lands in the same band rather than wherever its own lightness happened to
  // put it. The hover and active states are a shade below `--bg` and come out
  // around 3.8:1, which is a deliberate trade: targeting the darkest surface
  // any accent text can land on would darken every hue past the point of
  // still looking like the colour somebody picked.
  //
  // The dark branch is untouched. It is the theme these numbers were chosen
  // for and it already reads; searching it too would change a working screen
  // to make this function symmetrical, which is not a reason.
  root.setProperty(
    "--accent-bright",
    light ? readableOn(accent, "#e8e2d4", 4.5) : mix(accent, "#ffffff", 0.32),
  );
  // The quieter of the pair, so it steps toward the ground rather than away
  // from it — which is toward white on light and toward black on dark.
  root.setProperty(
    "--accent-dim",
    light ? mix(accent, "#ffffff", 0.22) : mix(accent, "#000000", 0.22),
  );
  // The washes are the accent laid over the surface at low alpha. The alpha
  // that reads as a tint over near-black is most of the way to invisible over
  // cream — a 12% purple on #f6f2e8 is a surface nobody can see is
  // highlighted, which is what a selected tab and a mentioned message both
  // rely on. Raised on light so the same tint carries the same weight.
  root.setProperty("--accent-wash", withAlpha(accent, light ? 0.17 : 0.12));
  root.setProperty(
    "--accent-wash-strong",
    withAlpha(accent, light ? 0.28 : 0.2),
  );
  root.setProperty("--accent-line", withAlpha(accent, light ? 0.5 : 0.38));
  // Surfaces are the stylesheet's business, and only the stylesheet's.
  //
  // This used to overwrite every background, border and text colour from here,
  // mixing a few percent of the accent into each so the whole interface read
  // as being *in* the chosen colour. Two things were wrong with it. The dark
  // bases written here were blue-black (#0a0b0f, #111320) while the stylesheet
  // had already been moved to true grey, so the JS quietly undid the CSS on
  // every render and the greys nobody could find in the file were the ones
  // actually on screen. And the accent mix is a hue by definition: a grey with
  // 5% purple in it is a purple-grey, which is exactly what a neutral surface
  // is not.
  //
  // Setting only the theme attribute now, and letting `:root` and
  // `:root[data-theme="light"]` supply the ramps. Both are complete — surfaces,
  // borders, text and shadows — so nothing here needs restating, and changing
  // a colour means editing the colour rather than hunting for the assignment
  // that overrides it.
  document.documentElement.dataset.theme = light ? "light" : "dark";
  // The browser chrome around the page — a phone's status bar, the installed
  // app's title bar — sits flush against the header, so it follows the page
  // ground, not the accent. Painting it with the accent put a saturated band
  // above a neutral surface on every phone, which is the opposite of the
  // seam this meta exists to hide. Read back from the stylesheet after the
  // theme attribute lands, so the chrome can never disagree with the ramp
  // the CSS actually resolved.
  const ground = getComputedStyle(document.documentElement)
    .getPropertyValue("--bg")
    .trim();
  if (ground !== "") {
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", ground);
  }
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

/** WCAG relative luminance, which is what a contrast ratio is built from. */
function luminance(hex) {
  const [red, green, blue] = channels(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(hex, against) {
  const [lighter, darker] = [luminance(hex), luminance(against)].sort(
    (left, right) => right - left,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The accent, darkened only as far as it has to be to be read on `ground`.
 *
 * Stepped rather than solved for: the relationship between a mix amount and
 * the resulting ratio is not one anybody should be inverting in a theme
 * function, and fifty steps of 2% is both exact enough and over in a fraction
 * of a millisecond. Stopping at the first step that clears the target is what
 * keeps the hue: darkening further buys contrast nobody needed and spends the
 * colour somebody chose to get it.
 *
 * An accent already dark enough comes back untouched, which is the common case
 * for anybody who picked a deep colour.
 */
function readableOn(accent, ground, target) {
  for (let step = 0; step <= 40; step += 1) {
    const candidate = mix(accent, "#000000", step / 50);
    if (contrastRatio(candidate, ground) >= target) {
      return candidate;
    }
  }
  return mix(accent, "#000000", 0.8);
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

/*
 * Dragging a file in the tree onto a directory moves it.
 *
 * Delegated like every other handler here, because the tree is re-rendered
 * whole on each change and per-node listeners would not survive it. The path
 * travels in `dataTransfer` rather than in module state so an aborted drag
 * leaves nothing behind to clear.
 */
document.addEventListener("dragstart", (event) => {
  const row = event.target.closest?.("[data-drag-path]");
  if (row === null || row === undefined) {
    return;
  }
  event.dataTransfer.setData("text/plain", row.dataset.dragPath);
  event.dataTransfer.effectAllowed = "move";
});

document.addEventListener("dragover", (event) => {
  const directory = event.target.closest?.("[data-drop-dir]");
  if (directory === null || directory === undefined) {
    return;
  }
  // Only calling preventDefault marks a target as accepting a drop, so this
  // is what makes directories droppable and everything else not.
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  directory.classList.add("drop-into");
});

document.addEventListener("dragleave", (event) => {
  event.target.closest?.("[data-drop-dir]")?.classList.remove("drop-into");
});

document.addEventListener("drop", (event) => {
  const directory = event.target.closest?.("[data-drop-dir]");
  if (directory === null || directory === undefined) {
    return;
  }
  event.preventDefault();
  directory.classList.remove("drop-into");
  const from = event.dataTransfer.getData("text/plain");
  const into = directory.dataset.dropDir;
  if (from === "" || into === undefined) {
    return;
  }
  // Moving a file into the directory it already sits in is a no-op rather
  // than an error: the drop is easy to make by accident.
  if (from.slice(0, from.lastIndexOf("/")) === into) {
    return;
  }
  void moveChannelFile(from, into).then((moved) => {
    if (moved === undefined) {
      return;
    }
    // Follow the file if it was the one being read, so the panel does not sit
    // on a path that no longer exists.
    if (state.chanFileView === from) {
      state.chanFileView = moved;
    }
    // The changeset now contains a deletion and an addition that the copy on
    // screen does not know about.
    invalidateCode();
    void ensureCodeData(render);
    render();
  });
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

/* Some markup is decided at render time by `phoneLayout()` — the channel
   header renders its tools pinned open on a phone — so crossing the
   breakpoint (a rotation, a resized window) has to re-render once or the
   header keeps the shape of the width it last rendered at. */
window.matchMedia("(max-width: 600px)").addEventListener("change", () => {
  render();
});

/**
 * Catching back up, at the moments a phone actually returns: the tab coming
 * to the foreground, the page coming back out of the back-forward cache,
 * the network reappearing. A backgrounded phone tab loses its socket and
 * has its timers frozen, so everything an agent said in the meantime — a
 * reply, its thinking, the outcome — was invisible until a manual reload.
 * Reconnecting replays the missed events through the hub's own cursor; the
 * explicit channel refresh covers the transcript on screen without waiting
 * a round trip for the replay to name it.
 */
function resumeLiveUpdates() {
  if (state.principal === undefined) {
    return;
  }
  ensureSocketAlive();
  void refresh({ quiet: true });
  const channel = activeChannelId();
  if (state.route === "chats" && channel) {
    void refreshChannelMessages(channel).then(() => {
      if (!renameFieldFocused()) {
        render();
      }
    });
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    resumeLiveUpdates();
  }
});
// `persisted` means the page was thawed from the back-forward cache rather
// than loaded — the one return path visibilitychange does not always cover.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    resumeLiveUpdates();
  }
});
window.addEventListener("online", () => {
  resumeLiveUpdates();
});

/* The soft keyboard shrinks the visual viewport, and the transcript above
   the composer loses its bottom edge — the message being replied to slides
   up behind the keyboard, and typing means typing at a conversation that is
   no longer visible. The layout viewport (and so `resize`) does not always
   move on iOS; `visualViewport` is the surface that actually tracks the
   keyboard. Re-pinning is `restoreChannelScroll`'s existing job — it only
   acts while the reader is following the bottom, so scrolled-back reading
   is never yanked. Debounced past the keyboard animation rather than run
   per frame. */
if (window.visualViewport !== undefined) {
  let keyboardSettle;
  window.visualViewport.addEventListener("resize", () => {
    clearTimeout(keyboardSettle);
    keyboardSettle = setTimeout(() => {
      if (state.route === "chats") {
        restoreChannelScroll();
      }
    }, 120);
  });
}

/**
 * Usage is fetched the first time a pointer rests on a roster entry, not with
 * the roster: the figure costs a CLI invocation on the server, so a channel
 * with several agents must not pay for all of them to render. The card itself
 * is CSS-driven, so this only fills it in — `ensureProviderUsage` keeps the
 * answer, and a second hover re-renders from state without another request.
 */
function requestUsageForHoverTarget(event) {
  const target =
    event.target instanceof Element
      ? event.target.closest('[data-hover="agent-usage"]')
      : null;
  if (target === null) {
    return;
  }
  void ensureProviderUsage(target.dataset.hoverValue, render);
}
document.addEventListener("mouseover", requestUsageForHoverTarget);
// `:hover` never matches on a touch screen, so the card above has nothing to
// reveal it there — `rosterRow` (screen-chats.js) gives `.rr-avatar` a
// `tabindex`, and `.rr-avatar:focus-within .rr-usage` (styles.css) already
// shows the card on focus exactly as it does on hover. This is what supplies
// the data for a tap the same way the listener above supplies it for a
// pointer.
document.addEventListener("focusin", requestUsageForHoverTarget);

/* -------------------------------------------------- phone swipe ---- */
/*
 * Each edge swipes in what lives on that side: from the right, the side
 * panel (threads, files); from the left, the channel drawer with the
 * channels, the users and the agents. Swiping back the way it came puts
 * either away.
 *
 * Phone only, and only on the chats screen. On a wide window both are
 * ordinary always-visible columns and there is nothing to reveal; the header
 * buttons keep working at every width and this is an addition to them, not a
 * replacement — a gesture nobody can see is a poor sole route to a feature.
 *
 * The open gestures have to start near their edge, because a drag from the
 * middle of a transcript is how someone scrolls a wide code block or swipes
 * between browser tabs. The close gestures have no edge requirement: an open
 * surface is full width (or nearly), so anywhere on it is the surface.
 */
const SWIPE_EDGE_PX = 28;
const SWIPE_MIN_PX = 60;
/* Vertical drift that means the finger was scrolling the transcript, not
   swiping across it. Checked against the horizontal distance rather than a
   fixed number so a long, slightly sloped swipe still counts. */
const SWIPE_MAX_SLOPE = 0.6;

let swipeStart;

/** Whichever side panel is showing, closed the way its own button closes it. */
function closeSidePanel() {
  if (state.chanFileView !== undefined) {
    // The same question the close button asks. A swipe is easy to do by
    // accident, which makes silently discarding an edit worse here, not
    // better.
    if (!confirmDiscardEdit()) {
      return false;
    }
    closeChannelFile();
    state.chanTree = false;
    return true;
  }
  if (state.chanTree === true) {
    state.chanTree = false;
    return true;
  }
  if (state.activeChannelThread !== undefined) {
    state.activeChannelThread = undefined;
    return true;
  }
  if (state.chanThreadList === true) {
    state.chanThreadList = false;
    return true;
  }
  return false;
}

function sidePanelOpen() {
  return (
    state.chanFileView !== undefined ||
    state.chanTree === true ||
    state.activeChannelThread !== undefined ||
    state.chanThreadList === true
  );
}

document.addEventListener(
  "touchstart",
  (event) => {
    // A second finger means a pinch or a scroll gesture, never this.
    swipeStart =
      event.touches.length === 1 && event.touches[0] !== undefined
        ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
        : undefined;
  },
  { passive: true },
);

document.addEventListener(
  "touchend",
  (event) => {
    const start = swipeStart;
    swipeStart = undefined;
    const touch = event.changedTouches[0];
    if (
      start === undefined ||
      touch === undefined ||
      !phoneLayout() ||
      state.route !== "chats"
    ) {
      return;
    }
    // Never steal a swipe that began inside something horizontally
    // scrollable — a wide code block or a diff is dragged, not swiped past.
    if (event.target instanceof Element) {
      const scroller = event.target.closest(".msg-code, pre, .diff, table");
      if (scroller !== null && scroller.scrollWidth > scroller.clientWidth) {
        return;
      }
    }
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dy) > Math.abs(dx) * SWIPE_MAX_SLOPE) {
      return;
    }
    if (dx < 0) {
      // Leftward: an open channel drawer goes back first — it came from
      // this edge, so this is its dismissal whatever the finger started on.
      if (state.chanSidebarOpen === true) {
        state.chanSidebarOpen = false;
        render();
        return;
      }
      // From the right edge: bring the panel in. The thread list is
      // what it opens onto — the panel's own tabs move between that, the file
      // tree and an open file once it is showing.
      if (start.x >= window.innerWidth - SWIPE_EDGE_PX && !sidePanelOpen()) {
        state.chanThreadList = true;
        render();
      }
      return;
    }
    // Rightward: whatever panel is out goes away first; with nothing out, the
    // left edge pulls in the channel drawer — channels, users and agents —
    // the same surface its header button opens.
    if (sidePanelOpen() && closeSidePanel()) {
      render();
      return;
    }
    if (start.x <= SWIPE_EDGE_PX && state.chanSidebarOpen !== true) {
      state.chanSidebarOpen = true;
      render();
    }
  },
  { passive: true },
);

/**
 * Unsaved text is worth one question before it disappears.
 *
 * Returns false when the reader decides to keep editing, and the caller then
 * does nothing at all — closing the panel and switching to the diff both throw
 * the draft away.
 */
const FOCUSABLE_FIELDS = new Set(["INPUT", "TEXTAREA"]);

/**
 * Where focus and the caret were, across a render nobody asked for.
 *
 * Every render is one `innerHTML` assignment over the whole app, so the field
 * being typed into is destroyed and rebuilt. The text survives — it is drawn
 * from state — but the element does not, and with it go focus, the caret, and
 * any height the composer had grown to. What that looks like from the outside
 * is a chat box that deselects itself mid-sentence.
 *
 * It only ever happened on renders the typist did not cause, which is what
 * made it feel random: a handler that renders on purpose puts focus back
 * itself, and there are seven things that render on their own schedule — a
 * thirty-second poll, an audit frame, somebody else's typing indicator, an
 * agent's busy dots, a direct message, a channel reconcile, and the refetches
 * `renderNow` itself kicks off.
 *
 * This used to save exactly one element, the file editor, and only on the
 * chats route. Keyed on `data-act` instead, it covers every field in the app
 * for nothing extra: `data-value` disambiguates the per-row fields, and the
 * restore is a no-op when nothing was focused.
 */
function captureFocus() {
  const node = document.activeElement;
  const act = node?.dataset?.act;
  if (act === undefined || !FOCUSABLE_FIELDS.has(node.tagName)) {
    return undefined;
  }
  let start;
  let end;
  try {
    start = node.selectionStart;
    end = node.selectionEnd;
  } catch {
    // A number or email input has no caret to read, and asking throws. Focus
    // alone is the whole restore for those.
    start = undefined;
  }
  return {
    act,
    value: node.dataset.value,
    start,
    end,
    height: node.style.height,
    top: node.scrollTop,
  };
}

function restoreFocus(saved) {
  if (saved === undefined) {
    return;
  }
  const next = [...document.querySelectorAll(`[data-act="${saved.act}"]`)].find(
    (candidate) => (candidate.dataset.value ?? "") === (saved.value ?? ""),
  );
  if (next === undefined || next === document.activeElement) {
    return;
  }
  // `preventScroll`, or refocusing would undo the transcript scroll restored
  // a moment earlier.
  next.focus({ preventScroll: true });
  if (saved.start !== undefined && saved.start !== null) {
    try {
      next.setSelectionRange(saved.start, saved.end);
    } catch {
      // Not a field with a selection. Focus is enough.
    }
  }
  if (saved.height !== "") {
    // The composer grows by having its height set imperatively, which is not
    // in the markup and so does not survive the rebuild on its own.
    next.style.height = saved.height;
  }
  next.scrollTop = saved.top;
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

/**
 * Guards the one `innerHTML` swap the whole screen goes through.
 *
 * Renders used to happen only because somebody clicked something. Typing
 * indicators changed that: a frame from another browser, or the sweep that
 * expires one, now redraws while a field is focused. Replacing the DOM under
 * a focused input fires `focusout`, whose handler commits the edit and
 * renders again — inside the render already running. The browser refuses
 * that with "The node to be removed is no longer a child of this node".
 *
 * So a render that arrives during a render is remembered, not run, and
 * happens once the first has finished unwinding.
 */
let rendering = false;
let renderAgain = false;

/**
 * Whether an agent rename is open and focused.
 *
 * The guard below keeps a background redraw from crashing; this keeps it from
 * being rude. Rebuilding the screen under a half-typed name throws the edit
 * away, and a redraw nobody asked for — somebody else typing in the channel —
 * has no business doing that. Only this form is protected: it is the one that
 * holds unsaved text and commits on losing focus.
 */
function renameFieldFocused() {
  const act = document.activeElement?.dataset?.act;
  return act === "channel-rename-input" || act === "channel-role-input";
}

export function render() {
  if (rendering) {
    renderAgain = true;
    return;
  }
  rendering = true;
  try {
    renderNow();
  } finally {
    rendering = false;
    if (renderAgain) {
      renderAgain = false;
      render();
    }
  }
}

function renderNow() {
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
  if (state.navCollapsed) {
    classes.push("nav-collapsed");
  }
  const focusedField = captureFocus();
  // No rail. The channel sidebar is the navigation now — channels are the
  // app — and everything the rail held moved: the brand into that sidebar
  // (clicking it opens Settings), the account block into the topbar avatar,
  // and the failure-only health line to the sidebar's foot. `sidebar()` and
  // the nav drawer stay in the file, unrendered, until the next sweep.
  root.innerHTML = `<div class="${classes.join(" ")}">
    <div class="main${BARE.has(state.route) ? " bare" : ""}${
      state.loadError === undefined ? "" : " has-banner"
    }">
      ${banner()}
      ${BARE.has(state.route) ? "" : topbar()}
      ${screen()}
    </div>
  </div>`;

  // Chats owns this now: the inline file and diff blocks in the transcript are
  // the only place code is read, so the channel has to load its own changeset
  // rather than inherit one a separate Code screen happened to fetch first.
  if (state.route === "chats") {
    // The transcript is replaced on every render, which resets it to the top.
    // Put it back where the reader had it before anything else runs.
    restoreChannelScroll();
    void ensureCodeData(render);
    scrollThread();
  }
  // Outside the chats branch: a search box on any screen loses focus the same
  // way. After `restoreChannelScroll`, so the refocus does not fight it.
  restoreFocus(focusedField);
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
    // Asked once per channel, not on every render: the preview outlives the
    // page, so a reload has to find the one already running rather than offer
    // to start a second. `undefined` is "not asked yet"; `null` is "asked,
    // there is none", which is why this tests for the former.
    if (state.previews[activeChannelId()] === undefined) {
      const channel = activeChannelId();
      // Claimed before the request so a second render in the same tick does
      // not fire it again.
      state.previews[channel] = null;
      void loadPreview(channel).then(() => {
        if (state.route === "chats") {
          render();
        }
      });
    }
    // Unread counts and presence, for the dots and badges beside the roster
    // this screen is already drawing. Unconditional rather than cached: both
    // are answers about right now, and a stale one is worse than none.
    void ensureDirectMessages(() => {
      if (state.route === "chats") {
        render();
      }
    });
    // The roster's model/effort pickers read the same real options My Agents
    // and Code load — loaded here too, rather than invented for this screen.
    //
    // By vendor, and for everyone's agents. The options route answers about
    // the CLI installed on this host and takes no per-user argument, so one
    // fetch per vendor serves every agent running on it. Loading only for
    // `agent.mine` left a colleague's agent with no options at all, and its
    // pickers fell back to a hardcoded list for as long as the channel was
    // open. Keyed on `provider` rather than `id` because a teammate's roster
    // id is `${userId}:${provider}`, which is not a provider and would fetch
    // a 404 and cache it.
    for (const provider of new Set(
      channelAgentsFor(activeChannelId())
        .map((agent) => agent.provider)
        .filter((provider) => typeof provider === "string" && provider !== ""),
    )) {
      void ensureAgentOptions(provider, () => {
        if (state.route === "chats") {
          render();
        }
      });
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
  if (pop !== null && activeChannelId()) {
    pop.innerHTML = channelInfoPopoverHtml(activeChannelId());
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
        // Only for repositories that actually have a GitHub origin — a menu
        // must never offer what the platform cannot do for this repository.
        ...(state.repositories.find((repo) => repo.id === value)?.provider ===
        "github"
          ? [{ act: "repo-sync", value, label: "Sync from GitHub", iconName: "sync" }]
          : []),
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
    case "repo-sync":
    case "channel-sync":
      closePopover();
      void syncRepositoryFromGitHub(value, render);
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
    case "channel-attach": {
      // Clicking the picker rather than being it: a bare file input cannot be
      // styled into the composer bar, and wrapping the button in a label would
      // swallow the click before the delegated handler saw it.
      $("[data-act='channel-attach-input']")?.click();
      return;
    }
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
    case "channel-slash-pick":
      pickSlashCommand(value, render);
      return;
    case "chan-term-toggle":
      state.termOpen = !state.termOpen;
      render();
      if (state.termOpen) {
        $("[data-act='chan-term-input']")?.focus();
      }
      return;
    case "channel-react":
      toggleChannelReaction(activeChannelId(), value, "👍");
      render();
      return;
    case "channel-pin":
      // `render` travels with it so a refusal can put the banner back: the
      // POST resolves long after this turn's render has run.
      toggleChannelMessagePin(activeChannelId(), value, render);
      render();
      return;
    case "channel-pins-toggle":
      state.pinsOpen = state.pinsOpen !== true;
      render();
      return;
    // A pinned thread opens as a thread; a plain pinned message scrolls
    // into view. The banner's copy answers for pins whose transcript row
    // has aged past the loaded page.
    case "channel-pin-jump": {
      const repositoryId = activeChannelId();
      const entry =
        channelMessagesFor(repositoryId).find((m) => m.id === value) ??
        (state.channelPins[repositoryId] ?? []).find((m) => m.id === value);
      if (
        entry !== undefined &&
        ((entry.replies ?? []).length > 0 || entry.taskId !== undefined)
      ) {
        if (!confirmDiscardEdit()) {
          return;
        }
        state.activeChannelThread = value;
        state.activeDm = undefined;
        state.activeAgentPanel = undefined;
        closeChannelFile();
        render();
        return;
      }
      state.scrollToMessage = value;
      render();
      return;
    }
    case "chan-tree-toggle":
      state.chanTree = state.chanTree !== true;
      state.chanFileView = undefined;
      render();
      return;
    case "chan-tree-close":
      state.chanTree = false;
      render();
      return;
    case "chan-sidebar-toggle":
      state.chanSidebarOpen = state.chanSidebarOpen !== true;
      render();
      return;
    case "nav-collapse-toggle":
      state.navCollapsed = state.navCollapsed !== true;
      persist("ag.navCollapsed", state.navCollapsed);
      render();
      return;
    // Records which way the reader just flipped it, and lets the browser do
    // the flipping. No re-render: `<details>` has already toggled itself by
    // the time this runs, so the stored value and the DOM agree — and
    // re-rendering here would fight the animation for no gain.
    case "thinking-toggle": {
      const details = node?.closest?.("details");
      state.thinkingOpen[value] = details === null || details === undefined
        ? true
        : !details.open;
      return;
    }
    case "chan-collapse-toggle":
      state.chanCollapsed = state.chanCollapsed !== true;
      persist("ag.chanCollapsed", state.chanCollapsed);
      render();
      return;
    case "chan-sidebar-close":
      state.chanSidebarOpen = false;
      render();
      return;
    case "chan-tree-dir": {
      const open = state.chanTreeOpen ?? [];
      state.chanTreeOpen = open.includes(value)
        ? open.filter((path) => path !== value)
        : [...open, value];
      render();
      return;
    }
    case "channel-threads-toggle":
      state.chanThreadList = state.chanThreadList !== true;
      render();
      return;
    case "channel-thread-delete":
      void deleteThreadAction(activeChannelId(), value);
      return;
    case "channel-threads-clear":
      void clearThreadsAction(activeChannelId());
      return;
    case "channel-threads-close":
      state.chanThreadList = false;
      render();
      return;
    case "channel-thread-open":
      // One panel, one owner: opening a thread puts away an open file.
      if (!confirmDiscardEdit()) {
        return;
      }
      state.activeChannelThread = value;
      // …and puts away an open conversation, for the same reason: they share
      // the one panel, and a direct message left on top of a thread the reader
      // just asked for would look like the thread failed to open.
      state.activeDm = undefined;
      state.activeAgentPanel = undefined;
      closeChannelFile();
      render();
      return;
    case "composer-thread-continue":
      // Aimed, then the panel gets out of the way: the point is to type in
      // the channel and have it land here, so leaving the thread open over
      // the transcript would hide the conversation being added to.
      state.composerThreadId = value;
      state.activeChannelThread = undefined;
      render();
      $("[data-act='channel-input']")?.focus();
      return;
    case "composer-thread-clear":
      state.composerThreadId = undefined;
      render();
      $("[data-act='channel-input']")?.focus();
      return;
    case "channel-thread-close":
      state.activeChannelThread = undefined;
      render();
      return;
    // Replying to a message that is already inside a thread: the answer can
    // only land in that same thread, so "reply" means the composer opens
    // with the message being answered already named. The quote is plain
    // text on purpose — the composer stays an ordinary textarea, and the
    // person deletes it as easily as they got it.
    case "thread-reply-quote": {
      const root = channelMessagesFor(activeChannelId()).find(
        (entry) => entry.id === state.activeChannelThread,
      );
      const target =
        root === undefined
          ? undefined
          : root.id === value
            ? root
            : (root.replies ?? []).find((reply) => reply.id === value);
      state.threadDraft = `${replyQuote(target?.content)}${state.threadDraft}`;
      render();
      {
        const input = $("[data-act='channel-thread-input']");
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      }
      return;
    }
    case "dm-reply-quote": {
      const messages = state.dmThreads[state.activeDm] ?? [];
      const target = messages.find((message) => message.id === value);
      state.dmDraft = `${replyQuote(target?.content)}${state.dmDraft}`;
      render();
      {
        const input = $("[data-act='dm-input']");
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      }
      return;
    }
    // Tapping somebody opens the conversation with them. Rendered before the
    // fetch so the panel is there immediately, with whatever was already
    // loaded — a private message is the one surface where waiting to see
    // anything reads as the message having gone nowhere.
    case "dm-open":
      state.activeDm = value;
      state.activeAgentPanel = undefined;
      state.dmDraft = "";
      render();
      void loadDmThread(value).then(() => render());
      return;
    // Starts an "@agents …" message rather than sending one: the person still
    // says what they want asked; this only saves them typing the address.
    case "mention-agents-insert": {
      const input = document.querySelector("[data-act='channel-input']");
      if (input !== null) {
        input.value = `@agents ${input.value.replace(/^@agents\s*/u, "")}`;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
      return;
    }
    case "dm-close":
      state.activeDm = undefined;
      state.dmDraft = "";
      render();
      return;
    // Your own agent, one to one, without leaving the room.
    //
    // This used to navigate to the agents screen. That answered "where is the
    // conversation" by taking the channel away, so talking to your own agent
    // meant losing sight of the work everyone else was doing — and coming
    // back meant finding your place again. It opens beside the channel now,
    // in the panel a thread or a direct message would use.
    //
    // `state.selectedAgent` is what `currentAgent` reads, so the composer
    // below is the same one the agents screen has: same `chat-submit`, same
    // `sendChat`, same ability to be given work rather than just talked to.
    case "agent-chat-open": {
      const opened = myAgents().find((agent) => agent.id === value);
      if (opened?.visibility === "org") {
        toast("Org agents work in the room — @mention them in the channel.");
        return;
      }
      state.selectedAgent = value;
      state.activeAgentPanel = value;
      // This entry point is "talk to my agent", so it lands on the chat half
      // rather than making somebody who clicked the avatar choose a tab.
      state.agentPanelTab = "chat";
      state.activeDm = undefined;
      state.activeChannelThread = undefined;
      render();
      return;
    }
    case "summary-toggle":
      // `<details>` toggles itself; this only records which way, so the choice
      // survives the next render.
      state.summaryOpen[value] = !(state.summaryOpen[value] ?? true);
      return;
    case "summary-simplify":
      void simplifySummaryAction(activeChannelId(), value);
      return;
    case "summary-simplify-toggle":
      state.simplifyShown[value] = !(state.simplifyShown[value] === true);
      render();
      return;
    case "chan-tools-toggle":
      state.chanToolsOpen = !(state.chanToolsOpen === true);
      render();
      return;
    case "preview-start":
      void startPreviewAction(value);
      return;
    case "preview-stop":
      void stopPreviewAction(value);
      return;
    case "agent-panel-open":
      // Any agent in the room, not only your own, and history first. The
      // private-chat entry above stays as it was: that one is a deliberate
      // "talk to my agent" and lands on the chat tab.
      state.activeAgentPanel = value;
      state.agentPanelTab = "history";
      state.activeDm = undefined;
      state.activeChannelThread = undefined;
      render();
      return;
    case "agent-panel-tab":
      state.agentPanelTab = value;
      render();
      return;
    case "agent-panel-close":
      state.activeAgentPanel = undefined;
      render();
      return;
    case "dm-submit": {
      const other = state.activeDm;
      const draft = state.dmDraft.trim();
      if (other === undefined || draft.length === 0) {
        return;
      }
      state.dmDraft = "";
      render();
      void sendDirectMessage(other, draft)
        .then(() => render())
        .catch((error) => toast(`Could not send: ${error.message}`, "error"));
      return;
    }
    // Expanding a file happens where it is read — in the transcript — so this
    // only toggles which paths are open, with no route change to lose the
    // reader's place in the conversation.
    case "chan-file-open":
      // Beside the conversation, not inside it. Opening a file used to expand
      // it in the transcript, which pushed the messages explaining the change
      // off the screen.
      state.chanFileView = value;
      state.activeChannelThread = undefined;
      state.activeAgentPanel = undefined;
      state.activeDm = undefined;
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
    // Two ways out of a file, because they mean different things. Back goes
    // up to the folder it was opened from — reading one file usually means
    // reading the next — and the tree is opened explicitly rather than relying
    // on it happening to still be toggled on underneath.
    case "chan-file-back":
      if (!confirmDiscardEdit()) {
        return;
      }
      closeChannelFile();
      state.chanTree = true;
      render();
      return;
    // The X leaves the code behind entirely: file and folder both, back to the
    // conversation. Closing the file and landing on a file tree somebody did
    // not ask to see again is not "close".
    case "chan-file-close":
      if (!confirmDiscardEdit()) {
        return;
      }
      closeChannelFile();
      state.chanTree = false;
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
    case "chan-revert-task":
      void revertTaskAction(activeChannelId(), value);
      return;
    case "auditor-toggle":
      // `value` is the *current* paused state, so the new one is its
      // opposite — read off the button that was drawn rather than from a
      // second lookup that could disagree with what was on screen.
      void toggleAuditingAction(activeChannelId(), value !== "true");
      return;
    case "channel-info":
      showPopover(node, channelInfoPopoverHtml(value));
      // Grants are fetched lazily, unlike the roster: the panel that reads
      // them only ever shows for someone who can already manage the
      // repository, so most opens of this popover need nothing here.
      void ensureRepositoryGrants(value, refreshChannelInfoPopover);
      void loadChannelStats(value).then(refreshChannelInfoPopover);
      return;
    case "channel-agent-add":
      addChannelAgent(activeChannelId(), value);
      render();
      refreshChannelInfoPopover();
      return;
    case "channel-agent-remove":
      removeChannelAgent(activeChannelId(), value);
      render();
      refreshChannelInfoPopover();
      return;
    case "channel-agent-remove-any": {
      // `value` is `${userId}:${provider}` — see `rosterRow` in
      // screen-chats.js, which mints it from the same pair
      // `channelAgentsFor` already attaches to every non-mine entry.
      const separatorIndex = value.indexOf(":");
      removeChannelAgentForUser(
        activeChannelId(),
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
    case "workspace-reset":
      // Re-cuts the workspace at current canonical. Confirmed only when there
      // is something to lose: a clean workspace being moved forward is not a
      // decision anybody needs to be asked about, and asking would make the
      // ordinary case feel dangerous.
      if (
        (state.workspace?.dirtyFiles ?? []).length > 0 &&
        !window.confirm(
          "Update to the latest version of the repository? Your unsaved edits in this workspace will be discarded.",
        )
      ) {
        return;
      }
      void resetWorkspace(render);
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
    case "tree-toggle":
      // At >900px `.tree-pane` is an ordinary grid column and this class has
      // no visual effect there; below it, it is the only way to reach the
      // file tree, which used to have no opener at all — see `renderCode`.
      state.treeOpen = state.treeOpen !== true;
      render();
      return;
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
    case "github-connect":
      void connectGitHubAccount(render);
      return;
    case "github-disconnect":
      void disconnectGitHub()
        .then(() => {
          toast("GitHub disconnected", "ok");
          render();
        })
        .catch((error) => toast(error.message, "error"));
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
    /**
     * The menu on a channel row: the few things with nowhere else to live.
     *
     * It used to also offer inviting somebody, adding an agent, and opening
     * the channel. Opening duplicated clicking the row itself, and the other
     * two are already in the channel's own header where somebody is looking
     * when they think of them. A menu that repeats what is one click away
     * costs a decision every time it is opened.
     *
     * Syncing earns its place by the same rule. It used to sit on the
     * repositories screen, which this interface no longer has — so the one
     * way to settle a repository that has diverged from GitHub was
     * unreachable, and a person watching a pull get refused in the channel
     * had nowhere at all to go.
     */
    case "channel-menu":
      showMenu(node, [
        // Only for repositories that actually have a GitHub origin: a menu
        // must never offer what the platform cannot do for this one.
        ...(state.repositories.find((repo) => repo.id === value)?.provider ===
        "github"
          ? [
              {
                act: "channel-sync",
                value,
                label: "Sync from GitHub",
                iconName: "sync",
              },
            ]
          : []),
        // Leaving is only offered to somebody who can actually leave. Access
        // that comes from an organization role reaches every repository the
        // organization owns, so there is no per-repository grant to give up —
        // the server says so with a 409, and offering the button anyway meant
        // the only item in this menu was one that could not work.
        ...(canLeaveRepository()
          ? [
              {
                act: "channel-leave",
                value,
                label: `Leave #${value}`,
                iconName: "logout",
              },
            ]
          : []),
        // Deleting is the admin's counterpart: somebody whose access is
        // organization-wide cannot leave a repository, but can remove it.
        // Without this the menu had nothing to offer them at all.
        ...(canManageRepository(value)
          ? [
              {
                act: "channel-delete-repo",
                value,
                label: `Delete #${value}`,
                iconName: "close",
              },
            ]
          : []),
      ]);
      return;
    /**
     * Agents join a channel the same way people do — from the channel's own
     * menu — rather than only from wherever they were connected. Only this
     * account's agents are offerable: membership is managed per caller, and
     * the server's membership route refuses a teammate's agent anyway.
     */
    case "channel-agent-menu": {
      // Anchor to the channel's own dots button, not to the menu item that
      // was clicked: `showMenu` closes the open popover first, which detaches
      // that item, and an anchor no longer in the document positions the new
      // menu against the corner of the screen instead of the channel.
      // Anchor to what was actually clicked when it will still be in the
      // document: the roster's "Add an agent" button opens this too, and
      // anchoring that click to the channel row's dots button floated the
      // list up beside the channels, nowhere near the hand that asked. Only
      // a click from inside a popover — which `showMenu` detaches before
      // positioning — falls back to the channel's own button.
      const fromPopover = node.closest(".pop-layer") !== null;
      const anchor = !fromPopover
        ? node
        : (document.querySelector(
            `[data-act="channel-menu"][data-value="${CSS.escape(value)}"]`,
          ) ?? node);
      // Only trust membership once the roster for *this* repository has
      // actually been fetched. Before that `channelAgentsFor` shows every
      // connected agent provisionally, which would read as "already here" and
      // grey out the whole list — worst exactly where this is needed, on a
      // channel that has no agent yet. Kick the fetch off so a second open
      // is accurate.
      const known = state.channelRosterLoaded.has(value);
      if (!known) {
        void ensureChannelRoster(value, render);
      }
      const inChannel = new Set(
        known
          ? channelAgentsFor(value)
              .filter((agent) => agent.mine === true)
              .map((agent) => agent.id)
          : [],
      );
      const connected = myAgents().filter((agent) => agent.connected === true);
      showMenu(
        anchor,
        connected.length === 0
          ? [
              {
                act: "nav",
                value: "agents",
                label: "Connect an agent first",
                iconName: "robot",
              },
            ]
          : connected.map((agent) => ({
              // Carries the repository too: this menu can be opened from a
              // channel that is not the one currently on screen, and adding
              // to whichever happens to be open would be silently wrong.
              act: "channel-agent-pick",
              value: `${value}|${agent.id}`,
              label: inChannel.has(agent.id)
                ? `${agent.name} · already here`
                : agent.name,
              iconName: "robot",
              disabled: inChannel.has(agent.id),
            })),
      );
      return;
    }
    /**
     * Who may use it is asked while adding it, not discovered later in a
     * settings panel. Both answers add the agent; they differ only in whether
     * a teammate's prompt may spend this account.
     */
    case "channel-agent-pick": {
      const split = value.indexOf("|");
      const repositoryId = value.slice(0, split);
      const agentId = value.slice(split + 1);
      // The button that opened the agent list, so this menu lands where the
      // last one was rather than beside the channels. It cannot be `node`:
      // `showPopover` closes the open popover before measuring, which detaches
      // the item just clicked, and a detached node measures as all zeroes and
      // puts the menu in the corner of the screen. Re-querying is the way
      // round that — the previous menu already does it — and this picked the
      // channel row's dots button, which is halfway up the sidebar.
      const anchor =
        document.querySelector(
          `[data-act="channel-agent-menu"][data-value="${CSS.escape(repositoryId)}"]`,
        ) ?? node;
      showMenu(anchor, [
        {
          act: "channel-agent-add-to",
          value: `${value}|personal`,
          label: "Add for just me",
          iconName: "shield",
        },
        {
          act: "channel-agent-add-to",
          value: `${value}|org`,
          label: "Add and share with the org",
          iconName: "users",
        },
      ]);
      return;
    }
    case "channel-agent-add-to": {
      const [repositoryId = "", agentId = "", scope = "personal"] = value.split("|");
      addChannelAgent(repositoryId, agentId);
      closePopover();
      render();
      refreshChannelInfoPopover();
      // A call sign, so the roster reads as names rather than as vendors and
      // owners. Chosen from the ones free in this channel, so it never lands
      // on one already in use; if every one is taken the person is asked
      // instead, since inventing "Vesper 2" is worse than saying so.
      const callSign = freeAgentCodeName(repositoryId);
      if (callSign !== undefined) {
        renameChannelAgent(repositoryId, agentId, callSign);
        render();
      } else {
        void promptForAgentName(repositoryId, agentId);
      }
      // Visibility is a property of the credential, so this is the same
      // account-wide switch the roster offers — said at the moment somebody
      // is already deciding who the agent is for.
      void applyProviderSetting(agentId, "visibility", scope)
        .then(() => render())
        .catch((error) => toast(error.message, "error"));
      return;
    }
    case "invite-revoke":
      void revokeInvitation(value)
        .then(() => {
          toast("Invitation revoked", "ok");
          render();
        })
        .catch((error) => toast(error.message, "error"));
      return;

    /* Settings */
    case "theme-toggle":
      setMyTheme(myTheme() === "light" ? "dark" : "light");
      render();
      return;
    case "avatar-clear":
      setMyAvatar(undefined);
      render();
      return;
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
    case "chan-term-submit":
      void runTerminalCommand(render);
      return;
    case "channel-thread-submit":
      submitThreadReply(render);
      return;
    case "channel-rename-form": {
      const input = $("[data-act='channel-rename-input']", form);
      if (input !== null) {
        renameChannelAgent(activeChannelId(), form.dataset.value, input.value);
      }
      const roleInput = $("[data-act='channel-role-input']", form);
      if (roleInput !== null) {
        setChannelAgentSetting(activeChannelId(), form.dataset.value, "role", roleInput.value.trim());
      }
      state.chatRenamingId = undefined;
      render();
      return;
    }
    default:
  }
});

/**
 * Reads a chosen image, shrinks it, and keeps it.
 *
 * Downscaled through a canvas to 128px because localStorage holds a few
 * megabytes for the whole origin and a phone photo is larger than that on its
 * own — storing it raw would break every other thing the app remembers.
 * Square-cropped from the centre, since every place it appears is a circle.
 */
async function pickAvatarFile(file) {
  if (file === undefined || !file.type.startsWith("image/")) {
    return;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    canvas
      .getContext("2d")
      ?.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        128,
        128,
      );
    setMyAvatar(canvas.toDataURL("image/jpeg", 0.82));
    render();
  } catch (error) {
    toast(`That image could not be read: ${error.message}`, "error");
  }
}

document.addEventListener("change", (event) => {
  const picker = event.target;
  if (picker?.dataset?.act === "avatar-pick") {
    void pickAvatarFile(picker.files?.[0]);
    return;
  }
  if (picker?.dataset?.act === "channel-attach-input") {
    void attachChannelImages([...(picker.files ?? [])]);
    // Cleared, or picking the same file twice in a row fires no change event
    // and the second attempt looks like a dead button.
    picker.value = "";
    return;
  }
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
      setChannelAgentSetting(activeChannelId(), agentId, field, node.value);
      render();
      return;
    }
    // Account-wide, unlike the two above: this is not how the agent presents
    // itself in this room but who may spend the credential behind it, so it
    // goes to the connection rather than the channel override.
    case "channel-agent-visibility": {
      const agentId = node.closest("[data-agent]")?.dataset.agent;
      if (!agentId) {
        return;
      }
      void applyProviderSetting(agentId, "visibility", node.value)
        .then(() => {
          toast(
            node.value === "org"
              ? "Everyone in the organization can use this agent"
              : "Only you can use this agent",
            "ok",
          );
          render();
        })
        .catch((error) => toast(error.message, "error"));
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
    // No thread id: this is the room itself, and the dots belong there only.
    sendTyping(activeChannelId(), undefined, node.value);
    updateComposerInput(node, render);
    return;
  }
  if (act === "chan-term-input") {
    // Deliberately no render: the drawer's transcript does not depend on
    // what is half-typed, and re-rendering would cost a caret restore on
    // every keystroke for nothing. Typing also leaves command recall, so
    // Up after editing starts from the newest entry again.
    state.termDraft = node.value;
    state.termSeek = undefined;
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
  if (act === "dm-input") {
    // Held without re-rendering. The draft is only read when the form is
    // submitted, and re-rendering the panel on every keystroke is what made
    // typing lag in the channel composer.
    state.dmDraft = node.value;
    return;
  }
  if (act === "channel-thread-input") {
    // Scoped to the open thread, so typing a reply raises dots inside that
    // thread and leaves the channel behind it quiet.
    sendTyping(activeChannelId(), state.activeChannelThread, node.value);
    // Held without re-rendering, like the channel and DM composers beside it.
    // This one kept the old behaviour and paid the old price: the draft is
    // read in two places — the textarea's own value and the submit — so a
    // render here rebuilt the whole app, threw away the transcript, the
    // sidebar and the roster, and reparsed the lot to redraw a character the
    // textarea was already showing. Then it hunted down the replacement
    // textarea to put the caret back, and `restoreChannelScroll` forced a
    // layout of the freshly parsed transcript. Once per keystroke.
    state.threadDraft = node.value;
    return;
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
  // Not when an IME is committing a candidate — that Enter belongs to the
  // composition, and sending on it posts a half-composed message.
  if (event.key === "Enter" && !event.shiftKey && !imeComposing(event)) {
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

/* Up and Down recall previously run commands in the terminal drawer. */
document.addEventListener("keydown", (event) => {
  if (event.target?.dataset?.act === "chan-term-input") {
    handleTerminalKeydown(event, render);
  }
  if (event.target?.dataset?.act === "chan-term-resize") {
    nudgeTerminalHeight(event, render);
  }
});

/* The terminal drawer's top edge is a drag handle. Started on pointerdown
   rather than click, and tracked on `window`, so the pointer outrunning the
   4px grip mid-drag does not drop the resize. */
document.addEventListener("pointerdown", (event) => {
  if (event.target?.dataset?.act === "chan-term-resize") {
    startTerminalResize(event, render);
  }
});

/* Enter sends a thread reply the same way it sends a channel message. */
document.addEventListener("keydown", (event) => {
  const node = event.target;
  if (node?.dataset?.act !== "channel-thread-input") {
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !imeComposing(event)) {
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
    event.key === "Enter" &&
    !imeComposing(event)
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
  if (activeChannelId() && agentId && state.chatRenamingId === agentId) {
    const nameInput = form === null ? null : $("[data-act='channel-rename-input']", form);
    const roleInput = form === null ? null : $("[data-act='channel-role-input']", form);
    if (nameInput !== null) {
      renameChannelAgent(activeChannelId(), agentId, nameInput.value);
    }
    if (roleInput !== null) {
      setChannelAgentSetting(activeChannelId(), agentId, "role", roleInput.value.trim());
    }
    state.chatRenamingId = undefined;
    render();
  }
});

window.addEventListener("hashchange", applyHash);

/* ---------------------------------------------------------------- boot ---- */

function showAuth() {
  closeSocket();
  // The signed-out screens theme themselves too. `renderNow` applies the
  // accent only once a principal exists, which is the one moment it certainly
  // does not — so sign-in, bootstrap and the invite screens were the single
  // part of the product that could not be re-themed, and greeted somebody
  // who had chosen green with the default purple every time their session
  // lapsed. `myAccent` answers with the last accent this browser saw while
  // there is nobody to ask.
  applyTheme();
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
  void loadGitHub().then(() => {
    if (state.route === "settings") {
      render();
    }
  });
  void loadInvitations().then(() => {
    if (state.route === "settings") {
      render();
    }
  });

  connectSocket((frame) => {
    // Transient, and never part of the audit replay — see `broadcastTransient`
    // on the hub. Re-rendered immediately so the dots appear while the other
    // person is still mid-word.
    // Transient too, and for the same reason — but unlike typing this one is
    // sent to the asker as well: they are the person waiting on it.
    if (frame?.type === "channel-agent-busy") {
      noteAgentBusy(frame);
      if (state.route === "chats" && !renameFieldFocused()) {
        render();
      }
      return;
    }
    // Private mail, delivered to the two people in it rather than to the
    // project (`sendToUsers`), and so never arriving here for anyone else.
    if (frame?.type === "direct-message") {
      noteDirectMessage(frame);
      if (state.activeDm !== undefined && !renameFieldFocused()) {
        // Reading it as it arrives, so the badge does not appear and clear.
        void api(
          `/projects/${encodeURIComponent(state.projectId)}/direct-messages/` +
            `${encodeURIComponent(state.activeDm)}/read`,
          { method: "POST" },
        ).catch(() => undefined);
      }
      if (!renameFieldFocused()) {
        render();
      }
      return;
    }
    if (frame?.type === "channel-typing") {
      noteTyping(frame);
      if (state.route === "chats" && !renameFieldFocused()) {
        render();
        // `typingOn` only drops expired entries when something reads it, and
        // the last frame is by definition the last thing that would have. One
        // sweep after the TTL is what actually takes the dots down when the
        // other person stops — without it they sat there until an unrelated
        // re-render happened to come along, which is to say forever.
        clearTimeout(typingSweep);
        typingSweep = setTimeout(() => {
          // Still mid-rename? Come back rather than taking the edit with it.
          if (renameFieldFocused()) {
            typingSweep = setTimeout(() => render(), TYPING_SWEEP_MS);
            return;
          }
          if (state.route === "chats") {
            render();
          }
        }, TYPING_SWEEP_MS);
      }
      return;
    }
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
    // News gets a banner before the store gets re-read: an ending or a
    // question is worth a sentence in the corner wherever the reader is,
    // which is the notifications tab's job done at the moment it matters.
    if (frame?.type === "audit") {
      const line = bannerLineForAudit(frame.event);
      if (line !== undefined) {
        popupBanner(line);
      }
    }
    // Canonical moved, so the file tree on screen is history now.
    //
    // `refresh` below already runs on every frame, but `ensureCodeData` keeps
    // what it loaded until something invalidates it and nothing ever did for
    // an advance. So the channel's Files panel went on showing the tree as it
    // was when the channel was first opened, however many tasks landed after —
    // a repository with three files in it displaying the one that existed when
    // somebody happened to open the tab, with a refresh button as the only way
    // to find out.
    if (frame?.type === "audit" && frame.event?.type === "canonical_promoted") {
      invalidateCode();
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
