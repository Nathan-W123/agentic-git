/**
 * The application menu, as a value rather than as a side effect.
 *
 * Every other risky piece of this app was pulled out of Electron so it could
 * be tested — the sign-in loopback, the MCP allowlist, the terminal consent —
 * and the menu was not, on the grounds that a menu is just labels. It is not:
 * it is the only place several settings exist at all, and an item that is
 * missing from it is a setting nobody can reach. That is exactly what
 * happened — a machine sat refusing terminals while the screen told its owner
 * to turn them on in a menu their copy of the app did not have — and nothing
 * in the suite could have said so, because nothing here was checkable.
 *
 * So this holds no Electron and takes its handlers as arguments. `role`
 * entries are passed through verbatim: they are Electron's own, and naming
 * them is the whole of what they are.
 */

/**
 * @param {{
 *   platform: string,
 *   releasesUrl: string | undefined,
 *   workerStatus: string,
 *   terminalsAllowed: boolean,
 *   awakeForWork: boolean,
 *   actions: {
 *     checkForUpdates: () => void,
 *     signOutAndRestart: () => void,
 *     changeServer: () => void,
 *     openWorkerLog: () => void,
 *     forgetAllowedMcp: () => void,
 *     allowTerminals: (checked: boolean) => void,
 *     keepAwake: (checked: boolean) => void,
 *   },
 * }} input
 */
export function menuTemplate(input) {
  const { actions } = input;
  const help = [];
  if (input.releasesUrl !== undefined) {
    // Deliberately a link rather than an update that installs itself. These
    // builds are unsigned, and an unsigned app replacing its own binary is
    // something the operating system is right to refuse; pointing at the
    // downloads is honest about what is actually on offer.
    help.push({ label: "Check for Updates…", click: actions.checkForUpdates });
    help.push({ type: "separator" });
  }
  help.push(
    { label: "Sign Out and Restart", click: actions.signOutAndRestart },
    { label: "Change Server…", click: actions.changeServer },
  );

  // Where a person volunteers this machine. Checkable rather than a dialog,
  // because the honest state is binary and they should be able to see which
  // one they are in without opening anything.
  const agents = [
    {
      // Shown, not offered. Whether agents run here is not a setting — but
      // whether they *are* running is a fact somebody needs, because the
      // reasons it can fail (no CLI signed in on this machine, an expired
      // credential) are all things only they can fix.
      label: input.workerStatus,
      enabled: false,
    },
    {
      // The rest of what that one line came from. A machine running agents
      // has no terminal open, so without this the worker's account of a task
      // — which phase took the time, what a CLI said before it gave up —
      // exists only until the next line replaces it.
      label: "Open Worker Log",
      click: actions.openWorkerLog,
    },
    {
      // The other half of the question the app asks when a project offers
      // its agents a tool. A yes that could only be taken back by editing a
      // JSON file would be a yes kept forever.
      label: "Forget Allowed MCP Servers…",
      click: actions.forgetAllowedMcp,
    },
    { type: "separator" },
    {
      // On unless somebody says otherwise, and here rather than behind a
      // prompt on first use. Nothing here can open a shell on another
      // person's machine, so the only party to this consent is whoever
      // installed the app and signed it in — asking them again would be
      // asking them to agree to what they already did.
      label: "Allow Terminals on This Machine",
      type: "checkbox",
      checked: input.terminalsAllowed,
      click: (item) => actions.allowTerminals(item.checked),
    },
    { type: "separator" },
    {
      // Named for what it actually does. The platform call underneath is
      // `SetThreadExecutionState`, and Microsoft is explicit that it "cannot
      // be used to prevent the user from putting the computer to sleep" — a
      // closed lid, the power button and Start > Sleep all go straight past
      // it. It stops the machine idling out, and nothing more, so the label
      // says idle rather than implying a promise it cannot keep.
      label: "Don't Sleep While Idle (plugged in, lid open)",
      type: "checkbox",
      checked: input.awakeForWork,
      click: (item) => actions.keepAwake(item.checked),
    },
  ];

  return [
    ...(input.platform === "darwin"
      ? [{ role: "appMenu" }]
      : [{ label: "File", submenu: [{ role: "quit" }] }]),
    // Edit and View are not decoration: the page is a remote document, and
    // without these there is no copy, no paste, and no way to reload it.
    { role: "editMenu" },
    { role: "viewMenu" },
    { label: "Agents", submenu: agents },
    { role: "windowMenu" },
    { role: "help", submenu: help },
  ];
}
