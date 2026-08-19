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
  api,
  closeSocket,
  connectSocket,
  ensureSocketAlive,
  TYPING_SWEEP_MS,
  noteAgentBusy,
  noteDirectMessage,
  noteDirectMessageDeleted,
  ensureDirectMessages,
  loadChannelStats,
  bannerLineForAudit,
  announcedThrough,
  noteAnnounced,
  noteEventSequence,
  notificationSeen,
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
  myAccentSecondary,
  myAgentColor,
  myAvatar,
  setMyAvatar,
  myTheme,
  setMyTheme,
  myAgents,
  notifications,
  persist,
  isFavourite,
  flushChannelDrafts,
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
  ensureProviderUsage,
  ensureRepositoryGrants,
  refreshChannelMessages,
  refreshProviderUsage,
  addChannelAgent,
  removeChannelAgent,
  removeChannelAgentForUser,
  renameAgent,
  renameChannelAgent,
  setChannelAgentSetting,
  deleteRepository,
  leaveRepository,
  channelMessagesFor,
  deleteAllChannelThreads,
  deleteChannelMessageEntry,
  deleteChannelReplyEntry,
  deleteChannelThread,
  deleteDirectMessageEntry,
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
} from "./data.js";
import {
  $,
  $$,
  vendorMark,
  colorWheel,
  hexToHsl,
  hslToHex,
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
import {
  ensureAgentOptions,
  scrollThread,
  sendChat,
  truncateConversationFrom,
} from "./chat.js";
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
  answerAgentQuestion,
  applyProviderSetting,
  createInvitation,
  invitationLink,
  loadInvitations,
  loadPendingQuestions,
  pendingQuestionFor,
  readInvitation,
  revokeInvitation,
  saveAppearance,
  signInForInvitation,
} from "./data.js";
import {
  captureChannelScroll,
  channelInfoPopoverHtml,
  copyMessageText,
  handleComposerKeydown,
  jumpToUnreadOrLatest,
  openChannel,
  paintJumpToLatest,
  pickMention,
  pickSlashCommand,
  reactionPicker,
  renderChats,
  roleMenuItems,
  rosterMenuItems,
  restoreChannelAnchor,
  restoreChannelScroll,
  submitComposerMessage,
  submitThreadReply,
  updateComposerInput,
  updateThreadComposerInput,
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

/**
 * The signed-out screens, addressable.
 *
 * Every link on the auth shell used to be `href="#"`, so the URL never said
 * which form was showing and there was nothing to send somebody who only
 * needs to sign in — the address of the sign-in page was "open the app and
 * hope you are signed out". These hashes name the three forms instead, which
 * makes `/#signin` a link that can be pasted into a message.
 */
const AUTH_HASHES = new Map([
  ["signin", "login"],
  ["register", "register"],
  ["setup", "bootstrap"],
  ["forgot", "forgot"],
  ["reset", "reset"],
]);

/** The same table read the other way, for writing the URL back. */
const AUTH_MODE_HASHES = new Map(
  [...AUTH_HASHES].map(([hash, mode]) => [mode, hash]),
);

/**
 * The form the current URL asks for, if it asks for one at all.
 *
 * Only the first segment names the form: a reset link carries its secret in
 * the same fragment, as `#reset/<token>`. The fragment is never sent to the
 * server by the browser, which is the point — the secret stays out of access
 * logs and out of `Referer` headers on the way to whatever the page loads.
 */
function authModeFromHash() {
  return AUTH_HASHES.get(
    window.location.hash.replace(/^#/u, "").split("/")[0] ?? "",
  );
}

/** The secret out of a `#reset/<token>` link, or "" when there is none. */
function passwordResetTokenFromHash() {
  const hash = window.location.hash.replace(/^#/u, "");
  return hash.startsWith("reset/") ? hash.slice("reset/".length) : "";
}

/**
 * What the server said about the reset link this browser arrived on:
 * `{ email }` once it is confirmed usable, `{ error }` when it is not, and
 * undefined until the answer comes back.
 */
let resetState;
/** The mailed-code challenge returned before a self-service account exists. */
let pendingRegistration;

let authMode = "login";
/**
 * Which half of the invite screen is showing: "join" creates the account the
 * invitation names, "signin" claims it as an account that already exists.
 *
 * Undefined until the recipient chooses, so the answer from the server —
 * whether the address already has an account — decides the first view and a
 * later choice overrides it rather than being overwritten on every re-render.
 */
let inviteMode;
/** Pending re-render that takes stale typing dots down once their TTL passes. */
let typingSweep;

/**
 * The screen somebody lands on when they open an invite link.
 *
 * Rendered on the auth shell because the recipient may have no account yet —
 * that is what an invitation is for — so it has to work before there is
 * anything to sign in to. It cannot only work that way, though: an
 * invitation sent to somebody who is already on Lattice is the ordinary case
 * for a second team or a second repository, and offering that person nothing
 * but "choose a password" is a dead end, because the address is taken and the
 * only account it could belong to is theirs.
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
  // The server says whether the address already has an account, so the first
  // view is the one that can actually succeed. Whoever the invitation names
  // is the only person who could sign in as it, so this is a shortcut rather
  // than a decision taken away: the other form is one link below either way.
  const signIn =
    inviteMode === undefined
      ? invite.accountExists === true
      : inviteMode === "signin";
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
            ${esc(invite.role)}. ${
              signIn
                ? "Sign in and the invitation is yours."
                : "Choose a password and you are in."
            }</p>
        </div>
      </div>
      <form class="auth-card" data-act="${
        signIn ? "invite-signin" : "invite-accept"
      }">
        <label class="field">
          <span>Email address</span>
          <input class="input" value="${esc(invite.email)}" disabled>
        </label>
        ${
          signIn
            ? ""
            : `<label class="field">
          <span>Your name</span>
          <input class="input" name="displayName" autocomplete="name" required>
        </label>`
        }
        <label class="field">
          <span>${signIn ? "Your password" : "Choose a password"}</span>
          <input class="input" name="password" type="password" minlength="12"
            autocomplete="${signIn ? "current-password" : "new-password"}"
            required placeholder="••••••••••••">
        </label>
        ${
          // Only when the password is being chosen. Retyping one you already
          // know is friction with nothing to catch.
          signIn
            ? ""
            : `<label class="field">
          <span>Confirm password</span>
          <input class="input" name="confirmPassword" type="password"
            minlength="12" autocomplete="new-password" required
            placeholder="••••••••••••">
        </label>`
        }
        <button class="btn btn-primary btn-wide" type="submit">
          ${signIn ? "Sign in and join" : "Accept and join"}
        </button>
        <p class="form-msg" id="auth-msg" role="alert"></p>
      </form>
      <p class="auth-foot">${
        signIn
          ? `No account for ${esc(invite.email)} yet? <a class="link-muted" href="#" data-act="invite-mode" data-value="join">Create one</a>.`
          : `Already have a Lattice account? <a class="link-muted" href="#" data-act="invite-mode" data-value="signin">Sign in instead</a>.`
      }</p>
    </div>
  </main>`;
}

function renderRegistrationConfirmation() {
  // Nothing was emailed when the server says the code went to its log, so the
  // screen says that rather than sending somebody to watch an empty inbox.
  const logOnly = pendingRegistration?.delivery === "log";
  return `<main class="auth-shell">
    <div class="auth-box">
      <div class="auth-mascot">
        ${brandMark(54)}
        <div>
          <h1>${logOnly ? "Your code is in the server log" : "Check your email"}</h1>
          <p>${
            logOnly
              ? `No mail relay is configured on this deployment, so no email was sent to ${esc(
                  pendingRegistration?.email ?? "your email address",
                )}. The six-digit code was written to the control plane log with the <code>[mail]</code> prefix — an operator can read it there, or set a mail relay so codes are emailed.`
              : `Enter the six-digit code sent to ${esc(
                  pendingRegistration?.email ?? "your email address",
                )}.`
          }</p>
        </div>
      </div>
      <form class="auth-card" data-act="registration-confirmation">
        <label class="field">
          <span>Confirmation code</span>
          <input class="input" name="code" type="text" inputmode="numeric"
            autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6"
            placeholder="000000" required autofocus>
        </label>
        <button class="btn btn-primary btn-wide" type="submit">
          Confirm and create account
        </button>
        <p class="form-msg" id="auth-msg" role="alert"></p>
      </form>
      <p class="auth-foot">The code expires shortly. <a class="link-muted"
        href="#signin" data-act="auth-mode" data-value="login">Return to sign in</a>.</p>
    </div>
  </main>`;
}

function renderAuth() {
  if (authMode === "forgot" || authMode === "reset") {
    return renderPasswordReset();
  }
  if (authMode === "register" && pendingRegistration !== undefined) {
    return renderRegistrationConfirmation();
  }
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
        ${
          // Asked for only where the address is being chosen. A typo in it is
          // not recoverable by the person who made it: every way back into the
          // account — the reset link most of all — goes to the address as
          // typed, so an account created against a mistyped one is lost at the
          // moment it is created.
          bootstrap || register
            ? `<label class="field">
          <span>Confirm email address</span>
          <input class="input" name="confirmEmail" type="email"
            autocomplete="off" placeholder="you@company.com" required>
        </label>`
            : ""
        }
        <label class="field">
          <span>Password</span>
          <input class="input" name="password" type="password" minlength="12"
            autocomplete="${bootstrap || register ? "new-password" : "current-password"}"
            placeholder="••••••••••••" required>
        </label>
        ${
          bootstrap || register
            ? `<label class="field">
          <span>Confirm password</span>
          <input class="input" name="confirmPassword" type="password"
            minlength="12" autocomplete="new-password" required
            placeholder="••••••••••••">
        </label>`
            : ""
        }

        ${
          bootstrap || register
            ? ""
            : // No "remember me": sessions run to a fixed server-side lifetime and
              // there is no per-login control over it, so the checkbox could
              // only ever have been decoration.
              `<p class="auth-hint"><a class="link-muted" href="#forgot"
                data-act="auth-mode" data-value="forgot">Forgotten your
                password?</a></p>`
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
          ? `This control plane has no owner yet. <a class="link-muted" href="#setup" data-act="auth-mode" data-value="bootstrap">Run first-time setup</a>.`
          : bootstrap
            ? `Already have an account? <a class="link-muted" href="#signin" data-act="auth-mode" data-value="login">Sign in</a>.`
            : register
              ? `Already have an account? <a class="link-muted" href="#signin" data-act="auth-mode" data-value="login">Sign in</a>.`
              : `New here? <a class="link-muted" href="#register" data-act="auth-mode" data-value="register">Create an account</a>.`
      }</p>
    </div>
  </main>`;
}

/**
 * The two halves of recovering a forgotten password.
 *
 * "forgot" asks for the address; "reset" is what the link in the mail opens,
 * and chooses the new password. One function because they are one flow and
 * share the shell — and because the reset half has to say something useful
 * when the link has expired, which is the state people actually arrive in.
 */
function renderPasswordReset() {
  const reset = authMode === "reset";
  const token = passwordResetTokenFromHash();
  const dead = reset && resetState?.error !== undefined;
  return `<main class="auth-shell">
    <div class="auth-box">
      <div class="auth-mascot">
        ${brandMark(54)}
        <div>
          <h1>${reset ? "Choose a new password" : "Reset your password"}</h1>
          <p>${
            reset
              ? dead
                ? esc(resetState.error)
                : resetState?.email === undefined
                  ? "Checking your link…"
                  : `Setting a new password for ${esc(resetState.email)}.`
              : "Tell us the address on your account and we will send a link to it."
          }</p>
        </div>
      </div>
      ${
        reset
          ? dead
            ? ""
            : `<form class="auth-card" data-act="password-reset">
        <input type="hidden" name="token" value="${esc(token)}">
        <label class="field">
          <span>New password</span>
          <input class="input" name="password" type="password" minlength="12"
            autocomplete="new-password" placeholder="••••••••••••" required>
        </label>
        <label class="field">
          <span>Confirm new password</span>
          <input class="input" name="confirmPassword" type="password"
            minlength="12" autocomplete="new-password" required
            placeholder="••••••••••••">
        </label>
        <button class="btn btn-primary btn-wide" type="submit">
          Set password and sign in
        </button>
        <p class="form-msg" id="auth-msg" role="alert"></p>
      </form>`
          : `<form class="auth-card" data-act="password-forgot">
        <label class="field">
          <span>Email address</span>
          <input class="input" name="email" type="email" autocomplete="username"
            placeholder="you@company.com" required>
        </label>
        <button class="btn btn-primary btn-wide" type="submit">
          Email me a reset link
        </button>
        <p class="form-msg" id="auth-msg" role="alert"></p>
      </form>`
      }
      <p class="auth-foot">${
        dead
          ? `<a class="link-muted" href="#forgot" data-act="auth-mode" data-value="forgot">Ask for a new link</a>.`
          : `Remembered it? <a class="link-muted" href="#signin" data-act="auth-mode" data-value="login">Sign in</a>.`
      }</p>
    </div>
  </main>`;
}

/**
 * Checks the link before showing the form behind it.
 *
 * Without this, somebody arriving on a week-old link would type a password
 * twice and only then be told the link was dead. The answer also names the
 * address, so the form can say whose password is being set — which is the
 * difference between trusting the page and guessing at it.
 */
async function loadPasswordReset() {
  const token = passwordResetTokenFromHash();
  if (token === "") {
    resetState = { error: "That reset link is incomplete. Ask for a new one." };
  } else {
    try {
      const answer = await api(
        `/auth/password-reset/${encodeURIComponent(token)}`,
      );
      resetState = { email: answer?.reset?.email ?? "" };
    } catch (error) {
      resetState = { error: error.message };
    }
  }
  const root = $("#auth-root");
  if (root !== null && !root.hidden && authMode === "reset") {
    root.innerHTML = renderAuth();
  }
}

/** Asks for a reset link. The answer is the same whether or not it exists. */
async function submitPasswordResetRequest(form) {
  const data = new FormData(form);
  const message = $("#auth-msg");
  try {
    const answer = await api("/auth/password-reset", {
      method: "POST",
      body: { email: String(data.get("email") ?? "") },
    });
    if (message !== null) {
      // Deliberately not "we sent it": the server does not say whether the
      // address has an account, and neither does this.
      message.textContent =
        answer?.message ??
        "If that address has an account, a reset link is on its way to it.";
    }
    form.reset();
  } catch (error) {
    if (message !== null) {
      message.textContent = error.message;
    }
  }
}

/**
 * Sets the new password and lands inside.
 *
 * The response carries the session, exactly as registering does, because
 * somebody who has just proved they hold the mailbox and chosen a password
 * has no reason to be asked for that password again on the next screen.
 */
async function submitPasswordReset(form) {
  const data = new FormData(form);
  const message = $("#auth-msg");
  const password = String(data.get("password") ?? "");
  const confirmation = String(data.get("confirmPassword") ?? "");
  if (password !== confirmation) {
    if (message !== null) {
      message.textContent = "Passwords do not match";
    }
    return;
  }
  try {
    await api("/auth/password-reset/confirm", {
      method: "POST",
      body: {
        token: String(data.get("token") ?? ""),
        password,
        confirmPassword: confirmation,
      },
    });
    resetState = undefined;
    authMode = "login";
    window.location.hash = "#chats";
    await boot();
    toast("Password changed", "ok");
  } catch (error) {
    if (message !== null) {
      message.textContent = error.message;
    }
  }
}

/**
 * Whether the retyped address and password match what they confirm.
 *
 * Checked here as well as on the server so the answer is instant and the form
 * keeps what was typed. The server checks too — a browser is not where a rule
 * lives — but a round trip to be told about a typo is a poor way to learn of
 * one. Absent fields pass: a form that does not ask twice has nothing to
 * disagree with.
 */
function confirmationsMatch(data) {
  const pairs = [
    ["email", "confirmEmail", "Email addresses do not match"],
    ["password", "confirmPassword", "Passwords do not match"],
  ];
  for (const [field, confirmation, complaint] of pairs) {
    const typed = data.get(confirmation);
    if (typed === null) {
      continue;
    }
    const original = String(data.get(field) ?? "").trim();
    const retyped = String(typed).trim();
    // The address is compared case-insensitively because the account stores
    // it that way; a capital letter in one box is not a mistake to report.
    const same =
      field === "email"
        ? original.toLowerCase() === retyped.toLowerCase()
        : original === retyped;
    if (!same) {
      const message = $("#auth-msg");
      if (message !== null) {
        message.textContent = complaint;
      }
      return false;
    }
  }
  return true;
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
    // The URL still names the form that was just submitted, and boot now
    // honours that name by signing out again. Naming the landing screen
    // instead is what lets the session survive its own creation.
    window.location.hash = "#chats";
    await boot();
  } catch (error) {
    $("#auth-msg").textContent = error.message;
  }
}

async function submitBootstrap(form) {
  const data = new FormData(form);
  if (!confirmationsMatch(data)) {
    return;
  }
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
        confirmEmail: String(data.get("confirmEmail") ?? ""),
        password: String(data.get("password") ?? ""),
        confirmPassword: String(data.get("confirmPassword") ?? ""),
      },
    });
    authMode = "login";
    window.location.hash = "#chats";
    await boot();
  } catch (error) {
    $("#auth-msg").textContent = error.message;
  }
}

/**
 * Creates the account and goes straight in.
 *
 * Email confirmation is switched off on this deployment, so the server
 * answers with a session and the app opens on the chats screen — the same
 * landing an invitation gets. A deployment that turns confirmation back on
 * answers with a challenge instead of a session, and the code screen below
 * still handles it; which one came back is what the response says.
 */
async function submitRegister(form) {
  const data = new FormData(form);
  if (!confirmationsMatch(data)) {
    return;
  }
  const organizationName = String(data.get("organizationName") ?? "").trim();
  try {
    const registration = await api("/auth/register", {
      method: "POST",
      body: {
        displayName: String(data.get("displayName") ?? ""),
        email: String(data.get("email") ?? ""),
        confirmEmail: String(data.get("confirmEmail") ?? ""),
        password: String(data.get("password") ?? ""),
        confirmPassword: String(data.get("confirmPassword") ?? ""),
        // Omitted rather than sent empty, so the server picks its default
        // instead of naming a team the empty string.
        ...(organizationName === "" ? {} : { organizationName }),
      },
    });
    // Signed in already: the account exists and the session cookie is set.
    if (registration.user !== undefined) {
      pendingRegistration = undefined;
      authMode = "login";
      window.location.hash = "#chats";
      await boot();
      return;
    }
    pendingRegistration = {
      registrationId: registration.registrationId,
      expiresAt: registration.expiresAt,
      email: String(data.get("email") ?? "").trim(),
      // "log" means this deployment has no mail relay, so nothing was sent.
      delivery: registration.delivery === "log" ? "log" : "mailbox",
    };
    $("#auth-root").innerHTML = renderAuth();
  } catch (error) {
    $("#auth-msg").textContent = error.message;
  }
}

/** Finishes sign-up and enters the application only after the code is valid. */
async function submitRegistrationConfirmation(form) {
  const data = new FormData(form);
  const message = $("#auth-msg");
  try {
    await api("/auth/register/confirm", {
      method: "POST",
      body: {
        registrationId: pendingRegistration?.registrationId ?? "",
        code: String(data.get("code") ?? "").trim(),
      },
    });
    pendingRegistration = undefined;
    authMode = "login";
    window.location.hash = "#chats";
    await boot();
  } catch (error) {
    if (message !== null) {
      message.textContent = error.message;
    }
  }
}

/** Where both invite forms land once the invitation is theirs. */
async function enterAfterInvitation() {
  state.invite = undefined;
  state.inviteToken = undefined;
  inviteMode = undefined;
  window.location.hash = "#chats";
  await boot();
  toast("Welcome aboard", "ok");
}

function inviteError(error) {
  const message = $("#auth-msg");
  if (message !== null) {
    message.textContent = error.message;
  }
}

/** Creates the account the invitation names, then claims it. */
async function submitInviteAccept(form) {
  const data = new FormData(form);
  if (!confirmationsMatch(data)) {
    return;
  }
  try {
    await acceptInvitation(
      state.inviteToken,
      String(data.get("displayName") ?? ""),
      String(data.get("password") ?? ""),
    );
    await enterAfterInvitation();
  } catch (error) {
    // The address turned out to be taken — the preview was read before the
    // account existed, or a stale tab is being submitted. Nothing typed here
    // can succeed, so move to the form that can rather than repeat a refusal.
    if (error.code === "account_exists") {
      inviteMode = "signin";
      showInvite();
      inviteError(error);
      return;
    }
    inviteError(error);
  }
}

/**
 * Signs in as the invited address and claims the invitation with that session.
 *
 * Two requests rather than one endpoint that takes a password: accepting
 * already trusts a session over anything in the body — precisely because the
 * link is not proof of who is holding it — and a second way to check a
 * password is a second place for that check to be wrong.
 */
async function submitInviteSignIn(form) {
  const data = new FormData(form);
  try {
    await signInForInvitation(
      state.invite?.email ?? "",
      String(data.get("password") ?? ""),
    );
    await acceptInvitation(state.inviteToken);
    await enterAfterInvitation();
  } catch (error) {
    inviteError(error);
  }
}

/* -------------------------------------------------------------- shell ---- */

/* No `sidebar()` here any more, and no `NAV` list behind it.
 *
 * The outer rail — brand, repository switcher, Chats/Settings links, account
 * card, plan card — stopped being rendered when the channel sidebar became the
 * navigation, and then sat in this file for a while as markup nothing could
 * reach. Everything it held has somewhere else to be: the brand and Settings
 * are the crown of `chanSidebar` (screen-chats.js), the account is the topbar
 * avatar's menu, and the failure-only health line is at that sidebar's foot.
 * Its stylesheet block, its phone drawer, the `nav-scrim` and the hamburger
 * that opened it went with it — a menu button that opens a panel which is no
 * longer rendered is worse than no button at all.
 */

function topbar() {
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
  return `<div class="scroll" data-scroll-key="settings"><div class="page">
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
              // The owner suffix is dropped from a vendor-label fallback
              // ("Claude (Nathan)" reads as "Claude" in your own settings),
              // but never from a name somebody chose — an agent called
              // "Athena (night shift)" keeps every word of it.
              const label =
                agent.hasName === true
                  ? agent.name
                  : agent.name.replace(/\s*\(.*\)$/u, "");
              const renaming = state.settingsRenamingId === agent.id;
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
                  ${
                    renaming
                      ? `<form class="agent-rename" data-act="agent-rename-form"
                          data-value="${esc(agent.id)}">
                          <input class="input" data-act="settings-rename-input"
                            data-value="${esc(agent.id)}" maxlength="40"
                            aria-label="Agent name" value="${esc(label)}">
                          <button class="btn btn-sm btn-primary" type="submit">Save</button>
                        </form>`
                      : `<div class="sr-title">${esc(label)}</div>`
                  }
                  <div class="sr-sub${state_.cls}">${esc(state_.text)}${
                    agent.detail ? ` — ${esc(agent.detail)}` : ""
                  }${
                    renaming
                      ? " — this name is what it answers to in every repository"
                      : ""
                  }</div>
                </span>
                <span class="sr-ctl">
                  ${
                    // A name belongs to a connection: there is nothing to
                    // rename on a vendor this account has never connected,
                    // and the server says so rather than guessing. An expired
                    // sign-in still has one, so it can still be renamed.
                    renaming || !(agent.connected || agent.needsReconnect)
                      ? ""
                      : `<button type="button" class="btn btn-sm"
                          data-act="agent-rename-toggle"
                          data-value="${esc(agent.id)}"
                          title="Rename this agent everywhere">Rename</button>`
                  }
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

/**
 * Commits a rename typed in Settings.
 *
 * The field closes first and the screen redraws from the optimistic local
 * name `renameAgent` applies, then again when the server has answered — a
 * refused name (a duplicate, or one the provider rejects) toasts and the old
 * name comes back on that second render.
 */
function commitAgentRename(providerId, name) {
  state.settingsRenamingId = undefined;
  render();
  void renameAgent(providerId, name).then(() => render());
}

/**
 * Writes one channel's role for one agent, from the details tab's inline
 * field.
 *
 * The repository is read off the field rather than taken from the open
 * channel: the tab lists every room the agent belongs to, and the whole point
 * of the list is that a role is per repository — the same agent can be the
 * reviewer here and the migration hand next door.
 *
 * `defaultValue` is moved to the committed text because Enter and the blur it
 * causes both arrive, and a second write would be a second request saying the
 * same thing.
 */
function commitChannelRole(input) {
  const agentId = input.dataset.value;
  const repositoryId = input.dataset.repo;
  if (!agentId || !repositoryId || input.value === input.defaultValue) {
    return;
  }
  const role = input.value.trim();
  input.defaultValue = role;
  setChannelAgentSetting(repositoryId, agentId, "role", role, render);
  render();
}

/**
 * Which role field opened the picker.
 *
 * A menu item carries one value — the role — and the field it was opened from
 * is the rest of the address. Remembered here rather than packed into that
 * value because an agent id already contains a colon and a repository id is
 * free text, so any separator chosen for them would be one somebody could
 * type.
 */
let roleMenuTarget;

/** The role field the picker was opened from, if it is still on screen. */
function openRoleInput() {
  if (roleMenuTarget === undefined) {
    return null;
  }
  return (
    $$("[data-act='agent-role-input']").find(
      (node) =>
        node.dataset.value === roleMenuTarget.agentId &&
        node.dataset.repo === roleMenuTarget.repositoryId,
    ) ?? null
  );
}

/**
 * Writes a role chosen from the picker, exactly as typing it would.
 *
 * The field is set first so it never disagrees with what was just picked in
 * the frame before the redraw, and `defaultValue` moves with it so the blur
 * that follows does not send the same word a second time.
 */
function pickChannelRole(role) {
  const target = roleMenuTarget;
  if (target === undefined) {
    return;
  }
  const input = openRoleInput();
  if (input !== null) {
    input.value = role;
    input.defaultValue = role;
  }
  setChannelAgentSetting(target.repositoryId, target.agentId, "role", role, render);
  render();
}

function appearanceCard() {
  const accent = myAccent();
  const agentColor = myAgentColor();
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

    ${colourRow(
      "set-accent",
      "Primary colour",
      `Accents, highlights, and the active state across the interface. Only
       you see this.`,
      accent,
    )}

    ${colourRow(
      "set-accent-secondary",
      "Secondary colour",
      `The other half of a pair: the second way into a repository, the far end
       of a progress bar, the thread beside a channel. Somewhere the interface
       shows two things and only one of them was coloured.`,
      myAccentSecondary(),
    )}

    ${colourRow(
      "set-agent-color",
      "Your agents' colour",
      `Every agent you connect is drawn in this colour, on shared views too —
       so your teammates can tell your agents from theirs. The mark says which
       vendor; the colour says whose.`,
      agentColor,
      `<div class="doodle-preview" style="color:${esc(agentColor)}">
        ${["anthropic", "cursor", "openai", "google", "xai", "deepseek"]
          .map(
            (kind) => `<span class="doodle-chip">
              <span class="doodle">${vendorMark(kind)}</span>
              <b>${esc(agentLabelOf(kind))}</b>
            </span>`,
          )
          .join("")}
      </div>`,
    )}
  </section>`;
}

/**
 * One colour: a swatch, and a button that opens the wheel.
 *
 * The wheel used to sit open under every colour, which meant three discs and
 * three sliders in a card whose other rows are one line each — the settings
 * were the small part of the settings screen. A swatch already answers "what
 * colour is this"; the wheel is only wanted by somebody who came to change it,
 * so it waits behind the press that says so.
 *
 * `state.openWheel` holds one act at a time, so opening a second wheel closes
 * the first rather than stacking them.
 */
function colourRow(act, title, sub, current, extra = "") {
  const open = state.openWheel === act;
  return `<div class="set-row">
      <span class="sr-body">
        <div class="sr-title">${title}</div>
        <div class="sr-sub">${sub}</div>
      </span>
      <span class="sr-ctl colour-pick">
        <span class="colour-dot" style="background:${esc(current)}"></span>
        <button type="button" class="btn btn-quiet" data-act="wheel-open"
          data-value="${esc(act)}" aria-expanded="${open}">
          ${open ? "Done" : "Change colour"}
        </button>
      </span>
    </div>
    ${
      open
        ? `<div class="wheel-drop">${colorWheel(act, current)}${extra}</div>`
        : ""
    }`;
}

/**
 * Which colour a point on the wheel is.
 *
 * Angle from the centre is hue, distance is saturation, and anything past the
 * rim is clamped to the rim rather than ignored — a click that lands a pixel
 * outside a circle is a click on the edge of it, and refusing it reads as a
 * dead control.
 */
function wheelColorAt(node, event, current) {
  const box = node.getBoundingClientRect();
  const x = (event.clientX - box.left) / box.width - 0.5;
  const y = (event.clientY - box.top) / box.height - 0.5;
  const hue = (Math.atan2(y, x) * 180) / Math.PI + 90;
  const saturation = Math.min(Math.hypot(x, y) * 2, 1);
  return hslToHex(hue, saturation, hexToHsl(current).l);
}

/** The appearance field a wheel's `data-act` belongs to. */
const WHEEL_FIELD = {
  "set-accent": "accent",
  "set-accent-secondary": "accentSecondary",
  "set-agent-color": "agentColor",
};

/** What each of those fields currently reads as. */
const WHEEL_VALUE = {
  accent: myAccent,
  accentSecondary: myAccentSecondary,
  agentColor: myAgentColor,
};

function currentWheelColor(field) {
  return (WHEEL_VALUE[field] ?? myAccent)();
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
 * Removes one agent membership after naming the exact, limited consequence.
 * "Delete" in the compact row menu means delete it from this chat; the agent
 * account and its work elsewhere remain intact.
 */
async function removeChannelAgentAction(agentId, removeAny = false) {
  const repositoryId = activeChannelId();
  const agent = channelAgentsFor(repositoryId).find(
    (candidate) => candidate.id === agentId,
  );
  if (!repositoryId || agent === undefined) {
    return;
  }
  const confirmed = await showModal({
    title: `Delete ${agent.name} from this chat?`,
    subtitle: "Its account and work in other chats stay intact.",
    confirm: "Delete",
  });
  if (confirmed === undefined) {
    return;
  }
  if (removeAny) {
    // Teammate entries are keyed `${userId}:${provider}` by
    // `channelAgentsFor`; the existing moderation operation takes the same
    // two values separately.
    const separatorIndex = agentId.indexOf(":");
    removeChannelAgentForUser(
      repositoryId,
      agentId.slice(0, separatorIndex),
      agentId.slice(separatorIndex + 1),
    );
  } else {
    removeChannelAgent(repositoryId, agentId);
  }
  state.chatSettingsOpenId = undefined;
  render();
  refreshChannelInfoPopover();
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

/**
 * Deleting one message from the channel.
 *
 * The confirmation is written from what this particular message is, because
 * the three outcomes are genuinely different things to agree to: a line with
 * nothing hanging off it simply goes, a thread's opening message is blanked
 * and its replies stay, and a message whose task is still running takes the
 * run with it. Somebody who is told "this cannot be undone" and nothing else
 * cannot tell which of those they just asked for.
 */
async function deleteChannelMessageAction(repositoryId, messageId) {
  const entry = channelMessagesFor(repositoryId).find(
    (candidate) => candidate.id === messageId,
  );
  const hasThread = (entry?.replies ?? []).length > 0;
  // A guess, and only for the wording: the channel is not sent task statuses,
  // so "carries a task and has not been marked ended" is the closest the
  // client gets to "still going". The server decides what is actually stopped
  // and says so in the reply.
  const running = entry?.taskId !== undefined && entry?.endedAt === undefined;
  const confirmed = await showModal({
    title: "Delete this message?",
    subtitle: [
      hasThread
        ? "The replies under it stay — they are the agent's account of the " +
          "work, and other people have read them. The message itself is " +
          "replaced with a note that it was deleted."
        : "It goes for everyone in this channel.",
      running
        ? "The task it asked for is still going, so it will be stopped."
        : "",
      "This cannot be undone.",
    ]
      .filter((line) => line !== "")
      .join(" "),
    confirm: "Delete",
  });
  if (confirmed === undefined) {
    return;
  }
  try {
    const { cancelledTask } = await deleteChannelMessageEntry(
      repositoryId,
      messageId,
    );
    if (state.activeChannelThread === messageId && !hasThread) {
      state.activeChannelThread = undefined;
    }
    toast(
      cancelledTask ? "Message deleted, and its task stopped" : "Message deleted",
      "ok",
    );
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

/** Deleting one reply from inside a thread. */
async function deleteChannelReplyAction(repositoryId, messageId, replyId) {
  const confirmed = await showModal({
    title: "Delete this reply?",
    subtitle:
      "It goes for everyone reading this thread. This cannot be undone.",
    confirm: "Delete",
  });
  if (confirmed === undefined) {
    return;
  }
  try {
    await deleteChannelReplyEntry(repositoryId, messageId, replyId);
    toast("Reply deleted", "ok");
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * Deleting a message from the private agent conversation, which rewinds it.
 *
 * The confirmation says how many messages go rather than "this one", because
 * that is what happens — see `truncateConversationFrom` for why it cannot be
 * one — and somebody scrolling back to delete an early message would
 * otherwise lose the whole conversation to a dialog that promised one line.
 */
async function deleteChatMessageAction(index) {
  const agent = currentAgent();
  if (agent === undefined || !Number.isInteger(index)) {
    return;
  }
  const following = (state.conversations[agent.id] ?? []).length - index;
  if (following <= 0) {
    return;
  }
  const confirmed = await showModal({
    title:
      following === 1
        ? "Delete this message?"
        : `Delete this message and the ${String(following - 1)} after it?`,
    subtitle:
      "This conversation is replayed to the agent on every turn, so it is " +
      "rewound to before this message rather than having one lifted out of " +
      "the middle. The agent's own session is dropped with it, so nothing " +
      "here is remembered on its side either.",
    confirm: "Delete",
  });
  if (confirmed === undefined) {
    return;
  }
  truncateConversationFrom(agent.id, index);
  render();
}

/** Unsending one direct message, from both sides of the conversation. */
async function deleteDirectMessageAction(userId, messageId) {
  const confirmed = await showModal({
    title: "Delete this message?",
    subtitle:
      "It goes from your side and theirs. This cannot be undone.",
    confirm: "Delete",
  });
  if (confirmed === undefined) {
    return;
  }
  try {
    await deleteDirectMessageEntry(userId, messageId);
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
 * Which draft an upload lands in, and what the reader looks at while it does.
 *
 * Three composers stage images: the channel bar, the thread panel's reply
 * box, and a direct message. Everything about the upload is identical, so the
 * only difference worth naming is where the reference goes, which counter the
 * "attaching…" note reads, and which textarea gets the caret back — three
 * strings, rather than another copy of the loop below drifting away.
 */
const ATTACH_TARGETS = {
  channel: {
    draft: "chatDraft",
    counter: "attaching",
    input: "channel-input",
  },
  thread: {
    draft: "threadDraft",
    counter: "threadAttaching",
    input: "channel-thread-input",
  },
  dm: {
    draft: "dmDraft",
    counter: "dmAttaching",
    input: "dm-input",
  },
};

/**
 * Puts images in the draft, as the reference a message carries.
 *
 * Uploaded one at a time and appended as they land, so a slow one does not
 * hold up the others and a failure loses only itself. The draft is written
 * through `state` and re-rendered because the textarea is rebuilt on render
 * anyway — this is one of the few places a composer render is the point
 * rather than the cost.
 */
async function attachChannelImages(files, target = "channel") {
  const where = ATTACH_TARGETS[target] ?? ATTACH_TARGETS.channel;
  const repositoryId = activeChannelId();
  const dmUserId = target === "dm" ? state.activeDm : undefined;
  const images = files.filter((file) => file.type.startsWith("image/"));
  if (
    repositoryId === undefined ||
    images.length === 0 ||
    (target === "dm" && dmUserId === undefined)
  ) {
    if (files.length > 0) {
      toast("Only images can be attached.", "error");
    }
    return;
  }
  state[where.counter] = (state[where.counter] ?? 0) + images.length;
  render();
  for (const file of images) {
    try {
      const id = await uploadAttachment(repositoryId, file);
      // A DM upload belongs to the person whose panel started it. If the
      // reader opens a different conversation before the bytes arrive, do
      // not append the old reference to the new person's draft.
      if (target === "dm" && state.activeDm !== dmUserId) {
        continue;
      }
      const alt = file.name.replace(/\.[^.]+$/u, "").slice(0, 60);
      const draft = state[where.draft] ?? "";
      state[where.draft] = `${draft}${
        draft === "" || draft.endsWith("\n") ? "" : "\n"
      }![${alt}](attachment:${id})\n`;
    } catch (error) {
      toast(error.message ?? "That image could not be attached.", "error");
    } finally {
      state[where.counter] = Math.max(0, (state[where.counter] ?? 1) - 1);
      render();
    }
  }
  $(`[data-act='${where.input}']`)?.focus();
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
    // Success is one status, so it is the one named. This used to list the
    // failures instead — blocked, noop, policy_failed — and treat everything
    // else as progress, which quietly made `conflict`, `validation_failed`,
    // `stale` and `empty` read as "reverting…". A revert that failed
    // validation announced itself as one that was on its way, and the reader
    // went looking in the channel for a result that was never coming.
    //
    // The endpoint is synchronous — it plans, validates and promotes before
    // it answers — so there is no case where the outcome is genuinely still
    // unknown here.
    if (result?.status !== "integrated") {
      toast(result?.explanation ?? "The revert was refused", "error");
      return;
    }
    const reverted = result?.files?.length ?? 0;
    toast(
      reverted === 0
        ? "Reverted — the repository is back to where it was"
        : `Reverted — ${reverted} file${reverted === 1 ? "" : "s"} back to ` +
            `where they were`,
      "ok",
    );
    await refresh({ quiet: true });
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
  const element = document.documentElement;
  const root = element.style;

  // Let the stylesheet choose the neutral grounds for this theme, then nudge
  // the page and conversation toward the chosen accent. Two percent is just
  // enough for the room to belong to the colour without turning the neutral
  // surface ramp into a second accent palette. Remove the previous inline
  // values first so switching themes always starts from that theme's own base.
  element.dataset.theme = light ? "light" : "dark";
  root.removeProperty("--bg");
  root.removeProperty("--room-tint");
  const neutralGround = getComputedStyle(element)
    .getPropertyValue("--bg")
    .trim();
  const neutralRoom = getComputedStyle(element)
    .getPropertyValue("--bg-chat")
    .trim();
  const ground = mix(
    neutralGround || (light ? "#ddd7cb" : "#141414"),
    accent,
    0.02,
  );
  const roomTint = mix(
    neutralRoom || (light ? "#f1ede3" : "#262626"),
    accent,
    0.02,
  );
  root.setProperty("--bg", ground);
  root.setProperty("--room-tint", roomTint);
  root.setProperty("--accent", accent);
  // "Bright" means "stands out from the ground", not "closer to white".
  //
  // Every one of these was derived for a dark ground and used on both themes,
  // which is why the highlights washed out the moment light was switched on.
  // `--accent-bright` carries accent-coloured *text* — tab labels, counts, the
  // active file, the thread's own name — and lightening a purple by a third
  // puts it a shade or two off cream: the same move that makes it legible on
  // the dark ground makes it vanish on #e8e2d4. Measured, the default accent
  // went from
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
    light ? readableOn(accent, ground, 4.5) : mix(accent, "#ffffff", 0.32),
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
  // The second colour, derived exactly as the first is so the two behave
  // identically under both themes. Fewer variants, deliberately: a secondary
  // that grew its own dim, bright and strong-wash would be a second theme
  // rather than a second colour, and every surface would then have to decide
  // which one it belonged to.
  const second = myAccentSecondary();
  root.setProperty("--accent-2", second);
  root.setProperty(
    "--accent-2-bright",
    light ? readableOn(second, "#e8e2d4", 4.5) : mix(second, "#ffffff", 0.32),
  );
  root.setProperty("--accent-2-wash", withAlpha(second, light ? 0.17 : 0.12));
  root.setProperty("--accent-2-line", withAlpha(second, light ? 0.5 : 0.38));
  // Every panel, card, border and text colour remains the stylesheet's
  // business. Keeping the tint to the page and conversation grounds preserves
  // the contrast and hierarchy of the complete neutral ramps in `:root` and
  // the light-theme override.
  // The browser chrome around the page — a phone's status bar, the installed
  // app's title bar — sits flush against the header, so it follows the page
  // ground, not the accent. Painting it with the accent put a saturated band
  // above a neutral surface on every phone, which is the opposite of the
  // seam this meta exists to hide. Read back from the stylesheet after the
  // theme attribute lands, so the chrome can never disagree with the ramp
  // the CSS actually resolved.
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
    return;
  }
  // Going away is the last moment a draft can be written where a reload will
  // find it. `saveChannelDraft` holds its own writes behind a short timer to
  // keep typing cheap, and a tab that closes inside that window would take the
  // last few words with it.
  flushChannelDrafts();
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
 * Each side swipes in what lives there: from the right, the side panel
 * (threads, files); rightward across the conversation, the channel drawer with
 * the channels, the users and the agents. Swiping back the way it came puts
 * either away.
 *
 * Phone only, and only on the chats screen. On a wide window both are
 * ordinary always-visible columns and there is nothing to reveal; the header
 * buttons keep working at every width and this is an addition to them, not a
 * replacement — a gesture nobody can see is a poor sole route to a feature.
 *
 * Two mechanisms, and the difference matters. The channel drawer is *dragged*:
 * it follows the finger pixel for pixel and settles when the finger lifts, so
 * the gesture announces itself the moment it starts and can be changed halfway
 * through. That is the block beginning at `drawerDragCandidate`. The side
 * panel is still a *threshold* swipe measured once, at the end — it opens from
 * the right edge only, because a drag from the middle of a transcript is how
 * someone scrolls a wide code block, and it has no equivalent scrim or partial
 * state to animate against. The `SWIPE_*` constants below belong to it.
 */
const SWIPE_EDGE_PX = 28;
const SWIPE_MIN_PX = 60;
/* Vertical drift that means the finger was scrolling the transcript, not
   swiping across it. Checked against the horizontal distance rather than a
   fixed number so a long, slightly sloped swipe still counts. */
const SWIPE_MAX_SLOPE = 0.6;

let swipeStart;

/* How far a finger travels before this decides whether the gesture is the
   drawer's or the transcript's. Small, because the drawer has to start moving
   almost immediately to read as attached to the hand; large enough that a tap
   with a shaky finger is still a tap. */
const DRAWER_SLOP_PX = 8;
/* Speed, in pixels per millisecond, at which the direction of travel decides
   the outcome regardless of distance — a flick. Below it, distance decides.  */
const DRAWER_FLICK_PX_PER_MS = 0.35;
/* A finger that has been still this long before lifting was not flicking,
   whatever it was doing a moment earlier. Without this, a fast drag that comes
   to rest halfway still carries its old velocity to the release and the
   drawer leaves under a hand that had quite clearly stopped. */
const DRAWER_REST_MS = 100;

/* The gesture in progress, or undefined. `active` separates a touch that might
   become a drag from one that has committed: everything before the slop is
   still potentially a tap or a scroll and must change nothing on screen. */
let drawerDrag;

/**
 * The channel drawer's one way to change state, and deliberately not a render.
 *
 * `render()` replaces `.chats-shell` outright, and an element inserted with
 * `roster-open` already on it has no before-state for CSS to transition from —
 * the drawer did not slide, it simply appeared, which is what the button used
 * to do. The same reasoning as `chan-collapse-toggle`: change the class on the
 * node already standing and let the stylesheet move it.
 *
 * Safe because the class is now the whole of the difference. The scrim used to
 * be rendered only while open, which made this a redraw whether it wanted to be
 * or not; it is always in the markup now (see `renderChats`), so nothing else
 * in the chats screen reads `chanSidebarOpen`.
 */
/* How long the sidebar's people and agents take to fold away or unroll, in
   milliseconds: the last pair's delay plus its own travel, rounded up. */
const CHAN_FOLD_MS = 380;
let chanFoldTimer;

/**
 * Say that the sidebar is mid-fold, for as long as it is.
 *
 * The two rosters have to clip their contents while their height is moving —
 * that clipping is the fold — but an expanded roster must not clip, because an
 * agent's usage card opens below its row and the last row's card reaches past
 * the bottom of the list. Clipping only while the fold runs gives the
 * animation the crop it needs and hands the card its overhang back the moment
 * the sidebar has settled.
 */
function markChanFolding(shell) {
  if (shell === null || shell === undefined) {
    return;
  }
  shell.classList.add("chan-folding");
  clearTimeout(chanFoldTimer);
  chanFoldTimer = setTimeout(() => {
    shell.classList.remove("chan-folding");
  }, CHAN_FOLD_MS);
}

function setChanDrawer(open) {
  const next = open === true;
  state.chanSidebarOpen = next;
  const shell = $(".chats-shell");
  if (shell === null) {
    // Not on the chats screen, or not drawn yet. Nothing to animate, and the
    // state above is what the next render will read.
    return;
  }
  shell.classList.toggle("roster-open", next);
  shell
    .querySelector(".chan-sidebar-btn")
    ?.setAttribute("aria-expanded", String(next));
}

/**
 * Whichever side panel is showing, closed the way its own button closes it.
 *
 * The order is `renderChats`'s order, not an order of its own. Six things can
 * occupy the one panel and only the first of them is on screen, so anything
 * closing by a different precedence closes something invisible. The two this
 * did not know about at all — an agent conversation and a direct message —
 * outrank the rest there, which meant a swipe with one of them open put away
 * the thread behind it and left the panel exactly where it was.
 */
function closeSidePanel() {
  if (state.activeAgentPanel !== undefined) {
    state.activeAgentPanel = undefined;
    return true;
  }
  if (state.activeDm !== undefined) {
    state.activeDm = undefined;
    state.dmDraft = "";
    return true;
  }
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
    state.activeAgentPanel !== undefined ||
    state.activeDm !== undefined ||
    state.chanFileView !== undefined ||
    state.chanTree === true ||
    state.activeChannelThread !== undefined ||
    state.chanThreadList === true
  );
}

/**
 * Escape closes whatever is stacked over the conversation, one layer a press.
 *
 * The panel had a close button and a swipe and nothing for a keyboard, which
 * on a desktop — where there is no swipe — left the mouse as the only way out
 * of a surface that covers half the window. This is the third way, and it
 * unwinds in the order the layers were put on: the phone's channel drawer,
 * then the side panel.
 *
 * Deliberately last in line. A field owns its own Escape (the file editor
 * blurs, the mention and slash pickers dismiss), a `<dialog>` closes itself,
 * and a popover traps its own keys — so this stands down whenever any of them
 * is what the press was for, and a reader in the reply box presses Escape
 * once to leave it and again to close the panel.
 */
document.addEventListener("keydown", (event) => {
  if (
    event.key !== "Escape" ||
    event.defaultPrevented ||
    state.route !== "chats"
  ) {
    return;
  }
  if ($("#modal")?.open === true || $("#layer-root")?.childElementCount > 0) {
    return;
  }
  // The element the key was pressed on, not the one focused now. The file
  // editor's own Escape handler runs before this one and blurs the textarea,
  // so by the time this reads `document.activeElement` the field it should
  // have stood down for is already gone — and one press would both leave the
  // editor and throw the panel away, which is the opposite of a ladder.
  // `event.target` still names the textarea either way.
  const field = event.target;
  if (field instanceof Element && FOCUSABLE_FIELDS.has(field.tagName)) {
    return;
  }
  if (state.chanSidebarOpen === true) {
    setChanDrawer(false);
    return;
  }
  if (sidePanelOpen() && closeSidePanel()) {
    render();
  }
});

/**
 * Whether a sideways drag starting here is something else's already.
 *
 * A wide code block, a diff or a table is dragged to read the rest of it, so a
 * gesture that begins inside one belongs to that element for its whole length.
 */
function horizontalScrollerAt(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  const scroller = target.closest(".msg-code, pre, .diff, table");
  return scroller !== null && scroller.scrollWidth > scroller.clientWidth;
}

/**
 * Whether this touch is allowed to become a drawer drag.
 *
 * Opening used to require starting inside a 28-pixel strip at the left edge,
 * which on a phone is mostly inside the system's own back-swipe: what was left
 * had to be found by accident, and so nobody found it and the header button
 * stayed the only route. The conversation never scrolls sideways, so the whole
 * of it can be the handle instead — the exclusions here are the places where a
 * sideways drag already means something.
 */
function drawerDragCandidate(target) {
  if (!phoneLayout() || state.route !== "chats") {
    return false;
  }
  if (horizontalScrollerAt(target)) {
    return false;
  }
  // A drag inside a field is how a caret is moved and a selection made.
  if (
    target instanceof Element &&
    target.closest("input, textarea, select") !== null
  ) {
    return false;
  }
  // Closing: the drawer is out and covers most of the screen, so anywhere is
  // the surface — the same reasoning the old close swipe used.
  if (state.chanSidebarOpen === true) {
    return true;
  }
  // Opening: only with nothing stacked over the conversation. A rightward
  // swipe with the thread panel out is that panel's dismissal, and the
  // threshold gesture in `touchend` below still owns it.
  return !sidePanelOpen();
}

/**
 * Hand whatever distance is left back to the stylesheet.
 *
 * Removing `.chan-dragging` restores both the transition and the class's own
 * transform in the same style recalculation, so the drawer eases from exactly
 * where the finger left it to whichever end it is going to — a release at 70%
 * animates the last 30% instead of starting the trip over. Doing it in one
 * step is the entire trick, which is why the modifier and `roster-open` change
 * together, with nothing between them that could force a layout in between.
 *
 * Returns whether a drag was actually under way, so the threshold gestures
 * below know to stand down rather than act on the same touch twice.
 */
function endDrawerDrag(event) {
  const drag = drawerDrag;
  drawerDrag = undefined;
  if (drag === undefined || drag.active !== true) {
    return false;
  }
  const progress = drag.width > 0 ? drag.offset / drag.width : 0;
  const resting =
    event === undefined || event.timeStamp - drag.lastTime > DRAWER_REST_MS;
  const open =
    !resting && Math.abs(drag.velocity) >= DRAWER_FLICK_PX_PER_MS
      ? drag.velocity > 0
      : progress >= 0.5;
  if (drag.shell.isConnected) {
    drag.shell.classList.remove("chan-dragging");
    drag.shell.style.removeProperty("--chan-drawer-x");
    drag.shell.style.removeProperty("--chan-drawer-p");
  }
  setChanDrawer(open);
  return true;
}

document.addEventListener(
  "touchstart",
  (event) => {
    // A second finger means a pinch or a scroll gesture, never this.
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    swipeStart =
      touch === undefined ? undefined : { x: touch.clientX, y: touch.clientY };
    drawerDrag = undefined;
    if (touch === undefined || !drawerDragCandidate(event.target)) {
      return;
    }
    drawerDrag = {
      startX: touch.clientX,
      startY: touch.clientY,
      // Where the drawer sits when the finger lands: fully out, or not out at
      // all. Every later position is this plus how far the hand has moved.
      from: state.chanSidebarOpen === true,
      lastX: touch.clientX,
      lastTime: event.timeStamp,
      velocity: 0,
      active: false,
      offset: 0,
      width: 0,
      shell: undefined,
    };
  },
  { passive: true },
);

/*
 * Not passive: once this owns the gesture it has to stop the browser scrolling
 * the transcript underneath a drawer that is moving with the finger, and stop
 * the edge from being read as a back-swipe. It cancels nothing before the slop
 * below, so an ordinary vertical scroll is never touched.
 */
document.addEventListener(
  "touchmove",
  (event) => {
    const drag = drawerDrag;
    if (drag === undefined) {
      return;
    }
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch === undefined) {
      // A second finger arrived mid-drag. Settle where it stands rather than
      // leaving the drawer stranded between its two states.
      endDrawerDrag(undefined);
      return;
    }
    const dx = touch.clientX - drag.startX;
    const dy = touch.clientY - drag.startY;
    if (drag.active !== true) {
      if (Math.abs(dx) < DRAWER_SLOP_PX && Math.abs(dy) < DRAWER_SLOP_PX) {
        return;
      }
      // The direction is decided once, at the slop, and stands for the rest of
      // the touch. Re-deciding every frame is how a drag ends up fighting a
      // scroll it half-owns.
      if (Math.abs(dx) <= Math.abs(dy)) {
        drawerDrag = undefined;
        return;
      }
      // An open drawer cannot be pulled further open, and a closed one cannot
      // be pushed further closed; either way there is nothing here to drag.
      const opening = dx > 0;
      if (drag.from === opening) {
        drawerDrag = undefined;
        return;
      }
      const shell = $(".chats-shell");
      const width = shell?.querySelector(".chan-sidebar")?.offsetWidth ?? 0;
      if (shell === null || width <= 0) {
        drawerDrag = undefined;
        return;
      }
      drag.shell = shell;
      drag.width = width;
      drag.active = true;
      shell.classList.add("chan-dragging");
    }
    // A background render replaced the shell out from under the gesture —
    // polling redraws the screen on its own schedule. The node holding the
    // drag's inline offsets is gone, so there is nothing left to move.
    if (!drag.shell.isConnected) {
      drawerDrag = undefined;
      return;
    }
    if (event.cancelable) {
      event.preventDefault();
    }
    drag.offset = Math.min(
      drag.width,
      Math.max(0, (drag.from ? drag.width : 0) + dx),
    );
    const elapsed = event.timeStamp - drag.lastTime;
    if (elapsed > 0) {
      drag.velocity = (touch.clientX - drag.lastX) / elapsed;
      drag.lastX = touch.clientX;
      drag.lastTime = event.timeStamp;
    }
    drag.shell.style.setProperty("--chan-drawer-x", `${drag.offset}px`);
    drag.shell.style.setProperty(
      "--chan-drawer-p",
      String(drag.offset / drag.width),
    );
  },
  { passive: false },
);

document.addEventListener(
  "touchcancel",
  () => {
    swipeStart = undefined;
    endDrawerDrag(undefined);
  },
  { passive: true },
);

document.addEventListener(
  "touchend",
  (event) => {
    const start = swipeStart;
    swipeStart = undefined;
    // A drag that ran has already decided where the drawer goes, and its
    // release is not also a swipe at whatever is behind it.
    if (endDrawerDrag(event)) {
      return;
    }
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
    if (horizontalScrollerAt(event.target)) {
      return;
    }
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dy) > Math.abs(dx) * SWIPE_MAX_SLOPE) {
      return;
    }
    if (dx < 0) {
      // Leftward: an open channel drawer goes back first — it came from
      // this edge, so this is its dismissal whatever the finger started on.
      // Reached only when the drag above declined the gesture, a field or a
      // mid-swipe redraw being the usual reasons.
      if (state.chanSidebarOpen === true) {
        setChanDrawer(false);
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
      setChanDrawer(true);
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
 * The Settings page's position across the whole-app render below.
 *
 * Settings controls redraw the screen to show their new value. That replaces
 * the `.scroll` node and gives its replacement a fresh `scrollTop` of zero,
 * sending somebody back to the first card after every click. Keying this one
 * surface makes navigation safe too: when entering or leaving Settings only
 * one side of the render has the key, so no position crosses between screens.
 */
function captureSettingsScroll() {
  return document.querySelector('[data-scroll-key="settings"]')?.scrollTop;
}

function restoreSettingsScroll(saved) {
  if (saved === undefined) {
    return;
  }
  const scroller = document.querySelector('[data-scroll-key="settings"]');
  if (scroller !== null) {
    scroller.scrollTop = saved;
  }
}

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
  if (saved.height !== "" && next.value !== "") {
    // The composer grows by having its height set imperatively, which is not
    // in the markup and so does not survive the rebuild on its own.
    //
    // Not onto a field that came back empty, though — which is what a
    // composer looks like on the render immediately after it is sent, still
    // focused for the next message. Restoring the height the sent message had
    // grown to would leave a lean, empty bar standing several rows tall until
    // something else happened to redraw it.
    next.style.height = saved.height;
  }
  next.scrollTop = saved.top;
  // A channel or thread composer's text is painted by a layer under the
  // textarea, and that layer is rebuilt by this render at the top of its own
  // scroll. Putting the textarea back where it was without moving the mirror
  // with it leaves the letters one scroll offset away from the caret sitting
  // in them — which is what a background frame arriving mid-message looked
  // like.
  const mirror = next
    .closest?.(".composer-field")
    ?.querySelector("[data-composer-mirror]");
  if (mirror !== null && mirror !== undefined) {
    mirror.scrollTop = next.scrollTop;
  }
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
  return (
    act === "channel-rename-input" ||
    act === "settings-rename-input"
  );
}

/* ------------------------------------------------------ surface motion ---- */

/**
 * The surfaces that slide rather than appear, and how to tell they moved.
 *
 * Everything here is toggled by `state`, and `state` is drawn by replacing the
 * whole document — so each of these is a brand new element after every
 * keystroke and every event off the stream. That is what stops CSS from
 * animating them on its own: an `animation` on `.thread-panel` runs when the
 * node is created, and the node is created constantly, so the panel would
 * slide in again every time somebody typed a character into the composer.
 * `@starting-style` has the same problem for the same reason.
 *
 * Only the render loop knows whether a surface that is here now was here a
 * moment ago, so the decision lives here and the classes below are the answer
 * it hands to the stylesheet. The two phone surfaces that *are* pure CSS — the
 * channel sidebar and its scrim — stay that way: both are toggled by a class
 * on a container that survives the render, so a transition has two states to
 * run between and needs none of this.
 *
 * `parent` is where a closing surface goes back to for the length of its exit.
 * The node the render threw away is still a perfectly good element; putting
 * it back is what gives a panel something to animate *out*, since by the time
 * anybody knows it closed it is already gone from the new tree.
 */
const MOTION_SURFACES = [
  // Thread, thread list, DM, agent profile and the file view are one column
  // that shows one of them — so this is "the panel is open", not "the thread
  // is open", and switching between two of them is deliberately not motion.
  {
    selector: ".thread-panel",
    parent: ".chats-shell",
    enter: "panel-entering",
    leave: "panel-leaving",
  },
  // The file tree, which is a drawer only below 900px. Above that it is an
  // ordinary grid column and never opens or closes at all — the classes are
  // still applied there and styled to do nothing, which keeps the width test
  // in the stylesheet where the rest of the breakpoint already lives.
  //
  // Open is asked of the shell rather than of the pane, because the pane is
  // in the markup either way and it is the modifier that decides.
  {
    selector: ".tree-pane",
    parent: ".code-shell",
    enter: "tree-entering",
    leave: "tree-leaving",
    isOpen: (root) => root.querySelector(".code-shell.tree-open") !== null,
  },
  {
    selector: ".tree-scrim",
    parent: ".code-shell",
    enter: "scrim-entering",
    leave: "scrim-leaving",
  },
  // The channel header's tool tray, which comes out of the arrow beside it
  // and folds back into it. The arrow is what a reader clicked, so the icons
  // travel to and from that one point rather than fading where they stand.
  //
  // Where it goes back matters here in a way it does not for a panel:
  // appended, a tray on its way out would reappear on the far side of the
  // arrow it is supposed to be retreating into, which is why `place` exists.
  {
    selector: ".chan-tools",
    parent: ".chan-head",
    enter: "tools-entering",
    leave: "tools-leaving",
    place: (parent, node) => {
      const toggle = parent.querySelector(".chan-tools-toggle");
      if (toggle === null) {
        parent.append(node);
        return;
      }
      toggle.before(node);
    },
  },
];

/** Whether each surface was on screen, and the element it was, before the swap. */
const surfaceWasOpen = new Map();
const surfaceNode = new Map();

/**
 * The live element for a surface, never the one a close is still fading out.
 *
 * The distinction is the whole reason this is a function. A closing surface is
 * put back into the shell and is, for those few frames, a perfectly ordinary
 * match for its own selector — so the next render would read it as "open
 * again", the render after that as "closed again", and the panel would sit
 * there fading out on a loop for as long as anything kept redrawing.
 */
function liveNode(root, surface) {
  return root.querySelector(`${surface.selector}:not(.${surface.leave})`);
}

function surfaceIsOpen(root, surface) {
  return surface.isOpen === undefined
    ? liveNode(root, surface) !== null
    : surface.isOpen(root);
}

/** Reads the outgoing document. Must run before `innerHTML` throws it away. */
function captureSurfaceMotion(root) {
  for (const surface of MOTION_SURFACES) {
    surfaceWasOpen.set(surface.selector, surfaceIsOpen(root, surface));
    surfaceNode.set(surface.selector, liveNode(root, surface));
  }
}

/** Plays whatever the swap turned out to be: an opening, a closing, or nothing. */
function playSurfaceMotion(root) {
  for (const surface of MOTION_SURFACES) {
    const open = surfaceIsOpen(root, surface);
    if (open === (surfaceWasOpen.get(surface.selector) === true)) {
      continue;
    }
    if (open) {
      const node = liveNode(root, surface);
      if (node !== null) {
        animateOnce(node, surface.enter, false);
      }
      continue;
    }
    const closed = surfaceNode.get(surface.selector);
    const parent = root.querySelector(surface.parent);
    if (closed === null || closed === undefined || parent === null) {
      continue;
    }
    // Back in the document, but not back in the interface: it answers to
    // nothing, takes no focus, and is gone before the animation is cold.
    closed.inert = true;
    if (surface.place === undefined) {
      parent.append(closed);
    } else {
      surface.place(parent, closed);
    }
    animateOnce(closed, surface.leave, true);
  }
}

/**
 * Wears a class for exactly one animation, then cleans up after itself.
 *
 * The timer is not a belt-and-braces second try at `animationend` — it is the
 * only guarantee. That event never fires at all when reduced motion has taken
 * the animation away, and browsers hold it back while a tab is in the
 * background, either of which would otherwise leave a closing panel pinned
 * over the screen until the next render happened to notice.
 */
function animateOnce(node, className, drop) {
  node.classList.add(className);
  let done = false;
  const finish = () => {
    if (done) {
      return;
    }
    done = true;
    node.removeEventListener("animationend", onEnd);
    node.classList.remove(className);
    if (drop) {
      node.remove();
    }
  };
  // `animationend` bubbles, and a panel is full of small animations of its
  // own — a status dot finishing a breath, a skeleton row shimmering. Without
  // this test the first of them to reach the top would end the panel's
  // animation on the panel's behalf, a frame or two in.
  const onEnd = (event) => {
    if (event.target === node) {
      finish();
    }
  };
  node.addEventListener("animationend", onEnd);
  window.setTimeout(finish, 400);
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
  // Before anything writes to `root`: the panels and drawers that animate are
  // read off the outgoing document, and one line below this they stop
  // existing. See `MOTION_SURFACES`.
  captureSurfaceMotion(root);
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
    root.innerHTML = `<div class="app"><div class="main">
      <div class="scroll"><div class="page">${emptyState(
        "folder",
        "No project yet",
        "This control plane has no project you can see. Ask an owner for access, or create one from the CLI.",
      )}</div></div></div></div>`;
    return;
  }

  const focusedField = captureFocus();
  const savedSettingsScroll = captureSettingsScroll();
  // Where the reader had the conversation, for the same reason focus is taken
  // here: the swap below throws both away, and neither is in `state`.
  const savedScroll = captureChannelScroll();
  // One column. There is no rail to open, collapse or scrim any more — the
  // channel sidebar is the navigation — so the shell carries no `nav-open` or
  // `nav-collapsed` modifier and the whole `sidebar()` block is gone.
  root.innerHTML = `<div class="app">
    <div class="main${BARE.has(state.route) ? " bare" : ""}${
      state.loadError === undefined ? "" : " has-banner"
    }">
      ${banner()}
      ${BARE.has(state.route) ? "" : topbar()}
      ${screen()}
    </div>
  </div>`;

  restoreSettingsScroll(savedSettingsScroll);
  // What the swap turned out to have opened or closed. Before the transcript
  // is put back where the reader had it, deliberately: an opening panel does
  // take its column here, and restoring a scroll against the full width and
  // then narrowing it again would move the very line the restore exists to
  // keep still. A closing one no longer takes anything — it leaves out of
  // flow, over a layout that has already settled — so this order costs it
  // nothing.
  playSurfaceMotion(root);

  // Chats owns this now: the inline file and diff blocks in the transcript are
  // the only place code is read, so the channel has to load its own changeset
  // rather than inherit one a separate Code screen happened to fetch first.
  if (state.route === "chats") {
    // The transcript is replaced on every render, which resets it to the top.
    // Put it back where the reader had it before anything else runs. The
    // anchor first and the follow pin second, in that order: somebody
    // reading history keeps their message, and somebody at the bottom of a
    // live conversation still gets the bottom.
    restoreChannelAnchor(savedScroll);
    restoreChannelScroll(savedScroll);
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
    // Once per channel, then only when the stream says the set changed. A
    // question is put to one person and lives in the control plane's memory,
    // so there is nothing in the transcript that would bring it back after a
    // reload — this is the read that finds a run already waiting.
    if (state.pendingQuestions[activeChannelId()] === undefined) {
      const channel = activeChannelId();
      state.pendingQuestions[channel] = [];
      void loadPendingQuestions(channel).then(() => {
        if (state.route === "chats") {
          render();
        }
      });
    }
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
  // An open rename field belongs to the screen it was opened on; leaving and
  // coming back to Settings should not find it still open on an old value.
  state.settingsRenamingId = undefined;
  closePopover();
  if (window.location.hash !== `#${route}`) {
    window.location.hash = `#${route}`;
  }
  render();
}

function applyHash() {
  // While the signed-out shell is up the hash names a form, not a screen —
  // so following `/#signin` from the create-account page has to swap the
  // form rather than fall through to the router, which knows nothing about
  // it. The invite screen renders here too; its hash is not an auth hash, so
  // it is left alone.
  const authRoot = $("#auth-root");
  if (authRoot !== null && !authRoot.hidden) {
    const mode = authModeFromHash();
    if (mode !== undefined && mode !== authMode) {
      authMode = mode;
      if (mode !== "register") {
        pendingRegistration = undefined;
      }
      // A different link means a different answer; the old one would otherwise
      // still be on screen while the new one is checked.
      if (mode === "reset") {
        resetState = undefined;
      }
      authRoot.innerHTML = renderAuth();
      if (mode === "reset") {
        void loadPasswordReset();
      }
    }
    return;
  }
  // Signed in, and the URL just changed to name a signed-out form: the same
  // request as arriving on the link, so it gets the same answer rather than
  // being dropped for not being a route.
  const linked = authModeFromHash();
  if (linked !== undefined && state.principal !== undefined) {
    void signOutForAuthLink(linked);
    return;
  }
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
  // Scoped through the id, not the bare class: a popover on its way out keeps
  // its markup for the length of its exit animation and would be found first
  // here, so the refresh would land on the copy nobody can see any more while
  // the live one kept its stale roster. `closePopover` drops the id the
  // moment a layer starts closing, which leaves exactly one match.
  const pop = $("#pop-layer .popover");
  if (pop !== null && activeChannelId()) {
    pop.innerHTML = channelInfoPopoverHtml(activeChannelId());
  }
}

/**
 * Types one character into the channel composer, as if it had been pressed.
 *
 * The "@" and the "/" are the two characters that open a picker, and both are
 * now reached from the "+" menu rather than from a button of their own. Going
 * through the draft rather than through the textarea is what survives the
 * render: the box is rebuilt from `state.chatDraft`, and any image already
 * staged for this message lives in the draft as markdown the textarea never
 * shows — so it is carried across rather than dropped on the floor.
 */
function typeIntoComposer(character, opened) {
  const input = $("[data-act='channel-input']");
  if (input === null) {
    return;
  }
  const at = input.selectionStart ?? input.value.length;
  const attachments = state.chatDraft.match(
    /!\[[^\]]*\]\(attachment:[0-9a-f]{32}\.(?:png|jpg|gif|webp)\)/gu,
  );
  state.chatDraft = `${input.value.slice(0, at)}${character}${input.value.slice(at)}${
    attachments === null ? "" : `\n${attachments.join("\n")}\n`
  }`;
  opened();
  render();
  const next = $("[data-act='channel-input']");
  next?.focus({ preventScroll: true });
  next?.setSelectionRange(at + 1, at + 1);
}

/* ------------------------------------------- the agent's question prompt ---
 *
 * The card above the composer. Everything here works on one set at a time —
 * the one `pendingQuestionFor` is showing — and keeps its half-finished
 * answers in `state` rather than in the DOM, because the whole screen is
 * rebuilt on every render and the DOM forgets.
 */

/** The set on screen, its questions, and where in it the reader is. */
function questionPromptState() {
  const repositoryId = activeChannelId();
  const pending = pendingQuestionFor(repositoryId);
  const questions = pending?.questions ?? [];
  if (pending === undefined || questions.length === 0) {
    return undefined;
  }
  const step = Math.min(
    Math.max(state.questionStep[pending.requestId] ?? 0, 0),
    questions.length - 1,
  );
  return { repositoryId, pending, questions, step };
}

/**
 * Records one answer and moves on — to the next question, or to the run.
 *
 * Answering the last one sends the set. A prompt with a Send button would ask
 * for one more tap than it needs: there is nothing else the last answer could
 * be for, and the run has been waiting the whole time.
 */
function answerQuestionStep(choice) {
  const current = questionPromptState();
  if (current === undefined) {
    return;
  }
  const { repositoryId, pending, questions, step } = current;
  if (state.questionSending[pending.requestId] === true) {
    return;
  }
  const answers = [...(state.questionAnswers[pending.requestId] ?? [])];
  answers[step] = choice;
  state.questionAnswers[pending.requestId] = answers;
  if (step < questions.length - 1) {
    state.questionStep[pending.requestId] = step + 1;
    render();
    return;
  }
  // Anything never visited is a skip: the reader paged past it, which is the
  // same "your call" the Skip button says outright.
  const complete = questions.map(
    (question, index) => answers[index] ?? { skipped: true },
  );
  // Started before the render, not after: sending is what dims the card, and
  // it is set as the call begins rather than when it resolves.
  const sent = answerAgentQuestion(repositoryId, pending.requestId, complete);
  render();
  void sent.then(() => render());
}

function actionOf(event) {
  const node = event.target.closest("[data-act]");
  return node === null ? undefined : { node, act: node.dataset.act, value: node.dataset.value };
}

/**
 * Gives a touch reader one message's controls at a time.
 *
 * A pointer reveals the action bar by hovering the row. Touch has no hover,
 * but permanently drawing every bar turns the transcript into a column of
 * controls. A tap on a message therefore selects that row; tapping it again
 * or anywhere outside a message clears the selection. Once the bar is open,
 * pressing one of its controls must not close it before the delegated action
 * below gets the same click.
 */
function selectMobileChannelMessage(event) {
  if (!window.matchMedia("(hover: none)").matches) {
    return;
  }
  const row = event.target.closest?.(".cmsg-row:not(.cmsg-system)") ?? null;
  if (row !== null && event.target.closest?.(".cmsg-actions") !== null) {
    return;
  }
  const shouldSelect =
    row !== null && !row.classList.contains("cmsg-selected");
  for (const selected of document.querySelectorAll(
    ".cmsg-row.cmsg-selected",
  )) {
    selected.classList.remove("cmsg-selected");
  }
  if (shouldSelect) {
    row.classList.add("cmsg-selected");
  }
}

document.addEventListener("click", (event) => {
  // This runs before action lookup because an ordinary message body has no
  // `data-act`: selecting it is still a complete interaction on touch.
  selectMobileChannelMessage(event);
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
    case "auth-mode": {
      event.preventDefault();
      authMode = value;
      if (value !== "register") {
        pendingRegistration = undefined;
      }
      // Rendered here rather than left to the `hashchange` this triggers, so
      // the form swaps on the click even when the hash is already the one
      // being asked for.
      const hash = AUTH_MODE_HASHES.get(value);
      if (hash !== undefined) {
        window.location.hash = `#${hash}`;
      }
      $("#auth-root").innerHTML = renderAuth();
      return;
    }
    case "invite-mode":
      event.preventDefault();
      inviteMode = value;
      showInvite();
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
    case "composer-plus": {
      // The one control on the left of the bar. Everything that adds something
      // to a message hangs off it: a picture, a command, a name. Ordering is
      // by how often each is reached for, and the menu opens *upward* — the
      // composer sits on the floor of the window, and `showPopover` hangs a
      // menu below its anchor, which would put this one off the screen.
      const menu =
        value === "chat"
          ? showMenu(node, [
              {
                act: "chat-attach-blocked",
                label: "Photos & files",
                hint: "Not available on this deployment",
                iconName: "paperclip",
                disabled: true,
              },
              { act: "chat-mention", label: "Mention a file or agent", iconName: "at" },
            ])
          : showMenu(node, [
              { act: "channel-attach", label: "Photos & files", iconName: "paperclip" },
              {
                act: "channel-slash-key",
                label: "Run a command",
                hint: "Everything this channel answers to",
                iconName: "terminal",
              },
              { act: "channel-mention-key", label: "Mention someone", iconName: "at" },
            ]);
      const box = node.getBoundingClientRect();
      menu.style.left = `${Math.max(
        12,
        Math.min(box.left, window.innerWidth - menu.offsetWidth - 12),
      )}px`;
      menu.style.top = `${Math.max(12, box.top - menu.offsetHeight - 8)}px`;
      return;
    }
    case "channel-attach": {
      // Clicking the picker rather than being it: a bare file input cannot be
      // styled into the composer bar, and wrapping the button in a label would
      // swallow the click before the delegated handler saw it.
      closePopover();
      $("[data-act='channel-attach-input']")?.click();
      return;
    }
    case "channel-attachment-remove":
    case "dm-attachment-remove":
    case "thread-attachment-remove": {
      const where =
        act === "channel-attachment-remove"
          ? ATTACH_TARGETS.channel
          : act === "thread-attachment-remove"
            ? ATTACH_TARGETS.thread
            : ATTACH_TARGETS.dm;
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      state[where.draft] = String(state[where.draft] ?? "")
        .replace(
          new RegExp(`!?\\[[^\\]]*\\]\\(attachment:${escaped}\\)\\n?`, "gu"),
          "",
        )
        .trimEnd();
      render();
      $(`[data-act='${where.input}']`)?.focus();
      return;
    }
    case "thread-attach": {
      // The thread's paperclip, which — like the channel's menu entry — only
      // clicks the hidden picker sitting beside it in the same bar.
      closePopover();
      $("[data-act='channel-thread-attach-input']")?.click();
      return;
    }
    case "dm-attach": {
      closePopover();
      $("[data-act='dm-attach-input']")?.click();
      return;
    }
    case "channel-mention-key": {
      closePopover();
      typeIntoComposer("@", () => {
        state.composerAutocompleteTarget = "channel";
        state.mentionActive = true;
        state.mentionQuery = "";
        state.mentionIndex = 0;
      });
      return;
    }
    case "channel-slash-key": {
      closePopover();
      typeIntoComposer("/", () => {
        state.composerAutocompleteTarget = "channel";
        state.slashActive = true;
        state.slashQuery = "";
        state.slashIndex = 0;
      });
      return;
    }
    case "channel-mention-pick":
      pickMention(value, render);
      return;
    case "channel-slash-pick":
      pickSlashCommand(value, render);
      return;
    case "thread-mention-pick":
      pickMention(value, render, "thread");
      return;
    case "thread-slash-pick":
      pickSlashCommand(value, render, "thread");
      return;
    case "channel-react": {
      // A tally carries the emoji it counts; the fallback is only for a caller
      // that has not said, which is now nobody.
      const emoji = node.dataset.emoji || "👍";
      toggleChannelReaction(activeChannelId(), value, emoji);
      render();
      return;
    }
    case "channel-react-pick":
      reactionPicker(node, activeChannelId(), value);
      return;
    case "channel-react-choose": {
      const emoji = node.dataset.emoji;
      if (emoji === undefined) {
        return;
      }
      closePopover();
      toggleChannelReaction(activeChannelId(), value, emoji);
      render();
      return;
    }
    case "channel-message-copy":
      void copyMessageText(activeChannelId(), value);
      return;
    case "channel-jump-latest":
      jumpToUnreadOrLatest();
      // The scroll the line above starts is what moves the flag; painting now
      // would read the old one. Next frame, once the transcript has settled.
      requestAnimationFrame(paintJumpToLatest);
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
    // A pinned task opens as a thread; a person's message (including one with
    // inline replies) scrolls into view. The banner's copy answers for pins
    // whose transcript row has aged past the loaded page.
    case "channel-pin-jump": {
      const repositoryId = activeChannelId();
      const entry =
        channelMessagesFor(repositoryId).find((m) => m.id === value) ??
        (state.channelPins[repositoryId] ?? []).find((m) => m.id === value);
      if (
        entry !== undefined &&
        entry.kind !== "user" &&
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
    // Both of these change a class rather than redrawing the screen, so the
    // button and the scrim slide the drawer exactly as a finger does — see
    // `setChanDrawer`, which explains why a render would not.
    case "chan-sidebar-toggle":
      setChanDrawer(state.chanSidebarOpen !== true);
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
    case "chan-collapse-toggle": {
      state.chanCollapsed = state.chanCollapsed !== true;
      persist("ag.chanCollapsed", state.chanCollapsed);

      // Keep this DOM in place while its width changes. A whole-screen render
      // replaces the sidebar outright, which gives a newly inserted element
      // its final width and leaves CSS with nothing to animate between.
      const shell = node.closest(".chats-shell");
      shell?.classList.toggle("chan-collapsed", state.chanCollapsed);
      markChanFolding(shell);
      const label = state.chanCollapsed ? "Expand sidebar" : "Collapse sidebar";
      node.setAttribute("aria-pressed", String(state.chanCollapsed));
      node.setAttribute("aria-label", label);
      node.setAttribute("title", label);
      return;
    }
    case "chan-sidebar-close":
      setChanDrawer(false);
      return;
    case "question-choose":
      answerQuestionStep({ chosen: Number(value) });
      return;
    case "question-skip": {
      // What the reader typed wins over the button they then pressed: the
      // pencil row holds both, and skipping with words in the box would throw
      // away the more specific answer of the two.
      const typed = $("[data-act='question-text']")?.value?.trim() ?? "";
      answerQuestionStep(typed === "" ? { skipped: true } : { text: typed });
      return;
    }
    case "question-back":
    case "question-next": {
      const current = questionPromptState();
      if (current === undefined) {
        return;
      }
      state.questionStep[current.pending.requestId] =
        act === "question-back"
          ? Math.max(current.step - 1, 0)
          : Math.min(current.step + 1, current.questions.length - 1);
      render();
      return;
    }
    case "question-dismiss": {
      // Put aside, not answered. The run is still waiting and its deadline is
      // still running; the prompt comes back on the next reload, which is the
      // honest state of things. Cancelling somebody else's run from a close
      // button would be a surprising amount of consequence for an X.
      const current = questionPromptState();
      if (current !== undefined) {
        state.questionDismissed[current.pending.requestId] = true;
        render();
      }
      return;
    }
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
    case "channel-message-delete":
      void deleteChannelMessageAction(activeChannelId(), value);
      return;
    case "thread-reply-delete": {
      // `rootId|replyId`: deleting a reply is a write against the thread it
      // lives in, and the row only ever carries one value.
      const [rootId = "", replyId = ""] = value.split("|");
      void deleteChannelReplyAction(activeChannelId(), rootId, replyId);
      return;
    }
    case "dm-delete":
      if (state.activeDm !== undefined) {
        void deleteDirectMessageAction(state.activeDm, value);
      }
      return;
    case "channel-threads-clear":
      void clearThreadsAction(activeChannelId());
      return;
    case "channel-threads-close":
      state.chanThreadList = false;
      render();
      return;
    case "channel-message-reply":
      // Person-to-person replies stay in the channel. Aim the channel
      // composer at the message without opening the task-thread panel.
      state.composerThreadId = value;
      state.activeChannelThread = undefined;
      render();
      $("[data-act='channel-input']")?.focus();
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
    // Starts an "@agents …" or "@everyone …" message rather than sending one:
    // the person still says what they want asked or told; this only saves
    // them typing the address. One body for both, because the only thing that
    // differs between the room's two broadcasts is the word.
    case "mention-agents-insert":
    case "mention-everyone-insert": {
      const address = act === "mention-agents-insert" ? "agents" : "everyone";
      const input = document.querySelector("[data-act='channel-input']");
      if (input !== null) {
        // Through the draft and a render, exactly like `typeIntoComposer`
        // above. Assigning `.value` fires no input event, so neither the draft
        // nor the layer painting the textarea's text heard about the eight
        // characters just put in front of them: the mirror kept showing the
        // old sentence while the caret stood a whole "@agents " to its right.
        const attachments = state.chatDraft.match(
          /!\[[^\]]*\]\(attachment:[0-9a-f]{32}\.(?:png|jpg|gif|webp)\)/gu,
        );
        const written = `@${address} ${input.value.replace(
          new RegExp(`^@${address}\\s*`, "u"),
          "",
        )}`;
        state.chatDraft = `${written}${
          attachments === null ? "" : `\n${attachments.join("\n")}\n`
        }`;
        render();
        const next = document.querySelector("[data-act='channel-input']");
        next?.focus();
        next?.setSelectionRange(written.length, written.length);
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
      // Also offered by the roster row's menu, which has nothing to say once
      // the panel it opens is on screen.
      closePopover();
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
    case "chan-tools-toggle": {
      const toggle = node;
      const focused = document.activeElement === toggle;
      const open = !(state.chanToolsOpen === true);
      state.chanToolsOpen = open;

      // Opening the fold changes which tools are in the header, so the rest
      // of the screen still needs its ordinary render. Keep this button,
      // though: a replacement already wearing its final class has no previous
      // state for the button colour or arrow rotation to transition from.
      render();
      const replacement = document.querySelector(".chan-tools-toggle");
      if (replacement !== null) {
        replacement.replaceWith(toggle);
        // Establish the retained button's old style after reattaching it,
        // then move it to the new state so the existing CSS transition runs.
        void toggle.offsetWidth;
        toggle.classList.toggle("on", open);
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("title", open ? "Hide tools" : "Show tools");
        if (focused) {
          toggle.focus();
        }
      }
      return;
    }
    case "preview-start":
      void startPreviewAction(value);
      return;
    case "preview-stop":
      void stopPreviewAction(value);
      return;
    case "agent-panel-open":
      // Any agent in the room, not only your own, and its specification first. The
      // private-chat entry above stays as it was: that one is a deliberate
      // "talk to my agent" and lands on the chat tab.
      state.activeAgentPanel = value;
      state.agentPanelTab = "spec";
      state.activeDm = undefined;
      state.activeChannelThread = undefined;
      render();
      // Usage belongs to the signed-in account, so it is only requested for
      // one of this person's own agents. Channel membership is repository
      // scoped; load every roster once so the specification can honestly
      // list every channel rather than only rooms visited this session.
      {
        const opened = channelAgentsFor(activeChannelId()).find(
          (agent) => agent.id === value,
        );
        if (opened?.mine === true) {
          void ensureProviderUsage(opened.provider ?? opened.id, render);
          // The model and reasoning pickers on the details tab are drawn from
          // the account's own reported lists, so they have to be asked for the
          // same way the composer's pickers are — otherwise the tab shows two
          // empty dropdowns and no way to tell that anything is missing.
          void ensureAgentOptions(opened.provider ?? opened.id, render);
        }
        void (async () => {
          for (const repository of state.repositories) {
            await ensureChannelRoster(repository.id);
          }
          render();
        })();
      }
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
    /**
     * The menu on a roster row — everything that row used to carry as its own
     * buttons, including the one that removes the agent.
     *
     * The items come from `rosterMenuItems` in screen-chats.js rather than
     * being built here: every condition in them is one the row is already
     * drawn from, and split across two files is how a menu ends up offering
     * what the row would not.
     */
    case "roster-agent-menu":
      showMenu(node, rosterMenuItems(value));
      return;
    /** Replaces the rendered name with its inline editor. */
    case "channel-settings-toggle":
      closePopover();
      state.chatSettingsOpenId = state.chatSettingsOpenId === value ? undefined : value;
      render();
      if (state.chatSettingsOpenId === value) {
        const input = $("[data-act='channel-rename-input']");
        input?.focus();
        input?.select();
      }
      return;
    case "agent-rename-toggle":
      state.settingsRenamingId =
        state.settingsRenamingId === value ? undefined : value;
      render();
      if (state.settingsRenamingId === value) {
        const input = $("[data-act='settings-rename-input']");
        input?.focus();
        input?.select();
      }
      return;
    case "chan-revert-task":
      void revertTaskAction(activeChannelId(), value);
      return;
    case "auditor-toggle":
      // `value` is the *current* paused state, so the new one is its
      // opposite — read off the menu entry that was drawn rather than from a
      // second lookup that could disagree with what was on screen.
      closePopover();
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
    // A selection or dismissal closes the menu. Deletion itself still asks
    // for confirmation before invoking the existing membership operation.
    case "channel-agent-remove":
      closePopover();
      void removeChannelAgentAction(value);
      return;
    case "channel-agent-remove-any":
      closePopover();
      void removeChannelAgentAction(value, true);
      return;
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
    case "sum-diff":
      closePopover();
      setDiffMode("split", render);
      return;
    case "chat-close":
    case "chat-toggle":
      toggleChat(render);
      return;
    case "chat-msg-delete":
      void deleteChatMessageAction(Number(value));
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
    case "agent-view":
      state.agentView = value;
      persist("ag.agentview", value);
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
    /*
     * The role field's picker. The field itself still takes any words — this
     * only offers the two the server acts on, so nobody has to know their
     * exact spelling to use them.
     */
    case "agent-role-menu": {
      const items = roleMenuItems(value, node.dataset.repo);
      if (items.length === 0) {
        return;
      }
      roleMenuTarget = { agentId: value, repositoryId: node.dataset.repo };
      showMenu(node, items);
      return;
    }
    case "agent-role-pick": {
      // `closePopover` returns focus to the chevron, which the redraw inside
      // `pickChannelRole` then replaces — so the menu goes first.
      closePopover();
      pickChannelRole(value ?? "");
      roleMenuTarget = undefined;
      return;
    }
    case "agent-role-custom": {
      const input = openRoleInput();
      closePopover();
      roleMenuTarget = undefined;
      input?.focus();
      input?.select();
      return;
    }
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
    // Asks the vendor again rather than reading the kept answer. A usage card
    // that said "no session has recorded rate limits yet" would otherwise go
    // on saying it for the rest of the session, including after the run that
    // produced some.
    case "agent-usage-refresh":
      void refreshProviderUsage(value, render);
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
      // No name is handed out here. An agent is named once, when its account
      // connects (`assignCallSign` in `src/providers.ts`), and arrives already
      // carrying that call sign — naming it again per channel is what made the
      // same agent Athena in one room and Vesta in the next, since a name
      // chosen here is stored as a channel override that outranks the
      // account's own. Somebody can still rename it in one channel from the
      // roster; that is a choice, not a side effect of adding it.
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
    case "wheel-open":
      // Toggle, and only one open: pressing the button under an open wheel is
      // "done", and pressing another colour's swaps rather than stacks.
      state.openWheel =
        state.openWheel === node.dataset.value ? undefined : node.dataset.value;
      render();
      return;
    case "set-accent-wheel":
    case "set-accent-secondary-wheel":
    case "set-agent-color-wheel": {
      const field = WHEEL_FIELD[act.replace(/-wheel$/u, "")];
      void saveAppearanceChoice({
        [field]: wheelColorAt(node, event, currentWheelColor(field)),
      });
      return;
    }
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
      closePopover();
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
    case "registration-confirmation":
      void submitRegistrationConfirmation(form);
      return;
    case "password-forgot":
      void submitPasswordResetRequest(form);
      return;
    case "password-reset":
      void submitPasswordReset(form);
      return;
    case "policy-save":
      void savePolicy(form);
      return;
    case "invite-accept":
      void submitInviteAccept(form);
      return;
    case "invite-signin":
      void submitInviteSignIn(form);
      return;
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
    case "agent-rename-form": {
      const input = $("[data-act='settings-rename-input']", form);
      if (input !== null) {
        commitAgentRename(form.dataset.value, input.value);
      }
      return;
    }
    /** The details tab's role field: Enter commits, blur commits the same. */
    case "agent-role-form": {
      const input = $("[data-act='agent-role-input']", form);
      if (input !== null) {
        commitChannelRole(input);
      }
      return;
    }
    /** The inline name edit commits on Enter; blur uses the same operation. */
    case "channel-rename-form": {
      const input = $("[data-act='channel-rename-input']", form);
      const renamed = input !== null && input.value !== input.defaultValue;
      if (renamed) {
        renameChannelAgent(activeChannelId(), form.dataset.value, input.value);
      }
      state.chatSettingsOpenId = undefined;
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
  if (
    picker?.dataset?.act === "channel-attach-input" ||
    picker?.dataset?.act === "channel-thread-attach-input" ||
    picker?.dataset?.act === "dm-attach-input"
  ) {
    const target =
      picker.dataset.act === "channel-thread-attach-input"
        ? "thread"
        : picker.dataset.act === "dm-attach-input"
          ? "dm"
          : "channel";
    void attachChannelImages(
      [...(picker.files ?? [])],
      target,
    );
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
    case "set-accent-light":
    case "set-accent-secondary-light":
    case "set-agent-color-light": {
      // On `change`, not `input`: dragging a slider would otherwise be one
      // save per pixel, and the value is stored on the account.
      const field = WHEEL_FIELD[act.replace(/-light$/u, "")];
      const { h, s: saturation } = hexToHsl(currentWheelColor(field));
      void saveAppearanceChoice({
        [field]: hslToHex(h, saturation, Number(node.value) / 100),
      });
      return;
    }
    case "set-accent-exact":
    case "set-accent-secondary-exact":
    case "set-agent-color-exact": {
      const field = WHEEL_FIELD[act.replace(/-exact$/u, "")];
      void saveAppearanceChoice({ [field]: node.value });
      return;
    }
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
      setChannelAgentSetting(activeChannelId(), agentId, field, node.value, render);
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

/* Clipboard image files take the same validated upload path as the picker.
   Text-only clipboard data is left to the textarea's native paste behavior. */
document.addEventListener("paste", (event) => {
  const act = event.target?.dataset?.act;
  // Every message composer, because pasting a screenshot is how most of these
  // arrive and it should land in the conversation where it was pasted.
  if (
    act !== "channel-input" &&
    act !== "channel-thread-input" &&
    act !== "dm-input"
  ) {
    return;
  }
  const files = [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file) => file !== null);
  if (files.length === 0) {
    return;
  }
  event.preventDefault();
  void attachChannelImages(
    files,
    act === "channel-thread-input"
      ? "thread"
      : act === "dm-input"
        ? "dm"
        : "channel",
  );
});

document.addEventListener("input", (event) => {
  const found = actionOf(event);
  if (found === undefined) {
    return;
  }
  const { node, act } = found;
  if (act === "question-text") {
    // No render: this is the one control on the prompt whose value is being
    // typed into, and rebuilding the screen under a caret loses it.
    const current = questionPromptState();
    if (current === undefined) {
      return;
    }
    const answers = [...(state.questionAnswers[current.pending.requestId] ?? [])];
    const typed = node.value.trim();
    if (typed === "") {
      delete answers[current.step];
    } else {
      answers[current.step] = { text: typed };
    }
    state.questionAnswers[current.pending.requestId] = answers;
    return;
  }
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
    // Cleared rather than measured once the box is empty: an empty composer
    // collapses to the lean bar, and a height measured against the open one
    // would hold the pill open with nothing in it.
    node.style.height = "auto";
    if (node.value !== "") {
      node.style.height = `${Math.min(node.scrollHeight, 148)}px`;
    }
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
    const attachments = String(state.dmDraft ?? "").match(
      /!\[[^\]]*\]\(attachment:[0-9a-f]{32}\.(?:png|jpg|gif|webp)\)/gu,
    );
    state.dmDraft = `${node.value}${
      attachments === null ? "" : `\n${attachments.join("\n")}\n`
    }`;
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
    //
    // Through the helper rather than a bare assignment: the textarea shows
    // only the visible half of the draft, and writing its value straight back
    // would drop the reference lines a staged image lives on.
    updateThreadComposerInput(node);
    return;
  }
});

/* Rows that are divs for markup reasons still have to answer the keyboard. */
document.addEventListener("keydown", (event) => {
  // A real control nested in the row keeps its native keyboard behaviour.
  // In particular, the inline agent-name input must accept Space and submit
  // on Enter rather than activating the row behind it.
  if (event.target.closest?.("button, input, select, textarea, a[href]")) {
    return;
  }
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

/* Channel and thread composers steer their shared @mention and slash-command
   pickers here; the handler also owns Enter-to-send after either list closes. */
document.addEventListener("keydown", (event) => {
  if (
    event.target?.dataset?.act === "channel-input" ||
    event.target?.dataset?.act === "channel-thread-input"
  ) {
    handleComposerKeydown(event, render);
  }
});

/**
 * The prompt's own keys: a number picks that option, Enter takes what was
 * typed, Escape puts the whole set aside.
 *
 * Digits only outside the text box — inside it "1" is somebody typing an
 * answer that starts with a one, and stealing it would make the box unusable
 * for exactly the answers it exists to accept.
 */
document.addEventListener("keydown", (event) => {
  const node = event.target;
  if (node?.dataset?.act === "question-text") {
    if (event.key === "Enter" && !imeComposing(event)) {
      event.preventDefault();
      const typed = node.value.trim();
      if (typed !== "") {
        answerQuestionStep({ text: typed });
      }
    }
    return;
  }
  if (
    state.route !== "chats" ||
    node?.tagName === "INPUT" ||
    node?.tagName === "TEXTAREA" ||
    node?.isContentEditable === true
  ) {
    return;
  }
  const current = questionPromptState();
  if (current === undefined) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    state.questionDismissed[current.pending.requestId] = true;
    render();
    return;
  }
  const picked = Number(event.key) - 1;
  const options = current.questions[current.step]?.options ?? [];
  if (Number.isInteger(picked) && picked >= 0 && picked < options.length) {
    event.preventDefault();
    answerQuestionStep({ chosen: picked });
  }
});

/* The DM composer has no @mention or slash picker steering its Enter, so the
   plain send rule is the whole rule here. */
document.addEventListener("keydown", (event) => {
  const node = event.target;
  if (node?.dataset?.act !== "dm-input") {
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !imeComposing(event)) {
    event.preventDefault();
    node.closest("form")?.requestSubmit();
  }
});

/** Enter or Escape finishes the inline agent-name edit. */
document.addEventListener("keydown", (event) => {
  const node = event.target;
  const act = node?.dataset?.act;
  if (act === "channel-rename-input" && event.key === "Escape") {
    event.preventDefault();
    state.chatSettingsOpenId = undefined;
    render();
    return;
  }
  // Escape abandons a half-typed role and puts the saved one back, which a
  // plain revert of the field's value is: `defaultValue` is what was last
  // committed.
  if (act === "agent-role-input" && event.key === "Escape") {
    event.preventDefault();
    node.value = node.defaultValue;
    node.blur();
    return;
  }
  if (
    (act === "channel-rename-input" ||
      act === "settings-rename-input" ||
      act === "agent-role-input") &&
    event.key === "Enter" &&
    !imeComposing(event)
  ) {
    event.preventDefault();
    node.closest("form")?.requestSubmit();
  }
});

/** The inline rename also saves and closes on blur. */
document.addEventListener("focusout", (event) => {
  const node = event.target;
  const act = node?.dataset?.act;
  // The Settings rename is the same bargain — clicking away commits rather
  // than discards — but it writes account-wide and has no role field beside
  // it, so it commits on its own here.
  if (act === "settings-rename-input") {
    const providerId = node.dataset.value;
    if (providerId && state.settingsRenamingId === providerId) {
      commitAgentRename(providerId, node.value);
    }
    return;
  }
  // The role field on the details tab makes the same bargain: clicking away
  // is how most edits to it end, and losing one because it was never
  // "submitted" would be the field quietly discarding work.
  if (act === "agent-role-input") {
    // Unless the click that took focus away was the chevron beside it. That
    // opens the picker, and committing here would redraw the field — taking
    // the button the menu is anchored to out of the page before the click
    // that opens it lands. Whatever was half-typed is still in the field and
    // still commits on the next blur.
    if (event.relatedTarget?.dataset?.act === "agent-role-menu") {
      return;
    }
    if (node.isConnected) {
      commitChannelRole(node);
    }
    return;
  }
  if (act !== "channel-rename-input") {
    return;
  }
  // Enter already committed and rebuilt the row, and the field this event
  // came from is the one that rebuild threw away. Reading a value off it
  // would commit the same edit a second time.
  if (!node.isConnected) {
    return;
  }
  const agentId = node.dataset.value;
  if (activeChannelId() && agentId && state.chatSettingsOpenId === agentId) {
    if (node.value !== node.defaultValue) {
      renameChannelAgent(activeChannelId(), agentId, node.value);
    }
    state.chatSettingsOpenId = undefined;
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
  // A session that lapses on a deep link leaves the old screen's hash behind,
  // which would then send a reload straight back to a screen there is nobody
  // to draw. Naming the form instead means the sign-in page reloads as the
  // sign-in page.
  const hash = AUTH_MODE_HASHES.get(authMode);
  // `startsWith` rather than equality, because a reset link's hash carries the
  // secret after the form's name — rewriting it to the bare `#reset` would
  // throw away the one thing the page needs.
  if (hash !== undefined && !window.location.hash.startsWith(`#${hash}`)) {
    window.location.hash = `#${hash}`;
  }
  $("#app-root").hidden = true;
  $("#auth-root").hidden = false;
  $("#auth-root").innerHTML = renderAuth();
  if (authMode === "reset" && resetState === undefined) {
    void loadPasswordReset();
  }
}

/**
 * Ends the session an auth link landed on top of, and draws the form it named.
 *
 * The sign-out is the point: a sign-in form drawn over a live session is a
 * dead end, because everything behind it — a reload, another tab, the socket —
 * still belongs to the previous account. Failure is swallowed rather than
 * retried; the form still appears, and signing in from it replaces whatever
 * session is left.
 */
async function signOutForAuthLink(mode) {
  await api("/auth/logout", { method: "POST", body: {} }).catch(
    () => undefined,
  );
  state.principal = undefined;
  authMode = mode;
  showAuth();
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
  // A fresh link decides its own first view; a choice made on the previous
  // one says nothing about this recipient.
  inviteMode = undefined;
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

/**
 * How long news waits to see whether more of it is arriving.
 *
 * Long enough to swallow a backlog, short enough that a single event still
 * reads as immediate.
 */
const NEWS_COALESCE_MS = 350;

/**
 * The same idea for the channel reconcile, and deliberately shorter: this one
 * is what puts a message on screen, so it is the delay somebody notices when
 * a teammate is typing to them.
 */
const CHANNEL_FRAME_COALESCE_MS = 120;

/**
 * How long news waits while the stream is still handing over a backlog.
 *
 * The hub drains from the cursor in batches of five hundred, one poll apart,
 * so a reconnect's history does not arrive as one burst — it arrives as
 * bursts half a second apart. That gap is wider than the live window above,
 * which is why a night's worth of events used to produce a banner per batch
 * rather than a banner. Wider than the hub's poll, so the whole replay
 * settles into one sentence.
 */
const BACKLOG_SETTLE_MS = 1_200;

/**
 * How old an event can be and still be worth interrupting somebody for.
 *
 * News is news for about as long as it is still happening. Anything older
 * than this is history the notifications tab already holds, and announcing it
 * on arrival is how a reader gets told at breakfast about a task that
 * finished before midnight.
 */
const BANNER_STALE_MS = 15 * 60 * 1_000;

let pendingNews = [];
let newsTimer;
let channelFrameTimer;
let catchUpTimer;

/**
 * Whether the stream is still catching this browser up.
 *
 * Set by the hub's `connected` frame and cleared once the stream goes quiet,
 * so a replay is told apart from the events that arrive while somebody is
 * watching. It changes only how long news waits before it speaks.
 */
let catchingUp = false;

function beginCatchUp() {
  catchingUp = true;
  extendCatchUp();
}

function extendCatchUp() {
  if (!catchingUp) {
    return;
  }
  window.clearTimeout(catchUpTimer);
  catchUpTimer = window.setTimeout(() => {
    catchingUp = false;
  }, BACKLOG_SETTLE_MS);
}

/**
 * One line of news, or one line about several.
 *
 * The socket opens with a cursor, so reconnecting delivers everything that
 * happened while it was closed — which on a phone opened the next morning is
 * every task that finished or was stopped overnight. Each of those raised its
 * own banner, five seconds each, stacked down the screen: the reader could
 * not read them, could not dismiss them, and the app appeared to hang while
 * it rendered them.
 *
 * The backlog is not less interesting than one event, but it is not more
 * interesting a hundred times over. Anything arriving inside the window
 * collapses into a count plus the most recent line, and the notifications tab
 * still has all of it in full. `banner` shows one at a time, so even a flush
 * that lands mid-replay replaces its predecessor instead of stacking on it.
 */
function announceNews(line) {
  pendingNews.push(line);
  window.clearTimeout(newsTimer);
  newsTimer = window.setTimeout(
    () => {
      const lines = pendingNews;
      pendingNews = [];
      const latest = lines.at(-1);
      if (latest === undefined) {
        return;
      }
      popupBanner(
        lines.length === 1 ? latest : `${lines.length} updates — latest: ${latest}`,
      );
    },
    catchingUp ? BACKLOG_SETTLE_MS : NEWS_COALESCE_MS,
  );
}

/**
 * The sentence this frame deserves in the corner, or nothing.
 *
 * Three things disqualify a frame, and all three are the same complaint: news
 * somebody has already had. A sequence at or below the announcement watermark
 * was announced in an earlier session; an event already marked read was read
 * on the notifications screen; an event from hours ago is not an
 * interruption. What is left is what actually just happened.
 */
function newsLineForFrame(frame) {
  const sequence = frame?.sequence;
  if (Number.isSafeInteger(sequence) && sequence <= announcedThrough()) {
    return undefined;
  }
  const event = frame?.event;
  const at = Date.parse(event?.occurredAt ?? "");
  if (Number.isFinite(at) && Date.now() - at > BANNER_STALE_MS) {
    return undefined;
  }
  if (notificationSeen(event ?? {})) {
    return undefined;
  }
  return bannerLineForAudit(event);
}

async function boot() {
  if (await handleInviteLink()) {
    return;
  }
  await loadHealth();
  if (state.health?.setupRequired === true && state.principal === undefined) {
    // First-time setup outranks the link: neither signing in nor registering
    // can succeed against a control plane that has no owner yet.
    authMode = "bootstrap";
  } else {
    const mode = authModeFromHash();
    if (mode !== undefined) {
      authMode = mode;
    }
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
  // A link that names a signed-out form is a request for that form. This used
  // to be answered by rewriting the hash to "#chats" whenever a session was
  // already in place, which made `/#signin` open the app of whoever last used
  // the browser — the one thing somebody following a sign-in link is not
  // asking for. The link wins instead, and the session it arrived on top of
  // is ended so the form it opens is one that can actually be used.
  const linked = authModeFromHash();
  if (linked !== undefined && state.principal !== undefined) {
    await signOutForAuthLink(linked);
    return;
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
    // The hub's handshake, and the only warning that a replay is about to
    // start. Everything between here and the stream going quiet is history
    // this browser missed rather than something happening now. Not returned
    // on: this frame has always fallen through to the refresh at the bottom,
    // which is what repaints a screen that has been away.
    if (frame?.type === "connected") {
      beginCatchUp();
    }
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
    // Unsent, and delivered the same private way it was sent.
    if (frame?.type === "direct-message-deleted") {
      noteDirectMessageDeleted(frame);
      if (!renameFieldFocused()) {
        render();
      }
      return;
    }
    // An agent stopped on a question, or one stopped waiting. Both change
    // what the prompt above the composer should be showing, and both are
    // transient: the list is re-read rather than patched from the frame.
    if (frame?.type === "agent-questions-changed") {
      const channel = activeChannelId();
      void loadPendingQuestions(channel).then(() => {
        if (state.route === "chats" && !renameFieldFocused()) {
          render();
        }
      });
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
      // Coalesced for the same reason the banners above are. A reconnect
      // delivers every channel event this browser missed, and each one used
      // to re-read the channel and rebuild the whole app — a backlog of forty
      // meant forty full renders back to back, which is the few seconds the
      // screen spent refusing to respond to a tap. The reconcile is
      // idempotent, so the last one in a burst produces the same answer as
      // all of them.
      window.clearTimeout(channelFrameTimer);
      channelFrameTimer = window.setTimeout(() => {
        void refreshChannelMessages(channelRepositoryId).then(() => render());
      }, CHANNEL_FRAME_COALESCE_MS);
    }
    // The audit half of the same news. The transient frame above is what
    // arrives while somebody is watching; this is what a browser coming back
    // from a reconnect replays, and a question asked while it was away would
    // otherwise wait for the next channel switch to appear.
    if (
      frame?.type === "audit" &&
      ["question_asked", "question_answered", "question_cancelled"].includes(
        String(frame.event?.type ?? ""),
      )
    ) {
      const channel = activeChannelId();
      void loadPendingQuestions(channel).then(() => {
        if (state.route === "chats" && !renameFieldFocused()) {
          render();
        }
      });
    }
    // News gets a banner before the store gets re-read: an ending or a
    // question is worth a sentence in the corner wherever the reader is,
    // which is the notifications tab's job done at the moment it matters.
    if (frame?.type === "audit") {
      // Remembered before anything else: the next connection starts here, and
      // that is what stops the same backlog being replayed — and re-announced
      // — every time a phone comes back to the foreground.
      noteEventSequence(frame.sequence);
      extendCatchUp();
      const line = newsLineForFrame(frame);
      if (line !== undefined) {
        noteAnnounced(frame.sequence);
        announceNews(line);
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
