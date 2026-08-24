/**
 * Kumi — control room entry point.
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
  noteDirectMessageEdited,
  noteDirectMessageDeleted,
  ensureDirectMessages,
  loadChannelStats,
  noteEventSequence,
  loadDmThread,
  sendDirectMessage,
  noteTyping,
  sendTyping,
  currentRepository,
  currentUserId,
  currentUserName,
  DEFAULT_ACCENT,
  DEFAULT_ACCENT_SECONDARY,
  DEFAULT_AGENT_COLOR,
  disconnectGitHub,
  loadContext,
  loadDeferredContext,
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
  setChannelPicture,
  myTheme,
  myThemePreference,
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
  canDeleteRepository,
  closeChannelFile,
  loadChannelFile,
  moveChannelFile,
  saveChannelFile,
  ensureChannelMessages,
  ensureChannelRoster,
  ensureProviderUsage,
  ensureRepositoryGrants,
  markChannelRead,
  refreshChannelMessages,
  refreshProviderUsage,
  takePromptedThread,
  takeReadyPlan,
  addChannelAgent,
  removeChannelAgent,
  renameAgent,
  renameChannelAgent,
  setChannelAgentSetting,
  deleteRepository,
  renameRepository,
  repositoryLabel,
  leaveRepository,
  channelMessagesFor,
  deleteAllChannelThreads,
  deleteChannelMessageEntry,
  deleteChannelReplyEntry,
  deleteChannelThread,
  deleteDirectMessageEntry,
  editChannelMessageEntry,
  editChannelReplyEntry,
  editDirectMessageEntry,
  loadPreview,
  rollbackTask,
  setAuditorPaused,
  simplifySummary,
  uploadAttachment,
  setRepositoryGrant,
  revokeRepositoryGrant,
  updateMemberRole,
  removeMember,
  state,
  toggleChannelMessagePin,
  toggleChannelReaction,
  toggleFavourite,
  dmUnreadTotal,
  isDirectMessagePerson,
  memberName,
  memberRole,
  personOnline,
  loadEarlierChannelMessages,
  loadChannelMessage,
  resendChannelMessage,
  ensureChangeSetForTask,
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
  brandWordmark,
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
  armChime,
  chime,
} from "./ui.js";
import {
  ensureAgentOptions,
  scrollThread,
  sendChat,
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
  TERMINAL_TASK_STATUS,
  cancelTask,
  connectAgent,
  connectGitHubAccount,
  renderAgents,
  retryTask,
  selectAgent,
  startAddAgentFlow,
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
  channelFileEdited,
  clearDirectMessageSelection,
  clearRightPanel,
  createInvitation,
  invitationLink,
  keptRightPanels,
  loadInvitations,
  loadPendingQuestions,
  newestRightPanel,
  pendingQuestionFor,
  putAwayRightPanel,
  readInvitation,
  revokeInvitation,
  saveAppearance,
  signInForInvitation,
} from "./data.js";
import {
  captureChannelScroll,
  channelMessageHasTaskThread,
  channelInfoPopoverHtml,
  closeComposerAutocomplete,
  copyMessageText,
  handleComposerKeydown,
  jumpToUnreadOrLatest,
  openChannel,
  paintComposerSuggestions,
  paintJumpToLatest,
  pickMention,
  pickSlashCommand,
  reactionPicker,
  renderChats,
  resizeComposers,
  rosterMenuItems,
  personMenuItems,
  restoreChannelAnchor,
  restoreChannelScroll,
  scrollDirectMessageToLatest,
  startPlannedWork,
  submitComposerMessage,
  submitThreadReply,
  updateComposerInput,
  updateComposerPresentation,
  updateThreadComposerInput,
  usageOwner,
  usageProviderId,
} from "./screen-chats.js";

// A socket callback cannot unlock browser audio by itself. The first genuine
// interaction quietly prepares it so a later incoming cue can play; no sound
// is made just for touching the interface.
document.addEventListener("pointerdown", armChime, { once: true, passive: true });
document.addEventListener("keydown", armChime, { once: true });

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
 * invitation sent to somebody who is already on Kumi is the ordinary case
 * for a second team or a second repository, and offering that person nothing
 * but "choose a password" is a dead end, because the address is taken and the
 * only account it could belong to is theirs.
 */
function renderInvite() {
  const invite = state.invite;
  if (invite === undefined) {
    return `<main class="auth-shell"><div class="auth-box">
      <div class="auth-mascot">${brandWordmark(120)}
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
      <div class="auth-mascot">${brandWordmark(120)}
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
  const acceptCurrentAccount =
    invite.signedIn === true && inviteMode === undefined;
  return `<main class="auth-shell">
    <div class="auth-box">
      <div class="auth-mascot">${brandWordmark(120)}
        <div>
          <h1>Join ${esc(invite.organizationName)}</h1>
          <!-- Both names, always. The headline is the team you are joining,
               which is a name somebody chose and may be anything at all — an
               organization called after a product reads as that product
               unless the product says so itself. -->
          <p>You have been invited to
            <b>${esc(invite.organizationName)}</b> on Kumi as a
            ${esc(invite.role)}. ${
              acceptCurrentAccount
                ? "Accept the invitation to restore your access."
                : signIn
                ? "Sign in and the invitation is yours."
                : "Choose a password and you are in."
            }</p>
        </div>
      </div>
      <form class="auth-card" data-act="${
        acceptCurrentAccount
          ? "invite-accept"
          : signIn
            ? "invite-signin"
            : "invite-accept"
      }">
        ${
          // An open link names nobody, so the address is asked for rather
          // than shown. The addressed form still shows it and still will not
          // let it be edited: changing it there would be accepting somebody
          // else's invitation.
          acceptCurrentAccount
            ? ""
            : invite.open === true
            ? `<label class="field">
          <span>Email address</span>
          <input class="input" name="email" type="email" autocomplete="email"
            required placeholder="you@company.com">
        </label>`
            : `<label class="field">
          <span>Email address</span>
          <input class="input" value="${esc(invite.email)}" disabled>
        </label>`
        }
        ${
          acceptCurrentAccount
            ? ""
            : signIn
            ? ""
            : `<label class="field">
          <span>Your name</span>
          <input class="input" name="displayName" autocomplete="name" required>
        </label>`
        }
        ${acceptCurrentAccount ? "" : `<label class="field">
          <span>${signIn ? "Your password" : "Choose a password"}</span>
          <input class="input" name="password" type="password" minlength="12"
            autocomplete="${signIn ? "current-password" : "new-password"}"
            required placeholder="••••••••••••">
        </label>`}
        ${
          // Only when the password is being chosen. Retyping one you already
          // know is friction with nothing to catch.
          acceptCurrentAccount || signIn
            ? ""
            : `<label class="field">
          <span>Confirm password</span>
          <input class="input" name="confirmPassword" type="password"
            minlength="12" autocomplete="new-password" required
            placeholder="••••••••••••">
        </label>`
        }
        <button class="btn btn-primary btn-wide" type="submit">
          ${
            acceptCurrentAccount
              ? "Accept and rejoin"
              : signIn
                ? "Sign in and join"
                : "Accept and join"
          }
        </button>
        <p class="form-msg" id="auth-msg" role="alert"></p>
      </form>
      <p class="auth-foot">${
        acceptCurrentAccount
          ? "This invitation will be added to your signed-in account."
          : signIn
          ? `${
              invite.open === true
                ? "No account yet?"
                : `No account for ${esc(invite.email)} yet?`
            } <a class="link-muted" href="#" data-act="invite-mode" data-value="join">Create one</a>.`
          : `Already have a Kumi account? <a class="link-muted" href="#" data-act="invite-mode" data-value="signin">Sign in instead</a>.`
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
        ${brandWordmark(120)}
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
        ${brandWordmark(120)}
        <div>
          <h1>${
            bootstrap
              ? "Set up your control room"
              : register
                ? "Create your account"
                : "Sign in to Kumi"
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
        ${brandWordmark(120)}
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
      String(data.get("email") ?? ""),
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
      // An open link names nobody, so the address is the one typed on this
      // form; an addressed one uses its own, which is why that field is
      // shown disabled rather than as an input.
      state.invite?.open === true
        ? String(data.get("email") ?? "")
        : (state.invite?.email ?? ""),
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
 * reach. Everything it held has somewhere else to be: the brand is the crown
 * of `chanSidebar` (screen-chats.js), Settings and the account are at its foot,
 * and the failure-only health line is there with them.
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
    <button class="account-btn" data-act="user-menu" title="${esc(user)}"
      >${avatar(user, 32, user, myAvatar())}${dmBadge()}</button>
  </header>`;
}

/**
 * The screens the account menu is the way into.
 *
 * Both account buttons — the topbar avatar and the channel sidebar's foot —
 * open the same menu, so this is one change point for both.
 *
 * Notifications is deliberately not one of them any more. Pressing your own
 * name is how you reach your own things, and a backlog of everything every
 * agent has done is not that; it remains reachable by name in the quick
 * switcher.
 *
 * My Agents is absent for the same reason it always was: a roster of agent
 * connections is not the account's own things either, and it keeps the quick
 * switcher and the channel agent menu's "Connect agents" as its doors.
 *
 * The count is read here rather than carried in state, so a number in this
 * menu cannot disagree with the list it sits above.
 */
function accountDestinations() {
  const dms = dmUnreadTotal();
  return [
    {
      act: "dm-list",
      label: "Direct messages",
      iconName: "chatBubble",
      ...(dms === 0 ? {} : { hint: `${dms} unread` }),
    },
  ];
}

/**
 * Everything waiting in direct messages, on the account button.
 *
 * A DM from somebody who is not in the room on screen had no signal anywhere:
 * the count was loaded with the conversation list and only ever rendered
 * beside a person already in this channel's roster.
 */
function dmBadge() {
  const unread = dmUnreadTotal();
  return unread === 0
    ? ""
    : `<span class="dot-badge">${esc(String(unread > 99 ? "99+" : unread))}</span>`;
}

/* ----------------------------------------------------------- settings ---- */

/**
 * Channel activity as a Wrapped-style recap — messages, replies, and tokens
 * for the open repository. Lived in the channel-info popover; Settings is
 * where a look-back belongs, not a tools tray.
 */
function channelStatsCard() {
  const repository = currentRepository();
  const repositoryId = repository?.id ?? "";
  const stats =
    repositoryId === "" ? undefined : state.channelStats[repositoryId];
  const fmt = (value) => Number(value ?? 0).toLocaleString();
  const tiles =
    stats === undefined || stats === null
      ? `<div class="set-row"><span class="sr-body"><div class="sr-sub">Counting…</div></span></div>`
      : `<div class="channel-wrapped">
          <div class="channel-wrapped-tile">
            <div class="channel-wrapped-value">${fmt(stats.messages)}</div>
            <div class="channel-wrapped-label">Messages</div>
          </div>
          <div class="channel-wrapped-tile">
            <div class="channel-wrapped-value">${fmt(stats.replies)}</div>
            <div class="channel-wrapped-label">Replies</div>
          </div>
          <div class="channel-wrapped-tile">
            <div class="channel-wrapped-value">${fmt(stats.tokens)}${
              stats.tokensIncomplete ? "+" : ""
            }</div>
            <div class="channel-wrapped-label">Tokens</div>
          </div>
        </div>`;
  return `<section class="card channel-stats-card">
    <div class="panel-head"><div><h3>Channel wrapped</h3>
      <p>${
        repositoryId === ""
          ? "Open a channel to see how this room has been used."
          : `A look back at #${esc(repositoryId)} — the work this room has held.`
      }</p></div></div>
    ${tiles}
  </section>`;
}

/**
 * The gate every plan passes before a worker is allowed to run it.
 *
 * Project-wide rather than personal — one person raising the bar raises
 * it for everybody's agents — which is why it lives behind Advanced now
 * rather than between a colour picker and a sign-out button.
 */
function admissionsCard() {
  const policy = state.project?.policy ?? {};
  const approvals = policy.approvals ?? {};
  const budgets = policy.budgets ?? {};
  return `<section class="card">
    <div class="panel-head"><div><h3>Admissions</h3>
      <p>What must stop for a person before a plan is admitted</p></div></div>
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
  </section>`;
}

/**
 * Which repository the control plane owns, and on which branch. Read-only
 * by design: canonical moves through the pipeline, not through a field on
 * a settings page.
 */
function repositoryCard() {
  const repository = currentRepository();
  return `<section class="card">
    <div class="panel-head"><div><h3>Repository</h3>
      <p>Canonical state is owned by the control plane</p></div></div>
    <div class="set-row">
      <span class="sr-body">
        <div class="sr-title">${esc(repository?.id ?? "No repository open")}</div>
        <div class="sr-sub">${esc(
          repository?.remoteUrl ?? "No remote recorded",
        )}. Publishing canonical to a remote branch is <code>/push</code> in
        the channel; the CLI does the same thing from outside the product.
        </div>
      </span>
      <span class="sr-ctl">
        <code class="hint-code">/push</code>
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
  </section>`;
}

const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "General",
    iconName: "gear",
    description: "Your account, theme, colours, and everyday preferences.",
  },
  {
    id: "agents",
    label: "Agents",
    iconName: "robot",
    description: "Connect and name the coding agents that belong to you.",
  },
  {
    id: "connections",
    label: "Connections",
    iconName: "link",
    description: "External accounts Kumi can use on your behalf.",
  },
  {
    id: "workspace",
    label: "Workspace",
    iconName: "users",
    description: "People and activity in the channel you have open.",
  },
  {
    id: "advanced",
    label: "Advanced",
    iconName: "sliders",
    description: "Project-wide repository and admission controls.",
  },
];

function accountCard() {
  return `<section class="card settings-account-card">
    <div class="panel-head"><div><h3>Account</h3>
      <p>The identity you use across this Kumi workspace</p></div></div>
    <div class="set-row">
      <span class="settings-account-avatar">
        ${avatar(currentUserName(), 42, currentUserName(), myAvatar())}
      </span>
      <span class="sr-body">
        <div class="sr-title">${esc(currentUserName())}</div>
        <div class="sr-sub">${esc(state.principal?.user?.email ?? "")}</div>
      </span>
      <span class="sr-ctl">
        <button class="btn btn-sm" data-act="logout">${icon("logout")} Sign out</button>
      </span>
    </div>
  </section>`;
}

function preferencesCard() {
  const sounds = window.localStorage.getItem("ag.messageSounds") !== "false";
  return `<section class="card">
    <div class="panel-head"><div><h3>Preferences</h3>
      <p>Small behaviours that apply only in this browser</p></div></div>
    <div class="set-row">
      <span class="sr-body">
        <div class="sr-title">Sound effects</div>
        <div class="sr-sub">Quiet cues for sent and incoming messages, completed work, and items that need attention.</div>
      </span>
      <span class="sr-ctl">
        <button type="button" class="switch${sounds ? " on" : ""}"
          data-act="settings-sounds" aria-pressed="${sounds}"
          aria-label="Sound effects"></button>
      </span>
    </div>
  </section>`;
}

function settingsSectionMarkup(section) {
  switch (section) {
    case "agents":
      return agentsCard();
    case "connections":
      return (
        githubCard() ||
        `<section class="card"><div class="set-row"><span class="sr-body">
          <div class="sr-title">No connections available</div>
          <div class="sr-sub">This deployment does not offer any external
            account connections.</div></span></div></section>`
      );
    case "workspace":
      return `${invitationsCard()}${channelStatsCard()}`;
    case "advanced":
      return `${repositoryCard()}${admissionsCard()}`;
    default:
      return `${accountCard()}${appearanceCard()}${preferencesCard()}`;
  }
}

/**
 * Settings is a large dialog over the conversation, with one stable category
 * rail and a single, focused content pane. It deliberately does not become a
 * router screen: closing it returns to the exact channel and scroll position
 * that were visible underneath.
 */
function settingsDialog() {
  const selected = SETTINGS_SECTIONS.some(
    (section) => section.id === state.settingsSection,
  )
    ? state.settingsSection
    : "general";
  const section =
    SETTINGS_SECTIONS.find((candidate) => candidate.id === selected) ??
    SETTINGS_SECTIONS[0];
  return `<div class="settings-layer" data-act="settings-backdrop">
  <style id="settings-dialog-styles">
    .settings-layer{position:fixed;inset:0;z-index:84;display:grid;place-items:center;padding:24px;background:rgba(4,5,9,.58);backdrop-filter:blur(3px)}
    .settings-dialog{width:min(980px,calc(100vw - 48px));height:min(720px,calc(100dvh - 48px));min-height:min(520px,calc(100dvh - 48px));display:grid;grid-template-columns:220px minmax(0,1fr);overflow:hidden;background:var(--bg-card);border:1px solid var(--border-strong);border-radius:16px;box-shadow:var(--shadow-pop);color:var(--text)}
    .settings-layer.settings-entering{animation:scrim-in var(--motion-scrim) ease}
    .settings-layer.settings-entering .settings-dialog{animation:settings-in var(--motion-pop) ease}
    .settings-layer.settings-leaving{animation:scrim-out var(--motion-scrim) ease forwards;pointer-events:none}
    .settings-layer.settings-leaving .settings-dialog{animation:settings-out var(--motion-pop) ease forwards}
    @keyframes settings-in{from{opacity:0;transform:translateY(6px) scale(.99)}}
    @keyframes settings-out{to{opacity:0;transform:translateY(6px) scale(.99)}}
    .settings-sidebar{min-width:0;display:flex;flex-direction:column;padding:18px 12px 14px;background:var(--bg-panel);border-right:1px solid var(--border-soft)}
    .settings-brand{display:flex;align-items:center;gap:9px;padding:2px 9px 16px;font-size:15px;font-weight:650;letter-spacing:-.01em}.settings-brand .ui-icon{width:17px;height:17px;color:var(--text-2)}
    .settings-nav{display:grid;gap:3px}.settings-nav-item{width:100%;min-height:38px;display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;color:var(--text-2);font-size:13px;text-align:left}.settings-nav-item:hover{background:var(--bg-hover);color:var(--text)}.settings-nav-item.active{background:var(--bg-active);color:var(--text);font-weight:550}.settings-nav-item .ui-icon{width:15px;height:15px;color:var(--text-3)}.settings-nav-item.active .ui-icon{color:var(--text)}
    .settings-sidebar-account{display:flex;align-items:center;gap:9px;margin-top:auto;padding:12px 9px 2px;border-top:1px solid var(--border-soft);min-width:0}.settings-sidebar-account-copy{min-width:0}.settings-sidebar-account-name,.settings-sidebar-account-email{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.settings-sidebar-account-name{font-size:12.5px;font-weight:550}.settings-sidebar-account-email{font-size:11px;color:var(--text-4);margin-top:1px}
    .settings-main{min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--bg-card)}
    .settings-main-head{min-height:86px;display:flex;align-items:flex-start;gap:18px;padding:23px 26px 18px;border-bottom:1px solid var(--border-soft)}.settings-main-title{min-width:0}.settings-main-title h2{font-size:20px;line-height:1.25;letter-spacing:-.025em}.settings-main-title p{margin-top:5px;color:var(--text-3);font-size:12.5px}.settings-close{margin-left:auto;flex:none}
    .settings-content.scroll{min-height:0;padding:22px 26px 30px}.settings-content-inner{display:grid;gap:14px;max-width:680px;margin:0 auto}.settings-content .card{box-shadow:none;border-color:var(--border-soft);background:var(--bg-card-2)}.settings-content .panel-head{padding:16px 17px 10px}.settings-content .panel-head h3{font-size:14px}.settings-content .panel-head p{margin-top:3px}.settings-account-avatar{flex:none}.settings-choice{display:inline-flex;gap:3px;padding:3px;background:var(--bg-inset);border:1px solid var(--border-soft);border-radius:9px}.settings-choice button{padding:5px 10px;border-radius:6px;color:var(--text-3);font-size:12px}.settings-choice button:hover{color:var(--text)}.settings-choice button.active{background:var(--bg-active);color:var(--text);box-shadow:0 1px 2px rgb(0 0 0 / 18%)}
    @media(max-width:700px){.settings-layer{padding:0}.settings-dialog{width:100vw;height:100dvh;min-height:0;border:0;border-radius:0;grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.settings-sidebar{padding:calc(10px + var(--safe-top)) 12px 10px;border-right:0;border-bottom:1px solid var(--border-soft)}.settings-brand{padding:0 4px 10px}.settings-nav{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none}.settings-nav::-webkit-scrollbar{display:none}.settings-nav-item{width:auto;min-height:34px;flex:none;padding:7px 10px}.settings-sidebar-account{display:none}.settings-main-head{min-height:78px;padding:16px 18px 14px}.settings-main-title p{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.settings-content.scroll{padding:16px 14px calc(24px + var(--safe-bottom))}.settings-content .set-row{align-items:flex-start;flex-wrap:wrap}.settings-content .set-row .sr-ctl{margin-left:auto}.settings-choice button{padding:6px 9px}}
  </style>
    <section class="settings-dialog" data-act="settings-dialog" role="dialog"
      aria-modal="true" aria-labelledby="settings-title">
      <aside class="settings-sidebar">
        <div class="settings-brand">${icon("gear")}<span>Settings</span></div>
        <nav class="settings-nav" aria-label="Settings categories">
          ${SETTINGS_SECTIONS.map(
            (item) => `<button type="button" class="settings-nav-item${
              item.id === selected ? " active" : ""
            }" data-act="settings-section" data-value="${esc(item.id)}"
              aria-current="${item.id === selected ? "page" : "false"}">
              ${icon(item.iconName)}<span>${esc(item.label)}</span></button>`,
          ).join("")}
        </nav>
        <div class="settings-sidebar-account">
          ${avatar(currentUserName(), 30, currentUserName(), myAvatar())}
          <span class="settings-sidebar-account-copy">
            <div class="settings-sidebar-account-name">${esc(currentUserName())}</div>
            <div class="settings-sidebar-account-email">${esc(
              state.principal?.user?.email ?? "",
            )}</div>
          </span>
        </div>
      </aside>
      <div class="settings-main">
        <header class="settings-main-head">
          <div class="settings-main-title"><h2 id="settings-title">${esc(
            section.label,
          )}</h2><p>${esc(section.description)}</p></div>
          <button type="button" class="icon-btn settings-close"
            data-act="settings-close" aria-label="Close settings"
            title="Close settings">${icon("close")}</button>
        </header>
        <div class="settings-content scroll" data-scroll-key="settings">
          <div class="settings-content-inner">
            ${settingsSectionMarkup(selected)}
          </div>
        </div>
      </div>
    </section>
  </div>`;
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
  const broken = github?.credential?.unusableReason;
  const connected = github?.connected === true;
  return `<section class="card">
    <div class="panel-head"><div><h3>GitHub</h3></div></div>
    <div class="set-row">
      <span class="sr-body">
        <div class="sr-title">${
          connected
            ? `Connected as ${esc(github.login ?? "you")}`
            : "Not connected"
        }</div>
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
    <div class="panel-head"><div><h3>Agents</h3></div></div>
    ${
      agents.length === 0
        ? `<div class="set-row"><span class="sr-body">
             <div class="sr-sub">No agent providers are configured on this
               deployment.</div></span></div>`
        : agents
            .map((agent) => {
              // The row title is the vendor people say ("Claude"), not the
              // call sign. The call sign belongs on the status line below —
              // "Connected as Hera" — so both facts stay visible at once
              // instead of the name swallowing the provider.
              // Rename still edits the call sign: the owner suffix is dropped
              // from a vendor-label fallback ("Claude (Nathan)" → "Claude")
              // but never from a name somebody chose — an agent called
              // "Athena (night shift)" keeps every word of it.
              const callSign =
                agent.hasName === true
                  ? agent.name
                  : agent.name.replace(/\s*\(.*\)$/u, "");
              const renaming = state.settingsRenamingId === agent.id;
              // Three states, not two: a credential that has stopped
              // authenticating is stored but useless, and saying "connected"
              // about it is what let every task it was given fail in silence.
              // Four states, because the merged card has to keep the
              // distinction the second card existed for: a provider the
              // deployment offers, one this machine's account is signed in to,
              // one *you* are signed in to, and a stored credential that has
              // stopped authenticating. Saying "connected" about the second or
              // the fourth is what let every task an agent was given fail
              // without the screen ever admitting anything was wrong.
              const state_ = agent.needsReconnect
                ? { text: "Sign-in expired", cls: " sr-warn" }
                : agent.mine
                  ? {
                      text:
                        agent.hasName === true
                          ? `Connected as ${agent.name}`
                          : "Connected as you",
                      cls: "",
                    }
                  : agent.hostAccount
                    ? {
                        text: "Available on this deployment — using this machine's account",
                        cls: "",
                      }
                    : { text: "Not connected", cls: "" };
              return `<div class="set-row">
                <span class="sr-body">
                  ${
                    renaming
                      ? `<form class="agent-rename" data-act="agent-rename-form"
                          data-value="${esc(agent.id)}">
                          <input class="input" data-act="settings-rename-input"
                            data-value="${esc(agent.id)}" maxlength="40"
                            aria-label="Agent name" value="${esc(callSign)}">
                          <button class="btn btn-sm btn-primary" type="submit">Save</button>
                        </form>`
                      : `<div class="sr-title">${esc(agentLabelOf(agent.id))}</div>`
                  }
                  <div class="sr-sub${state_.cls}">${esc(state_.text)}${
                    agent.detail ? ` — ${esc(agent.detail)}` : ""
                  }</div>
                </span>
                <span class="sr-ctl">
                  ${
                    // A name belongs to a connection: there is nothing to
                    // rename on a vendor this account has never connected,
                    // and the server says so rather than guessing. An expired
                    // sign-in still has one, so it can still be renamed.
                    renaming || !(agent.mine || agent.needsReconnect)
                      ? ""
                      : `<button type="button" class="btn btn-sm"
                          data-act="agent-rename-toggle"
                          data-value="${esc(agent.id)}"
                          title="Rename this agent everywhere">Rename</button>`
                  }
                  ${
                    // The control follows this account's own credential, not
                    // the machine's. Offering "Disconnect" on a host-account
                    // row hid the connect flow behind a button that did the
                    // opposite, and there was no way to attach your own
                    // account at all.
                    agent.mine && !agent.needsReconnect
                      ? `<button type="button" class="btn btn-sm"
                          data-act="agent-disconnect"
                          data-value="${esc(agent.id)}">Disconnect</button>`
                      : `<button type="button" class="btn btn-sm btn-primary"
                          data-act="agent-connect"
                          data-value="${esc(agent.id)}">${
                            agent.needsReconnect
                              ? "Reconnect"
                              : agent.hostAccount
                                ? "Connect yours"
                                : "Connect"
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

function appearanceCard() {
  const accent = myAccent();
  const agentColor = myAgentColor();
  const theme = myThemePreference();
  return `<section class="card">
    <div class="panel-head"><div><h3>Appearance</h3>
      <p>How Kumi looks to you, and how your agents look to everyone</p></div></div>

    <div class="set-row">
      <span class="sr-body">
        <div class="sr-title">Theme</div>
        <div class="sr-sub">Follow your device, or keep Kumi light or dark.</div>
      </span>
      <span class="sr-ctl settings-choice" role="group" aria-label="Theme">
        ${[
          ["system", "System"],
          ["light", "Light"],
          ["dark", "Dark"],
        ]
          .map(
            ([value, label]) => `<button type="button" class="${
              theme === value ? "active" : ""
            }" data-act="settings-theme" data-value="${value}"
              aria-pressed="${theme === value}">${label}</button>`,
          )
          .join("")}
      </span>
    </div>

    <div class="set-row">
      <span class="sr-body">
        <div class="sr-title">Profile picture</div>
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
      accent,
    )}

    ${colourRow(
      "set-accent-secondary",
      "Secondary colour",
      myAccentSecondary(),
    )}

    ${colourRow(
      "set-agent-color",
      "Your agents' colour",
      agentColor,
      `<div class="doodle-preview" style="color:${esc(agentColor)}">
        ${[
          "anthropic",
          "cursor",
          "copilot",
          "kiro",
          "openai",
          "google",
          "xai",
          "deepseek",
        ]
          .map(
            (kind) => `<span class="doodle-chip">
              <span class="doodle">${vendorMark(kind)}</span>
              <b>${esc(agentLabelOf(kind))}</b>
            </span>`,
          )
          .join("")}
      </div>`,
    )}

    <div class="set-row">
      <span class="sr-body">
        <div class="sr-title">Default colours</div>
      </span>
      <span class="sr-ctl">
        <button type="button" class="btn btn-quiet" data-act="colours-reset">
          Reset colours
        </button>
      </span>
    </div>
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
function colourRow(act, title, current, extra = "") {
  const open = state.openWheel === act;
  return `<div class="set-row">
      <span class="sr-body">
        <div class="sr-title">${title}</div>
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
  const accessDetail = fixed
    ? `They will get access to ${repositoryId}, and nothing else in this project.`
    : "Access is granted per repository. Pick the one to share, or share " +
      "everything if they are joining the team properly.";
  const values = await showModal({
    title: fixed ? `Invite someone to #${repositoryId}` : "Invite someone to collaborate",
    subtitle:
      `${accessDetail} The readable name is the link's key, so anyone who ` +
      "guesses it can use the invitation.",
    confirm: "Create invite link",
    body: `<label class="field">
        <span>Name for the invite link</span>
        <input class="input" name="recipientName" autocomplete="off"
          autocapitalize="characters" spellcheck="false" minlength="6" maxlength="48"
          pattern="[A-Za-z0-9]+([ -][A-Za-z0-9]+)*" placeholder="Nathan" required autofocus>
      </label>${
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
  if (values === undefined) {
    return;
  }
  try {
    // No address. The button makes the link, and where the link goes is not
    // this app's business — most of the time it is the group chat the team
    // is already in, which was never something an email field could express.
    const created = await createInvitation(
      values.recipientName,
      values.role,
      values.repositoryId,
    );
    rerender();
    await showInviteLink(created.token, values.repositoryId);
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
async function showInviteLink(token, repositoryId) {
  const link = invitationLink(token);
  await showModal({
    title: "Send this link",
    subtitle: `Anyone who opens it joins ${
      repositoryId ? `#${repositoryId}` : "this project"
    }, and as many people can as you send it to. It works for seven days
      unless you revoke it. The readable name is the link's key, so anyone
      who guesses it can use this invitation. The link is not stored — so
      this is the only time it can be copied.`,
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
async function removeChannelAgentAction(agentId) {
  const repositoryId = activeChannelId();
  const agent = channelAgentsFor(repositoryId).find(
    (candidate) => candidate.id === agentId,
  );
  if (!repositoryId || agent?.mine !== true) {
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
  removeChannelAgent(repositoryId, agentId);
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
    state.activeChannelThreads = (state.activeChannelThreads ?? []).filter(
      (id) => id !== messageId,
    );
    if (state.activeChannelThread === messageId) {
      state.activeChannelThread = state.activeChannelThreads.at(-1);
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
      state.activeChannelThreads = (state.activeChannelThreads ?? []).filter(
        (id) => id !== messageId,
      );
      state.activeChannelThread = state.activeChannelThreads.at(-1);
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

/** One compact editor shared by channel roots, replies, and direct messages. */
async function messageEditValue(
  content,
  { agentAware = false, maxLength = 10_000 } = {},
) {
  const values = await showModal({
    title: "Edit message",
    subtitle: agentAware
      ? "You can correct it until somebody replies or an agent starts acting on it."
      : "The correction appears for everyone in this conversation.",
    confirm: "Save",
    body: `<label class="field">
        <span>Message</span>
        <textarea class="input" name="content" rows="6" maxlength="${String(maxLength)}"
          required autofocus>${esc(String(content ?? ""))}</textarea>
      </label>`,
  });
  const next = String(values?.content ?? "").trim();
  return values === undefined || next === "" ? undefined : next;
}

async function editChannelMessageAction(repositoryId, messageId) {
  const message = channelMessagesFor(repositoryId).find(
    (entry) => entry.id === messageId,
  );
  if (message === undefined) {
    return;
  }
  const content = await messageEditValue(message.content, { agentAware: true });
  if (content === undefined || content === String(message.content ?? "").trim()) {
    return;
  }
  try {
    await editChannelMessageEntry(repositoryId, messageId, content);
    toast("Message updated", "ok");
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function editChannelReplyAction(repositoryId, messageId, replyId) {
  const root = channelMessagesFor(repositoryId).find(
    (entry) => entry.id === messageId,
  );
  const reply = (root?.replies ?? []).find((entry) => entry.id === replyId);
  if (reply === undefined) {
    return;
  }
  const content = await messageEditValue(reply.content, { agentAware: true });
  if (content === undefined || content === String(reply.content ?? "").trim()) {
    return;
  }
  try {
    await editChannelReplyEntry(repositoryId, messageId, replyId, content);
    toast("Message updated", "ok");
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function editDirectMessageAction(userId, messageId) {
  const message = (state.dmThreads[userId] ?? []).find(
    (entry) => entry.id === messageId,
  );
  if (message === undefined) {
    return;
  }
  const content = await messageEditValue(message.content, { maxLength: 8_000 });
  if (content === undefined || content === String(message.content ?? "").trim()) {
    return;
  }
  try {
    await editDirectMessageEntry(userId, messageId, content);
    toast("Message updated", "ok");
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
    state.activeChannelThreads = [];
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
 * Puts images in the draft, as the reference a message carries, and says
 * plainly what it would not take.
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
  // Named, not counted. Dropping a screenshot and a log together attached the
  // screenshot and said nothing at all about the log — the message went out
  // referring to a file that was never uploaded, and the sender had no way to
  // know. The allowlist itself is deliberately short and is not widened here:
  // that crosses a security boundary `attachments.ts` keeps on purpose and
  // deserves its own review.
  const skipped = files.filter((file) => !file.type.startsWith("image/"));
  if (skipped.length > 0) {
    const named = skipped
      .slice(0, 3)
      .map((file) => file.name)
      .join(", ");
    toast(
      `Not attached: ${named}${
        skipped.length > 3 ? ` and ${skipped.length - 3} more` : ""
      } — only PNG, JPEG, GIF and WebP images can be attached.`,
      "error",
    );
  }
  if (
    repositoryId === undefined ||
    images.length === 0 ||
    (target === "dm" && dmUserId === undefined)
  ) {
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
 * Irreversible: cascades the repository's own channel and grants, and takes
 * the execution history with it. A single confirm button is too easy to hit
 * by reflex for something nobody can undo, so this asks for the repository's
 * name to be typed out — `yesiwanttodelete<name>` — and refuses anything
 * else. The name is whatever the repository is called on screen right now, so
 * a renamed repository asks for its new name rather than its id; spaces are
 * dropped so the phrase stays one word. Matched case-insensitively and
 * trimmed: the phrase is there to make the person read what they are
 * deleting, not to catch a stray capital.
 *
 * Only owners and co-owners are offered the control at all (see
 * `canDeleteRepository`), and the server refuses anyone else regardless.
 */
async function deleteRepositoryAction(repositoryId) {
  const label = repositoryLabel(repositoryId);
  const phrase = `yesiwanttodelete${label.replace(/\s+/gu, "")}`;
  const values = await showModal({
    title: "Delete this repository?",
    subtitle: `This permanently deletes ${label}, its chat history, and its repository-scoped grants. This cannot be undone.`,
    confirm: "Delete repository",
    body: `<label class="field">
        <span>Type <code>${esc(phrase)}</code> to confirm</span>
        <input class="input" name="confirmation" autocomplete="off"
          autocapitalize="off" spellcheck="false" required autofocus
          placeholder="${esc(phrase)}">
      </label>`,
  });
  if (values === undefined) {
    return;
  }
  if (String(values.confirmation ?? "").trim().toLowerCase() !== phrase.toLowerCase()) {
    toast(`Type ${phrase} exactly to delete this repository`, "error");
    return;
  }
  try {
    await deleteRepository(repositoryId);
    closePopover();
    toast(`Deleted ${label}`, "ok");
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * Renaming a repository — what it is called, not what it is keyed by.
 *
 * The id keeps addressing the channel, its tasks and its files, so the modal
 * says so rather than implying a rename moves anything. Clearing the field
 * puts the repository back to being called by its id.
 */
async function renameRepositoryAction(repositoryId) {
  const current = repositoryLabel(repositoryId);
  const values = await showModal({
    title: "Rename this repository",
    subtitle: `Changes what ${repositoryId} is called here. Its id keeps addressing the channel, its tasks and its files.`,
    confirm: "Rename",
    body: `<label class="field">
        <span>Name</span>
        <input class="input" name="name" value="${esc(current)}"
          maxlength="80" autocomplete="off" placeholder="${esc(repositoryId)}">
      </label>`,
  });
  if (values === undefined) {
    return;
  }
  const name = String(values.name ?? "").trim();
  if (name === current) {
    closePopover();
    return;
  }
  try {
    await renameRepository(repositoryId, name);
    closePopover();
    toast(name === "" ? `Renamed back to ${repositoryId}` : `Renamed to ${name}`, "ok");
    render();
  } catch (error) {
    toast(error.message, "error");
  }
}

/** Changes an organization member's role, or a guest's repository grant. */
async function memberRoleAction(repositoryId, userId) {
  const name = memberName(userId) ?? userId;
  const organizationRole = memberRole(userId);
  const current =
    organizationRole ??
    (state.repositoryGrants[repositoryId] ?? []).find(
      (grant) => grant.userId === userId,
    )?.role;
  const values = await showModal({
    title: `Change ${name}'s role`,
    subtitle:
      organizationRole === undefined
        ? `This role applies to ${repositoryId}.`
        : "This role applies across every repository they can reach through this organization.",
    confirm: "Change role",
    body: `<label class="field">
        <span>Role</span>
        <select class="input" name="role">
          ${INVITE_ROLES.map(
            (role) => `<option value="${esc(role.value)}"${
              role.value === current ? " selected" : ""
            }>${esc(role.label)} — ${esc(role.detail)}</option>`,
          ).join("")}
        </select>
      </label>`,
  });
  if (values === undefined) {
    return;
  }
  const role = String(values.role ?? "");
  if (role === current) {
    closePopover();
    return;
  }
  try {
    if (organizationRole === undefined) {
      await setRepositoryGrant(repositoryId, userId, role);
      const person = (state.channelPeople[repositoryId] ?? []).find(
        (entry) => (entry.user?.id ?? entry.userId ?? entry.id) === userId,
      );
      if (person !== undefined) {
        person.role = role;
      }
      delete state.repositoryGrants[repositoryId];
      await ensureRepositoryGrants(repositoryId, render);
    } else {
      await updateMemberRole(userId, role);
    }
    const label = INVITE_ROLES.find((option) => option.value === role)?.label ?? role;
    toast(`${name} is now ${label}`, "ok");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    closePopover();
    render();
  }
}

/** Removes an organization member or repository-only guest from KUMI. */
async function removeMemberAction(repositoryId, userId) {
  const name = memberName(userId) ?? userId;
  const organizationRole = memberRole(userId);
  const confirmed = await showModal({
    title: `Remove ${name} from KUMI?`,
    subtitle:
      organizationRole === undefined
        ? `They lose access to ${repositoryId}. Their messages stay in the channels they wrote them in.`
        : "They lose access to every repository this organization owns. Their messages stay in the channels they wrote them in.",
    confirm: "Remove from KUMI",
  });
  if (confirmed === undefined) {
    return;
  }
  try {
    if (organizationRole === undefined) {
      await revokeRepositoryGrant(repositoryId, userId);
      state.channelPeople[repositoryId] = (
        state.channelPeople[repositoryId] ?? []
      ).filter(
        (person) =>
          (person.user?.id ?? person.userId ?? person.id) !== userId,
      );
      delete state.repositoryGrants[repositoryId];
    } else {
      await removeMember(userId);
      if (
        (state.repositoryGrants[repositoryId] ?? []).some(
          (grant) => grant.userId === userId,
        )
      ) {
        // Organization membership and repository grants are additive. Clear
        // the visible repository grant too, or a promoted co-owner would stay
        // in this room immediately after being removed from KUMI.
        await revokeRepositoryGrant(repositoryId, userId);
        delete state.repositoryGrants[repositoryId];
      }
    }
    toast(`Removed ${name}`, "ok");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    closePopover();
    render();
  }
}

/**
 * Promoting an existing organization member to repository-scoped co-owner —
 * the same capabilities the repository's creator has there, without
 * touching the member's organization-wide role.
 *
 * Prefer a concrete `userId` from the People-row menu. Without one, a picker
 * still asks which member — the old channel-info promote button used that.
 */
async function promoteRepositoryOwnerAction(repositoryId, userId) {
  let targetUserId = userId;
  if (!targetUserId) {
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
    targetUserId = values.userId;
  } else {
    const confirmed = await showModal({
      title: "Promote to co-owner?",
      subtitle:
        `Gives full capabilities on ${repositoryId} only — the same the ` +
        `repository's creator has there — without changing their ` +
        "organization-wide role.",
      confirm: "Promote",
    });
    if (confirmed === undefined) {
      return;
    }
  }
  try {
    await setRepositoryGrant(repositoryId, targetUserId, "owner");
    toast("Promoted to repository co-owner", "ok");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    delete state.repositoryGrants[repositoryId];
    void ensureRepositoryGrants(repositoryId, render);
    render();
    refreshChannelInfoPopover();
  }
}

/** Revoking a repository-scoped grant on someone else's behalf. */
async function revokeRepositoryGrantAction(repositoryId, userId) {
  try {
    if (memberRole(userId) === undefined) {
      // A repository-only guest would disappear entirely if their sole grant
      // were revoked. Demotion keeps them in KUMI as a developer; the
      // dedicated Remove action is what takes the grant away altogether.
      await setRepositoryGrant(repositoryId, userId, "developer");
      const person = (state.channelPeople[repositoryId] ?? []).find(
        (entry) => (entry.user?.id ?? entry.userId ?? entry.id) === userId,
      );
      if (person !== undefined) {
        person.role = "developer";
      }
      toast("Demoted from co-owner to Developer", "ok");
    } else {
      await revokeRepositoryGrant(repositoryId, userId);
      toast("Co-owner access removed", "ok");
    }
  } catch (error) {
    toast(error.message, "error");
  } finally {
    delete state.repositoryGrants[repositoryId];
    void ensureRepositoryGrants(repositoryId, render);
    render();
    refreshChannelInfoPopover();
  }
}

/** Pending invitations, for the Settings screen. */
function invitationsCard() {
  // Accepted, revoked, and expired offers are historical records rather than
  // people still waiting to join. Keep this surface focused on invitations
  // that can still be acted on.
  const rows = (state.invitations ?? []).filter(
    (invitation) => invitation.status === "pending",
  );
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
            No pending invitations. An invitation grants one repository by
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
    neutralGround || (light ? "#ddd7cb" : "#121110"),
    accent,
    0.02,
  );
  const roomTint = mix(
    neutralRoom || (light ? "#f1ede3" : "#1a1817"),
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
  // The words written *on* the accent, for the surfaces that are filled with
  // it rather than tinted by it — a sent private message being the one people
  // read most. White is right for a deep blue and unreadable on a chosen
  // yellow, so this asks which of the theme's own two extremes actually reads
  // against the colour somebody picked instead of assuming either.
  root.setProperty("--accent-ink", accentInk(accent));
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

/**
 * The readable ink for text sitting on a filled accent.
 *
 * Not a search, because there are only two answers worth having: near-white
 * and near-black are the two colours a filled bubble can carry without
 * inventing a third tone the palette does not have. Whichever stands further
 * off the accent wins, which lands white on a deep blue and black on the
 * yellows and limes the wheel also allows — the case a hardcoded `#fff` got
 * wrong every time.
 */
function accentInk(accent) {
  return contrastRatio("#ffffff", accent) >= contrastRatio("#141312", accent)
    ? "#ffffff"
    : "#141312";
}

/* ------------------------------------------------------------- router ---- */

const ROUTES = new Set([
  "chats",
  "agents",
  "notifications",
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

const RIGHT_PANEL_DRAG_TYPE = "application/x-coord-right-panel";

/**
 * Move a surface to one end of the column.
 *
 * Both ways in use it. Every button that opens something calls it with
 * `"right"` once it has set its own state: a surface being asked for is what
 * the right edge means, and one already held further back would otherwise sit
 * where it was — which on a phone, where only the edge is drawn, looks like
 * the button did nothing at all. Dragging a panel's own name onto the
 * conversation is the other direction, and says "keep this one, out of the
 * way" without closing it.
 *
 * A kind that is not open is not moved. `keptRightPanels` is what decides
 * that, so the press also reconciles the column before joining it.
 */
function moveRightPanel(kind, edge) {
  const kept = keptRightPanels();
  if (!kept.includes(kind)) {
    return;
  }
  const rest = kept.filter((open) => open !== kind);
  state.rightPanelStack =
    edge === "left" ? [kind, ...rest] : [...rest, kind];
}

/** Add a thread as its own side tab and make it the active composer target. */
function openThreadPanel(messageId) {
  const current = state.activeChannelThread;
  const open = state.activeChannelThreads ?? [];
  const withCurrent =
    open.length === 0 && current !== undefined ? [current] : open;
  state.activeChannelThread = messageId;
  state.activeChannelThreads = [
    ...withCurrent.filter((id) => id !== messageId),
    messageId,
  ];
  moveRightPanel(`thread:${messageId}`, "right");
}

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
  const tab = event.target.closest?.("[data-right-panel-kind]");
  if (tab !== null && tab !== undefined && !phoneLayout()) {
    event.dataTransfer.setData(RIGHT_PANEL_DRAG_TYPE, tab.dataset.rightPanelKind);
    event.dataTransfer.effectAllowed = "move";
    document.querySelector(".chats-shell")?.classList.add("panel-splitting");
    return;
  }
  const row = event.target.closest?.("[data-drag-path]");
  if (row === null || row === undefined) {
    return;
  }
  event.dataTransfer.setData("text/plain", row.dataset.dragPath);
  event.dataTransfer.effectAllowed = "move";
});

document.addEventListener("dragover", (event) => {
  const isPanelTab = [...event.dataTransfer.types].includes(RIGHT_PANEL_DRAG_TYPE);
  const splitTarget = event.target.closest?.(".chan-main, .thread-panel");
  if (isPanelTab && splitTarget !== null && splitTarget !== undefined) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    return;
  }
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

document.addEventListener("dragend", () => {
  document.querySelector(".chats-shell")?.classList.remove("panel-splitting");
});

document.addEventListener("drop", (event) => {
  const panelKind = event.dataTransfer.getData(RIGHT_PANEL_DRAG_TYPE);
  if (panelKind !== "") {
    const transcript = event.target.closest?.(".chan-main");
    const panel = event.target.closest?.(".thread-panel");
    if (transcript !== null && transcript !== undefined) {
      event.preventDefault();
      moveRightPanel(panelKind, "left");
      render();
      return;
    }
    if (
      panel !== null &&
      panel !== undefined &&
      panel.dataset.rightPanelPosition === "right"
    ) {
      event.preventDefault();
      moveRightPanel(panelKind, "right");
      render();
      return;
    }
  }
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

/* ------------------------------------------------- keyboard shortcuts ---- */

/**
 * The quick switcher, and the two keys beside it.
 *
 * Everything reachable in this product is reachable by pointing at it, and
 * nothing was reachable any other way — no shortcut moved between rooms, and
 * a keyboard user crossed the whole sidebar to change channel. This is the
 * one that pays for itself: a room, a person or a screen by name.
 *
 * Drawn in `#layer-root` rather than inside the app shell, the same place
 * popovers live, because the shell is replaced wholesale on every poll — an
 * overlay rendered inside it would be swept away mid-search.
 */
let switcherIndex = 0;

function switcherEntries(query) {
  const term = query.trim().toLowerCase();
  const rows = [
    ...state.repositories.map((repo) => ({
      kind: "Channel",
      label: `# ${repo.id}`,
      act: "switch-channel",
      value: repo.id,
      iconName: "chatBubble",
    })),
    ...state.dmPeople
      .filter((person) => person.id !== currentUserId())
      .map((person) => ({
        kind: "Person",
        label: person.name ?? memberName(person.id) ?? person.id,
        act: "switch-person",
        value: person.id,
        iconName: "users",
      })),
    ...[
      { route: "chats", label: "Chats" },
      { route: "agents", label: "My agents" },
      { route: "notifications", label: "Notifications" },
    ].map((screen) => ({
      kind: "Screen",
      label: screen.label,
      act: "switch-screen",
      value: screen.route,
      iconName: "arrowRight",
    })),
    {
      kind: "Dialog",
      label: "Settings",
      act: "switch-screen",
      value: "settings",
      iconName: "gear",
    },
  ];
  return rows
    .filter((row) => term === "" || row.label.toLowerCase().includes(term))
    .slice(0, 40);
}

function paintSwitcher() {
  const layer = document.querySelector("#qs-layer");
  if (layer === null) {
    return;
  }
  const input = layer.querySelector("[data-act='switch-input']");
  const rows = switcherEntries(input?.value ?? "");
  switcherIndex = rows.length === 0 ? 0 : switcherIndex % rows.length;
  const list = layer.querySelector(".qs-list");
  if (list === null) {
    return;
  }
  list.innerHTML =
    rows.length === 0
      ? `<div class="qs-empty">Nothing matches that</div>`
      : rows
          .map(
            (row, index) => `<button type="button" class="qs-item${
              index === switcherIndex ? " active" : ""
            }" data-act="${row.act}" data-value="${esc(row.value)}">
              ${icon(row.iconName)}
              <span class="qs-label">${esc(row.label)}</span>
              <span class="qs-kind">${esc(row.kind)}</span>
            </button>`,
          )
          .join("");
  list.querySelector(".qs-item.active")?.scrollIntoView({ block: "nearest" });
}

function closeSwitcher() {
  document.querySelector("#qs-layer")?.remove();
}

function openSwitcher() {
  if (document.querySelector("#qs-layer") !== null) {
    closeSwitcher();
    return;
  }
  closePopover();
  switcherIndex = 0;
  const layer = document.createElement("div");
  layer.id = "qs-layer";
  layer.className = "qs-layer";
  layer.innerHTML = `<div class="pop-scrim" data-act="switch-close"></div>
    <div class="qs-card" role="dialog" aria-label="Go to">
      <input class="qs-input" data-act="switch-input" type="text"
        placeholder="Go to a channel, a person, or a screen…"
        aria-label="Go to" autocomplete="off">
      <div class="qs-list" role="listbox"></div>
    </div>`;
  document.querySelector("#layer-root").append(layer);
  paintSwitcher();
  layer.querySelector("[data-act='switch-input']")?.focus();
}

/** What the keys do, said in one place rather than learned by accident. */
function openShortcutSheet() {
  const pairs = [
    ["Ctrl / ⌘ + K", "Go to a channel, a person, or a screen"],
    ["?", "This list"],
    ["Esc", "Close whatever is stacked over the conversation"],
    ["Enter", "Send; Shift + Enter starts a new line"],
    ["↑ / ↓", "Move through an open command or name list"],
  ];
  closeSwitcher();
  const layer = document.createElement("div");
  layer.id = "qs-layer";
  layer.className = "qs-layer";
  layer.innerHTML = `<div class="pop-scrim" data-act="switch-close"></div>
    <div class="qs-card" role="dialog" aria-label="Keyboard shortcuts">
      <div class="qs-head">Keyboard shortcuts</div>
      <div class="qs-keys">${pairs
        .map(
          ([keys, what]) =>
            `<div class="qs-key"><kbd>${esc(keys)}</kbd><span>${esc(what)}</span></div>`,
        )
        .join("")}</div>
    </div>`;
  document.querySelector("#layer-root").append(layer);
}

/** Whether the keyboard currently belongs to something being typed in. */
function typingSomewhere(target) {
  const field = target?.closest?.(
    "input, textarea, select, [contenteditable='true']",
  );
  return field !== null && field !== undefined;
}

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openSwitcher();
    return;
  }
  const inSwitcher = event.target?.dataset?.act === "switch-input";
  if (inSwitcher) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSwitcher();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const rows = switcherEntries(event.target.value);
      if (rows.length > 0) {
        switcherIndex =
          (switcherIndex + (event.key === "ArrowDown" ? 1 : rows.length - 1)) %
          rows.length;
        paintSwitcher();
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      document
        .querySelector("#qs-layer .qs-item.active")
        ?.click();
      return;
    }
    // Anything else is a keystroke in the box; repaint after the browser has
    // put it there.
    window.setTimeout(() => {
      switcherIndex = 0;
      paintSwitcher();
    }, 0);
    return;
  }
  if (event.key === "Escape" && document.querySelector("#qs-layer") !== null) {
    event.preventDefault();
    closeSwitcher();
    return;
  }
  // The single-key shortcuts, and only when the keyboard is not somebody's
  // sentence. A composer must go on receiving "?" as a character.
  if (typingSomewhere(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
    return;
  }
  if (event.key === "?") {
    event.preventDefault();
    openShortcutSheet();
    return;
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

/* Some markup is decided at render time by `phoneLayout()` — the channel
   header renders its tools pinned open on a phone — so crossing the
   breakpoint (a rotation, a resized window) has to re-render once or the
   header keeps the shape of the width it last rendered at. */
window.matchMedia("(max-width: 600px)").addEventListener("change", () => {
  render();
});

// A System theme remains live after the settings dialog closes. A laptop
// changing with sunset should repaint Kumi at the same moment as the rest of
// the desktop rather than waiting for the next message to trigger a render.
window
  .matchMedia("(prefers-color-scheme: light)")
  .addEventListener("change", () => {
    if (myThemePreference() === "system") {
      render();
    }
  });

/**
 * Marks a channel read because it is the one on screen, being looked at.
 *
 * Opening a room is the only thing that used to clear it, so anything that
 * arrived while the reader sat in it raised a badge on the room they were
 * reading — and that badge stayed until they left and came back. A message
 * landing in front of somebody is a message read; anywhere else, or with the
 * tab in the background, it is genuinely still waiting.
 */
function markChannelReadIfWatching(repositoryId) {
  if (
    !repositoryId ||
    state.route !== "chats" ||
    activeChannelId() !== repositoryId ||
    document.visibilityState !== "visible"
  ) {
    return;
  }
  markChannelRead(repositoryId);
}

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
      openPromptedThread(channel);
      openReadyPlan(channel);
      // Coming back to the tab is the other half of reading it: whatever
      // arrived while this browser was away is now on screen.
      markChannelReadIfWatching(channel);
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
  // This is the real edge of "while you were away". Advancing the personal
  // catch-up mark here means work already completed in front of this person
  // is not handed back as news on their next visit. A panel they have not yet
  // dismissed is deliberately exempt, so leaving does not silently consume
  // a list they never read.
  markCatchUpSeenWhilePresent();
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
// `visibilitychange` is the usual phone path; `pagehide` covers a navigation
// or tab close that skips it. The store's cursor is forward-only, so the two
// signals arriving together are harmless.
window.addEventListener("pagehide", () => markCatchUpSeenWhilePresent());
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
  void ensureProviderUsage(
    target.dataset.hoverValue,
    render,
    target.dataset.hoverOwner,
  );
}
document.addEventListener("mouseover", requestUsageForHoverTarget);
// `:hover` never matches on a touch screen, so the card above has nothing to
// reveal it there — `profileAnchor` (screen-chats.js) gives every face a
// `tabindex`, and `.pcard-anchor:focus-within .pcard-pop` (styles.css)
// already shows the card on focus exactly as it does on hover. This is what
// supplies the data for a tap the same way the listener above supplies it
// for a pointer.
document.addEventListener("focusin", requestUsageForHoverTarget);

/**
 * How much clear space a profile card wants past its own height before it is
 * willing to open in the direction it prefers.
 */
const PROFILE_CARD_MARGIN = 10;

/**
 * Put a fixed profile card at viewport coordinates, even when its anchor
 * establishes a fixed-position containing block.
 *
 * Message rows use layout containment and the roster animates with a
 * transform. Both make a nested `position: fixed` element local to the row
 * instead of the viewport, so assigning viewport coordinates directly adds
 * the row's own offset and leaves the card far away from the face. Measuring
 * where that first assignment actually landed gives us the offset to remove.
 */
function placeProfileCard(card, left, top) {
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  const placed = card.getBoundingClientRect();
  card.style.left = `${left + (left - placed.left)}px`;
  card.style.top = `${top + (top - placed.top)}px`;
}

/**
 * The geometry of a profile card that a stylesheet cannot decide.
 *
 * Each card states the direction it would rather open — down from a roster
 * row, up from a message, because that is where the room is in the ordinary
 * case. What a rule cannot know is whether that room exists for *this* face:
 * the last agent in a long roster has nothing under it, and the first message
 * in a thread has nothing over it, and a card opening into either is a card
 * clipped in half by whatever is doing the scrolling.
 *
 * So the preference stands and this only overrides it, by intersecting the
 * viewport with every surface that can crop the face. The fixed card then
 * gets a bounded width, height and position in that visible rectangle.
 */
function positionProfileCard(event) {
  const target = event?.target;
  const hovered =
    target instanceof Element ? target.closest("[data-profile-dir]") : null;
  const anchors =
    hovered === null
      ? document.querySelectorAll(
          ".pcard-anchor:hover, .pcard-anchor:focus-within",
        )
      : [hovered];
  anchors.forEach((anchor) => {
    const card = anchor.querySelector(":scope > .pcard-pop");
    if (card === null) {
      return;
    }
    const box = anchor.getBoundingClientRect();
    const clip = clippingBoundsFor(anchor);
    const maxHeight = Math.max(
      1,
      clip.bottom - clip.top - PROFILE_CARD_MARGIN * 2 - 14,
    );
    const maxWidth = Math.max(
      1,
      clip.right - clip.left - PROFILE_CARD_MARGIN * 2,
    );
    card.style.setProperty("--profile-max-height", `${maxHeight}px`);
    card.style.setProperty("--profile-max-width", `${maxWidth}px`);

    const height = card.offsetHeight;
    const width = card.offsetWidth;
    const below = clip.bottom - box.bottom - PROFILE_CARD_MARGIN;
    const above = box.top - clip.top - PROFILE_CARD_MARGIN;
    const prefersDown = anchor.dataset.profileDir !== "up";
    const opensDown =
      prefersDown
        ? below >= height
          ? true
          : above >= height
            ? false
            : below >= above
        : above >= height
          ? false
          : below >= height
            ? true
            : below > above;
    const minLeft = clip.left + PROFILE_CARD_MARGIN;
    const maxLeft = Math.max(
      minLeft,
      clip.right - PROFILE_CARD_MARGIN - width,
    );
    const minTop = clip.top + PROFILE_CARD_MARGIN;
    const maxTop = Math.max(
      minTop,
      clip.bottom - PROFILE_CARD_MARGIN - height,
    );
    const desiredTop = opensDown ? box.bottom : box.top - height;
    const desiredLeft = Math.min(maxLeft, Math.max(minLeft, box.left - 6));
    placeProfileCard(
      card,
      desiredLeft,
      Math.min(maxTop, Math.max(minTop, desiredTop)),
    );
    anchor.toggleAttribute("data-profile-flip", opensDown !== prefersDown);
  });
}

/** The intersection of everything that can crop the card and the viewport. */
function clippingBoundsFor(node) {
  const viewport = window.visualViewport;
  const offsetLeft = viewport?.offsetLeft || 0;
  const offsetTop = viewport?.offsetTop || 0;
  const bounds = {
    left: offsetLeft,
    top: offsetTop,
    right: offsetLeft + (viewport?.width || window.innerWidth),
    bottom: offsetTop + (viewport?.height || window.innerHeight),
  };
  for (
    let parent = node.parentElement;
    parent !== null && parent !== document.body;
    parent = parent.parentElement
  ) {
    const style = window.getComputedStyle(parent);
    const box = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      bounds.left = Math.max(bounds.left, box.left);
      bounds.right = Math.min(bounds.right, box.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      bounds.top = Math.max(bounds.top, box.top);
      bounds.bottom = Math.min(bounds.bottom, box.bottom);
    }
  }
  return bounds;
}

document.addEventListener("mouseover", positionProfileCard);
document.addEventListener("focusin", positionProfileCard);
document.addEventListener("scroll", positionProfileCard, true);
window.addEventListener("resize", positionProfileCard);
window.visualViewport?.addEventListener("resize", positionProfileCard);
window.visualViewport?.addEventListener("scroll", positionProfileCard);

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

/* How long the pinned shelf takes to fold away, in milliseconds: the longest
   leg of the `.chan-pins` transition in styles.css. The redraw that removes
   the shelf from the document waits this out so the fold is seen. */
const PINS_FOLD_MS = 240;
let pinsFoldTimer;

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

/**
 * Opens or closes the pinned-message shelf.
 *
 * Closed, the shelf is not in the document at all: a folded-away banner that
 * still existed left a line of itself above the conversation, and the point of
 * the header shortcut is that pins are out of the way until they are asked
 * for. Opening therefore draws the screen and then replays the unfold from the
 * collapsed state, and closing folds the nodes that are already there before a
 * redraw takes them out — so both directions still animate.
 */
function setPinnedMessagesOpen(open) {
  const next = open === true;
  state.pinsOpen = next;
  paintPinnedMessagesShortcut(next);

  if (next) {
    render();
    requestAnimationFrame(() => {
      const shelf = document.querySelector(".chan-pins");
      if (shelf === null || state.pinsOpen !== true) {
        return;
      }
      shelf.classList.remove("open");
      // Reading the height commits the folded state, so adding the class back
      // is a change the transition can run over rather than a no-op.
      void shelf.offsetHeight;
      shelf.classList.add("open");
    });
    return;
  }

  const banner = document.querySelector(".chan-pins");
  if (banner === null) {
    return;
  }
  banner.classList.remove("open");
  banner.setAttribute("aria-hidden", "true");
  banner.toggleAttribute("inert", true);
  banner
    .querySelector(".chan-pins-head")
    ?.setAttribute("aria-expanded", "false");
  const list = banner.querySelector(".chan-pins-list-frame");
  list?.setAttribute("aria-hidden", "true");
  list?.toggleAttribute("inert", true);
  clearTimeout(pinsFoldTimer);
  pinsFoldTimer = setTimeout(() => {
    if (state.pinsOpen !== true) {
      render();
    }
  }, PINS_FOLD_MS);
}

/**
 * Keeps the header's pin shortcut telling the truth about the shelf. It lives
 * outside the toggle above because the shortcut is there whether or not the
 * channel has any pins to show yet.
 */
function paintPinnedMessagesShortcut(open) {
  const shortcut = document.querySelector(".ch-pins-toggle");
  if (shortcut === null) {
    return;
  }
  const title = open ? "Hide pinned messages" : "Show pinned messages";
  shortcut.classList.toggle("on", open);
  shortcut.title = title;
  shortcut.setAttribute("aria-label", title);
  shortcut.setAttribute("aria-pressed", String(open));
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
 * The order is the column's own order, not a precedence of its own: the
 * newest surface is the one holding the right edge, and on a phone it is the
 * only one drawn at all. A swipe or an Escape must always put away the
 * surface the reader can actually see, and anything closing by a different
 * ranking closes something invisible instead — which is what this did while
 * eight surfaces were competing for one place.
 */
function closeSidePanel() {
  const showing = newestRightPanel();
  if (showing === undefined) {
    return false;
  }
  // The catch-up is not merely closed: putting it away is how this account
  // says it has read the work it lists.
  if (showing === "catch-up") {
    dismissSinceYouLeft();
    return true;
  }
  // The same question the close button asks. A swipe is easy to do by
  // accident, which makes silently discarding an edit worse here, not better.
  if (showing === "file" && !confirmDiscardEdit()) {
    return false;
  }
  putAwayRightPanel(showing);
  return true;
}

function sidePanelOpen() {
  return (
    state.catchUp !== undefined ||
    state.activePlan !== undefined ||
    state.activeAgentPanel !== undefined ||
    state.activeDm !== undefined ||
    state.chanFileView !== undefined ||
    state.chanTree === true ||
    state.activeChannelThread !== undefined ||
    state.chanThreadList === true
  );
}

/**
 * Opens the thread an agent has just started, for the person who asked it to.
 *
 * Tasking an agent used to end in waiting: the request sat in the room saying
 * nothing, and when the agent finally began narrating it did so inside a
 * thread that showed up collapsed to a single summary line. The person who
 * prompted it had to notice that line and click it to see any of the work
 * they had asked for. `notePromptedThread` in data.js spots the moment a
 * thread appears under one of this account's own requests; this decides
 * whether the panel is free to show it.
 *
 * Desktop only. The thread panel is beside the transcript here, so opening it
 * costs the reader nothing they were already looking at — where on a phone it
 * is a full-screen surface dropped over the room, which is a different and
 * much ruder thing to do to somebody mid-sentence.
 *
 * A file or a conversation already in the column is no longer a reason to
 * decline: the column holds three, and a prompted thread takes a free place
 * in it rather than somebody else's. A thread the reader opened themselves is
 * still never taken off them — the only thing this will replace is a thread
 * it opened the same way a moment ago, so a second task prompted while the
 * first one's thread is still up moves on to the newer work.
 */
function openPromptedThread(repositoryId) {
  const messageId = takePromptedThread(repositoryId);
  if (
    messageId === undefined ||
    phoneLayout() ||
    state.route !== "chats" ||
    (state.activeChannelThread !== undefined &&
      state.activeChannelThread !== state.autoOpenedThread)
  ) {
    return;
  }
  state.activeChannelThread = messageId;
  state.autoOpenedThread = messageId;
}

/**
 * Pops a plan open the moment the agent finishes writing it.
 *
 * `/plan` is the one command whose whole answer is a document somebody has to
 * read and decide on, and until this it landed as a card inside a thread that
 * may not even be on screen: the room showed a request, a working indicator,
 * and then a hold line — while the thing being held for sat folded away.
 *
 * The same manners `openPromptedThread` has, for the same reasons. Desktop
 * only, because on a phone the panel is the whole window and dropping a page
 * of plan over somebody mid-sentence is rude rather than helpful — the card
 * in the thread is how it is reached there. And it takes a free place in the
 * column rather than somebody else's: a plan already open stays, and the only
 * thing it will replace is a thread this app opened itself a moment ago,
 * which for a `/plan` is exactly the thread this plan belongs to.
 */
function openReadyPlan(repositoryId) {
  const messageId = takeReadyPlan(repositoryId);
  if (
    messageId === undefined ||
    phoneLayout() ||
    state.route !== "chats" ||
    state.activePlan !== undefined ||
    (state.activeChannelThread !== undefined &&
      state.activeChannelThread !== state.autoOpenedThread)
  ) {
    return;
  }
  state.activePlan = messageId;
  state.activeChannelThread = undefined;
  state.autoOpenedThread = undefined;
}

/** Keep keyboard focus inside the settings surface while it is modal. */
document.addEventListener("keydown", (event) => {
  if (event.key !== "Tab" || state.settingsOpen !== true) {
    return;
  }
  const dialog = document.querySelector(".settings-dialog");
  const focusable = [
    ...(dialog?.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []),
  ];
  if (focusable.length === 0) {
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

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
  if (event.key !== "Escape" || event.defaultPrevented) {
    return;
  }
  if (state.settingsOpen === true) {
    event.preventDefault();
    closeSettings();
    return;
  }
  if (state.route !== "chats") {
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
 * The Settings dialog's position across the whole-app render below.
 *
 * Settings controls redraw the screen to show their new value. That replaces
 * the `.scroll` node and gives its replacement a fresh `scrollTop` of zero,
 * sending somebody back to the first card after every click. Keying this one
 * surface makes opening and closing safe too: only the dialog has the key,
 * so its offset can never be dropped onto the conversation underneath.
 */
function captureSettingsScroll() {
  const settings = document.querySelector('[data-scroll-key="settings"]');
  return settings === null ? undefined : settings.scrollTop;
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

/** One question for every way of stopping a run — see `task-cancel`. */
function confirmTaskCancel(taskId) {
  const task = state.tasks.find((entry) => entry.id === taskId);
  return window.confirm(
    `Stop this task?\n\n${
      task?.objective ? `"${task.objective}"\n\n` : ""
    }The agent stops where it is and its workspace is released. Anything it ` +
      `has already written stays; nothing is reverted.`,
  );
}

function confirmDiscardEdit() {
  if (!channelFileEdited()) {
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
  // Thread, thread list, DM, agent profile and the file view share one column
  // that holds up to three of them, and each of them is tracked by name
  // through `key` — so this is "which surfaces are in the column", not "is
  // the column occupied". Without the key the column was one thing that was
  // either there or not, and a second tab opening beside the first was
  // therefore not a change at all: it appeared fully formed, in one frame,
  // while the tab already open jumped aside to make room for it.
  {
    selector: ".thread-panel",
    parent: ".chats-shell",
    enter: "panel-entering",
    leave: "panel-leaving",
    key: (node) => node.dataset.panelKey ?? "",
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
  // Settings is redrawn with the rest of the app. An animation on the bare
  // dialog would play from opacity 0 on every control that calls render —
  // theme, section, sounds — so the panel would vanish and settle again
  // while it was already open. The class is applied only when the overlay
  // was not on the last tree.
  {
    selector: ".settings-layer",
    parent: ".app",
    enter: "settings-entering",
    leave: "settings-leaving",
  },
];

/**
 * What each surface was showing before the swap: its keys, and the element
 * each one was.
 *
 * A map rather than a flag because a surface can be on screen more than once
 * — the right-hand column holds up to three panels — and "one of them opened"
 * is a different event from "the column opened". Surfaces that only ever have
 * one of themselves file it under the empty key and read exactly as they did.
 */
const surfaceNodes = new Map();

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

/**
 * Every live copy of a surface, by key.
 *
 * A surface with no `key` has at most one copy and gets the empty key, which
 * is the whole of the old behaviour. A surface that decides whether it is
 * open from something other than its own element — the file tree, which is a
 * grid column above 900px — keeps answering that question, and files its one
 * element under the same empty key.
 */
function liveNodes(root, surface) {
  const found = new Map();
  if (surface.isOpen !== undefined) {
    if (surfaceIsOpen(root, surface)) {
      found.set("", liveNode(root, surface));
    }
    return found;
  }
  for (const node of root.querySelectorAll(
    `${surface.selector}:not(.${surface.leave})`,
  )) {
    found.set(surface.key === undefined ? "" : surface.key(node), node);
  }
  return found;
}

/** Reads the outgoing document. Must run before `innerHTML` throws it away. */
function captureSurfaceMotion(root) {
  for (const surface of MOTION_SURFACES) {
    surfaceNodes.set(surface.selector, liveNodes(root, surface));
  }
}

/** Plays whatever the swap turned out to be: an opening, a closing, or nothing. */
function playSurfaceMotion(root) {
  for (const surface of MOTION_SURFACES) {
    const before = surfaceNodes.get(surface.selector) ?? new Map();
    const now = liveNodes(root, surface);
    for (const [key, node] of now) {
      if (before.has(key) || node === null) {
        continue;
      }
      animateOnce(node, surface.enter, false);
    }
    for (const [key, closed] of before) {
      if (now.has(key) || closed === null || closed === undefined) {
        continue;
      }
      const parent = root.querySelector(surface.parent);
      if (parent === null) {
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

/* -------------------------------------------------------- text arrival ---- */

/**
 * The pace an answer opens at: how far apart the first few words start, and
 * how long each one takes to settle.
 *
 * Deliberately short. The effect is meant to be noticed at the edge of
 * attention and then be over — a line or two should read as one soft settle
 * rather than as a sentence being spelled out. Anything slower and the reader
 * is waiting on words they can already half-see.
 *
 * The word's own duration is stated here as well as in `.text-reveal-word`,
 * because this is what decides when an arrival is over and stops being
 * resumed; the stylesheet is what actually plays it.
 */
const REVEAL_STAGGER_MS = 18;
const REVEAL_WORD_MS = 220;

/**
 * The longest an arrival is ever spread over, however much was said.
 *
 * A reader takes the effect in from the first line; after that every extra
 * moment is spent watching text that is already written appear at walking
 * pace. So a long answer is not simply the opening pace repeated — it is the
 * same words, much closer together: the more there is to say, the quicker it
 * is said, and the ceiling here plus one word's settle is the longest any
 * message can hold the reader.
 */
const REVEAL_MAX_TOTAL_MS = 420;

/**
 * How far apart consecutive words start, given how many there are.
 *
 * A short line is barely staggered at all: a handful of words are a fraction
 * of a beat apart, which is enough to read as arriving and little enough to
 * be finished before it can be studied. From there the gap closes off
 * smoothly — the spread approaches `REVEAL_MAX_TOTAL_MS` without ever
 * reaching it — so a paragraph lands in under half a second and a wall of
 * text is done inside two thirds of one. Nothing is truncated and there is no
 * cliff where a longer message suddenly stops animating; it just arrives
 * faster the more of it there is.
 */
function revealStaggerFor(count) {
  if (count <= 1) {
    return 0;
  }
  return (
    REVEAL_MAX_TOTAL_MS /
    (count - 1 + REVEAL_MAX_TOTAL_MS / REVEAL_STAGGER_MS)
  );
}

/**
 * How many words are taken apart at all. Past this the remainder is left as
 * plain text: by then it is far below the fold, and at the pace a message
 * this long arrives at, the tail is landing within a few milliseconds of
 * itself anyway — a span apiece costs more than the effect is worth.
 */
const REVEAL_MAX_WORDS = 120;

/** How many arrivals are remembered before the oldest are let go. */
const REVEAL_MEMORY = 800;

/**
 * What this tab has already watched arrive, and when each one started.
 *
 * The screen is redrawn by replacing the whole document — see
 * `MOTION_SURFACES` — so "is this element new" is never the question CSS can
 * answer on its own. Every block that can animate carries a stable
 * `data-reveal` key, and this map is the only thing that knows whether the
 * words under that key are new to the reader or have been on screen for a
 * while.
 *
 * The timestamp is kept rather than a bare flag because a redraw lands in the
 * middle of most arrivals — somebody typing in the room is enough — and the
 * words have to pick the animation back up where the last frame left it
 * instead of starting over or snapping to the end.
 */
const revealSeen = new Map();

/**
 * The surfaces that were on screen a moment ago, by the group half of the key.
 *
 * This is what separates "a message arrived" from "you opened a conversation
 * that already had a hundred of them". Only text belonging to a surface the
 * reader was already looking at animates; opening a channel, a thread or a
 * direct message shows its backlog the way it has always been shown, whole.
 */
let revealGroups = new Set();

/** `group|id` — the group is the surface, the id is the block within it. */
function revealGroupOf(key) {
  const cut = key.indexOf("|");
  return cut === -1 ? key : key.slice(0, cut);
}

function motionIsUnwanted() {
  return (
    window.matchMedia !== undefined &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Plays whatever arrived in this render, and only what arrived.
 *
 * Runs after the swap, beside `playSurfaceMotion` and for the same reason:
 * the outgoing document is gone by then, and the render loop is the only
 * thing left that remembers what it was showing.
 */
function playTextReveal(root) {
  const quiet = motionIsUnwanted();
  const now = Date.now();
  const groups = new Set();
  for (const block of root.querySelectorAll("[data-reveal]")) {
    const key = block.dataset.reveal ?? "";
    if (key === "") {
      continue;
    }
    const group = revealGroupOf(key);
    groups.add(group);
    const started = revealSeen.get(key);
    if (started === undefined) {
      // New to the document. Whether it is new to the *reader* is the
      // question the group answers: text in a surface that was not on screen
      // last time is a backlog being opened, not an answer coming in.
      const arriving = !quiet && revealGroups.has(group);
      revealSeen.set(key, arriving ? now : 0);
      if (arriving) {
        revealWords(block, 0);
      }
      continue;
    }
    // Zero means "was already here", which never animates. Anything else is
    // an arrival still in flight until its last word has landed.
    if (started === 0 || quiet) {
      continue;
    }
    const elapsed = now - started;
    if (elapsed < REVEAL_MAX_TOTAL_MS + REVEAL_WORD_MS) {
      revealWords(block, elapsed);
    }
  }
  revealGroups = groups;
  forgetOldReveals(groups);
}

/**
 * Keeps the map from growing for as long as the tab is open.
 *
 * Only keys from surfaces nobody is looking at are dropped: forgetting a
 * message still on screen would make it arrive a second time on the next
 * redraw, which is the one thing this whole mechanism exists to prevent.
 */
function forgetOldReveals(groups) {
  if (revealSeen.size <= REVEAL_MEMORY) {
    return;
  }
  for (const key of revealSeen.keys()) {
    if (!groups.has(revealGroupOf(key))) {
      revealSeen.delete(key);
    }
  }
}

/** Text that is not prose, and is not taken apart. */
const REVEAL_SKIPPED = new Set([
  "PRE",
  "CODE",
  "SCRIPT",
  "STYLE",
  "TEXTAREA",
  "SVG",
]);

function insideSkipped(node, root) {
  let parent = node.parentNode;
  while (parent !== null && parent !== root) {
    if (REVEAL_SKIPPED.has(String(parent.nodeName).toUpperCase())) {
      return true;
    }
    parent = parent.parentNode;
  }
  return false;
}

/**
 * A picture posted with the message.
 *
 * An attachment is part of the body rather than something beside it —
 * `messageBody` in screen-chats.js puts it inside the very block the words
 * are in — so it belongs to the same arrival. The link is what carries the
 * picture's box; the bare image is the fallback for anywhere one is written
 * without it.
 */
function revealIsMedia(element) {
  return (
    element.classList.contains("cmsg-image") ||
    (String(element.nodeName).toUpperCase() === "IMG" &&
      element.hasAttribute("data-attachment"))
  );
}

/**
 * The outermost thing around this node that arrives in one piece, if any.
 *
 * A picture is not read word by word, and neither is a span of code inside a
 * sentence: each is one thing that appears, so each takes a single place in
 * the schedule instead of being split or — as both were — left out of it
 * altogether and shown whole while the words around them were still coming
 * in.
 *
 * Outermost, because a picture is a link around an image: counting it twice
 * would leave one copy waiting on the other in the middle of the message.
 */
function revealWholeOf(node, block) {
  let found = null;
  for (
    let step = node;
    step !== null && step !== block;
    step = step.parentNode
  ) {
    if (
      step instanceof Element &&
      (revealIsMedia(step) || String(step.nodeName).toUpperCase() === "CODE")
    ) {
      found = step;
    }
  }
  return found;
}

/**
 * Wraps each piece of a block in its own element so it can come in on its own
 * delay, resuming `elapsed` milliseconds into the sequence.
 *
 * A negative delay is what does the resuming: the browser starts an animation
 * that far through rather than waiting, so a redraw two hundred milliseconds
 * into an arrival carries on from two hundred milliseconds instead of
 * replaying the opening. Whitespace is left as it was, which is what keeps
 * wrapping, selection and copied text identical to the markup underneath.
 *
 * A piece is usually a word, but the message is what arrives, not only its
 * prose: a picture posted with it takes a place in the same schedule, which
 * is also what gives a message of nothing but a picture an arrival at all.
 *
 * The block is the body and stops there. The quoted line above a reply, the
 * reactions under it and the buttons beside it are the room's furniture
 * rather than anything that was said, so they stay where they are — see the
 * `data-reveal` key in screen-chats.js for what a block is.
 */
function revealWords(block, elapsed) {
  // One pass in reading order over the text and the elements together, so a
  // picture between two paragraphs arrives between them rather than before or
  // after everything else.
  const walker = document.createTreeWalker(
    block,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
  );
  const parts = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Element) {
      if (revealWholeOf(node, block) === node && !insideSkipped(node, block)) {
        parts.push(node);
      }
      continue;
    }
    const text = node.nodeValue ?? "";
    if (
      text.trim() !== "" &&
      !insideSkipped(node, block) &&
      revealWholeOf(node, block) === null
    ) {
      parts.push(node);
    }
  }
  // Wrapped first and timed second: the stagger depends on how many pieces
  // there turned out to be, and that is only known once the last one is in
  // hand.
  const revealedPings = new Set();
  const words = [];
  for (const part of parts) {
    if (part instanceof Element) {
      // Kept however long the message runs to. A picture or a piece of code
      // is a handful of nodes at most, and one of them standing at full
      // strength beside a sentence that is still arriving is the whole thing
      // this is here to prevent.
      part.classList.add(
        revealIsMedia(part) ? "text-reveal-media" : "text-reveal-word",
      );
      words.push(part);
      continue;
    }
    if (words.length >= REVEAL_MAX_WORDS) {
      continue;
    }
    const ping = revealPingOf(part, block);
    if (ping !== null) {
      if (revealedPings.has(ping)) {
        continue;
      }
      revealedPings.add(ping);
      ping.classList.add("text-reveal-word");
      words.push(ping);
      continue;
    }
    const pieces = String(part.nodeValue).split(/(\s+)/u);
    const holder = document.createDocumentFragment();
    for (const piece of pieces) {
      if (piece === "") {
        continue;
      }
      if (piece.trim() === "" || words.length >= REVEAL_MAX_WORDS) {
        holder.append(piece);
        continue;
      }
      const word = document.createElement("span");
      word.className = "text-reveal-word";
      word.textContent = piece;
      holder.append(word);
      words.push(word);
    }
    part.replaceWith(holder);
  }
  const step = revealStaggerFor(words.length);
  for (const [index, word] of words.entries()) {
    word.style.setProperty(
      "--reveal-delay",
      `${Math.round(index * step - elapsed)}ms`,
    );
  }
}

/**
 * A posted ping or slash command, if this text node belongs to one.
 *
 * Those spans carry a coloured wash. Splitting them word by word would leave
 * the box visible while each piece faded in, so the whole token is tagged as
 * one arrival instead.
 */
function revealPingOf(node, block) {
  let parent = node.parentNode;
  while (parent !== null && parent !== block) {
    if (
      parent instanceof Element &&
      (parent.classList.contains("mention-ping") ||
        parent.classList.contains("slash-ping"))
    ) {
      return parent;
    }
    parent = parent.parentNode;
  }
  return null;
}

export function render() {
  if (rendering) {
    renderAgain = true;
    return;
  }
  rendering = true;
  try {
    renderNow();
  } catch (error) {
    // A throw here used to escape silently and leave the previous paint on
    // screen. That is indistinguishable from a screen that is still loading —
    // and when the previous paint was a loading skeleton, which it always is
    // on the way into a channel, the room appeared to load forever. Every
    // later render threw at the same place, so it never recovered.
    //
    // The stale paint is the misleading part, so it goes. What replaces it
    // says what broke, because a person who can read the message can report
    // it and a person looking at grey boxes cannot.
    renderFailure(error);
  } finally {
    rendering = false;
    if (renderAgain) {
      renderAgain = false;
      render();
    }
  }
}

/**
 * What the screen says when rendering itself failed.
 *
 * Deliberately built without the helpers the failed render just used: if
 * `esc`, the icon set or the layout is what threw, reaching for them again
 * would throw again and leave nothing at all. Text nodes and a reload button,
 * nothing else.
 */
function renderFailure(error) {
  const message =
    error instanceof Error
      ? `${error.message}${error.stack === undefined ? "" : `\n\n${error.stack}`}`
      : String(error);
  console.error("Render failed", error);
  const root = document.querySelector("#app-root");
  if (root === null) {
    return;
  }
  root.hidden = false;
  root.removeAttribute("aria-busy");
  root.textContent = "";
  const box = document.createElement("div");
  box.className = "empty";
  const title = document.createElement("b");
  title.textContent = "This screen could not be drawn";
  const body = document.createElement("p");
  body.textContent =
    "Something in the page failed while rendering. The details below say " +
    "what, and reloading may clear it.";
  const detail = document.createElement("pre");
  detail.style.whiteSpace = "pre-wrap";
  detail.style.textAlign = "left";
  detail.style.fontSize = "12px";
  detail.style.overflowX = "auto";
  detail.textContent = message;
  const again = document.createElement("button");
  again.type = "button";
  again.className = "btn btn-sm";
  again.textContent = "Reload";
  again.addEventListener("click", () => {
    window.location.reload();
  });
  box.append(title, body, detail, again);
  root.append(box);
}

/**
 * The first useful paint while session and project context are still in flight.
 *
 * Kept in the app as well as `index.html`: the document covers a cold start,
 * while a later context refresh can return to the same stable, accessible
 * shape without inventing a second loading screen.
 */
function renderLoadingShell(root = $("#app-root")) {
  root.hidden = false;
  root.setAttribute("aria-busy", "true");
  root.innerHTML = `<div class="boot-shell" role="status" aria-live="polite"
    aria-label="Loading Kumi">
    <span class="sr-only">Loading Kumi…</span>
    <div class="boot-skeleton-rail" aria-hidden="true">
      <span class="skeleton boot-skeleton-rail-button"></span>
      <span class="skeleton boot-skeleton-rail-button"></span>
      <span class="skeleton boot-skeleton-rail-button"></span>
    </div>
    <div class="boot-skeleton-sidebar" aria-hidden="true">
      <span class="skeleton boot-skeleton-title"></span>
      <span class="skeleton boot-skeleton-search"></span>
      <div class="boot-skeleton-nav">
        <span class="skeleton"></span><span class="skeleton"></span>
        <span class="skeleton"></span><span class="skeleton"></span>
        <span class="skeleton"></span>
      </div>
    </div>
    <main class="boot-skeleton-main" aria-hidden="true">
      <header class="boot-skeleton-head">
        <span class="skeleton boot-skeleton-heading"></span>
        <span class="skeleton boot-skeleton-action"></span>
      </header>
      <div class="boot-skeleton-messages">
        <div class="boot-skeleton-message"><span class="skeleton boot-skeleton-avatar"></span><span class="boot-skeleton-copy"><span class="skeleton"></span><span class="skeleton"></span></span></div>
        <div class="boot-skeleton-message"><span class="skeleton boot-skeleton-avatar"></span><span class="boot-skeleton-copy"><span class="skeleton"></span><span class="skeleton"></span></span></div>
        <div class="boot-skeleton-message"><span class="skeleton boot-skeleton-avatar"></span><span class="boot-skeleton-copy"><span class="skeleton"></span><span class="skeleton"></span></span></div>
      </div>
      <div class="skeleton boot-skeleton-composer"></div>
    </main>
  </div>`;
}

function renderNow() {
  const root = $("#app-root");
  if (state.principal === undefined && state.loadError === undefined) {
    return;
  }
  applyTheme();
  // Before anything writes to `root`: the panels and drawers that animate are
  // read off the outgoing document, and one line below this they stop
  // existing. See `MOTION_SURFACES`.
  captureSurfaceMotion(root);
  if (!state.loaded && state.loadError !== undefined) {
    root.removeAttribute("aria-busy");
    root.innerHTML = `<div class="app"><div class="main">
      <div class="page" role="alert">${emptyState(
        "cloud",
        "Kumi could not load",
        state.loadError,
      )}</div></div></div>`;
    return;
  }
  if (!state.loaded) {
    renderLoadingShell(root);
    return;
  }
  root.removeAttribute("aria-busy");
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
    }"${state.settingsOpen === true ? " inert" : ""}>
      ${banner()}
      ${BARE.has(state.route) ? "" : topbar()}
      ${screen()}
    </div>
    ${state.settingsOpen === true ? settingsDialog() : ""}
  </div>`;

  // Drafts can be restored without producing an input event. Size them from
  // their real rendered width so short messages keep the compact row while
  // wrapped messages reopen to the height they need.
  resizeComposers(root);

  restoreSettingsScroll(savedSettingsScroll);
  // What the swap turned out to have opened or closed. Before the transcript
  // is put back where the reader had it, deliberately: an opening panel does
  // take its column here, and restoring a scroll against the full width and
  // then narrowing it again would move the very line the restore exists to
  // keep still. A closing one no longer takes anything — it leaves out of
  // flow, over a layout that has already settled — so this order costs it
  // nothing.
  playSurfaceMotion(root);

  // What the swap turned out to have *said*: the words that were not in the
  // room a moment ago come in one at a time, and everything already there
  // stays where it is. See `playTextReveal`.
  playTextReveal(root);

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
  // The private chat's command and name pickers. Its composer is drawn by
  // `chat.js`, which sits below the screens in the import graph and so leaves
  // an empty surface for this to fill; painting on every route is also what
  // keeps an open list open across the render an arrow key causes.
  paintComposerSuggestions(activeChannelId());
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
    // Grants feed the People-row promote / demote menus. Loaded with the
    // roster rather than on channel-info open — those actions no longer live
    // in that popover.
    void ensureRepositoryGrants(activeChannelId(), () => {
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
    // page, so a reload has to find the address of the one already running.
    // `undefined` is "not asked yet"; `null` is "asked, there is none", which
    // is why this tests for the former.
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
  if (state.settingsOpen === true) {
    const repositoryId = activeChannelId();
    // Once per repository, same claim pattern as previews: `undefined` is
    // "not asked", `null` is "asked, still counting", and a real object is
    // the recap. Without the claim, every settings render would re-fetch.
    if (repositoryId && state.channelStats[repositoryId] === undefined) {
      state.channelStats[repositoryId] = null;
      void loadChannelStats(repositoryId).then(() => {
        if (state.settingsOpen === true) {
          render();
        }
      });
    }
  }
}

/**
 * Opens a person-to-person direct message and closes any agent private-chat
 * panel that was beside it. Agent threads stay on `agent-chat-open`; this
 * entry is only for people.
 */
function openUserDirectMessage(userId) {
  state.activeDm = userId;
  state.activeAgentPanel = undefined;
  clearRightPanel("agent");
  state.dmDraft = "";
  state.dmReplyMessageId = undefined;
  moveRightPanel("dm", "right");
  setChanDrawer(false);
}

/**
 * Who this account can write to privately — people, and only people.
 *
 * Two halves. The conversations already going come first, ordered by what
 * is waiting in them, and everyone else on the project follows, so the
 * menu is a way to *start* a private conversation and not only a list of
 * the ones that happen to exist. "No conversations yet" was a dead end:
 * the one state in which somebody most needs this menu was the one state
 * in which it offered nothing to press.
 *
 * Agents are deliberately not here, and are filtered out rather than
 * merely not added — a direct message is between two accounts. Talking to
 * your own agent is `agent-chat-open`, which opens beside the channel
 * instead of taking the room away, and an org agent's whole point is that
 * it works where the team can see it. Both are reached from the roster.
 */
function showDirectMessageMenu(node) {
  const conversations = [...state.dmConversations]
    .filter((conversation) => isDirectMessagePerson(conversation.userId))
    .sort(
      (left, right) => Number(right.unread ?? 0) - Number(left.unread ?? 0),
    );
  const talking = new Set(
    conversations.map((conversation) => conversation.userId),
  );
  // Everyone reachable who has not been written to yet. `dmPeople` is the
  // project's whole room as the server counts it — memberships plus
  // repository grants — and it arrives with the inbox above.
  const others = state.dmPeople.filter(
    (person) => isDirectMessagePerson(person.id) && !talking.has(person.id),
  );
  const rows = [
    ...conversations.slice(0, 12).map((conversation) => ({
      act: "dm-open",
      value: conversation.userId,
      label: memberName(conversation.userId) ?? conversation.userId,
      iconName: "chatBubble",
      ...(Number(conversation.unread ?? 0) === 0
        ? {}
        : { hint: `${conversation.unread} unread` }),
    })),
    ...(conversations.length > 0 && others.length > 0
      ? [{ separator: true }]
      : []),
    ...others.slice(0, 12).map((person) => ({
      act: "dm-open",
      value: person.id,
      label: person.name ?? memberName(person.id) ?? person.id,
      iconName: "users",
      hint: personOnline(person.id) ? "Here now" : "Send a message",
    })),
  ];
  showMenu(
    node,
    rows.length === 0
      ? [
          {
            act: "noop",
            label: "Nobody else on this project yet",
            disabled: true,
          },
        ]
      : rows,
  );
}

/**
 * Opens the already-cached history at its newest message, then does the same
 * once the server's current history replaces it. Ordinary renders continue
 * through the anchor restore, so scrolling up afterwards is still respected.
 */
function loadOpenedDirectMessage(userId) {
  scrollDirectMessageToLatest();
  void loadDmThread(userId).then(() => {
    // A slower request for the conversation just left must not move the one
    // that replaced it.
    if (state.activeDm !== userId) {
      return;
    }
    render();
    scrollDirectMessageToLatest();
  });
}

function openSettings(section = "general") {
  state.settingsOpen = true;
  state.settingsSection = SETTINGS_SECTIONS.some(
    (candidate) => candidate.id === section,
  )
    ? section
    : "general";
  state.settingsRenamingId = undefined;
  state.openWheel = undefined;
  closePopover();
  render();
  window.queueMicrotask(() =>
    document.querySelector("[data-act='settings-close']")?.focus(),
  );
}

function closeSettings() {
  if (state.settingsOpen !== true) {
    return;
  }
  state.settingsOpen = false;
  state.settingsRenamingId = undefined;
  state.openWheel = undefined;
  if (/^#(?:settings|advanced)$/u.test(window.location.hash)) {
    window.history.replaceState(null, "", `#${state.route}`);
  }
  render();
  window.queueMicrotask(() =>
    document
      .querySelector('[data-act="nav"][data-value="settings"]')
      ?.focus(),
  );
}

function navigate(route) {
  // Settings categories are a dialog over the current conversation, not
  // destinations that replace it. Keep accepting the historical "advanced"
  // value so an old bookmark opens the right category in the new surface.
  if (route === "settings" || route === "advanced") {
    openSettings(route === "advanced" ? "advanced" : "general");
    return;
  }
  // A link or a stored route from before Code and Coordinator were folded into
  // the channel lands here; chats is the landing view, so it is the fallback.
  if (!ROUTES.has(route)) {
    route = "chats";
  }
  state.settingsOpen = false;
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
  // Invite links can arrive after boot as well as on the initial page load.
  // Give them the same invitation flow before either the signed-out shell or
  // the ordinary product router gets a chance to ignore the special hash.
  if (/^#invite\/.+$/u.test(window.location.hash)) {
    void handleInviteLink();
    return;
  }
  // While the signed-out shell is up the hash names a form, not a screen —
  // so following `/#signin` from the create-account page has to swap the
  // form rather than fall through to the router, which knows nothing about
  // it.
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
  if (route === "settings" || route === "advanced") {
    state.settingsOpen = true;
    state.settingsSection = route === "advanced" ? "advanced" : "general";
    render();
    return;
  }
  if (
    ROUTES.has(route) &&
    (route !== state.route || state.settingsOpen === true)
  ) {
    state.settingsOpen = false;
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

/**
 * The same gesture in the private chat's box.
 *
 * Its own function because that draft is kept per agent rather than in one
 * field of `state`, and because the box is the only copy of it until the
 * keystroke is written through — see the `chat-input` handler.
 */
function typeIntoPrivateComposer(character, opened) {
  const input = $("[data-act='chat-input']");
  if (input === null) {
    return;
  }
  const at = input.selectionStart ?? input.value.length;
  input.value = `${input.value.slice(0, at)}${character}${input.value.slice(at)}`;
  const agentId = input.dataset.value;
  if (agentId !== undefined && agentId !== "") {
    state.agentChatDrafts[agentId] = input.value;
  }
  opened();
  render();
  const next = $("[data-act='chat-input']");
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
  if (node !== null) {
    return { node, act: node.dataset.act, value: node.dataset.value };
  }
  const attachment = event.target.closest(".cmsg-image");
  if (attachment === null || attachment.querySelector("img[data-attachment]") === null) {
    return undefined;
  }
  return { node: attachment, act: "image-preview", value: undefined };
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

/**
 * Gives one private message its clock and its controls, and the rest none.
 *
 * A conversation is mostly short lines, and drawing a timestamp and a pair of
 * buttons under every one of them is most of the panel's height spent saying
 * the same two things over and over. A press on a message asks for them;
 * pressing it again, or anywhere else that does nothing, puts them away.
 *
 * The choice lives in `state` rather than on the row: this panel is rebuilt
 * on every poll, and a class left straight on the DOM would not survive it.
 */
function selectDirectMessage(event) {
  const row = event.target.closest?.(".dm-msg") ?? null;
  const chosen = row === null ? undefined : row.dataset.dmMessage;
  const next = chosen === state.dmSelectedMessageId ? undefined : chosen;
  if (next === state.dmSelectedMessageId) {
    return;
  }
  state.dmSelectedMessageId = next;
  // Selecting a message only changes two classes. Rebuilding the whole app
  // here also replaces the conversation's scroller; when another side panel
  // precedes this one, that scroller has no captured anchor and starts again
  // at the first message. Keep the durable choice in state for later polls,
  // and paint this interaction on the existing rows.
  for (const selected of document.querySelectorAll(".dm-msg.dm-selected")) {
    selected.classList.remove("dm-selected");
  }
  if (next !== undefined) {
    row.classList.add("dm-selected");
  }
}

document.addEventListener("click", (event) => {
  // This runs before action lookup because an ordinary message body has no
  // `data-act`: selecting it is still a complete interaction on touch.
  selectMobileChannelMessage(event);
  const owningThread = event.target.closest?.("[data-thread-id]")?.dataset.threadId;
  if (owningThread !== undefined) {
    state.activeChannelThread = owningThread;
  }
  const found = actionOf(event);
  if (found === undefined) {
    // Nothing here does anything of its own, so a press on a private message
    // is a complete interaction: it asks for that message's time and its
    // controls, and a press anywhere else puts them away again.
    selectDirectMessage(event);
    return;
  }
  const { node, act, value } = found;

  /* Anything that is not a link navigation should not also submit a form. */
  if (node.tagName === "BUTTON" && node.type !== "submit") {
    event.preventDefault();
  }

  switch (act) {
    case "image-preview": {
      event.preventDefault();
      const image = node.querySelector("img[data-attachment]");
      if (image === null) {
        return;
      }
      void showModal({
        title: "Image preview",
        image: {
          src: image.currentSrc || image.src,
          alt: image.alt,
        },
      });
      return;
    }
    case "settings-dialog":
      // The dialog itself owns otherwise-empty presses so they do not bubble
      // up to the backdrop action wrapped around it.
      return;
    case "settings-backdrop":
      if (event.target === node) {
        closeSettings();
      }
      return;
    case "settings-close":
      closeSettings();
      return;
    case "settings-section":
      if (!SETTINGS_SECTIONS.some((section) => section.id === value)) {
        return;
      }
      state.settingsSection = value;
      state.settingsRenamingId = undefined;
      state.openWheel = undefined;
      render();
      document.querySelector('[data-scroll-key="settings"]')?.scrollTo(0, 0);
      return;
    case "settings-theme":
      setMyTheme(value);
      render();
      return;
    case "settings-sounds": {
      const enabled = window.localStorage.getItem("ag.messageSounds") !== "false";
      const next = !enabled;
      window.localStorage.setItem("ag.messageSounds", String(next));
      // Enabling is its own preview, so the switch never asks somebody to
      // trust a sound setting they have not heard.
      if (next) {
        chime("sent");
      }
      render();
      return;
    }
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
        ...accountDestinations(),
        { separator: true },
        { act: "logout", label: "Sign out", iconName: "logout" },
      ]);
      return;
    case "switch-close":
      closeSwitcher();
      return;
    case "switch-channel":
      closeSwitcher();
      navigate("chats");
      openChannel(value, render);
      return;
    case "switch-person":
      closeSwitcher();
      navigate("chats");
      openUserDirectMessage(value);
      render();
      loadOpenedDirectMessage(value);
      return;
    case "switch-screen":
      closeSwitcher();
      navigate(value);
      return;
    /**
     * Who this account can write to privately — people, and only people.
     * Built by {@link showDirectMessageMenu}.
     */
    case "dm-list": {
      showDirectMessageMenu(node);
      return;
    }
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
        // The same two the channel's own menu carries, for whoever reached
        // the repository from here instead.
        ...(canManageRepository(value)
          ? [
              { act: "channel-rename-repo", value, label: "Rename repository…", iconName: "pencil" },
            ]
          : []),
        // Deleting asks for more than managing does: an owner, or a co-owner
        // of this repository. An admin who may rename it is not offered it.
        ...(canDeleteRepository(value)
          ? [
              {
                act: "channel-delete-repo",
                value,
                label: "Delete repository",
                iconName: "trash",
                danger: true,
              },
            ]
          : []),
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
              {
                act: "chat-slash-key",
                label: "Run a command",
                // The channel's own list, offered here too. What a command
                // means in a private chat is an instruction to the agent
                // reading it rather than something the room carries out, so
                // the hint says whose list it is rather than promising more.
                hint: "The same list the channel offers",
                iconName: "terminal",
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
    /* The private conversations pick from the same two lists. */
    case "chat-mention-pick":
      pickMention(value, render, "chat");
      return;
    case "chat-slash-pick":
      pickSlashCommand(value, render, "chat");
      return;
    case "dm-mention-pick":
      pickMention(value, render, "dm");
      return;
    case "dm-slash-pick":
      pickSlashCommand(value, render, "dm");
      return;
    case "channel-react": {
      // A tally carries the emoji it counts; the fallback is only for a caller
      // that has not said, which is now nobody.
      const emoji = node.dataset.emoji || "👍";
      toggleChannelReaction(activeChannelId(), value, emoji, render);
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
      toggleChannelReaction(activeChannelId(), value, emoji, render);
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
      setPinnedMessagesOpen(state.pinsOpen !== true);
      return;
    // A pin is a durable doorway into its conversation. Even a person's
    // root with no replies yet opens in the thread panel, and the one-shot
    // target prevents a previously scrolled thread from opening elsewhere.
    case "channel-pinned-open":
      openThreadPanel(value);
      state.activeChannelThread = value;
      state.scrollToThreadMessage = value;
      state.threadReplyMessageId = undefined;
      state.autoOpenedThread = undefined;
      render();
      return;
    // References to tasks open their thread; references to a person's message
    // (including one with inline replies) scroll the channel into view. The
    // pin list is still a fallback after paginated history is exhausted.
    case "channel-pin-jump": {
      const repositoryId = activeChannelId();
      void loadChannelMessage(repositoryId, value, render)
        .then((loaded) => {
          const entry =
            loaded ??
            (state.channelPins[repositoryId] ?? []).find(
              (message) => message.id === value,
            );
          if (
            entry !== undefined &&
            (entry.taskId !== undefined ||
              (entry.kind !== "user" && (entry.replies ?? []).length > 0))
          ) {
            openThreadPanel(value);
            state.activeChannelThread = value;
            state.scrollToThreadMessage = value;
            // Chosen, so `openPromptedThread` will not choose over it.
            state.autoOpenedThread = undefined;
            render();
            return;
          }
          state.scrollToMessage = value;
          render();
        })
        .catch((error) => {
          toast(`Could not open that message: ${error.message}`, "error");
        });
      return;
    }
    // The tree and a file opened out of it are two surfaces, and the column
    // holds both: reading a change is usually reading the next file after it.
    case "chan-tree-toggle":
      state.chanTree = state.chanTree !== true;
      moveRightPanel("tree", "right");
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
    // Exactly the shape above, for the same reason: the browser has not
    // flipped the `<details>` yet when this runs, so the value being stored
    // is the state it is about to be in — and re-rendering here would fight
    // the animation for nothing.
    case "changed-files-toggle": {
      const details = node?.closest?.("details");
      state.changesOpen[value] =
        details === null || details === undefined ? true : !details.open;
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
      shell
        ?.querySelectorAll('[data-act="chan-collapse-toggle"]')
        .forEach((button) => {
          button.setAttribute("aria-pressed", String(state.chanCollapsed));
          button.setAttribute("aria-label", label);
          button.setAttribute("title", label);
        });
      return;
    }
    // One list rolled up or unrolled, and nothing else on the screen touched.
    // The classes go on in place for the same reason the collapse above does
    // it that way: a whole-screen render replaces the roster outright, which
    // gives the new element its final height and leaves the fold nothing to
    // animate between.
    case "roster-section-toggle": {
      const open = state.rosterSectionsOpen[value] === false;
      state.rosterSectionsOpen[value] = open;
      persist("ag.rosterSectionsOpen", JSON.stringify(state.rosterSectionsOpen));
      const heading = node.closest(".chan-sec");
      heading?.classList.toggle("chan-sec-closed", !open);
      heading?.nextElementSibling?.classList.toggle("chan-roster-closed", !open);
      const label = heading?.querySelector(".chan-sec-label")?.textContent ?? "";
      const fold = `${open ? "Hide" : "Show"} ${label.trim().toLowerCase()}`;
      node.setAttribute("aria-expanded", String(open));
      node.setAttribute("aria-label", fold);
      node.setAttribute("title", fold);
      return;
    }
    case "chan-sidebar-close":
      setChanDrawer(false);
      return;
    // Posts the same words again under the same local id — see
    // `resendChannelMessage` for why it must not mint a second one.
    case "chan-message-resend":
      resendChannelMessage(activeChannelId(), value, render);
      return;
    // The page of roots before the oldest one loaded. The reader's position
    // is held across the prepend by the anchoring in `render`: content is
    // being added *above* the viewport, so the offset that was captured means
    // nothing and the `scrollHeight` delta is what has to be applied.
    // Asking again after a failed first read. `ensureChannelMessages` refuses
    // a channel it has already been refused, so the flag has to be cleared by
    // the request rather than by the render that follows it.
    case "channel-retry-load": {
      void ensureChannelMessages(value, render, true);
      render();
      return;
    }
    case "channel-load-earlier": {
      const list = document.querySelector("#chan-messages");
      const anchor = list === null ? undefined : {
        height: list.scrollHeight,
        top: list.scrollTop,
      };
      void loadEarlierChannelMessages(value, () => {
        render();
        if (anchor === undefined) {
          return;
        }
        const next = document.querySelector("#chan-messages");
        if (next !== null) {
          next.scrollTop = anchor.top + (next.scrollHeight - anchor.height);
        }
      });
      return;
    }
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
    // The way back to a question that was put aside. Dismissal stays what it
    // was — the prompt goes away — but it is no longer silent: the chip above
    // the composer says an agent is still waiting, and this is its button.
    case "question-undismiss":
      delete state.questionDismissed[value];
      render();
      $("[data-act='question-text']")?.focus();
      return;
    case "chan-tree-dir": {
      const open = state.chanTreeOpen ?? [];
      state.chanTreeOpen = open.includes(value)
        ? open.filter((path) => path !== value)
        : [...open, value];
      render();
      return;
    }
    case "channel-threads-toggle": {
      // The list can still be marked open while the column has no room left
      // to draw it, and on a phone while a newer surface covers it. Toggle
      // only when it is the thing the reader is looking at; from anywhere
      // else this control is navigation back to the library.
      const listVisible = phoneLayout()
        ? newestRightPanel() === "threads"
        : keptRightPanels().includes("threads");
      if (listVisible) {
        state.chanThreadList = false;
        render();
        return;
      }
      // Opening the library pushes whatever is in the column left rather than
      // putting it away, so nothing here is being replaced and there is no
      // unsaved edit to ask about. A library already held further back comes
      // to the edge, which is what pressing Thread from inside one of its
      // threads means.
      state.chanThreadList = true;
      moveRightPanel("threads", "right");
      render();
      return;
    }
    case "channel-thread-delete":
      void deleteThreadAction(activeChannelId(), value);
      return;
    case "channel-message-delete":
      void deleteChannelMessageAction(activeChannelId(), value);
      return;
    case "channel-message-edit":
      void editChannelMessageAction(activeChannelId(), value);
      return;
    case "thread-reply-edit": {
      const [rootId = "", replyId = ""] = value.split("|");
      void editChannelReplyAction(activeChannelId(), rootId, replyId);
      return;
    }
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
    case "dm-edit":
      if (state.activeDm !== undefined) {
        void editDirectMessageAction(state.activeDm, value);
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
      // The thread joins the column at its right edge and pushes whatever was
      // there left: a file or a conversation open beside it is usually the
      // reason the thread was worth opening at all.
      openThreadPanel(value);
      state.activeChannelThread = value;
      state.threadReplyMessageId = undefined;
      // Chosen, so `openPromptedThread` will not choose over it.
      state.autoOpenedThread = undefined;
      render();
      return;
    case "thread-composer-focus":
      // The header's reply affordance belongs to the thread already on
      // screen; it must not close that thread and silently move the draft to
      // the group-channel composer.
      node.closest("[data-thread-id]")
        ?.querySelector("[data-act='channel-thread-input']")
        ?.focus();
      return;
    case "composer-thread-clear":
      state.composerThreadId = undefined;
      render();
      $("[data-act='channel-input']")?.focus();
      return;
    case "channel-thread-close":
      putAwayRightPanel(`thread:${value ?? state.activeChannelThread}`);
      state.threadReplyMessageId = undefined;
      render();
      return;
    // A plan joins the column the same way a thread does, at the right edge.
    case "plan-open":
      state.activePlan = value;
      moveRightPanel("plan", "right");
      render();
      return;
    case "plan-close":
      state.activePlan = undefined;
      render();
      return;
    case "catch-up-close":
      dismissSinceYouLeft();
      render();
      return;
    case "catch-up-task-open": {
      const taskRepositoryId = node.dataset.repository ?? activeChannelId();
      if (!value || !taskRepositoryId) {
        return;
      }
      void (async () => {
        await ensureChannelMessages(taskRepositoryId, render);
        let taskMessage = channelMessagesFor(taskRepositoryId).find(
          (entry) =>
            entry.taskId === value && channelMessageHasTaskThread(entry),
        );
        while (
          taskMessage === undefined &&
          state.channelHasMore[taskRepositoryId] === true
        ) {
          const before = channelMessagesFor(taskRepositoryId).length;
          await loadEarlierChannelMessages(taskRepositoryId, render);
          taskMessage = channelMessagesFor(taskRepositoryId).find(
            (entry) =>
              entry.taskId === value && channelMessageHasTaskThread(entry),
          );
          if (channelMessagesFor(taskRepositoryId).length === before) {
            break;
          }
        }
        if (taskMessage === undefined) {
          toast(
            "That task's thread is no longer in the channel history.",
            "error",
          );
          return;
        }
        openThreadPanel(taskMessage.id);
        state.activeChannelThread = taskMessage.id;
        state.threadReplyMessageId = undefined;
        state.autoOpenedThread = undefined;
        render();
      })();
      return;
    }
    // Reading it is done; saying something about it happens in the thread.
    case "plan-thread-open":
      state.activePlan = undefined;
      openThreadPanel(value);
      state.activeChannelThread = value;
      state.autoOpenedThread = undefined;
      render();
      return;
    // Approved. The thread opens on the way, because from here on the thing
    // worth watching is the work rather than the plan.
    case "plan-approve":
      startPlannedWork(activeChannelId(), value);
      state.activePlan = undefined;
      openThreadPanel(value);
      state.activeChannelThread = value;
      state.autoOpenedThread = undefined;
      render();
      return;
    // Replying inside a thread uses the same selected-message mechanism as
    // the group and direct-message composers. The address stays outside the
    // draft, so choosing a reply never rewrites words already being typed.
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
      state.threadReplyMessageId = target?.id;
      render();
      {
        const input = $("[data-act='channel-thread-input']");
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      }
      return;
    }
    case "thread-reply-clear":
      state.threadReplyMessageId = undefined;
      render();
      $("[data-act='channel-thread-input']")?.focus();
      return;
    case "thread-reference-jump": {
      const root = state.activeChannelThread;
      const selector =
        value === root ? ".thread-root" : `#thread-msg-${CSS.escape(value)}`;
      document.querySelector(selector)?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
      return;
    }
    case "dm-reply-quote": {
      const messages = state.dmThreads[state.activeDm] ?? [];
      const target = messages.find((message) => message.id === value);
      state.dmReplyMessageId = target?.id;
      render();
      {
        const input = $("[data-act='dm-input']");
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      }
      return;
    }
    case "dm-reply-clear":
      state.dmReplyMessageId = undefined;
      render();
      $("[data-act='dm-input']")?.focus();
      return;
    case "dm-reference-jump": {
      const target = document.querySelector(`#dm-msg-${CSS.escape(value)}`);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    // Tapping somebody opens the conversation with them. Rendered before the
    // fetch so the panel is there immediately, with whatever was already
    // loaded — a private message is the one surface where waiting to see
    // anything reads as the message having gone nowhere.
    case "dm-open":
      state.activeDm = value;
      state.dmDraft = "";
      clearDirectMessageSelection();
      openUserDirectMessage(value);
      render();
      loadOpenedDirectMessage(value);
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
      clearRightPanel("dm");
      state.activeDm = undefined;
      state.dmDraft = "";
      state.dmReplyMessageId = undefined;
      clearDirectMessageSelection();
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
      moveRightPanel("agent", "right");
      setChanDrawer(false);
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
    case "agent-panel-open":
      // Any agent in the room, not only your own, and its specification first. The
      // private-chat entry above stays as it was: that one is a deliberate
      // "talk to my agent" and lands on the chat tab.
      state.activeAgentPanel = value;
      state.agentPanelTab = "spec";
      moveRightPanel("agent", "right");
      setChanDrawer(false);
      render();
      // Usage is asked for whichever agent was opened, teammates' included —
      // the route takes an owner, so the figures are that agent's own.
      // Channel membership is repository scoped; load every roster once so
      // the specification can honestly list every channel rather than only
      // rooms visited this session.
      {
        const opened = channelAgentsFor(activeChannelId()).find(
          (agent) => agent.id === value,
        );
        if (opened !== undefined) {
          // Opening the specification is an explicit request for the current
          // account figures. Discard the browser's last snapshot so Codex's
          // native quota read runs for every visit instead of leaving an old
          // percentage in a panel somebody has just reopened.
          void refreshProviderUsage(
            usageProviderId(opened),
            render,
            usageOwner(opened),
          );
        }
        if (opened?.mine === true) {
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
      // Returning from chat or history opens the specification just as surely
      // as clicking the roster row does, so it gets the same fresh reading.
      if (value === "spec") {
        const opened = channelAgentsFor(activeChannelId()).find(
          (agent) => agent.id === state.activeAgentPanel,
        );
        if (opened !== undefined) {
          void refreshProviderUsage(
            usageProviderId(opened),
            render,
            usageOwner(opened),
          );
        }
      }
      return;
    case "agent-panel-close":
      clearRightPanel("agent");
      state.activeAgentPanel = undefined;
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
      // Which work this file was opened from, so its Diff tab can show that
      // task's changeset rather than whichever run the Code screen last
      // loaded. The changed-file rows carry it; a file opened from anywhere
      // else has none and falls back to the global, which is what "latest"
      // means and is correct there.
      state.chanFileTaskId = node?.dataset?.task ?? undefined;
      if (state.chanFileTaskId !== undefined) {
        void ensureChangeSetForTask(state.chanFileTaskId, render);
      }
      moveRightPanel("file", "right");
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
    /**
     * The menu on a People row — promote / demote / remove co-owner, the
     * same actions that used to live in the channel-info panel.
     */
    case "roster-person-menu":
      showMenu(node, personMenuItems(value));
      return;
    /** Replaces the rendered name with its inline editor. */
    case "channel-settings-toggle": {
      closePopover();
      const repositoryId = activeChannelId();
      const agent = channelAgentsFor(repositoryId).find(
        (candidate) => candidate.id === value,
      );
      if (agent?.mine !== true) {
        return;
      }
      state.chatSettingsOpenId = state.chatSettingsOpenId === value ? undefined : value;
      render();
      if (state.chatSettingsOpenId === value) {
        const input = $("[data-act='channel-rename-input']");
        input?.focus();
        input?.select();
      }
      return;
    }
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
    case "channel-leave":
      void leaveRepositoryAction(value);
      return;
    case "channel-delete-repo":
      void deleteRepositoryAction(value);
      return;
    case "channel-rename-repo":
      void renameRepositoryAction(value);
      return;
    /**
     * Organization role changes and removal from the People row. The role is
     * chosen in the dialog; the menu value only needs to identify the person.
     */
    case "member-role": {
      closePopover();
      const separatorIndex = value.indexOf(":");
      void memberRoleAction(
        value.slice(0, separatorIndex),
        value.slice(separatorIndex + 1),
      );
      return;
    }
    case "member-remove": {
      closePopover();
      const separatorIndex = value.indexOf(":");
      void removeMemberAction(
        value.slice(0, separatorIndex),
        value.slice(separatorIndex + 1),
      );
      return;
    }
    case "channel-grant-promote": {
      // People-row menus pass `${repositoryId}:${userId}`; the legacy picker
      // path still accepts a bare repository id.
      closePopover();
      const separatorIndex = value.indexOf(":");
      if (separatorIndex === -1) {
        void promoteRepositoryOwnerAction(value);
      } else {
        void promoteRepositoryOwnerAction(
          value.slice(0, separatorIndex),
          value.slice(separatorIndex + 1),
        );
      }
      return;
    }
    case "channel-grant-revoke": {
      // `value` is `${repositoryId}:${userId}` — see `personMenuItems` /
      // `coOwnerPanelHtml` in screen-chats.js.
      closePopover();
      const separatorIndex = value.indexOf(":");
      void revokeRepositoryGrantAction(
        value.slice(0, separatorIndex),
        value.slice(separatorIndex + 1),
      );
      return;
    }
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
    /* Agents */
    case "agent-pick":
      selectAgent(value, render);
      return;
    case "agent-tab":
      state.agentTab = value;
      render();
      // The Files tab is scoped to this agent's own work now, which means it
      // needs that work's changeset — one fetch per task, cached. Without
      // this the tab would be honest and permanently empty, which is only
      // half the fix.
      if (value === "files") {
        const task = currentAgent()?.task;
        if (task !== undefined) {
          void ensureChangeSetForTask(task.id, render);
        }
      }
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
    case "agent-add":
      closePopover();
      void startAddAgentFlow(render);
      return;
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
      navigate("agents");
      return;
    // Asks the vendor again rather than reading the kept answer. A usage card
    // that said "no session has recorded rate limits yet" would otherwise go
    // on saying it for the rest of the session, including after the run that
    // produced some.
    case "agent-usage-refresh":
      // The owner rides on the button, because the roster shows other
      // people's agents too and a refresh must ask about the same account the
      // card is displaying rather than about whoever pressed it.
      void refreshProviderUsage(value, render, node.dataset.owner);
      return;
    /**
     * Stopping a run, asked about first.
     *
     * Cancelling ends work that is mid-flight and holding a workspace, and
     * this fired straight through on one click from a plain button sitting
     * beside Retry. One confirm helper serves every entry point — the agent
     * detail's button and the thread header's — so the two cannot come to
     * disagree about how much of a decision this is.
     */
    case "thread-task-cancel":
    case "task-cancel": {
      // A thread whose task id is missing renders no control at all, so this
      // is a belt-and-braces guard rather than a state anybody can reach.
      if (!value || !confirmTaskCancel(value)) {
        return;
      }
      void cancelTask(value, render);
      return;
    }
    // Only work that has actually stopped. Retry was offered whatever state a
    // task was in, including while it was running, where the server refuses
    // it — a button that exists to be refused is worse than no button.
    case "task-retry": {
      const task = state.tasks.find((entry) => entry.id === value);
      if (task !== undefined && !TERMINAL_TASK_STATUS.has(task.status)) {
        toast("That task has not finished yet.", "error");
        return;
      }
      void retryTask(value, render);
      return;
    }

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
    /**
     * Reading a notification takes you to what it is about.
     *
     * It used to only tick the row off, which made every row on the screen a
     * dead end: "Task failed" told you something had gone wrong and left
     * finding it to you. The rows have carried a `taskId` all along, and
     * `notifications()` now carries the repository beside it, so the
     * destination is a lookup rather than a new route.
     *
     * Marking read is unconditional and happens first: a notification that
     * cannot be opened — the task has aged out of the loaded window, or the
     * event never had one — should still stop nagging.
     */
    case "notif-open": {
      readOne(value, render);
      const row = notifications().find((entry) => entry.id === value);
      const repositoryId = row?.repositoryId;
      if (repositoryId === undefined) {
        return;
      }
      navigate("chats");
      openChannel(repositoryId, render);
      void ensureChannelMessages(repositoryId, render).then(() => {
        // The thread the failure happened in, where there is one. A root
        // carries the `taskId` of the work hanging under it — the same field
        // `chan-revert-task` acts on. No match means the root is older than
        // the loaded page; the channel itself is still the right place to
        // have landed, so that is where the reader is left.
        const root = channelMessagesFor(repositoryId).find(
          (entry) =>
            row.taskId !== undefined && entry.taskId === row.taskId,
        );
        if (root !== undefined) {
          state.activeChannelThread = root.id;
          state.scrollToMessage = root.id;
        }
        render();
      });
      return;
    }

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
        // Renaming is the admin's counterpart: somebody whose access is
        // organization-wide cannot leave a repository, but can rename it.
        // Without this the menu had nothing to offer them at all. A rename
        // changes only what the repository is called — the id keeps
        // addressing the channel, its tasks and its files.
        ...(canManageRepository(value)
          ? [
              {
                act: "channel-rename-repo",
                value,
                label: `Rename #${repositoryLabel(value)}`,
                iconName: "pencil",
              },
            ]
          : []),
        // Deleting is not: it is irreversible and takes everyone else's
        // history with it, so only an owner or a co-owner of this repository
        // is offered it.
        ...(canDeleteRepository(value)
          ? [
              {
                act: "channel-delete-repo",
                value,
                label: `Delete #${repositoryLabel(value)}`,
                iconName: "trash",
                danger: true,
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
      const connected = myAgents().filter(
        (agent) => agent.mine === true && agent.connected === true,
      );
      const canConnectAnother = state.providers.some(
        (provider) =>
          provider.ownCredential === undefined &&
          (provider.signInFlow !== undefined ||
            (provider.acceptedCredentialKinds ?? []).length > 0),
      );
      showMenu(anchor, [
        ...connected.map((agent) => ({
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
        {
          // Always leave a way forward. Previously one connected agent that
          // was already in the room filled this menu with a single disabled
          // row, so the plus button could no longer start another connection.
          act: "agent-add",
          label: canConnectAnother
            ? "Connect another agent"
            : "View agent connections",
          iconName: "plus",
        },
      ]);
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
    case "colours-reset":
      state.openWheel = undefined;
      void saveAppearanceChoice({
        accent: DEFAULT_ACCENT,
        accentSecondary: DEFAULT_ACCENT_SECONDARY,
        agentColor: DEFAULT_AGENT_COLOR,
      });
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
    case "chat-mention":
      closePopover();
      // Typed rather than merely inserted: the "@" opens the name picker the
      // same way pressing the key does, which is the whole point of reaching
      // for it from the menu.
      typeIntoPrivateComposer("@", () => {
        state.composerAutocompleteTarget = "chat";
        state.mentionActive = true;
        state.mentionQuery = "";
        state.mentionIndex = 0;
      });
      return;
    case "chat-slash-key":
      closePopover();
      typeIntoPrivateComposer("/", () => {
        state.composerAutocompleteTarget = "chat";
        state.slashActive = true;
        state.slashQuery = "";
        state.slashIndex = 0;
      });
      return;
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
      // The composer says which agent it belongs to; `currentAgent` is only
      // the fallback now. It reads `state.selectedAgent`, which nothing sets
      // when the private chat is opened from the channel's agent panel — so
      // the message went to whichever agent happened to be first, or, with
      // none connected on this screen, nowhere at all.
      const agent =
        myAgents().find((candidate) => candidate.id === form.dataset.value) ??
        currentAgent();
      if (agent === undefined || input === null) {
        return;
      }
      const text = input.value;
      if (text.trim() === "" || state.sending[agent.id] === true) {
        return;
      }
      const conversationLength = (state.conversations[agent.id] ?? []).length;
      input.value = "";
      delete state.agentChatDrafts[agent.id];
      // Whatever list was open belonged to the message that just went.
      closeComposerAutocomplete("chat");
      chime("sent");
      void sendChat(agent.id, text, render).then(() => {
        // `sendChat` turns failures into a system row. Only a completed
        // assistant turn is an incoming-message cue.
        if (
          (state.conversations[agent.id] ?? [])
            .slice(conversationLength)
            .some((entry) => entry.role === "assistant" && entry.pending !== true)
        ) {
          chime("received");
        }
      });
      return;
    }
    // Here rather than in the click handler it used to live in: the send
    // button is a submit button, so a click reaches this listener the same way
    // Enter does. Handled only on the click, pressing Enter raised a submit
    // this switch had no answer for, and the message went nowhere.
    case "dm-submit": {
      const other = state.activeDm;
      const draft = state.dmDraft.trim();
      if (other === undefined || draft.length === 0) {
        return;
      }
      state.dmDraft = "";
      const referencedMessageId = state.dmReplyMessageId;
      state.dmReplyMessageId = undefined;
      closeComposerAutocomplete("dm");
      render();
      void sendDirectMessage(other, draft, referencedMessageId)
        .then(() => {
          chime("sent");
          render();
        })
        .catch((error) => toast(`Could not send: ${error.message}`, "error"));
      return;
    }
    case "channel-submit":
      submitComposerMessage(render);
      return;
    case "channel-thread-submit":
      if (form.dataset.value !== undefined) {
        state.activeChannelThread = form.dataset.value;
      }
      submitThreadReply(render);
      return;
    case "agent-rename-form": {
      const input = $("[data-act='settings-rename-input']", form);
      if (input !== null) {
        commitAgentRename(form.dataset.value, input.value);
      }
      return;
    }
    /** The inline name edit commits on Enter; blur uses the same operation. */
    case "channel-rename-form": {
      const input = $("[data-act='channel-rename-input']", form);
      const renamed = input !== null && input.value !== input.defaultValue;
      const ownAgent = channelAgentsFor(activeChannelId()).some(
        (agent) => agent.id === form.dataset.value && agent.mine === true,
      );
      if (renamed && ownAgent) {
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

async function pickChannelPictureFile(repositoryId, file) {
  if (
    repositoryId === undefined ||
    file === undefined ||
    !file.type.startsWith("image/")
  ) {
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
    setChannelPicture(repositoryId, canvas.toDataURL("image/jpeg", 0.82));
    render();
  } catch (error) {
    toast(`That image could not be read: ${error.message}`, "error");
  }
}

document.addEventListener("change", (event) => {
  const picker = event.target;
  if (picker?.dataset?.act === "channel-picture-pick") {
    void pickChannelPictureFile(picker.dataset.repository, picker.files?.[0]);
    return;
  }
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
  const owningThread = node.closest?.("[data-thread-id]")?.dataset.threadId;
  if (owningThread !== undefined) {
    state.activeChannelThread = owningThread;
  }
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
  const owningThread = node.closest?.("[data-thread-id]")?.dataset.threadId;
  if (owningThread !== undefined) {
    state.activeChannelThread = owningThread;
  }
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
    // Held in `state` before anything else, and deliberately without a render:
    // the panel is rebuilt by every background refresh, and a value that lived
    // only in the textarea was thrown away with it — which is what deleted
    // what somebody was typing to their agent.
    const agentId = node.dataset.value;
    if (agentId !== undefined && agentId !== "") {
      state.agentChatDrafts[agentId] = node.value;
    }
    // Then the live layers around the box — the "/" and "@" pickers and the
    // box's own height — through the same helper the channel composer uses,
    // so a command list opens here on the same keystroke it opens there. It
    // is also what keeps the box from growing past the lean bar when empty.
    updateComposerPresentation(node, "chat");
    return;
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
    // The pickers and the box's height, without a render — the same live
    // layers the channel composer updates on each keystroke.
    updateComposerPresentation(node, "dm");
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
  // The command and name pickers steer first, exactly as they do in the
  // channel: while a list is open, Enter takes the highlighted row and the
  // arrows move through it. Only a closed list leaves Enter meaning send.
  if (handleComposerKeydown(event, render)) {
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

/* The direct-message composer steers the same two pickers, and sends on the
   Enter neither of them claimed. */
document.addEventListener("keydown", (event) => {
  const node = event.target;
  if (node?.dataset?.act !== "dm-input") {
    return;
  }
  if (handleComposerKeydown(event, render)) {
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
  if (
    (act === "channel-rename-input" ||
      act === "settings-rename-input") &&
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
  // The Settings rename commits when focus leaves the account-wide field.
  if (act === "settings-rename-input") {
    const providerId = node.dataset.value;
    if (providerId && state.settingsRenamingId === providerId) {
      commitAgentRename(providerId, node.value);
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
  const ownAgent = channelAgentsFor(activeChannelId()).some(
    (agent) => agent.id === agentId && agent.mine === true,
  );
  if (
    activeChannelId() &&
    agentId &&
    ownAgent &&
    state.chatSettingsOpenId === agentId
  ) {
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
  const appRoot = $("#app-root");
  appRoot.hidden = true;
  appRoot.removeAttribute("aria-busy");
  appRoot.innerHTML = "";
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
  const appRoot = $("#app-root");
  appRoot.hidden = false;
  appRoot.removeAttribute("aria-busy");
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
  const appRoot = $("#app-root");
  appRoot.hidden = true;
  appRoot.removeAttribute("aria-busy");
  appRoot.innerHTML = "";
  $("#auth-root").hidden = false;
  $("#auth-root").innerHTML = renderInvite();
}

/**
 * The same idea for the channel reconcile, and deliberately shorter: this one
 * is what puts a message on screen, so it is the delay somebody notices when
 * a teammate is typing to them.
 */
const CHANNEL_FRAME_COALESCE_MS = 120;

/**
 * How quickly an ordinary event re-reads the rest of the control plane.
 *
 * A live frame should become visible promptly. A replay is different: the
 * event hub delivers its history in batches, so refreshing between batches
 * repeatedly replaces the whole mobile screen while the app is opening.
 */
const CONTEXT_REFRESH_MS = 400;

/**
 * How long the stream can stay quiet before a replay is considered complete.
 *
 * The hub drains from the cursor in batches of five hundred, one poll apart,
 * so a reconnect's history does not arrive as one burst. This delay is wider
 * than the hub's poll so channel and context refreshes wait for the whole
 * replay instead of rebuilding the screen between batches.
 */
const BACKLOG_SETTLE_MS = 1_200;

let channelFrameTimer;
let catchUpTimer;

/**
 * Channel entries that are conversation, not the high-frequency narration of
 * a run. Progress remains visual; sounding every milestone would turn one
 * task into a string of interruptions.
 */
const AUDIBLE_CHANNEL_KINDS = new Set([
  "user",
  "agent",
  "system",
  "outcome",
  "plan",
]);

function audibleChannelEntryKeys(repositoryId) {
  const keys = new Set();
  const me = currentUserId();
  const add = (entry, prefix) => {
    if (
      entry?.id !== undefined &&
      entry.deletedAt === undefined &&
      entry.authorId !== me &&
      AUDIBLE_CHANNEL_KINDS.has(entry.kind)
    ) {
      keys.add(`${prefix}:${entry.id}`);
    }
  };
  for (const message of channelMessagesFor(repositoryId)) {
    add(message, "message");
    for (const reply of message.replies ?? []) {
      add(reply, "reply");
    }
  }
  return keys;
}

/** Only live, user-relevant audit outcomes warrant a sound of their own. */
const AUDIT_CHIMES = {
  canonical_promoted: "success",
  approval_requested: "attention",
  question_asked: "attention",
  task_failed: "attention",
};

/**
 * Whether the stream is still catching this browser up.
 *
 * Set by the hub's `connected` frame and cleared once the stream goes quiet,
 * so a replay is told apart from the events that arrive while somebody is
 * watching. It keeps replay-driven refreshes and presence bookkeeping from
 * being mistaken for live activity.
 */
let catchingUp = false;

/**
 * Lets a replay settle before work that redraws the screen, while preserving
 * the shorter delay for an event that happened while the app was already up.
 */
function replayAwareDelay(liveDelay) {
  return catchingUp ? BACKLOG_SETTLE_MS : liveDelay;
}

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
 * Opens the completed-work list for the time this account was away.
 *
 * The endpoint supplies the personal `since` watermark and generated outcome;
 * the already-loaded task records supply the complete list, including
 * conversational tasks whose latest turn has landed but whose thread is still
 * open. Joining by task id keeps those outcomes with the right repository.
 */
async function showSinceYouLeft() {
  const projectId = state.projectId;
  if (projectId === "") {
    return;
  }

  let response;
  try {
    response = await api(
      `/projects/${encodeURIComponent(projectId)}/catch-up`,
    );
  } catch {
    // This is helpful context, not something that should turn a successful
    // login into an error screen. Leaving the watermark alone makes the next
    // login another chance to show it.
    return;
  }

  // The gateway wraps API records today; accepting the record itself keeps
  // this client aligned with the endpoint's documented response shape too.
  const catchUp = response?.catchUp ?? response;
  const sinceAt = Date.parse(catchUp?.since ?? "");
  if (!Number.isFinite(sinceAt)) {
    return;
  }
  if (state.projectId !== projectId || state.principal === undefined) {
    return;
  }
  // A context refresh may have selected another project without reloading the
  // document. Never let that project's parked repository reports survive it.
  state.catchUps = {};
  state.catchUp = undefined;
  const serverOutcomes = new Map(
    (Array.isArray(catchUp?.tasks) ? catchUp.tasks : [])
      .map((task) => [task.id, task]),
  );
  const tasks = state.tasks
    .filter((task) => {
      const completedAt = Date.parse(task.completedAt ?? task.openedAt ?? "");
      return (
        // Only work the server wrote an account of. A row it did not describe
        // has nothing to say but the request somebody typed, and a panel of
        // requests read back is not a summary of what happened — it is the
        // thing the reader already knows.
        serverOutcomes.has(task.id) &&
        ["integrated", "open"].includes(task.status) &&
        Number.isFinite(completedAt) &&
        completedAt > sinceAt
      );
    })
    .sort(
      (left, right) =>
        Date.parse(right.completedAt ?? right.openedAt ?? "") -
        Date.parse(left.completedAt ?? left.openedAt ?? ""),
    )
    .map((task) => {
      const outcome = serverOutcomes.get(task.id);
      return {
        ...task,
        completedAt: outcome?.completedAt ?? task.completedAt ?? task.openedAt,
        // The server's account of what the work did. Never the request that
        // asked for it: this panel exists to say what changed, and echoing
        // back what the reader typed says nothing they did not already know.
        summary:
          String(outcome?.summary ?? "").trim() ||
          "Completed the requested work.",
        changedFiles: Array.isArray(outcome?.changedFiles)
          ? outcome.changedFiles
          : [],
      };
    });
  if (tasks.length === 0) {
    render();
    return;
  }
  state.catchUps = Object.fromEntries(
    state.repositories
      .map((repository) => {
        const repositoryTasks = tasks.filter(
          (task) => task.repositoryId === repository.id,
        );
        return [repository.id, {
          projectId,
          repositoryId: repository.id,
          since: catchUp.since,
          tasks: repositoryTasks,
        }];
      })
      .filter(([, report]) => report.tasks.length > 0),
  );
  state.catchUp = state.catchUps[activeChannelId()];
  render();
}

/**
 * Advances the away-window cursor as the visible visit ends.
 *
 * `keepalive` is the important part: mobile browsers commonly freeze or tear
 * down the page immediately after this signal. The request has no useful
 * response for the departing page, but the next visit needs its server time.
 */
function markCatchUpSeenWhilePresent() {
  const projectId = state.projectId;
  if (
    projectId === "" ||
    state.principal === undefined ||
    Object.keys(state.catchUps ?? {}).length > 0
  ) {
    return;
  }
  void api(
    `/projects/${encodeURIComponent(projectId)}/catch-up/seen`,
    { method: "POST", body: {}, keepalive: true },
  ).catch(() => undefined);
}

/**
 * Puts away exactly the list that was shown and advances its personal mark.
 * Best-effort like the old modal close: the panel disappears immediately,
 * while a failed mark leaves the same work eligible on the next visit rather
 * than silently losing it.
 */
function dismissSinceYouLeft() {
  const projectId = state.catchUp?.projectId;
  const repositoryId = state.catchUp?.repositoryId;
  if (repositoryId !== undefined) {
    delete state.catchUps[repositoryId];
  }
  state.catchUp = undefined;
  if (
    projectId === undefined ||
    Object.keys(state.catchUps ?? {}).length > 0
  ) {
    return;
  }
  void api(
    `/projects/${encodeURIComponent(projectId)}/catch-up/seen`,
    { method: "POST", body: {} },
  ).catch(() => undefined);
}

async function boot() {
  renderLoadingShell();
  if (await handleInviteLink()) {
    return;
  }
  // Health says whether this control plane has an owner yet; the context call
  // says who is asking. Neither answer depends on the other, so a cold start
  // asks for both at once instead of paying two round trips in a row for what
  // is one wait on a phone. The context failure is captured rather than
  // thrown, because it has to be handled after the health answer is in.
  // Read before the context call can answer: "nobody is signed in yet" has to
  // mean what it meant when this ran second.
  const signedOut = state.principal === undefined;
  const contextFailure = loadContext({ defer: true }).then(
    () => undefined,
    (error) => error,
  );
  const healthFailure = loadHealth().then(
    () => undefined,
    (error) => error,
  );
  const healthError = await healthFailure;
  if (state.health?.setupRequired === true && signedOut) {
    // First-time setup outranks the link: neither signing in nor registering
    // can succeed against a control plane that has no owner yet.
    authMode = "bootstrap";
  } else {
    const mode = authModeFromHash();
    if (mode !== undefined) {
      authMode = mode;
    }
  }
  const failure = (await contextFailure) ?? healthError;
  if (failure !== undefined) {
    if (failure.status === 401) {
      state.principal = undefined;
      showAuth();
      return;
    }
    state.loadError = failure.message;
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
  // Everything below this line happens with a screen already up. The audit
  // feed, the run history, the metrics tile and the worker fleet are read on
  // screens somebody has to navigate to first, so they no longer stand between
  // tapping the icon and seeing the app.
  void loadDeferredContext().then(() => {
    render();
    // Completion summaries and changed files live in the audit slice loaded
    // above. Older records can still fall back to the request, but current
    // work should lead with the agent's account of what was implemented.
    void showSinceYouLeft();
  });
  void loadProviders().then(() => render());
  void loadGitHub().then(() => {
    if (state.settingsOpen === true) {
      render();
    }
  });
  void loadInvitations().then(() => {
    if (state.settingsOpen === true) {
      render();
    }
  });

  connectSocket((frame) => {
    // The hub's handshake, and the only warning that a replay is about to
    // start. Everything between here and the stream going quiet is history
    // this browser missed rather than something happening now. The handshake
    // itself carries no changed data, and boot/resume already loaded context;
    // letting it fall through would redraw the app on every reconnect even
    // when there is nothing to catch up on.
    if (frame?.type === "connected") {
      beginCatchUp();
      return;
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
      // Reading it as it arrives — when it arrives in the conversation that is
      // open — happens inside `noteDirectMessage`, which is the only place
      // that knows whose conversation the message belongs to.
      const added = noteDirectMessage(frame);
      if (added && frame.message?.recipientId === currentUserId()) {
        chime("received");
      }
      if (!renameFieldFocused()) {
        render();
      }
      return;
    }
    // A correction replaces the existing bubble for both participants. It is
    // not a new message and must not increment unread counts or replay the
    // arrival animation.
    if (frame?.type === "direct-message-edited") {
      noteDirectMessageEdited(frame);
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
      // Taken before the reconcile replaces local state. Comparing ids after
      // the read distinguishes a genuinely new reply from an edit, delete,
      // reaction, old reconnect history, or this browser's own server echo.
      const canSound = !catchingUp;
      const audibleBefore = canSound
        ? audibleChannelEntryKeys(channelRepositoryId)
        : undefined;
      // Coalesced because a reconnect delivers every channel event this
      // browser missed, and each one used
      // to re-read the channel and rebuild the whole app — a backlog of forty
      // meant forty full renders back to back, which is the few seconds the
      // screen spent refusing to respond to a tap. The reconcile is
      // idempotent, so the last one in a burst produces the same answer as
      // all of them.
      window.clearTimeout(channelFrameTimer);
      channelFrameTimer = window.setTimeout(() => {
        void refreshChannelMessages(channelRepositoryId).then(() => {
          openPromptedThread(channelRepositoryId);
          openReadyPlan(channelRepositoryId);
          markChannelReadIfWatching(channelRepositoryId);
          const received =
            audibleBefore !== undefined &&
            [...audibleChannelEntryKeys(channelRepositoryId)].some(
              (key) => !audibleBefore.has(key),
            );
          render();
          if (received) {
            chime("received");
          }
        });
      }, replayAwareDelay(CHANNEL_FRAME_COALESCE_MS));
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
    if (frame?.type === "audit") {
      // Remembered before anything else so the next connection starts here
      // instead of replaying the same backlog every time a phone returns to
      // the foreground. Notifications remain available in their dedicated
      // history without interrupting the current screen.
      noteEventSequence(frame.sequence);
      const auditChime = catchingUp
        ? undefined
        : AUDIT_CHIMES[frame.event?.type];
      if (auditChime !== undefined) {
        chime(auditChime);
      }
      extendCatchUp();
      // A terminal event delivered live was already seen during this visit.
      // Record that immediately instead of relying only on the later tab-close
      // request: a hard reload can begin its catch-up read while that final
      // keepalive write is still in flight and hand the same ending back.
      if (
        !catchingUp &&
        document.visibilityState === "visible" &&
        ["canonical_promoted", "task_reported", "task_failed"].includes(
          frame.event?.type,
        )
      ) {
        markCatchUpSeenWhilePresent();
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
    state.timer = window.setTimeout(
      () => void refresh({ quiet: true }),
      replayAwareDelay(CONTEXT_REFRESH_MS),
    );
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
