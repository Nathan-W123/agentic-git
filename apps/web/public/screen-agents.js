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
  createLocalAgent,
  connectGitHub,
  forgetAgentInLoadedRosters,
  connectProviderCredential,
  gitHubSignInStatus,
  loadGitHub,
  loadProviders,
  myAgents,
  providerSignInStatus,
  startGitHubSignIn,
  startProviderSignIn,
  state,
  submitProviderSignInCode,
} from "./data.js";
import {
  agentLabelOf,
  esc,
  showModal,
  toast,
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
export async function startAddAgentFlow(rerender) {
  try {
    if (!state.providersLoaded) {
      await loadProviders();
    }
  } catch (error) {
    toast(`Could not load available agents — ${error.message}`, "error");
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
  await connectAgent(providerId, rerender);
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
      <code>${esc(plan.signIn)}</code>. Follow its sign-in, then come back —
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
 * One sign-in: the CLI's own, which is the one that decides whether anything
 * works. The agent record is created first so it exists even if somebody
 * closes the installer — an agent that is there and grey is honest, and the
 * prompt on its first mention will offer the same setup again.
 */
async function connectLocalAgent(providerId, rerender) {
  state.providerConnecting?.add(providerId);
  rerender();
  let agent;
  try {
    agent = await createLocalAgent(providerId);
  } catch (error) {
    toast(
      `Could not create the ${agentLabelOf(providerId)} agent — ${error.message}`,
      "error",
    );
    return false;
  } finally {
    state.providerConnecting?.delete(providerId);
  }
  await loadProviders();
  const failedRepositories = await addAgentToAllRepositories(providerId);
  toast(
    failedRepositories.length === 0
      ? `${agent?.callSign ?? agentLabelOf(providerId)} is yours`
      : `${agentLabelOf(providerId)} connected, but could not be added to every repository`,
    failedRepositories.length === 0 ? "ok" : "error",
  );
  rerender();
  await finishLocalSetup(providerId, rerender);
  return true;
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
      ${esc(label)} account is untouched — you can connect it again whenever
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
    toast(`Could not disconnect ${label} — ${error.message}`, "error");
    return false;
  }
  forgetAgentInLoadedRosters(providerId);
  await loadProviders();
  toast(`${name} disconnected`, "ok");
  rerender();
  return true;
}

/**
 * The vendor CLI behind each provider account.
 *
 * A provider is the account somebody signs into; a vendor is the program that
 * runs on their machine. They are named differently by their own owners —
 * "anthropic" issues the credential, `claude` does the work — and the desktop
 * installs by the second. Mirrors `PROVIDER_TO_VENDOR` on the server, which is
 * what the roster's own setup hints are keyed by.
 */
const PROVIDER_VENDOR = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
  cursor: "cursor",
  copilot: "copilot",
  kiro: "kiro",
};

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
        ? "Open the Kumi app on the machine that runs this agent — a browser " +
            "cannot see what is installed there."
        : "This copy of the Kumi app is too old to install or check a CLI. " +
            "Download the latest version and open it again — your agents and " +
            "their names are kept.",
      "error",
    );
    return;
  }
  await finishLocalSetup(providerId, rerender);
}

async function finishLocalSetup(providerId, rerender) {
  const bridge = window.KUMI_INSTALL;
  if (bridge === undefined) {
    return;
  }
  const vendor = PROVIDER_VENDOR[providerId];
  if (vendor === undefined) {
    return;
  }
  const detected = await bridge.detected().catch(() => undefined);
  if (detected === undefined) {
    return;
  }
  if (!detected.includes(vendor)) {
    // Nothing here can run it. `installVendorCli` shows what it will run,
    // runs it, and opens the sign-in afterwards — the whole remaining setup,
    // in the place somebody is already standing.
    await installVendorCli(vendor, rerender);
    return;
  }
  // Installed, but nothing here can tell whether it is signed in — that lives
  // inside the vendor's own config and reading it would be guessing at a
  // format none of them promise. So it is offered rather than assumed, which
  // is honest and costs one dismissed dialog for somebody already set up.
  const now = await showModal({
    title: `${agentLabelOf(providerId)} is installed on this machine`,
    subtitle:
      "One last thing: Kumi runs it under this machine's own login, so it " +
      "has to be signed in here too.",
    body: `<p class="modal-hint">Opens a terminal running the CLI. If it is
      already signed in, close the window — nothing else to do.</p>`,
    confirm: "Check the sign-in",
    cancel: "Already done",
  });
  if (now !== undefined) {
    await bridge.signIn(vendor).catch(() => false);
  }
}

async function signInAgent(providerId, mode, rerender, intent) {
  // On a deployment that runs agents locally, the vendor sign-in below buys
  // nothing the agent needs. It stores a credential this server then never
  // reads — the CLI runs under the machine's own login — so somebody signed in
  // twice and only the second one made anything work. Worse, the first was
  // what created the agent at all, which is why "reconnect from Settings →
  // Agents" was offered as the fix for a CLI that was not signed in, and could
  // never have helped.
  //
  // So the agent is created outright and setup finishes on the machine. The
  // credential becomes an optional extra, for the usage figures and for a
  // deployment that has server-side execution switched on.
  if (state.localAgentsOnly === true && intent !== "link-account") {
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
    toast(`${agentLabelOf(providerId)} sign-in unavailable — ${error.message}`, "error");
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
     — it opens in a new tab, on your own account.</p>`;
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

/**
 * Attaches a vendor account to an agent that already exists.
 *
 * The credential is no longer what makes an agent — that is the record the
 * connect flow writes — but it is still what the usage figures on the agent
 * card read, and what a deployment with server-side execution switched on
 * needs. So it stays available, as the extra it actually is rather than as
 * the gate somebody has to pass before finding out whether their CLI works.
 */
export async function linkAgentAccount(providerId, rerender) {
  const entry = (state.providers ?? []).find((item) => item.id === providerId);
  const signInFlow = entry?.signInFlow;
  if (signInFlow === undefined) {
    toast(
      `${agentLabelOf(providerId)} has no browser sign-in to link.`,
      "error",
    );
    return;
  }
  // Asked before a tab opens, because of what this row looks like to somebody
  // who wants their agent back.
  //
  // A connected agent has no Connect button — it is connected — so the row
  // reads Rename, Link for usage, Disconnect. Somebody who has just
  // disconnected an agent and wants it working again presses the only one of
  // those that sounds like connecting, and lands on the vendor's sign-in page:
  // exactly the second sign-in this release exists to remove, reached by the
  // one button on the row that still leads there. It happened to the first
  // person who tried it.
  //
  // So the dialog says what the button cannot fit: that the agent already
  // works, and what linking actually buys. The name, because the row is about
  // an agent somebody knows by name rather than about a vendor.
  const agent = myAgents().find((item) => item.id === providerId);
  const name = agent?.hasName === true ? agent.name : agentLabelOf(providerId);
  const label = agentLabelOf(providerId);
  const proceed = await showModal({
    title: `Link your ${esc(label)} account?`,
    subtitle:
      `This is optional. ${name} already works — it runs on this machine ` +
      "under the login the CLI there already has.",
    body: `<p class="modal-hint">Linking signs you in to ${esc(label)} in a new
      tab and stores that account, which is what lets Kumi show how much of
      your quota is left. It does not change how ${esc(name)} runs.</p>`,
    confirm: "Sign in to link",
    cancel: "Not now",
  });
  if (proceed === undefined) {
    return;
  }
  // The browser may refuse the tab now that the original click is over — the
  // sign-in flow already handles that, opening the address from the dialog it
  // shows instead. A blocked tab on an optional extra is a far better trade
  // than sending somebody to a vendor sign-in they never asked for.
  //
  // `link-account` rather than the flow's own mode, so `signInAgent` knows not
  // to take the local shortcut it takes for an ordinary connect.
  await signInAgent(providerId, signInFlow, rerender, "link-account");
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
          taking too long — starting it again is normally all it needs.${
            pasteable
              ? " If the message above says this account is not eligible, " +
                "signing in again will not help — connect a credential instead."
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
          <option value="personal" selected>Personal — only you can task it</option>
          <option value="org">Org-wide — anyone with access to a repository
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
        who may @mention this agent to submit work — the credential itself is
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
    toast(`GitHub sign-in unavailable — ${error.message}`, "error");
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
        the GitHub sign-in page</a> — it opens in a new tab.</p>
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
          closed or the code expiring — starting again is normally all it
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

