/**
 * Personal agent and GitHub connection flows shared by Settings and chat.
 *
 * Connections remain scoped to the signed-in person. This module owns only
 * credential setup and task actions; agent activity is shown in the channel
 * where the work happens.
 */

import {
  addAgentToAllRepositories,
  api,
  cancelGitHubSignIn,
  cancelProviderSignIn,
  createEditorToken,
  createLocalAgent,
  connectGitHub,
  forgetAgentInLoadedRosters,
  connectProviderCredential,
  gitHubSignInStatus,
  loadGitHub,
  loadProviders,
  myAgents,
  PROVIDER_VENDOR,
  providerSignInStatus,
  startGitHubSignIn,
  startProviderSignIn,
  state,
  submitProviderSignInCode,
} from "./data.js";
import {
  agentLabelOf,
  esc,
  icon,
  showModal,
  toast,
  VENDOR_LABEL,
  vendorMark,
} from "./ui.js";

/** Task states from which a stopped run may be retried. */
export const TERMINAL_TASK_STATUS = new Set([
  "integrated",
  "failed",
  "cancelled",
]);

/** How somebody gets a credential we can accept, per provider. */
const CREDENTIAL_HELP = {
  anthropic: {
    hint: "Run <code>claude setup-token</code> on your own machine and finish the browser sign-in. It prints a token starting <code>sk-ant-oat</code> that spends your own Claude subscription.",
    placeholder: "sk-ant-oat-…",
    kinds: [
      ["oauth_token", "Subscription token (claude setup-token)"],
      ["api_key", "API key from console.anthropic.com"],
    ],
  },
  google: {
    // Google retired the Gemini CLI's browser sign-in for personal accounts,
    // so for most people a key is now the only way in.
    hint: "Create a key at <a class=\"link\" target=\"_blank\" rel=\"noopener noreferrer\" href=\"https://aistudio.google.com/apikey\">aistudio.google.com/apikey</a>. It bills per request rather than against a subscription. Browser sign-in still works on a paid Gemini Code Assist plan.",
    placeholder: "AIza…",
    kinds: [["api_key", "API key from Google AI Studio"]],
  },
  openai: {
    // Codex has no `setup-token` equivalent, so a ChatGPT subscription can
    // only be brought over as the session file the CLI itself wrote.
    hint: "On a ChatGPT subscription, sign in with <code>codex</code> on your own machine and paste the contents of <code>~/.codex/auth.json</code>. On API credits, paste a key from platform.openai.com instead.",
    placeholder: "sk-… or the contents of auth.json",
    kinds: [
      ["session_file", "ChatGPT subscription (contents of ~/.codex/auth.json)"],
      ["api_key", "API key from platform.openai.com"],
    ],
  },
};

/**
 * Said once, on the kinds it is true of.
 *
 * A copied session file shares a rotating refresh token with the machine it
 * came from, so the two can revoke each other by refreshing. That is a real
 * consequence of using it and belongs in front of somebody about to paste
 * one, not in a comment they will never read.
 */
const SESSION_FILE_WARNING =
  "A copied session file shares a refresh token with the machine it came " +
  "from: signing out there, or a refresh on either side, can invalidate the " +
  "other. An API key or subscription token does not do this.";

/** The short promise beside a provider in the first step of connecting it. */
function providerConnectionDescription(provider) {
  if (provider.ownCredential !== undefined) {
    return "Connected to your account";
  }
  const browser = provider.signInFlow !== undefined;
  const credential = (provider.acceptedCredentialKinds ?? []).length > 0;
  if (browser && credential) {
    return "Browser sign-in or your own credential";
  }
  if (browser) {
    return "Continue with browser sign-in";
  }
  if (credential) {
    return "Connect with your own credential";
  }
  return "Connection is not available on this deployment";
}

/**
 * Starts every Add Agent control at the same provider choice.
 *
 * Existing connections remain visible so the list does not appear to change
 * underneath somebody after their first connection, but only a provider this
 * account has not connected can be chosen. The provider's own flow takes over
 * after this step, which keeps browser approval, code exchange, and credential
 * entry in one implementation.
 */
export async function startAddAgentFlow(rerender, goToSettings) {
  try {
    if (!state.providersLoaded) {
      await loadProviders();
    }
  } catch (error) {
    toast(`Could not load available agents. ${error.message}`, "error");
    return;
  }

  const providers = state.providers ?? [];
  const available = providers.filter(
    (provider) =>
      provider.ownCredential === undefined &&
      (provider.signInFlow !== undefined ||
        (provider.acceptedCredentialKinds ?? []).length > 0),
  );
  const selected = available[0]?.id;
  const choices = providers
    .map((provider) => {
      const connected = provider.ownCredential !== undefined;
      const connectable =
        provider.signInFlow !== undefined ||
        (provider.acceptedCredentialKinds ?? []).length > 0;
      const disabled = connected || !connectable;
      return `<label class="agent-provider-choice${
        connected ? " is-connected" : disabled ? " is-disabled" : ""
      }">
        <input type="radio" name="providerChoice" value="${esc(provider.id)}"${
          provider.id === selected ? " checked" : ""
        }${disabled ? " disabled" : ""}>
        <span class="agent-provider-mark">${vendorMark(provider.id)}</span>
        <span class="agent-provider-copy">
          <strong>${esc(agentLabelOf(provider.id))}</strong>
          <small>${esc(providerConnectionDescription(provider))}</small>
        </span>
        <span class="agent-provider-state">${
          connected ? "Connected" : disabled ? "Unavailable" : "Choose"
        }</span>
      </label>`;
    })
    .join("");
  const availabilityNote =
    providers.length === 0
      ? "Ask an administrator to enable an agent provider for this deployment."
      : providers.every((provider) => provider.ownCredential !== undefined)
        ? "Every available provider is already connected to your account."
        : available.length === 0
          ? "No additional provider can be connected on this deployment."
          : "Next, you will see the sign-in or connection details for the provider you choose.";

  const pending = showModal({
    title: "Add an agent",
    subtitle:
      "Choose a provider. Your existing agents and their conversations stay unchanged.",
    confirm: available.length === 0 ? "Done" : "Continue",
    cancel: available.length === 0 ? "Close" : "Not now",
    body: `<fieldset class="agent-provider-picker">
        <legend class="sr-only">Agent provider</legend>
        ${
          choices ||
          `<p class="agent-provider-empty">No agent providers are available on this deployment.</p>`
        }
      </fieldset>
      <input type="hidden" name="providerId" value="${esc(selected ?? "")}">
      <p class="modal-hint">${availabilityNote}</p>`,
  });

  // `showModal` collects ordinary form fields. Keep one hidden field in sync
  // with the radio cards so it receives the checked value, not merely the last
  // radio in document order.
  const dialog = document.querySelector("#modal");
  const syncProvider = (event) => {
    const field = event.target;
    if (!(field instanceof HTMLInputElement) || field.name !== "providerChoice") {
      return;
    }
    const value = dialog?.querySelector('[name="providerId"]');
    if (value instanceof HTMLInputElement) {
      value.value = field.value;
    }
  };
  dialog?.addEventListener("change", syncProvider);
  const values = await pending;
  dialog?.removeEventListener("change", syncProvider);
  const providerId = String(values?.providerId ?? "");
  if (providerId === "") {
    return;
  }
  await connectProviderSomehow(providerId, rerender, goToSettings);
}

/**
 * Connects one editor on this machine, end to end.
 *
 * Three steps that used to be a person's job: mint a token scoped to filing
 * work and nothing else, have the app write that editor's own config file,
 * and say what is left. The token is never shown, because nobody has to carry
 * it anywhere, which is also why it cannot be pasted with its angle brackets
 * on, or without the word Bearer, or into the wrong scope.
 *
 * The outcome is a dialog somebody closes, not a toast. What it says is the
 * one instruction that decides whether the connection works, and a message
 * that clears itself after six seconds is the wrong carrier for it: the
 * Codex advice below was missed exactly that way.
 */
export async function connectEditorToKumi(vendor, rerender) {
  const bridge = window.KUMI_INSTALL;
  if (bridge?.connectEditor === undefined) {
    return;
  }
  const label = VENDOR_LABEL[vendor] ?? vendor;
  rememberEditor(vendor, "connecting", "Connecting");
  rerender();
  let outcome;
  try {
    // Named for the editor and the machine, so the tokens list is something a
    // person can actually revoke from rather than a column of identical rows.
    const minted = await createEditorToken(`${label} on ${deviceLabel()}`, vendor);
    const written = await bridge.connectEditor(vendor, minted.token);
    outcome =
      written?.ok !== true
        ? {
            state: "failed",
            message: `Could not connect ${label}. ${
              written?.detail ?? "The app gave no reason."
            }`,
          }
        : { state: "connected", message: editorNextStep(vendor, label, written, minted) };
  } catch (error) {
    outcome = {
      state: "failed",
      message: `Could not connect ${label}. ${error.message}`,
    };
  }
  rememberEditor(vendor, outcome.state, outcome.message);
  rerender();
  await showModal({
    title:
      outcome.state === "connected"
        ? `${label} is connected`
        : `${label} was not connected`,
    subtitle:
      outcome.state === "connected"
        ? `${label} can now file work into Kumi, and pick up work waiting for it.`
        : "Nothing was written, and nothing on your account changed.",
    body: `<p class="modal-hint">${esc(outcome.message)}</p>`,
    confirm: "Close",
    cancel: "",
  });
}

/** Remembers what happened to one editor, for the rows that report it. */
function rememberEditor(vendor, connectionState, message) {
  state.editorConnected = {
    ...state.editorConnected,
    [vendor]: { state: connectionState, message },
  };
}

/**
 * What is left to do after the config is written, per editor.
 *
 * Only Codex gets the advice about the environment, and only Codex should:
 * it is the one vendor that reads its token from a variable rather than from
 * the file just written, so it is the one vendor where writing the file is
 * not the end of the job. Telling somebody with Claude or Cursor to restart
 * their computer is asking for a reboot that changes nothing.
 */
function editorNextStep(vendor, label, written, minted) {
  // Said first, because it changes what the connection can do. A viewer's
  // editor can read the roster and follow a task and cannot file one, and
  // finding that out by being refused mid-sentence is worse than being told
  // now.
  const scope = minted.readOnly
    ? "Connected read only. Your role cannot submit tasks, so this editor " +
      "can follow work but not file it. An owner can grant you " +
      "developer access. "
    : "";
  if (written.manual !== undefined) {
    // Codex away from Windows: the file is written and the variable is not,
    // because a shell profile is the person's own file. Saying so beats
    // reporting a job that is only half done.
    return `${scope}Config written. Add this line to your shell, then reopen ${label}: ${written.manual}`;
  }
  if (vendor === "codex") {
    // Codex reads its token from the environment, and a running program keeps
    // the environment it started with. Restarting the computer is the one
    // instruction that is true for both the Codex app and every terminal;
    // "close Codex" is not, because the Store build only suspends when its
    // window closes and resumes holding the same environment.
    return `${scope}Connected. Codex reads its token from your account's environment, and a program that is already running keeps the environment it started with. Restart your computer, then ask Codex to have Kumi do something.`;
  }
  return `${scope}Connected. Restart ${label}, then ask it to have Kumi do something.`;
}

/** This computer, as the tokens list should name it. */
function deviceLabel() {
  const platform = /win/iu.test(navigator.platform ?? "")
    ? "Windows"
    : /mac/iu.test(navigator.platform ?? "")
      ? "Mac"
      : "this computer";
  return platform;
}

/**
 * Which of the three connections somebody wants, and then making it.
 *
 * There are three, they are genuinely different, and until now two of them
 * lived on a Settings screen nobody looking at an agent would think to open.
 * Asking here is the whole point: "connect Codex" is ambiguous, and the
 * ambiguity is what left somebody with a connected agent that could not be
 * mentioned, or a grey dot beside a CLI they had definitely installed.
 *
 * The CLI is asked about first because it is the one that makes an agent
 * exist. The other two are MCP in opposite directions, which is why they are
 * a second question rather than three items in one list: they are the same
 * kind of thing pointing different ways, and flattening them reads as three
 * unrelated options.
 */
export async function connectProviderSomehow(providerId, rerender, goToSettings) {
  const label = agentLabelOf(providerId);
  const vendor = PROVIDER_VENDOR[providerId];
  const bridge = window.KUMI_INSTALL;
  // Only what this build can actually write, and only where there is an app
  // to write it. In a browser the editor half is unreachable, and offering it
  // would be offering a button that cannot work.
  const editorable =
    bridge?.connectEditor !== undefined &&
    vendor !== undefined &&
    (bridge.connectable ?? ["claude", "codex", "cursor"]).includes(vendor);

  // Whether the CLI half can be finished from wherever this is being read.
  //
  // It cannot from a phone. Kumi installs to a home screen as a standalone
  // app, so somebody can be *in the Kumi app*, press Connect, and be told to
  // go and open the Kumi app. Refused here, before the flow rather than after
  // it, exactly as the direction dialog below already refuses the editor half.
  //
  // `KUMI_SERVER` is what keeps this from blocking the case that matters
  // most: the desktop app whose bridge is missing when it should not be. That
  // is a fault, not a place, and greying the row out would take away the one
  // button that produces a diagnosis of it. Somewhere with no app at all is
  // the only thing refused up front.
  const cliable =
    bridge?.detected !== undefined ||
    window.KUMI_SERVER !== undefined ||
    state.localAgentsOnly !== true;

  // One option per row, each with a mark, a heading, the badge that carries
  // the jargon, and a sentence. `showModal` resolves a radio group to its
  // checked value on its own, so there is no hidden mirror field to keep in
  // step with it any more.
  const kind = await chooseFrom({
    title: `Connect ${label}`,
    subtitle: "Two different things share the name. Which one do you want?",
    confirm: "Continue",
    cancel: "Not now",
    body: `<fieldset class="choice-list">
      <legend class="sr-only">Connection kind</legend>
      ${choiceRow({
        group: "connectionKind",
        value: "cli",
        checked: cliable,
        disabled: !cliable,
        mark: "terminal",
        title: "Run agents on this computer",
        badge: "CLI",
        blocked: cliable ? undefined : "Needs the desktop app",
        note: cliable
          ? `Installs ${esc(label)}'s command-line tool and signs it in. This
             is the one that makes the agent exist: @mention it and the work
             happens here, on your machine, on your own subscription.`
          : `An agent runs on a computer, and only that computer can say
             whether it is set up. Open Kumi's desktop app on the machine that
             will run this agent and connect it there. You can still send it
             work from here afterwards.`,
      })}
      ${choiceRow({
        group: "connectionKind",
        value: "mcp",
        checked: !cliable,
        mark: "link",
        title: "Connect tools",
        badge: "MCP",
        note: `A separate thing, and it does not replace the CLI. Either work
          with Kumi from inside ${esc(label)}, or give Kumi's agents tools to
          use while they work.`,
      })}
    </fieldset>`,
  }, "connectionKind");
  if (kind === undefined) {
    return;
  }
  if (kind === "cli" || kind === "") {
    await connectAgent(providerId, rerender);
    return;
  }

  // The direction badges are the point of this dialog. "MCP goes both ways"
  // is a sentence somebody has to hold in their head; `Codex → Kumi` and
  // `Kumi → Codex` are the same fact, readable at a glance, and they make two
  // opposite options impossible to confuse.
  const direction = await chooseFrom({
    title: `Connect ${label} over MCP`,
    subtitle: "MCP runs in both directions, and they do opposite things.",
    confirm: "Set it up",
    cancel: "Back",
    body: `<fieldset class="choice-list">
      <legend class="sr-only">Direction</legend>
      ${choiceRow({
        group: "mcpDirection",
        value: "editor",
        checked: editorable,
        disabled: !editorable,
        mark: "send",
        title: `Work with Kumi from ${esc(label)}`,
        badge: `${esc(label)} → Kumi`,
        blocked: editorable
          ? undefined
          : bridge?.connectEditor === undefined
            ? "Needs the desktop app"
            : "Not supported yet",
        note: editorable
          ? `Type "have Kumi fix the login redirect" in ${esc(label)} and the
             task is filed here, with a thread following it. It can also pick
             up work waiting for it and do it in the repository you already
             have open, with no CLI installed. Kumi writes the config on this
             computer.`
          : bridge?.connectEditor === undefined
            ? `This writes a file on the computer ${esc(label)} runs on, so it
               has to be set up from Kumi's desktop app rather than a browser.`
            : `Kumi cannot write ${esc(label)}'s config yet.`,
      })}
      ${choiceRow({
        group: "mcpDirection",
        value: "tools",
        checked: !editorable,
        mark: "wand",
        title: "Give Kumi's agents tools",
        badge: `Kumi → tools`,
        note: `Approve a server (documentation, issues, a browser) and every agent
          working on this repository can use it. Approving is recorded, and
          each teammate's computer asks before running anything.`,
      })}
    </fieldset>`,
  }, "mcpDirection");
  if (direction === undefined) {
    return;
  }
  if (direction === "editor") {
    await connectEditorToKumi(vendor, rerender);
    return;
  }
  // The servers themselves live in project settings, because approving one is
  // a decision about the project rather than about this agent — and it is
  // recorded there against whoever made it.
  //
  // `#/settings/mcp-servers` was not a route. Nothing happened, on the one
  // branch of this flow whose whole job is to take somebody somewhere, so
  // choosing it looked exactly like choosing nothing. `project-controls` is
  // the section that actually holds the card.
  await showModal({
    title: "Approve a tool server",
    subtitle:
      "Kumi is opening the place these are kept, in this project's settings.",
    body: `<p class="modal-hint">Approve a server there and every agent working
      on this repository can use it. Approving is recorded against you, and
      each teammate's computer asks before it runs anything.</p>`,
    confirm: "Close",
    cancel: "",
  });
  // Handed in rather than imported: the shell imports this module, so
  // reaching back into it would be a cycle. The caller owns navigation
  // anyway — this one owns the decision.
  goToSettings?.("project-controls", "mcp-servers");
}

/**
 * One option in a decision dialog.
 *
 * A mark, a heading, a badge, and a sentence — laid out by `.choice`, which
 * exists because these used to borrow `.agent-provider-picker`. That is a
 * two-column grid built for the four short agent tiles, and two columns of a
 * 448px dialog left each option's prose about ten characters wide: the
 * headings wrapped one word per line and the explanations became ribbons.
 *
 * `badge` carries the jargon — "CLI", "MCP", or a direction like
 * `Codex → Kumi` — so the heading can be plain English. `blocked` replaces it
 * when an option cannot be chosen here, because a row at reduced opacity says
 * only that something is wrong, never what.
 */
function choiceRow({
  group,
  value,
  mark,
  title,
  badge,
  note,
  blocked,
  checked = false,
  disabled = false,
}) {
  return `<label class="choice${disabled ? " is-disabled" : ""}">
    <input type="radio" name="${esc(group)}" value="${esc(value)}"${
      checked ? " checked" : ""
    }${disabled ? " disabled" : ""}>
    <span class="choice-mark">${icon(mark)}</span>
    <span class="choice-head">
      <span class="choice-title">${title}</span>
      ${
        blocked === undefined
          ? badge === undefined
            ? ""
            : `<span class="choice-badge">${badge}</span>`
          : `<span class="choice-badge is-blocked">${esc(blocked)}</span>`
      }
    </span>
    <span class="choice-tick" aria-hidden="true"></span>
    <span class="choice-note">${note}</span>
  </label>`;
}

/**
 * Asks a dialog full of `choiceRow`s and answers with what was picked.
 *
 * `showModal` reads a radio group's checked value itself, so this no longer
 * mirrors the answer into a hidden field on every change — that workaround
 * was written when the modal took the last radio in document order instead of
 * the chosen one, and it outlived the bug.
 */
async function chooseFrom(spec, group) {
  const values = await showModal(spec);
  return values === undefined ? undefined : String(values[group] ?? "");
}

/**
 * Connecting means handing over a credential of your own — not borrowing the
 * host's.
 *
 * This used to POST straight to the CLI sign-in, which authenticates as
 * whoever owns the machine. That is the wrong default for everyone except the
 * person who set the host up: it spends their account, and for anybody else it
 * fails outright with an administrator error. So the credential is the default
 * and the only path offered here; the CLI remains available to system
 * administrators through the provider's own settings.
 */
/** Waits, so a sign-in can be polled without spinning the browser. */
function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Signing in through the browser, where the vendor allows it.
 *
 * This is what "connect" should have meant all along: the deployment runs the
 * vendor's own sign-in, the user approves it on their own machine, and no
 * long-lived credential has to be found or copied from another machine.
 *
 * Two shapes, and the server says which. `approve` shows a code the user
 * confirms in the browser and the CLI polls for the answer. `code_exchange`
 * shows a link and takes a code back — the vendor's page issues it, and the
 * waiting CLI needs it before it can finish.
 *
 * Returns `true` when connected, `false` when retry should be offered, and
 * `null` when the user walked away.
 */
/**
 * Installs a vendor's CLI from inside the app, after showing what will run.
 *
 * The confirmation is the point. These are the vendors' own one-liners and two
 * of them pipe a downloaded script into an interpreter — which is exactly what
 * a person would paste by hand, and exactly why it should not happen because
 * somebody pressed "Connect". So the command is displayed, agreed to, and only
 * then run.
 *
 * The command shown is read back from the desktop rather than composed here.
 * The page names a vendor and the app decides what that means, so a remote
 * document cannot put a command on this machine's shell — and what is agreed
 * to cannot differ from what executes, because they are the same value.
 */
export async function installVendorCli(vendor, rerender) {
  const bridge = window.KUMI_INSTALL;
  if (bridge === undefined || vendor === "") {
    return;
  }
  const plan = await bridge.plan(vendor).catch(() => undefined);
  if (plan === undefined) {
    toast("This machine has no published installer for that agent.", "error");
    return;
  }
  const agreed = await showModal({
    title: `Install the ${vendor} CLI`,
    subtitle:
      "Kumi runs agents on this machine, so the vendor's own CLI has to be " +
      "here. This is what will run:",
    body: `<pre class="install-command">${esc(plan.command)}</pre>
      <p class="modal-hint">It comes from ${esc(vendor)}'s own published
      instructions. You can copy it and run it yourself instead.</p>`,
    confirm: "Run it",
    cancel: "Not now",
  });
  if (agreed === undefined) {
    return;
  }

  // The output is collected, not displayed while it runs. A dialog somebody
  // has to dismiss between agreeing to an install and being asked to sign in
  // is a step that asks nothing — and the modal helper puts a confirm button
  // on it, so it read as a decision when there was none to make. It is kept
  // for the one case that needs it: a failure, where the vendor's own words
  // say whether this was a missing npm, a proxy, or a blocked script, and a
  // bare "it failed" would leave somebody exactly where they started.
  const lines = [];
  const stop = bridge.onOutput((line) => {
    lines.push(line);
  });
  toast(`Installing ${vendor}…`);
  let result;
  try {
    result = await bridge.run(vendor);
  } catch (error) {
    result = { ok: false, detail: error?.message ?? "The install failed." };
  } finally {
    stop?.();
  }

  if (result?.ok !== true) {
    await showModal({
      title: `${esc(vendor)} was not installed`,
      subtitle: result?.detail ?? "The installer did not finish.",
      body: `<pre class="install-output">${esc(lines.join("").slice(-2000))}</pre>`,
      confirm: "Close",
    });
    return;
  }

  // Installed, and still unusable until somebody signs in — the one step no
  // app can take for them, because every vendor's login is an interactive
  // flow it owns. The most this can do is put them in front of it with
  // nothing left to type.
  const now = await showModal({
    title: `${esc(vendor)} is installed`,
    subtitle:
      `One thing left: sign in. Kumi uses this machine's own ${esc(vendor)} ` +
      "login, so it has to be done here, once.",
    body: `<p class="modal-hint">This opens a terminal already running
      <code>${esc(plan.signIn)}</code>. Follow its sign-in, then come back.
      Kumi picks it up on its own.</p>`,
    confirm: "Open the sign-in",
    cancel: "Later",
  });
  if (now !== undefined) {
    const opened = await bridge.signIn(vendor).catch(() => false);
    if (opened !== true) {
      toast(
        `Could not open a terminal. Run \`${plan.signIn}\` yourself to sign in.`,
        "error",
      );
    }
  }
  rerender?.();
}

/**
 * Connecting an agent where the machine, not the server, will run it.
 *
 * Nothing is created until the machine has answered. This used to run the
 * other way round — `createLocalAgent` first, so the agent and its call sign
 * existed before a single question had been put to the computer, and the
 * failure arrived afterwards as a toast: "Eris is yours, but Codex is not
 * installed on this machine yet." Somebody was left holding a named agent, in
 * every channel, that could not run, and the only thing that had ever said so
 * was six seconds of a message in a corner.
 *
 * The argument for the old order was that an agent which is there and grey is
 * honest. It is not: it is @mentionable, it is on every roster, and the first
 * anybody else learns of the gap is a task that goes nowhere.
 *
 * So the order is: ask the machine, fix what is fixable, and only then coin
 * the agent and its name. Every way out before that point leaves the account
 * exactly as it was.
 */
async function connectLocalAgent(providerId, rerender) {
  const label = agentLabelOf(providerId);
  state.providerConnecting?.add(providerId);
  rerender();
  let verdict;
  try {
    verdict = await verifyMachineFor(providerId, rerender);
  } finally {
    state.providerConnecting?.delete(providerId);
    rerender();
  }
  if (verdict !== "ready") {
    // Refused, and said in a dialog rather than a toast. This is the end of
    // the flow somebody started, the reason is something they have to act on,
    // and a message that clears itself in six seconds is the wrong carrier for
    // the one sentence that explains why they have no agent.
    await showModal({
      title: `${label} was not connected`,
      subtitle: REFUSAL[verdict]?.subtitle ?? "This machine could not be checked.",
      body: `<p class="modal-hint">${REFUSAL[verdict]?.body ?? ""}</p>${refusalDetail(
        verdict,
      )}`,
      confirm: "Close",
      cancel: "",
    });
    return false;
  }

  let agent;
  try {
    agent = await createLocalAgent(providerId);
  } catch (error) {
    toast(`Could not create the ${label} agent. ${error.message}`, "error");
    return false;
  }
  await loadProviders();
  rerender();
  const failedRepositories = await addAgentToAllRepositories(providerId);
  const name = agent?.callSign ?? label;
  toast(
    failedRepositories.length === 0
      ? `${name} is yours, and this machine can run it`
      : `${name} is yours, but could not be added to every repository`,
    failedRepositories.length === 0 ? "ok" : "error",
  );
  rerender();
  return true;
}

/**
 * Why an agent was not created, in words somebody can act on.
 *
 * One entry per verdict `verifyMachineFor` can return, so a state added there
 * without a sentence here is visible immediately rather than surfacing as an
 * empty dialog.
 */
const REFUSAL = {
  "no-app": {
    subtitle: "Kumi could not check this computer.",
    repair: `Agents run on your own machine, so only the machine can say
      whether this one is set up. Open Kumi's desktop app on the computer that
      runs this agent.`,
    body: `Agents run on your own machine, so Kumi has to see the CLI before it
      creates one. Open Kumi's desktop app on the computer that will run this
      agent and connect it there. Nothing was created here.`,
  },
  missing: {
    subtitle: "The CLI is not installed on this machine.",
    repair: `This agent cannot run until it is installed. Press Check the CLI
      again and Kumi will offer to install it for you.`,
    body: `An agent without its CLI cannot run, so none was created. Install it
      and press Connect again. Kumi can do the install for you from the same
      button.`,
  },
  "signed-out": {
    subtitle: "The CLI is installed, but nobody is signed in to it.",
    repair: `Kumi runs it under this machine's own login, so the sign-in has to
      happen here. This agent stays where it is and starts working the moment
      the login is live.`,
    body: `Kumi runs it under this machine's own login, so the sign-in has to
      happen here. Finish it and press Connect again. No agent was created, and
      nothing on your account changed.`,
  },
  // Apart from `no-app` because the advice is the opposite, and carrying a
  // `detail` because this is the refusal somebody reports to a colleague who
  // cannot see their screen. See `appBridgeDetail`.
  "stale-app": {
    subtitle: "This copy of the Kumi app cannot check the CLI.",
    repair: `The app is running, but the part of it that inspects this machine
      did not load. Download the latest version and open it again. Your
      agents and their names are kept.`,
    body: `The app is running, but the part of it that inspects this machine
      did not load, so Kumi cannot see whether the CLI is there. Download the
      latest version and open it again, then press Connect. Nothing was
      created here, and your agents and their names are kept.`,
    detail: () => appBridgeDetail(),
  },
  unknown: {
    subtitle: "This machine could not be asked.",
    detail: () => machineDetail,
    repair: `The check did not complete, so this is not an answer about the
      agent. Try again, and if it keeps happening restart the Kumi app.`,
    body: `The check did not complete, so Kumi will not claim an agent works
      when it has not established that it does. Try again, and if it keeps
      happening restart the Kumi app.`,
  },
};

/**
 * Which build of the desktop app this page is running inside, if any.
 *
 * Read from the User-Agent first, and that order is the whole point: the app
 * has appended `KumiDesktop/<version>` to it since long before it exposed a
 * version to the page, so this answers for installs already out there rather
 * than only for ones built after somebody thought to ask. `KUMI_VERSION` is
 * the newer, exact source and wins where it exists.
 *
 * `undefined` in a browser, which is not a missing version — there is no
 * desktop app to have one.
 */
export function desktopVersion() {
  const exposed = window.KUMI_VERSION;
  if (typeof exposed === "string" && exposed !== "") {
    return exposed;
  }
  const stamped = /\bKumiDesktop\/([0-9][0-9A-Za-z.+-]*)/u.exec(
    typeof navigator === "undefined" ? "" : (navigator.userAgent ?? ""),
  );
  return stamped?.[1];
}

/**
 * What the page can actually see of the app it is running in.
 *
 * Read from the globals rather than described in prose, so the sentence is
 * evidence instead of a guess. `KUMI_VERSION` is only in builds that expose
 * it, and saying so is itself the answer for a build old enough to lack it.
 */
/**
 * The evidence line under a refusal, or nothing when there is none to give.
 *
 * A `detail` that comes back empty is the ordinary case — most refusals are
 * self-explanatory — so this renders nothing rather than the word `undefined`,
 * which is what a naive template would have put on screen.
 */
function refusalDetail(verdict) {
  const said = REFUSAL[verdict]?.detail?.();
  return typeof said === "string" && said !== ""
    ? `<p class="modal-hint">${esc(said)}</p>`
    : "";
}

/**
 * The last thing this machine said about why a check did not finish.
 *
 * `verifyMachineFor` answers with a verdict *name*, which is what picks the
 * sentence out of `REFUSAL` and what the tests read. The machine's own reason
 * — "The CLI did not answer in time.", an ENOENT, a spawn that was refused —
 * came back beside it and was dropped on the floor. That reason is the entire
 * content of a support conversation about somebody else's laptop, so it is
 * kept here and shown under the sentence.
 */
let machineDetail;

function appBridgeDetail() {
  const version = desktopVersion() ?? "not reported by this build";
  const bridge = window.KUMI_INSTALL;
  const missing =
    bridge === undefined
      ? "the whole bridge"
      : bridge.detected === undefined
        ? "the machine check"
        : bridge.login === undefined
          ? "the vendor login check"
          : "nothing";
  return `Kumi app ${version}; missing: ${missing}.`;
}

/**
 * What this machine can say about running one agent, before anything is made.
 *
 * Returns `"ready"` or the reason it is not. The install and the sign-in are
 * offered along the way, because they are the whole remaining setup and the
 * person is already standing here — but neither is *assumed* to have worked.
 * Each is re-asked afterwards, since reporting a success because a remedy was
 * offered is the same mistake this ordering exists to fix.
 */
async function verifyMachineFor(providerId, rerender) {
  const bridge = window.KUMI_INSTALL;
  const vendor = PROVIDER_VENDOR[providerId];
  if (bridge?.detected === undefined || vendor === undefined) {
    // Two very different situations, and only one of them is "you are in a
    // browser". `KUMI_SERVER` is exposed by the same preload and has been
    // there far longer, so a page holding it without the install bridge is
    // the app — just one whose bridge did not load. Telling that person to
    // open the desktop app sends them to check the one thing that is not
    // wrong, which is how this was found.
    return window.KUMI_SERVER === undefined ? "no-app" : "stale-app";
  }
  machineDetail = undefined;
  const detected = await bridge
    .detected()
    .catch((error) => {
      machineDetail = `Asking this machine what is installed failed: ${
        error?.message ?? String(error)
      }`;
      return undefined;
    });
  if (detected === undefined) {
    // Set here as well as in the `catch`, because a bridge that *resolves*
    // with nothing never rejects and so never reached that handler — one of
    // two ways this refusal could still arrive with nothing under it.
    machineDetail ??= "This machine did not say what is installed on it.";
    return "unknown";
  }
  if (!detected.includes(vendor)) {
    await installVendorCli(vendor, rerender);
    const after = await bridge.detected().catch(() => undefined);
    if (after?.includes(vendor) !== true) {
      return "missing";
    }
  }

  // An app too old to answer this cannot be treated as a yes. It is the same
  // build that created agents without checking anything, so believing it here
  // would reinstate exactly the behaviour this replaces.
  if (bridge.login === undefined) {
    // Old, not unknowable. "Try again, and if it keeps happening restart the
    // Kumi app" is advice that cannot work: restarting the same installer
    // brings back the same missing bridge, and this is the one refusal whose
    // remedy is a download. Answered as `stale-app` so it says so.
    return "stale-app";
  }
  const first = await bridge.login(vendor).catch((error) => {
    machineDetail = `Asking ${vendor} about its login failed: ${
      error?.message ?? String(error)
    }`;
    return undefined;
  });
  const outcome = await settleLogin(first, vendor, bridge, providerId);
  return outcome;
}

/**
 * Reads a login verdict, offering the sign-in once and asking again after.
 *
 * `unknowable` is a pass, and deliberately. Cursor, Copilot and Kiro sign in
 * through a browser session this deployment does not treat as a connection —
 * the control plane reports them signed out by definition — so there is no
 * login here to read. Refusing on that would make three agents permanently
 * impossible to connect in order to enforce a question nobody can answer, so
 * they are connected on what *is* established, which is that the CLI is
 * there, and the dialog says which half was checked.
 */
async function settleLogin(verdict, vendor, bridge, providerId) {
  if (verdict === undefined) {
    return "unknown";
  }
  if (verdict.state === "signed-in" || verdict.state === "unknowable") {
    return "ready";
  }
  if (verdict.state === "missing") {
    return "missing";
  }
  if (verdict.state !== "signed-out") {
    // `readVendorLogin` says why in `detail` — a timeout, an ENOENT, a spawn
    // the operating system refused. Collapsing that to the word "unknown" is
    // what made this dialog unactionable from anywhere but the machine.
    machineDetail =
      typeof verdict.detail === "string" && verdict.detail !== ""
        ? `${vendor}: ${verdict.detail}`
        : `${vendor}: the check answered "${String(verdict.state)}", which ` +
          "Kumi does not know how to read.";
    return "unknown";
  }
  const now = await showModal({
    title: `${agentLabelOf(providerId)} is installed, but not signed in`,
    subtitle:
      `Kumi runs it under this machine's own ${esc(vendor)} login, so it has ` +
      "to be signed in here before there is an agent to create.",
    body: `<p class="modal-hint">This opens a terminal running the sign-in.
      Finish it there, then come back. Kumi checks again rather than taking your
      word for it, so nothing is created until it can see the login.</p>`,
    confirm: "Open the sign-in",
    cancel: "Not now",
  });
  if (now === undefined) {
    return "signed-out";
  }
  const opened = await bridge.signIn?.(vendor).catch(() => false);
  if (opened !== true) {
    toast("Could not open a terminal for the sign-in", "error");
    return "signed-out";
  }
  // Waited for deliberately: the terminal is a separate window and the sign-in
  // is a browser round trip, so asking again immediately would always find the
  // old answer. The person says when they are done.
  const finished = await showModal({
    title: "Finished signing in?",
    subtitle: `Kumi will ask ${esc(vendor)} again before creating the agent.`,
    body: `<p class="modal-hint">If the sign-in did not work, close this.
      Nothing has been created and nothing on your account has changed.</p>`,
    confirm: "I have signed in",
    cancel: "Not yet",
  });
  if (finished === undefined) {
    return "signed-out";
  }
  const again = await bridge.login(vendor).catch(() => undefined);
  if (again === undefined) {
    return "unknown";
  }
  return again.state === "signed-in" || again.state === "unknowable"
    ? "ready"
    : again.state === "missing"
      ? "missing"
      : again.state === "signed-out"
        ? "signed-out"
        : "unknown";
}

/**
 * Removing an agent.
 *
 * "Disconnect" used to mean deleting a stored credential, because the
 * credential was the agent. It is not any more, and the button had drifted
 * away from what it says in two directions at once: on an agent with a
 * credential it deleted the secret and left the agent itself in every
 * channel, and on an agent without one — which is every agent on a
 * deployment that runs them locally — it was not offered at all, so an agent
 * could be created and never removed.
 *
 * It asks first. Removing an agent is not undoable in the way that matters:
 * the call sign goes back in the pool and the next agent dealt may take it,
 * so the name people have learned can end up belonging to somebody else.
 *
 * What it deliberately does not touch is the vendor CLI on this machine and
 * the vendor account behind it. Kumi installed the one and never owned the
 * other, and signing somebody out of Codex because they tidied up a Kumi
 * roster would be a surprise of an entirely different order.
 */
export async function disconnectAgent(providerId, rerender) {
  const label = agentLabelOf(providerId);
  const agent = myAgents().find((entry) => entry.id === providerId);
  // The call sign if it has one, because that is the name on the screen and
  // in every channel — asking "disconnect Codex?" about an agent everybody
  // calls Eris is asking about something else.
  const name = agent?.hasName === true ? agent.name : label;
  // Whether it is mid-run. `myAgents` already worked this out to draw the
  // busy dot, so saying it here costs nothing — and it is the one thing about
  // removing an agent that cannot be undone by connecting another. Work
  // already claimed runs to completion on its own machine; what goes is the
  // ability to address it. Mentions resolve through the roster on every read
  // rather than being stored, so once the agent is gone `@${name}` matches
  // nothing and neither does cancelling by name.
  const busy = agent?.task !== undefined;
  const confirmed = await showModal({
    title: `Disconnect ${name}?`,
    subtitle:
      `${name} leaves every channel it is in, and its name goes back in the ` +
      "pool for another agent to be dealt.",
    body:
      (busy
        ? `<p class="modal-hint sr-warn">${esc(name)} is working right now.
            That run will finish on its own, but once the agent is gone you
            will not be able to cancel it or reply to it by name.</p>`
        : "") +
      `<p class="modal-hint">Nothing is uninstalled, and your
      ${esc(label)} account is untouched, so you can connect it again whenever
      you like.</p>`,
    confirm: "Disconnect",
    cancel: "Keep it",
  });
  if (confirmed === undefined) {
    return false;
  }
  try {
    await api(`/chat/providers/${encodeURIComponent(providerId)}`, {
      method: "DELETE",
    });
  } catch (error) {
    toast(`Could not disconnect ${label}. ${error.message}`, "error");
    return false;
  }
  forgetAgentInLoadedRosters(providerId);
  await loadProviders();
  toast(`${name} disconnected`, "ok");
  rerender();
  return true;
}

/**
 * The half of connecting that happens on this machine.
 *
 * A vendor sign-in gives Kumi an agent. It does not give the machine anything
 * — the CLI that agent runs as still has to be installed here and logged into
 * separately. Splitting those apart is how somebody could finish "Connect",
 * see a green agent, @mention it, and only then be told nothing on their
 * machine could run it. The gap was found the hard way: three agents
 * connected, none of them runnable, and a morning spent reading process lists
 * to work out why.
 *
 * So connecting finishes here instead. Only in the desktop app, which is the
 * only thing that can see the machine; a browser has no business being asked
 * and is left exactly as it was.
 */
/**
 * Sorting out the machine, for an agent that already exists.
 *
 * `finishLocalSetup` only ever ran as the tail of connecting, so the install
 * and the sign-in were reachable from exactly one button — and that button is
 * absent from a connected row, because the row is connected. An agent whose
 * CLI was never installed, or whose CLI has since signed out, therefore had no
 * route to either: the row offered a rename, a vendor web sign-in and a
 * delete, and none of those touch the machine.
 *
 * That is how somebody ended up with three connected agents, no CLI behind any
 * of them, and nothing on any screen able to say so. Same dialog, same
 * installer, asked for when it is wanted rather than only on the way past.
 */
export async function checkLocalCli(providerId, rerender) {
  if (window.KUMI_INSTALL === undefined) {
    // Two very different reasons, and telling them apart is the whole value of
    // the message. `KUMI_SERVER` has been in the app's preload since the app
    // was first something you could download; the install bridge beside it
    // came much later. So a page with the first and not the second is the app,
    // just an old one — and saying "open the app" to somebody who is already
    // in it sends them to check the one thing that is not wrong.
    //
    // That mattered: a build without the bridge cannot install a CLI, cannot
    // offer a sign-in, and cannot say that it cannot. Every agent connected
    // from it looks connected and can run nothing, which is exactly how this
    // was found.
    toast(
      window.KUMI_SERVER === undefined
        ? "Open the Kumi app on the machine that runs this agent. A browser " +
            "cannot see what is installed there."
        : "This copy of the Kumi app is too old to install or check a CLI. " +
            "Download the latest version and open it again. Your agents and " +
            "their names are kept.",
      "error",
    );
    return;
  }
  await finishLocalSetup(providerId, rerender);
}

/**
 * Sorting the machine out for an agent that already exists.
 *
 * The same check the connect flow now runs before creating anything, so this
 * button and that flow cannot disagree about whether an agent can run. It
 * used to offer the sign-in and then answer "ready" regardless — the one
 * control whose job is to say why an agent does not work, unable to tell a
 * live login from an absent one.
 *
 * Spoken rather than returned: every caller of this awaits it and none reads
 * the answer, because by here the agent exists and what is wanted is a
 * sentence about the machine.
 */
async function finishLocalSetup(providerId, rerender) {
  const verdict = await verifyMachineFor(providerId, rerender);
  const label = agentLabelOf(providerId);
  if (verdict === "ready") {
    toast(`${label} can run on this machine`, "ok");
    return;
  }
  await showModal({
    title: `${label} cannot run here yet`,
    subtitle: REFUSAL[verdict]?.subtitle ?? "This machine could not be checked.",
    // The agent already exists on this path, so the sentence about nothing
    // having been created would be untrue — that half belongs to the connect
    // flow and is deliberately not repeated here.
    body: `<p class="modal-hint">${
      REFUSAL[verdict]?.repair ?? REFUSAL[verdict]?.body ?? ""
    }</p>${refusalDetail(verdict)}`,
    confirm: "Close",
    cancel: "",
  });
}

async function signInAgent(providerId, mode, rerender) {
  // On a deployment that runs agents locally, the vendor sign-in below buys
  // nothing the agent needs. It stores a credential this server then never
  // reads — the CLI runs under the machine's own login — so somebody signed in
  // twice and only the second one made anything work. Worse, the first was
  // what created the agent at all, which is why "reconnect from Settings →
  // Agents" was offered as the fix for a CLI that was not signed in, and could
  // never have helped.
  //
  // So the agent is created outright and setup finishes on the machine. The
  // last thing the credential still bought — the usage figures — now comes
  // from this machine's own CLI, so on a local deployment there is nothing
  // left for the vendor sign-in to be an extra for, and no route to it.
  if (state.localAgentsOnly === true) {
    return await connectLocalAgent(providerId, rerender);
  }
  state.providerConnecting?.add(providerId);
  rerender();
  // Opened now, empty, and pointed at the vendor once the URL is known.
  // A tab opened after the `await` below is a popup as far as the browser is
  // concerned — the click that authorised it is long over — so it gets
  // blocked. Claiming it during the gesture and navigating it later is what
  // makes "press Connect and the sign-in page appears" actually happen.
  //
  // Claude looked like it worked without this only because its CLI opens a
  // browser itself — on the *server*, which is the user's own machine here
  // and somebody else's everywhere else. Codex's CLI prints the URL and opens
  // nothing, which is how the difference showed up.
  // Deliberately without `noopener`: that feature makes `window.open` return
  // null, and a null handle cannot be navigated — the tab opens and sits on
  // about:blank forever. The opener reference is dropped below instead, which
  // gets the same protection while keeping the handle.
  const tab = claimSignInTab();
  if (tab !== null && tab !== undefined) {
    // Starting the CLI can take a few seconds. Leaving the claimed tab as
    // about:blank during that wait made a working sign-in look broken before
    // its URL had even arrived.
    tab.document.title = `Opening ${agentLabelOf(providerId)} sign-in`;
    tab.document.body.style.cssText =
      "margin:0;display:grid;min-height:100vh;place-items:center;" +
      "font:16px system-ui,sans-serif;color:#334155;background:#f8fafc";
    tab.document.body.textContent =
      `Preparing the ${agentLabelOf(providerId)} sign-in page…`;
  }
  let flow;
  try {
    flow = await startProviderSignIn(providerId);
  } catch (error) {
    state.providerConnecting?.delete(providerId);
    rerender();
    tab?.close();
    // The caller offers a fresh attempt, and saying why beats silently
    // showing a credential form the user did not ask for.
    toast(`${agentLabelOf(providerId)} sign-in unavailable. ${error.message}`, "error");
    return false;
  }
  state.providerConnecting?.delete(providerId);
  rerender();

  // If the tab was blocked anyway, the link in the dialog is still there and
  // still works — this is a shortcut, not the only route.
  if (tab !== null && tab !== undefined) {
    // Cut the back-reference before navigating, so the vendor's page cannot
    // reach back into this one.
    tab.opener = null;
    tab.location.replace(flow.verificationUrl);
  } else {
    openSignInFallback(flow.verificationUrl);
  }

  const exchange = (flow.mode ?? mode) === "code_exchange";
  const link =
    `<p class="modal-hint"><a class="link" target="_blank" rel="noopener noreferrer"
       href="${esc(flow.verificationUrl)}">Open the ${esc(agentLabelOf(providerId))} sign-in page</a>
     It opens in a new tab, on your own account.</p>`;
  // Whether the browser hands back a code varies by vendor and by how the
  // sign-in page resolves: approving in the browser is often enough on its
  // own, and the CLI exits without ever prompting. So the flow is polled
  // while the dialog is open, and the code box is a fallback rather than a
  // requirement — asking for a code that was never issued is a dead end.
  let settledWhileOpen;
  let modalOpen = true;
  void (async () => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      await pause(1500);
      if (!modalOpen) {
        return undefined;
      }
      let current;
      try {
        current = await providerSignInStatus(providerId, flow.flowId);
      } catch {
        return undefined;
      }
      if (!modalOpen) {
        return current;
      }
      if (current.status !== "pending") {
        settledWhileOpen = current;
        document.querySelector("#modal")?.close();
        return current;
      }
    }
    return undefined;
  })();

  const values = await showModal({
    title: `Sign in to ${agentLabelOf(providerId)}`,
    subtitle: "Your account, not this machine's.",
    confirm: exchange ? "Connect" : "I've approved it",
    body: exchange
      ? `${link}
         ${
           flow.userCode
             ? `<p class="modal-code">${esc(flow.userCode)}</p>
                <p class="modal-hint">Enter that code on the sign-in page if it asks for one.</p>`
             : ""
         }
         <label class="field"><span>Code from that page
             <span class="field-optional">only if it shows one</span></span>
           <input class="input" name="code" autocomplete="one-time-code"
             placeholder="Paste it here if you were given one"></label>
         <p class="modal-hint">Approve the sign-in in that tab. Most of the
           time that is all it takes and this will finish on its own; if the
           page shows you a code instead, paste it above. This deployment
           never sees your password.</p>`
      : `${link}
         <p class="modal-code">${esc(flow.userCode ?? "")}</p>
         <p class="modal-hint">Enter that code on the page, approve it, then
           come back here.</p>`,
  });
  // Stop the dialog watcher before the submit path starts polling. A terminal
  // status is intentionally readable only once, so two pollers can otherwise
  // race and turn a successful code exchange into an "unknown sign-in" error.
  modalOpen = false;

  if (settledWhileOpen !== undefined) {
    const settled = settledWhileOpen;
    if (settled.status !== "completed") {
      toast(
        settled.detail ?? `${agentLabelOf(providerId)} sign-in did not complete`,
        "error",
      );
      return false;
    }
    await loadProviders();
    const failedRepositories = await addAgentToAllRepositories(providerId);
    toast(
      failedRepositories.length === 0
        ? `${agentLabelOf(providerId)} connected as ${settled?.account ?? "your account"}`
        : `${agentLabelOf(providerId)} connected, but could not be added to every repository`,
      failedRepositories.length === 0 ? "ok" : "error",
    );
    rerender();
    await finishLocalSetup(providerId, rerender);
    return true;
  }

  if (values === undefined) {
    await cancelProviderSignIn(providerId, flow.flowId);
    return null;
  }

  try {
    const code = exchange ? String(values.code ?? "").trim() : "";
    if (code !== "") {
      await submitProviderSignInCode(providerId, flow.flowId, code);
    }
    // The CLI finishes on its own clock — it has a browser round trip to wait
    // on either way — so the outcome is polled rather than assumed.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const state_ = await providerSignInStatus(providerId, flow.flowId);
      if (state_.status === "completed") {
        // `loadProviders`, not `loadContext`: the context call reads
        // organizations, projects and repositories and never touches
        // `state.providers`. Refreshing the wrong thing is why a sign-in
        // could report success — the credential really was stored — while
        // the screen went on showing the provider as unconnected and it
        // never appeared in the agent list. The paste path did not have this
        // fault because storing a credential returns the new provider list
        // in its own response.
        await loadProviders();
        const failedRepositories = await addAgentToAllRepositories(providerId);
        toast(
          failedRepositories.length === 0
            ? `${agentLabelOf(providerId)} connected as ${state_.account ?? "your account"}`
            : `${agentLabelOf(providerId)} connected, but could not be added to every repository`,
          failedRepositories.length === 0 ? "ok" : "error",
        );
        rerender();
        await finishLocalSetup(providerId, rerender);
        return true;
      }
      if (state_.status !== "pending") {
        toast(state_.detail ?? `${agentLabelOf(providerId)} sign-in did not complete`, "error");
        return false;
      }
      await pause(1000);
    }
    toast(`${agentLabelOf(providerId)} sign-in timed out`, "error");
    await cancelProviderSignIn(providerId, flow.flowId);
    return false;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

export async function connectAgent(providerId, rerender) {
  state.providerConnecting?.add(providerId);
  rerender();
  // Sign-in first where the vendor supports it, because the alternative is
  // asking somebody to go and find a secret. The server reports which
  // providers can, so this does not have to know.
  const entry = (state.providers ?? []).find(
    (item) => item.id === providerId,
  );
  const signInFlow = entry?.signInFlow;
  // What the server says this provider will accept by hand. Asked rather than
  // assumed: which providers have a paste route changes when a vendor changes
  // its mind, as Google did when it closed the Gemini CLI's browser sign-in to
  // personal accounts, and a list hardcoded here goes stale silently.
  const pasteable = (entry?.acceptedCredentialKinds ?? []).length > 0;
  if (signInFlow !== undefined) {
    // A failed sign-in used to fall through to the paste box, which answered
    // "that did not work" by asking somebody to go and find an OAuth token on
    // another machine. That is a harder job than the one that just failed, and
    // it arrived unasked — so the commonest reason a connection failed (a
    // mistimed tab, a closed window, a slow vendor) turned into a research
    // task instead of a second press of the button.
    //
    // Offering the retry in a loop, because retrying is what actually fixes
    // it. Closing the dialog is how somebody says they are done.
    for (;;) {
      const outcome = await signInAgent(providerId, signInFlow, rerender);
      if (outcome === true || outcome === null) {
        return;
      }
      // Retrying fixes a mistimed tab. It cannot fix a vendor that has
      // withdrawn the flow — Gemini's refusal for personal accounts is
      // permanent, and looping "Try again" on it is a trap. So where a
      // pasted credential is accepted, that is offered as the other way out.
      const again = await showModal({
        title: "Connection failed",
        subtitle: `${agentLabelOf(providerId)} did not finish signing in.`,
        confirm: "Try again",
        cancel: pasteable ? "Use a credential instead" : "Not now",
        body: `<p class="modal-hint">Nothing was saved, and nothing on your
          account changed. This is usually the sign-in tab being closed or
          taking too long, and starting it again is normally all it needs.${
            pasteable
              ? " If the message above says this account is not eligible, " +
                "signing in again will not help, so connect a credential instead."
              : ""
          }</p>`,
      });
      if (again === undefined) {
        if (!pasteable) {
          return;
        }
        break;
      }
    }
  }
  // A provider that accepts nothing by hand is browser-only, and saying so is
  // the whole answer for it. Decided from what the server accepts rather than
  // from a list here, so a vendor gaining or losing a paste route does not
  // need this file changed to match.
  if (!pasteable) {
    state.providerConnecting?.delete(providerId);
    rerender();
    toast(`${agentLabelOf(providerId)} browser sign-in is unavailable`, "error");
    return;
  }

  state.providerConnecting?.delete(providerId);
  rerender();
  const help = CREDENTIAL_HELP[providerId] ?? {
    hint: "Paste a credential for this provider.",
    placeholder: "",
    kinds: [["api_key", "API key"]],
  };
  const values = await showModal({
    title: `Connect ${agentLabelOf(providerId)}`,
    subtitle: "Your credential, used only for you.",
    confirm: "Connect",
    body: `
      <p class="modal-hint">${help.hint}</p>
      ${
        help.kinds.length > 1
          ? `<label class="field"><span>Credential type</span>
               <select class="input" name="kind">
                 ${help.kinds
                   .map(([id, label]) => `<option value="${id}">${esc(label)}</option>`)
                   .join("")}
               </select></label>`
          : `<input type="hidden" name="kind" value="${help.kinds[0][0]}">`
      }
      <label class="field"><span>Credential</span>
        ${
          // A session file is a whole JSON document, so a one-line masked
          // input cannot hold one legibly. Providers that accept a file get a
          // textarea, which takes a pasted key just as well.
          help.kinds.some(([id]) => id === "session_file")
            ? `<textarea class="input cred-paste" name="secret" rows="4"
                 autocomplete="off" placeholder="${esc(help.placeholder)}"
                 required></textarea>`
            : `<input class="input" name="secret" type="password" autocomplete="off"
                 placeholder="${esc(help.placeholder)}" required>`
        }</label>
      <label class="field"><span>Label <span class="field-optional">optional</span></span>
        <input class="input" name="label" autocomplete="off"
          placeholder="Which account this is"></label>
      <label class="field"><span>Who can task it</span>
        <select class="input" name="visibility">
          <option value="personal" selected>Personal, only you can task it</option>
          <option value="org">Org-wide, anyone with access to a repository
            it works in can @mention it there</option>
        </select></label>
      <p class="modal-hint">This agent will be added to every repository you
        can currently access and to repositories you create or import later.
        You can still remove or add it for any individual repository.</p>
      ${
        help.kinds.some(([id]) => id === "session_file")
          ? `<p class="modal-hint">${esc(SESSION_FILE_WARNING)}</p>`
          : ""
      }
      <p class="modal-hint">Stored encrypted, never shown again, and never
        shared with anyone else on this deployment. "Org-wide" only changes
        who may @mention this agent to submit work. The credential itself is
        still never shared.</p>`,
  });
  if (values === undefined) {
    return;
  }
  const secret = String(values.secret ?? "").trim();
  if (secret === "") {
    toast("A credential is required", "error");
    return;
  }
  try {
    await connectProviderCredential(
      providerId,
      String(values.kind ?? "api_key"),
      secret,
      String(values.label ?? "").trim(),
      values.visibility === "org" ? "org" : "personal",
    );
    const failedRepositories = await addAgentToAllRepositories(providerId);
    toast(
      failedRepositories.length === 0
        ? `${providerId} connected`
        : `${providerId} connected, but could not be added to every repository`,
      failedRepositories.length === 0 ? "ok" : "error",
    );
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * The GitHub device sign-in, shaped like `signInAgent`'s approve mode:
 * GitHub issues a short code, the person enters it at github.com in a tab
 * of their own, and the poll finishes the moment they approve. Returns
 * true when connected, false to fall back to the paste box, null when the
 * person walked away.
 */
/**
 * Whether this page is running inside the desktop app rather than a browser.
 *
 * The preload sets `KUMI_SERVER`; `data.js` reads the same value to decide
 * whether to address a configured server with a bearer token or to behave
 * like an ordinary browser tab. It is the established signal for "not a
 * browser", so this uses it rather than inventing a second one.
 */
function insideDesktopApp() {
  return typeof window.KUMI_SERVER === "string" && window.KUMI_SERVER !== "";
}

/**
 * Claim a tab now, to navigate once the sign-in URL is known.
 *
 * This is browser technique and it is load-bearing there: a tab opened after
 * the `await` below is a popup as far as the browser is concerned, because
 * the click that authorised it is long over, and it gets blocked.
 *
 * The desktop app is not a browser. Every `window.open` is intercepted and
 * the URL handed to the operating system, so the claim is refused *and* the
 * placeholder is forwarded — and an empty URL is `about:blank`, which is how
 * pressing Connect came to ask Windows which application opens `about:`
 * links, on top of a sign-in that then had no tab to open into. There is no
 * popup blocker to outmanoeuvre there, so nothing is claimed and the real URL
 * is opened when it arrives.
 */
function claimSignInTab() {
  return insideDesktopApp() ? null : window.open("", "_blank");
}

/**
 * Send the browser to a sign-in URL when the claimed tab did not survive.
 *
 * The claim-during-the-click trick is a browser technique and the desktop app
 * is not a browser: it intercepts every `window.open` and hands the URL to the
 * operating system instead, so the claimed tab is always denied and `tab` is
 * null there — the sign-in page would never open at all, and the person would
 * be left to find the link in the dialog.
 *
 * Opening again with the real URL is what the desktop needs and what a browser
 * ignores: this only runs when the first open was already blocked, so a
 * browser that refused one popup refuses this one too, with nothing lost.
 */
function openSignInFallback(verificationUrl) {
  try {
    window.open(verificationUrl, "_blank", "noopener");
  } catch {
    // The link in the dialog is still there and still works. A failure to
    // open a convenience must not take the flow down with it.
  }
}

async function signInGitHub(rerender) {
  state.providerConnecting?.add("github");
  rerender();
  // Claimed during the click, navigated once the URL is known — the same
  // popup-blocker reasoning as `signInAgent`.
  const tab = claimSignInTab();
  let flow;
  try {
    flow = await startGitHubSignIn();
  } catch (error) {
    state.providerConnecting?.delete("github");
    rerender();
    tab?.close();
    toast(`GitHub sign-in unavailable. ${error.message}`, "error");
    return false;
  }
  state.providerConnecting?.delete("github");
  rerender();
  if (tab !== null && tab !== undefined) {
    tab.opener = null;
    tab.location.replace(flow.verificationUrl);
  } else {
    openSignInFallback(flow.verificationUrl);
  }

  let finishedWhileOpen = false;
  const watch = (async () => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      await pause(1500);
      let current;
      try {
        current = await gitHubSignInStatus(flow.flowId);
      } catch {
        return undefined;
      }
      if (current.status !== "pending") {
        if (current.status === "granted") {
          finishedWhileOpen = true;
          document.querySelector("#modal")?.close();
        }
        return current;
      }
    }
    return undefined;
  })();

  const values = await showModal({
    title: "Sign in to GitHub",
    subtitle: "Your account; this deployment never sees your password.",
    confirm: "I've approved it",
    body: `<p class="modal-hint"><a class="link" target="_blank"
        rel="noopener noreferrer" href="${esc(flow.verificationUrl)}">Open
        the GitHub sign-in page</a>. It opens in a new tab.</p>
      <p class="modal-code">${esc(flow.userCode ?? "")}</p>
      <p class="modal-hint">Enter that code on the page, approve the
        access, then come back here. Pushes an agent runs for you will
        authenticate as this account.</p>`,
  });

  if (finishedWhileOpen) {
    const settled = await watch;
    toast(`GitHub connected as ${settled?.login ?? "you"}`, "ok");
    await loadGitHub();
    rerender();
    return true;
  }
  if (values === undefined) {
    await cancelGitHubSignIn(flow.flowId);
    return null;
  }
  try {
    // "I've approved it" — give the grant a moment to land, polling the
    // same status the background watch reads.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const current = await gitHubSignInStatus(flow.flowId);
      if (current.status === "granted") {
        toast(`GitHub connected as ${current.login ?? "you"}`, "ok");
        await loadGitHub();
        rerender();
        return true;
      }
      if (current.status !== "pending") {
        toast(current.detail ?? "GitHub sign-in did not complete", "error");
        return false;
      }
      await pause(1000);
    }
    toast("GitHub sign-in timed out", "error");
    await cancelGitHubSignIn(flow.flowId);
    return false;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

/**
 * Connecting GitHub is connecting an identity, not enabling a feature: a
 * push an agent runs for you authenticates as this token, as you, and
 * reaches only what you can reach. There is deliberately no deployment-wide
 * token for it to borrow — until this is connected, an asked-for push is
 * refused by name.
 *
 * Sign-in first when the deployment offers it, exactly like the agents: a
 * browser approval beats sending somebody off to mint a secret. The paste
 * box remains for deployments without an OAuth App, and for anyone who
 * wants a fine-grained token scoped tighter than the sign-in's `repo`
 * grant.
 */
export async function connectGitHubAccount(rerender) {
  state.providerConnecting?.add("github");
  rerender();
  if (state.github?.signInAvailable === true) {
    for (;;) {
      const outcome = await signInGitHub(rerender);
      if (outcome === true || outcome === null) {
        return;
      }
      // Confirm retries; anything else — the paste button, Escape — falls
      // through to the paste box below, which is also the way out of the
      // loop for somebody done with dialogs (the paste box closes too).
      const again = await showModal({
        title: "Sign-in did not finish",
        subtitle: "Nothing was saved, and nothing on your account changed.",
        confirm: "Try again",
        cancel: "Paste a token instead",
        body: `<p class="modal-hint">This is usually the sign-in tab being
          closed or the code expiring, and starting again is normally all it
          needs. A pasted personal access token works too, and can be
          scoped to single repositories where the sign-in cannot.</p>`,
      });
      if (again === undefined) {
        break;
      }
    }
  }
  state.providerConnecting?.delete("github");
  rerender();
  const values = await showModal({
    title: "Connect GitHub",
    subtitle: "Your token, spent only on pushes your own tasks ask for.",
    confirm: "Connect",
    body: `
      <p class="modal-hint">Create a personal access token on github.com
        (Settings &rarr; Developer settings) with write access to the
        repositories you want published to, and paste it here. It is
        verified against GitHub before it is stored.</p>
      <label class="field"><span>Personal access token</span>
        <input class="input" name="token" type="password" autocomplete="off"
          placeholder="ghp_&hellip; or github_pat_&hellip;" required></label>
      <p class="modal-hint">Stored encrypted, never shown again, and never
        shared with anyone else on this deployment. Pushes run as this token
        and reach only what it can.</p>`,
  });
  if (values === undefined) {
    return;
  }
  const token = String(values.token ?? "").trim();
  if (token === "") {
    toast("A token is required", "error");
    return;
  }
  try {
    const status = await connectGitHub(token);
    toast(`GitHub connected as ${status.login ?? "you"}`, "ok");
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function cancelTask(taskId, rerender) {
  try {
    await api(`/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
      body: {},
    });
    toast("Task cancelled", "ok");
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}

/**
 * Pausing and resuming one task, from the thread header that owns it.
 *
 * Two thin wrappers rather than one with a flag, because the two say
 * different things when they are refused: "that task is no longer running"
 * and "that task is not paused" are the two races this control has, and both
 * are ordinary — a run can finish in the moment between the render and the
 * press. The server's own message is what the toast carries.
 */
export async function pauseTask(taskId, rerender) {
  try {
    await api(`/tasks/${encodeURIComponent(taskId)}/pause`, {
      method: "POST",
      body: {},
    });
    toast("Task paused", "ok");
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function resumeTask(taskId, rerender) {
  try {
    await api(`/tasks/${encodeURIComponent(taskId)}/resume`, {
      method: "POST",
      body: {},
    });
    toast("Task resumed", "ok");
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}

export async function retryTask(taskId, rerender) {
  try {
    await api(`/tasks/${encodeURIComponent(taskId)}/retry`, {
      method: "POST",
      body: {},
    });
    toast("Task requeued", "ok");
    rerender();
  } catch (error) {
    toast(error.message, "error");
  }
}

