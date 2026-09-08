/**
 * The menu, which nothing could check until a machine sat refusing terminals
 * while the screen told its owner to turn them on in an item their copy of
 * the app did not have.
 *
 * A menu looks like labels, which is why it went untested; it is in fact the
 * only place several of this app's settings exist at all, so an item missing
 * from it is a setting nobody can reach and a switch wired to nothing is a
 * switch that silently does not work.
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/* By URL, as the other Electron-free modules are: on Windows an absolute path
   is not a valid import specifier, and this suite runs on the Windows runner
   during a release build. */
const electronDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "electron",
);

interface Item {
  label?: string;
  role?: string;
  type?: string;
  enabled?: boolean;
  checked?: boolean;
  submenu?: Item[];
  click?: (item: { checked?: boolean }) => void;
}

interface MenuModule {
  menuTemplate: (input: {
    platform: string;
    releasesUrl: string | undefined;
    workerStatus: string;
    terminalsAllowed: boolean;
    awakeForWork: boolean;
    actions: Record<string, (...args: never[]) => void>;
  }) => Item[];
}

async function load(): Promise<MenuModule> {
  return (await import(
    pathToFileURL(path.join(electronDir, "menu.mjs")).href
  )) as unknown as MenuModule;
}

/** Every action, and a record of which ones were called with what. */
function spies() {
  const calls: Array<[string, unknown]> = [];
  const names = [
    "checkForUpdates",
    "signOutAndRestart",
    "changeServer",
    "openWorkerLog",
    "forgetAllowedMcp",
    "allowTerminals",
    "keepAwake",
  ];
  const actions: Record<string, (value?: unknown) => void> = {};
  for (const name of names) {
    actions[name] = (value?: unknown) => calls.push([name, value]);
  }
  return { calls, actions: actions as Record<string, (...a: never[]) => void> };
}

function build(
  overrides: Partial<{
    platform: string;
    releasesUrl: string | undefined;
    workerStatus: string;
    terminalsAllowed: boolean;
    awakeForWork: boolean;
  }> = {},
) {
  const { calls, actions } = spies();
  return {
    calls,
    async template(): Promise<Item[]> {
      const { menuTemplate } = await load();
      return menuTemplate({
        platform: "darwin",
        releasesUrl: "https://github.com/example/releases",
        workerStatus: "Running agents on this machine",
        terminalsAllowed: true,
        awakeForWork: false,
        ...overrides,
        actions,
      });
    },
  };
}

function submenu(template: Item[], label: string): Item[] {
  const found = template.find((entry) => entry.label === label);
  assert.ok(found !== undefined, `no ${label} menu`);
  return found.submenu ?? [];
}

function item(items: Item[], label: string): Item {
  const found = items.find((entry) => entry.label === label);
  assert.ok(found !== undefined, `no "${label}" item`);
  return found;
}

test("the machine's own settings are all in the Agents menu, and all wired", async () => {
  const harness = build();
  const agents = submenu(await harness.template(), "Agents");

  // The one this exists for. Absent, a machine refuses terminals and the only
  // instruction anybody can be given points at nothing.
  const terminals = item(agents, "Allow Terminals on This Machine");
  assert.equal(terminals.type, "checkbox");
  assert.equal(terminals.checked, true);

  item(agents, "Open Worker Log");
  item(agents, "Forget Allowed MCP Servers…");
  item(agents, "Don't Sleep While Idle (plugged in, lid open)");

  // The status line is the one entry that is deliberately dead: it is a fact,
  // not an offer.
  const status = item(agents, "Running agents on this machine");
  assert.equal(status.enabled, false);
  assert.equal(status.click, undefined);

  // Everything else does something. A labelled item with no handler is a
  // setting that looks available and silently is not.
  for (const entry of agents) {
    if (entry.type === "separator" || entry.enabled === false) {
      continue;
    }
    assert.equal(typeof entry.click, "function", entry.label);
  }
});

test("a checkbox passes on the state it was left in, not the one it had", async () => {
  const harness = build({ terminalsAllowed: true, awakeForWork: false });
  const agents = submenu(await harness.template(), "Agents");

  // Electron hands the handler the item *after* the click, so its `checked`
  // is the new value. A handler that read the captured flag instead would
  // write back the state that was already there and the switch would never
  // move.
  item(agents, "Allow Terminals on This Machine").click?.({ checked: false });
  item(agents, "Don't Sleep While Idle (plugged in, lid open)").click?.({
    checked: true,
  });
  assert.deepEqual(harness.calls, [
    ["allowTerminals", false],
    ["keepAwake", true],
  ]);
});

test("a machine that has turned terminals off is drawn as off", async () => {
  const harness = build({ terminalsAllowed: false });
  const agents = submenu(await harness.template(), "Agents");
  assert.equal(item(agents, "Allow Terminals on This Machine").checked, false);
});

test("the way out of a token this deployment will not take is in the Help menu", async () => {
  const harness = build();
  const template = await harness.template();
  const help = template.find((entry) => entry.role === "help")?.submenu ?? [];

  // The only way to recover an app whose credential was revoked, or which is
  // pointed at a deployment that has moved. Both are states the app cannot
  // fix by itself and neither is reachable from anywhere else.
  item(help, "Sign Out and Restart").click?.({});
  item(help, "Change Server…").click?.({});
  item(help, "Check for Updates…").click?.({});
  // These take the menu item Electron hands every handler and ignore it —
  // they are not switches — so the name is what is being checked, and each
  // one exactly once.
  assert.deepEqual(
    harness.calls.map(([name]) => name),
    ["signOutAndRestart", "changeServer", "checkForUpdates"],
  );

  // A build with nowhere to point people offers no link rather than a broken
  // one.
  const bare = build({ releasesUrl: undefined });
  const without = (await bare.template()).find((entry) => entry.role === "help");
  assert.equal(
    (without?.submenu ?? []).some(
      (entry) => entry.label === "Check for Updates…",
    ),
    false,
  );
});

test("the page keeps its copy, paste and reload on either platform", async () => {
  // Edit and View are not decoration here: the window shows a remote
  // document, and without these there is no copy, no paste, and no way to
  // reload it when the deployment redeploys under it.
  for (const platform of ["darwin", "win32", "linux"]) {
    const template = await build({ platform }).template();
    const roles = template.map((entry) => entry.role);
    assert.ok(roles.includes("editMenu"), platform);
    assert.ok(roles.includes("viewMenu"), platform);
    // And a way to quit that is where that platform keeps it.
    if (platform === "darwin") {
      assert.equal(template[0]?.role, "appMenu");
    } else {
      assert.equal(template[0]?.label, "File");
      assert.deepEqual(template[0]?.submenu, [{ role: "quit" }]);
    }
  }
});
