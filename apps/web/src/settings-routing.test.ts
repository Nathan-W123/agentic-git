import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function publicFile(name: string): Promise<string> {
  return await readFile(path.join(packageRoot, "public", name), "utf8");
}

type SettingsModule = {
  SETTINGS_SECTIONS: readonly { id: string; adminOnly?: boolean }[];
  SETTINGS_SECTION_ALIASES: Record<string, string>;
  normalizeSettingsSection: (
    value: unknown,
    allowed?: readonly string[],
  ) => string;
  settingsSectionFromHash: (hash: string) => string | undefined;
};

async function settingsModule(): Promise<SettingsModule> {
  const url = new URL("../public/screen-settings.js", import.meta.url).href;
  return (await import(url)) as SettingsModule;
}

test("the six categories are the ones the type names", async () => {
  const { SETTINGS_SECTIONS } = await settingsModule();
  const ids = SETTINGS_SECTIONS.filter(
    (section) => section.adminOnly !== true,
  ).map((section) => section.id);
  assert.deepEqual(ids, [
    "general",
    "agents",
    "integrations",
    "workspace",
    "billing",
    "project-controls",
  ]);
  // Deployment is still here, and still only for whoever runs the control
  // plane.
  assert.equal(
    SETTINGS_SECTIONS.some(
      (section) => section.id === "deployment" && section.adminOnly === true,
    ),
    true,
  );
});

test("the old category ids still name the categories they meant", async () => {
  const { normalizeSettingsSection, SETTINGS_SECTION_ALIASES } =
    await settingsModule();

  assert.equal(SETTINGS_SECTION_ALIASES["connections"], "integrations");
  assert.equal(SETTINGS_SECTION_ALIASES["advanced"], "project-controls");
  assert.equal(normalizeSettingsSection("connections"), "integrations");
  assert.equal(normalizeSettingsSection("advanced"), "project-controls");
  assert.equal(normalizeSettingsSection("ADVANCED"), "project-controls");
  assert.equal(normalizeSettingsSection(" advanced "), "project-controls");

  // Anything that names no category at all lands on the first one rather than
  // on a blank pane.
  assert.equal(normalizeSettingsSection("nonsense"), "general");
  assert.equal(normalizeSettingsSection(undefined), "general");
  assert.equal(normalizeSettingsSection(""), "general");

  // A category this account may not open is not opened by naming it.
  assert.equal(
    normalizeSettingsSection("deployment", ["general", "agents"]),
    "general",
  );
  assert.equal(
    normalizeSettingsSection("agents", ["general", "agents"]),
    "agents",
  );
});

test("settings rides alongside the chat route rather than replacing it", async () => {
  const { settingsSectionFromHash } = await settingsModule();

  const chat = "#chats/LATTICE/main?channel=subchan_33e89208";
  assert.equal(settingsSectionFromHash(chat), undefined);
  assert.equal(settingsSectionFromHash(`${chat}&settings=general`), "general");
  assert.equal(settingsSectionFromHash(`${chat}&settings=billing`), "billing");
  // Aliases resolve wherever they are written.
  assert.equal(
    settingsSectionFromHash(`${chat}&settings=connections`),
    "integrations",
  );
  assert.equal(
    settingsSectionFromHash(`${chat}&settings=advanced`),
    "project-controls",
  );
  // An empty value asks for nothing rather than for General.
  assert.equal(settingsSectionFromHash(`${chat}&settings=`), undefined);

  // The two bare legacy hashes were Settings itself.
  assert.equal(settingsSectionFromHash("#settings"), "general");
  assert.equal(settingsSectionFromHash("#advanced"), "project-controls");
  assert.equal(settingsSectionFromHash("#chats"), undefined);
  assert.equal(settingsSectionFromHash(""), undefined);
});

test("opening pushes one entry and moving between categories pushes none", async () => {
  const app = await publicFile("app.js");

  // One history entry for the whole visit: opening pushes, every category
  // change after it replaces. Back from anywhere inside Settings therefore
  // lands on the conversation rather than walking back through six
  // categories nobody navigated to.
  assert.match(
    app,
    /function openSettings\([\s\S]{0,900}writeSettingsLocation\(state\.settingsSection, \{ replace: already \}\)/u,
  );
  assert.match(
    app,
    /function selectSettingsSection\([\s\S]{0,400}writeSettingsLocation\(state\.settingsSection, \{ replace: true \}\)/u,
  );
  assert.match(
    app,
    /function writeSettingsLocation\([\s\S]{0,1200}window\.history\.pushState/u,
  );
  assert.match(
    app,
    /function writeSettingsLocation\([\s\S]{0,1200}window\.history\.replaceState/u,
  );
});

test("closing removes only the settings value", async () => {
  const app = await publicFile("app.js");

  // The value comes out of the query string; every other parameter — the
  // channel, the secondary context — is left exactly as it was.
  assert.match(
    app,
    /if \(section === undefined\) \{\s*\n\s*params\.delete\("settings"\);/u,
  );
  assert.match(app, /params\.set\("settings", section\)/u);
  // Closing gives back the entry opening added, so Back and Close do the same
  // thing to the URL.
  assert.match(
    app,
    /function closeSettings\([\s\S]{0,1200}window\.history\.back\(\)/u,
  );
  assert.match(
    app,
    /function closeSettings\([\s\S]{0,1400}writeSettingsLocation\(undefined\)/u,
  );
  // The two bare legacy hashes are not routes to come back to.
  assert.match(
    app,
    /path === "" \|\| path === "settings" \|\| path === "advanced"/u,
  );
});

test("a settings-only hash change leaves the conversation alone", async () => {
  const app = await publicFile("app.js");

  // Back out of Settings must not rebuild the channel underneath it: that
  // throws away the reader's place in a transcript for a dialog closing over
  // the top of it.
  assert.match(
    app,
    /const settingsSection = settingsSectionFromHash\(\);/u,
  );
  assert.match(
    app,
    /state\.chatHashApplied === window\.location\.hash\.split\("\?"\)\[0\][\s\S]{0,200}applySettingsSection\(settingsSection\)/u,
  );
  // And the route branch no longer slams Settings shut on every hash change;
  // it applies whatever the URL says.
  assert.doesNotMatch(
    app,
    /state\.settingsSection = route === "advanced" \? "advanced" : "general"/u,
  );
  assert.match(app, /function applySettingsSection\(section\)/u);
});

test("escape stands down while an explicit-save form is dirty", async () => {
  const app = await publicFile("app.js");

  assert.match(app, /closeSettings\(\{ viaEscape: true \}\)/u);
  assert.match(
    app,
    /if \(dirty && viaEscape\) \{[\s\S]{0,200}return;/u,
  );
  // Anything else that closes asks first.
  assert.match(app, /if \(!confirmDiscardSettings\(\)\) \{\s*\n\s*return;/u);
  assert.match(app, /function confirmDiscardSettings\(\)/u);
});

test("focus is taken by search and given back to the trigger", async () => {
  const app = await publicFile("app.js");

  assert.match(
    app,
    /function openSettings\([\s\S]{0,1600}document\.querySelector\("\[data-act='settings-search-input'\]"\)\?\.focus\(\)/u,
  );
  assert.match(app, /function restoreFocusToProfileTrigger\(\)/u);
  assert.match(app, /state\.settingsReturnFocus/u);
  assert.match(app, /function trapSettingsFocus\(event\)/u);
  assert.match(app, /document\.addEventListener\("keydown", trapSettingsFocus\)/u);
  // The background is inert while the dialog is modal.
  assert.match(app, /state\.settingsOpen === true \? " inert" : ""/u);
});
