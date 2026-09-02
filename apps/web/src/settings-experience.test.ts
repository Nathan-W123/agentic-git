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

type SettingsSection = {
  id: string;
  label: string;
  iconName: string;
  description: string;
  adminOnly?: boolean;
};

type SettingsModule = {
  SETTINGS_GROUPS: readonly {
    id: string;
    label: string;
    sections: readonly string[];
  }[];
  settingsSidebar: (input: {
    sections: readonly SettingsSection[];
    selected: string;
  }) => string;
  settingsMobileCombobox: (input: {
    sections: readonly SettingsSection[];
    selected: string;
  }) => string;
  settingsPageHeader: (input: { title: string; description?: string }) => string;
  settingsSectionBlock: (input: {
    id: string;
    heading: string;
    description?: string;
    body?: string;
  }) => string;
  settingRow: (input: {
    row?: string;
    label: string;
    description?: string;
    control?: string;
    stacked?: boolean;
  }) => string;
  segmentedControl: (input: {
    act: string;
    label: string;
    value: string;
    options: readonly { value: string; label: string; iconName?: string }[];
  }) => string;
  switchControl: (input: {
    act: string;
    field?: string;
    label: string;
    on: boolean;
  }) => string;
  statusBadge: (
    tone: string,
    label: string,
    options?: { iconName?: string },
  ) => string;
  providerRow: (input: {
    row?: string;
    mark?: string;
    name: string;
    description?: string;
    status?: string;
    detail?: string;
    controls?: string;
  }) => string;
  skeletonRows: (count?: number) => string;
  emptyState: (input: { title: string; description?: string }) => string;
  errorState: (input: {
    title: string;
    description?: string;
    retryAct?: string;
    retryLabel?: string;
  }) => string;
  dirtySaveBar: (input: {
    message?: string;
    saveAct: string;
    discardAct: string;
    saving?: boolean;
  }) => string;
  definitionList: (
    items: readonly { term: string; value: string; mono?: boolean }[],
  ) => string;
  SETTINGS_SECTIONS: readonly SettingsSection[];
};

async function settingsModule(): Promise<SettingsModule> {
  const url = new URL("../public/screen-settings.js", import.meta.url).href;
  return (await import(url)) as SettingsModule;
}

/* ----------------------------------------------- information architecture */

test("the sidebar is Personal above Workspace", async () => {
  const { SETTINGS_GROUPS, SETTINGS_SECTIONS, settingsSidebar } =
    await settingsModule();

  assert.deepEqual(
    SETTINGS_GROUPS.find((group) => group.id === "personal")?.sections,
    ["general", "agents", "integrations"],
  );
  assert.deepEqual(
    SETTINGS_GROUPS.find((group) => group.id === "workspace")?.sections,
    ["workspace", "billing", "project-controls"],
  );

  const rail = settingsSidebar({
    sections: SETTINGS_SECTIONS.filter(
      (section) => section.id !== "deployment",
    ),
    selected: "general",
  });
  assert.match(rail, /aria-label="Settings categories"/u);
  assert.match(rail, />Personal</u);
  assert.match(rail, />Workspace</u);
  assert.match(rail, />Integrations</u);
  assert.match(rail, />Project controls</u);
  assert.doesNotMatch(rail, />Connections</u);
  assert.doesNotMatch(rail, />Advanced</u);
  // Exactly one row says it is the one you are on, and it says so in a way a
  // screen reader reads rather than only in a colour.
  assert.equal(rail.match(/aria-current="page"/gu)?.length, 1);
  assert.equal(
    rail.match(/data-act="settings-section"/gu)?.length,
    SETTINGS_SECTIONS.length - 1,
  );
});

test("the sidebar carries no account footer any more", async () => {
  const app = await publicFile("app.js");
  const styles = await publicFile("styles.css");

  // The name and the email were in the sidebar foot and again at the top of
  // General. One of them was furniture.
  assert.doesNotMatch(app, /settings-rail-account/u);
  assert.doesNotMatch(styles, /\.settings-rail-account/u);
  assert.match(app, /function profileRow\(\)/u);
  assert.match(app, /state\.principal\?\.user\?\.email/u);
});

test("the phone gets a labelled category combobox instead of the sidebar", async () => {
  const { SETTINGS_SECTIONS, settingsMobileCombobox } = await settingsModule();
  const styles = await publicFile("styles.css");

  const combobox = settingsMobileCombobox({
    sections: SETTINGS_SECTIONS,
    selected: "billing",
  });
  assert.match(combobox, /<label class="sr-only" for="settings-category"/u);
  assert.match(combobox, /id="settings-category"/u);
  assert.match(combobox, /data-act="settings-section-select"/u);
  assert.match(combobox, /<optgroup label="Personal">/u);
  assert.match(combobox, /value="billing" selected/u);

  // Below 760px the sidebar is gone and the header carries the search and the
  // combobox instead.
  assert.match(styles, /@media \(max-width: 760px\)/u);
  const phone = styles.slice(styles.indexOf("@media (max-width: 760px)"));
  assert.match(phone, /\.st-sidebar \{\s*\n\s*display: none;/u);
  assert.match(phone, /\.st-mobile-bar \{[\s\S]{0,200}position: sticky;/u);
});

test("System is not a heading somebody who has no System category reads", async () => {
  const {
    SETTINGS_GROUPS,
    SETTINGS_SECTIONS,
    settingsSidebar,
    settingsMobileCombobox,
  } = await settingsModule();

  // Deployment is the whole of the System group, so an account that may not
  // open it must not be told the group exists — an empty heading over nothing
  // is how a reader learns there is a room they are not allowed into.
  assert.deepEqual(
    SETTINGS_GROUPS.find((group) => group.id === "system")?.sections,
    ["deployment"],
  );

  const mine = SETTINGS_SECTIONS.filter(
    (section) => section.adminOnly !== true,
  );
  const rail = settingsSidebar({ sections: mine, selected: "general" });
  assert.doesNotMatch(rail, />System</u);
  assert.doesNotMatch(rail, /data-value="deployment"/u);
  assert.doesNotMatch(rail, />Deployment</u);
  // And no orphan row at the foot either: the sidebar draws anything the
  // groups forget, and a filtered-out category is not forgotten.
  assert.equal(
    rail.match(/data-act="settings-section"/gu)?.length,
    mine.length,
  );

  const combobox = settingsMobileCombobox({
    sections: mine,
    selected: "general",
  });
  assert.doesNotMatch(combobox, /<optgroup label="System">/u);
  assert.doesNotMatch(combobox, /value="deployment"/u);

  // Whoever does run the deployment still gets both.
  const admin = settingsSidebar({
    sections: SETTINGS_SECTIONS,
    selected: "deployment",
  });
  assert.match(admin, />System</u);
  assert.match(admin, /data-value="deployment"/u);
  assert.match(
    settingsMobileCombobox({
      sections: SETTINGS_SECTIONS,
      selected: "deployment",
    }),
    /<optgroup label="System">/u,
  );
});

/* ---------------------------------------------------------------- shell */

test("the shell is sized, cornered and bordered to the spec", async () => {
  const styles = await publicFile("styles.css");
  const dialog = /\n\.settings-dialog \{([\s\S]*?)\n\}/u.exec(styles)?.[1] ?? "";

  assert.match(dialog, /width: min\(960px, calc\(100vw - 32px\)\);/u);
  assert.match(dialog, /height: min\(720px, calc\(100dvh - 32px\)\);/u);
  assert.match(dialog, /grid-template-columns: 208px minmax\(0, 1fr\);/u);
  assert.match(dialog, /border-radius: var\(--settings-shell-radius\);/u);
  assert.match(dialog, /border: 1px solid var\(--settings-border\);/u);

  // The content pane scrolls on its own, under a header that stays put.
  assert.match(styles, /\.st-page-head \{[\s\S]{0,160}position: sticky;/u);
  assert.match(styles, /\.st-content\.scroll \{[\s\S]{0,120}min-height: 0;/u);
});

test("both themes define the settings grounds", async () => {
  const styles = await publicFile("styles.css");
  const dark = styles.slice(0, styles.indexOf(':root[data-theme="light"]'));
  const light = styles.slice(styles.indexOf(':root[data-theme="light"]'));

  assert.match(dark, /--settings-modal-bg: #1C1A18;/u);
  assert.match(dark, /--settings-sidebar-bg: #171613;/u);
  assert.match(dark, /--settings-surface: #22201D;/u);
  assert.match(dark, /--settings-text: #F3EFE8;/u);
  assert.match(dark, /--settings-border: rgba\(243, 239, 232, 0\.12\);/u);

  assert.match(light, /--settings-modal-bg: #FAF9F6;/u);
  assert.match(light, /--settings-sidebar-bg: #F2F0EA;/u);
  assert.match(light, /--settings-surface: #FFFFFF;/u);
  assert.match(light, /--settings-text: #1F1C19;/u);
  assert.match(light, /--settings-border: rgba\(31, 28, 25, 0\.12\);/u);

  // The radii and the smallest thing anybody has to hit.
  assert.match(dark, /--settings-shell-radius: 12px;/u);
  assert.match(dark, /--settings-control-radius: 8px;/u);
  assert.match(dark, /--settings-nav-radius: 6px;/u);
  assert.match(dark, /--settings-row-min-h: 36px;/u);
});

test("the type ramp is four sizes and no others", async () => {
  const styles = await publicFile("styles.css");
  const settings = styles.slice(styles.indexOf(".settings-layer {"));

  // Page title 20/24.
  assert.match(
    settings,
    /\.st-page-title h2 \{[\s\S]{0,120}font-size: 20px;[\s\S]{0,60}line-height: 24px;/u,
  );
  // Section heading 15/20.
  assert.match(
    settings,
    /\.st-section-title h3 \{[\s\S]{0,120}font-size: 15px;[\s\S]{0,60}line-height: 20px;/u,
  );
  // Body and controls 14/20.
  assert.match(
    settings,
    /\.st-row-label \{[\s\S]{0,120}font-size: 14px;[\s\S]{0,60}line-height: 20px;/u,
  );
  assert.match(
    settings,
    /\.st-nav-item \{[\s\S]{0,400}font-size: 14px;[\s\S]{0,60}line-height: 20px;/u,
  );
  // Supporting text never smaller than 12.5/18.
  assert.match(
    settings,
    /\.st-row-help \{[\s\S]{0,120}font-size: 12\.5px;[\s\S]{0,60}line-height: 18px;/u,
  );
  // Nothing pressable is under the minimum.
  assert.match(
    settings,
    /\.st-nav-item \{[\s\S]{0,120}min-height: var\(--settings-row-min-h\);/u,
  );
  assert.match(
    settings,
    /\.st-row \{[\s\S]{0,160}min-height: var\(--settings-row-min-h\);/u,
  );
});

test("peach fills carry dark ink, never white", async () => {
  const styles = await publicFile("styles.css");
  assert.match(
    styles,
    /\.st-segment\.is-active \{[\s\S]{0,120}background: var\(--accent\);[\s\S]{0,60}color: var\(--accent-ink\);/u,
  );
  assert.match(
    styles,
    /\.settings-dialog \.switch\.on::after \{[\s\S]{0,80}background: var\(--accent-ink\);/u,
  );
});

/* ---------------------------------------------------------- primitives */

test("a setting row is a label, a supporting line and a control", async () => {
  const { settingRow } = await settingsModule();
  const row = settingRow({
    row: "theme",
    label: "Theme",
    description: "Follow your device.",
    control: "<button>x</button>",
  });
  assert.match(row, /id="settings-row-theme"/u);
  assert.match(row, /data-settings-row="theme"/u);
  // Focusable, so a search result can land on the row rather than on the
  // first control inside it.
  assert.match(row, /tabindex="-1"/u);
  assert.match(row, /class="st-row-label" id="settings-row-theme-label">Theme</u);
  assert.match(row, /class="st-row-help">Follow your device\.</u);

  const stacked = settingRow({
    label: "Protected paths",
    control: "<textarea></textarea>",
    stacked: true,
  });
  assert.match(stacked, /class="st-row st-row-stacked"/u);
});

test("the theme control is a radiogroup with icons and labels", async () => {
  const { segmentedControl } = await settingsModule();
  const control = segmentedControl({
    act: "settings-theme",
    label: "Theme",
    value: "dark",
    options: [
      { value: "system", label: "System", iconName: "display" },
      { value: "light", label: "Light", iconName: "sun" },
      { value: "dark", label: "Dark", iconName: "moon" },
    ],
  });
  assert.match(control, /role="radiogroup" aria-label="Theme"/u);
  assert.equal(control.match(/role="radio"/gu)?.length, 3);
  assert.equal(control.match(/aria-checked="true"/gu)?.length, 1);
  // Never colour alone: each option is named as well as marked.
  assert.match(control, /<span>System<\/span>/u);
  assert.match(control, /<span>Light<\/span>/u);
  assert.match(control, /<span>Dark<\/span>/u);
  assert.match(control, /data-icon="display"/u);
  assert.match(control, /data-icon="sun"/u);
  assert.match(control, /data-icon="moon"/u);
  // Only the chosen one is in the tab order — a radio group is one stop.
  assert.equal(control.match(/tabindex="0"/gu)?.length, 1);
});

test("switches are switches, and badges say a word as well as a colour", async () => {
  const { switchControl, statusBadge } = await settingsModule();

  const on = switchControl({
    act: "policy-toggle",
    field: "approvalsEnabled",
    label: "Human approval",
    on: true,
  });
  assert.match(on, /role="switch" aria-checked="true"/u);
  assert.match(on, /aria-label="Human approval"/u);
  assert.match(on, /class="switch st-switch on"/u);
  assert.match(
    switchControl({ act: "a", label: "b", on: false }),
    /aria-checked="false"/u,
  );

  const badge = statusBadge("ok", "Connected", { iconName: "checkCircle" });
  assert.match(badge, /class="st-status st-status-ok"/u);
  assert.match(badge, /<span>Connected<\/span>/u);
  assert.match(badge, /data-icon="checkCircle"/u);
});

test("loading, empty, error and dirty states all exist and say what they are", async () => {
  const { skeletonRows, emptyState, errorState, dirtySaveBar, definitionList } =
    await settingsModule();

  const skeleton = skeletonRows(3);
  assert.equal(skeleton.match(/class="st-skeleton-row"/gu)?.length, 3);
  assert.match(skeleton, /aria-hidden="true"/u);

  const empty = emptyState({ title: "Nothing here", description: "Yet." });
  assert.match(empty, /data-settings-empty/u);
  assert.match(empty, /Nothing here/u);

  const error = errorState({
    title: "Billing could not be loaded",
    description: "Nothing has changed.",
    retryAct: "billing-retry",
  });
  assert.match(error, /role="alert"/u);
  assert.match(error, /data-act="billing-retry"/u);
  assert.match(error, />Retry</u);

  const bar = dirtySaveBar({
    saveAct: "policy-save",
    discardAct: "policy-discard",
  });
  assert.match(bar, /data-settings-dirty/u);
  assert.match(bar, /aria-live="polite"/u);
  assert.match(bar, /data-act="policy-save"/u);
  assert.match(bar, /data-act="policy-discard"/u);
  assert.match(
    dirtySaveBar({ saveAct: "a", discardAct: "b", saving: true }),
    /aria-busy="true"/u,
  );

  const list = definitionList([
    { term: "Repository", value: "LATTICE" },
    { term: "Canonical branch", value: "main", mono: true },
  ]);
  assert.match(list, /<dt>Repository<\/dt>/u);
  assert.match(list, /<dd>LATTICE<\/dd>/u);
  assert.match(list, /class="st-deflist-mono">main/u);
});

test("a provider row carries a mark, a name, a status and its controls", async () => {
  const { providerRow, statusBadge } = await settingsModule();
  const row = providerRow({
    row: "github",
    mark: "<svg></svg>",
    name: "GitHub",
    description: "Pushes authenticate as you.",
    status: statusBadge("ok", "Connected"),
    detail: "as octocat",
    controls: '<button data-act="github-disconnect">Disconnect</button>',
  });
  assert.match(row, /data-settings-row="github"/u);
  assert.match(row, /class="st-provider-name">GitHub</u);
  assert.match(row, /Pushes authenticate as you\./u);
  assert.match(row, /st-status-ok/u);
  assert.match(row, /as octocat/u);
  assert.match(row, /data-act="github-disconnect"/u);
});

/* ------------------------------------------------------------- sections */

test("General is a profile row, appearance, preferences and a session", async () => {
  const app = await publicFile("app.js");
  const general = app.slice(
    app.indexOf("function generalSection() {"),
    app.indexOf("function agentsSection() {"),
  );
  assert.match(general, /profileRow\(\)/u);
  assert.match(general, /appearanceCard\(\)/u);
  assert.match(general, /preferencesCard\(\)/u);
  assert.match(general, /sessionSection\(\)/u);

  // Sign out is its own section, not a control beside the name and email.
  assert.match(app, /heading: "Session"/u);
  assert.match(
    app,
    /function sessionSection\(\)[\s\S]{0,900}data-act="logout"/u,
  );

  // Three colours, one row, one editor — and Reset inside it.
  assert.match(app, /function profileColoursRow\(\)/u);
  assert.match(app, /label: "Profile colours"/u);
  assert.match(
    app,
    /function profileColoursRow\(\)[\s\S]{0,3000}data-act="colours-reset"/u,
  );
  assert.doesNotMatch(app, /function colourRow\(/u);

  // Sound effects stays under Preferences and says where it is kept.
  assert.match(
    app,
    /function preferencesCard\(\)[\s\S]{0,900}Saved on this device/u,
  );
  assert.match(app, /window\.localStorage\.getItem\("ag\.messageSounds"\)/u);
});

test("agents are provider rows with connect, manage and a confirmed disconnect", async () => {
  const app = await publicFile("app.js");
  const agents = app.slice(
    app.indexOf("function agentProviderRow(agent) {"),
    app.indexOf("function commitAgentRename("),
  );

  assert.match(agents, /providerRow\(\{/u);
  assert.match(agents, /data-act="agent-connect"/u);
  assert.match(agents, /data-act="agent-manage"/u);
  assert.match(agents, /aria-haspopup="menu"/u);
  // The overflow holds exactly the three things it should.
  assert.match(agents, /data-act="agent-rename-toggle"[\s\S]{0,120}Rename/u);
  assert.match(
    agents,
    /data-act="agent-check-cli"[\s\S]{0,300}Check CLI/u,
  );
  assert.match(agents, /data-act="agent-disconnect"[\s\S]{0,120}Disconnect/u);
  assert.match(agents, /st-menu-danger/u);
  // Checking says it is checking, and connecting says it is connecting.
  assert.match(agents, /checking \? "Checking…" : "Check CLI"/u);
  assert.match(agents, /Connecting…/u);
  // Four states, not two.
  assert.match(agents, /Sign-in expired/u);
  assert.match(agents, /Not connected/u);

  // Loading and empty treatments, without touching any API.
  assert.match(app, /state\.settingsAgentsLoading === true[\s\S]{0,200}skeletonRows/u);
  assert.match(app, /No agent providers on this deployment/u);
  // Disconnect is confirmed before anything is destroyed.
  assert.match(app, /function disconnectAgentConfirmed\(providerId\)/u);
  assert.match(app, /disconnectAgentConfirmed\(value\);/u);
});

test("Integrations draws GitHub as a whole row rather than a loose button", async () => {
  const app = await publicFile("app.js");
  const section = app.slice(
    app.indexOf("function integrationsSection() {"),
    app.indexOf("function invitationsCard() {"),
  );
  assert.match(section, /providerRow\(\{/u);
  assert.match(section, /name: "GitHub"/u);
  assert.match(section, /mark: icon\("github"\)/u);
  assert.match(section, /description:/u);
  assert.match(section, /statusBadge\(/u);
  // The one control the row carries is chosen from the connection state, so
  // both acts live in the same expression rather than in two branches of
  // markup that could disagree about which one a connected account gets.
  assert.match(section, /"github-disconnect" : "github-connect"/u);
  assert.match(section, /data-act="\$\{/u);
  // A deployment that offers none says so rather than showing a bare page.
  assert.match(section, /No integrations on this deployment/u);
  assert.doesNotMatch(app, /function githubCard\(\)/u);
});

test("Workspace is identity, invitations, then a restrained activity strip", async () => {
  const app = await publicFile("app.js");
  const section = app.slice(
    app.indexOf("function workspaceSection() {"),
    app.indexOf("function billingCard() {"),
  );
  // Identity first, invitations second, activity last.
  assert.equal(
    section.indexOf('id: "workspace-identity"') <
      section.indexOf("invitationsCard()"),
    true,
  );
  assert.equal(
    section.indexOf("invitationsCard()") <
      section.indexOf('id: "workspace-activity"'),
    true,
  );

  // Abbreviated for the eye, exact for everybody else.
  assert.match(app, /abbreviateCount\(figure\.value\)/u);
  assert.match(app, /exactCountLabel\(figure\.value, figure\.noun\)/u);
  assert.match(app, /class="sr-only">\$\{esc\(label\)\}/u);

  // A compact no-invitations state, not an empty card.
  assert.match(app, /No pending invitations/u);
  assert.match(app, /st-inline-empty/u);

  // One vocabulary. A room inside a workspace is a channel here, everywhere.
  assert.doesNotMatch(section, /\broom\b/u);
  assert.doesNotMatch(app, /Invitations into \$\{esc\(/u);
});

test("billing shows skeletons, retries, and cannot load forever", async () => {
  const app = await publicFile("app.js");
  const data = await publicFile("data.js");

  // No bare "Loading…" anywhere in Settings any more.
  const section = app.slice(
    app.indexOf("function billingCard() {"),
    app.indexOf("function apiTokensCard() {"),
  );
  assert.doesNotMatch(section, /Loading…/u);
  assert.match(section, /skeletonRows\(3\)/u);
  assert.match(section, /errorState\(\{/u);
  assert.match(section, /retryAct: "billing-retry"/u);
  assert.match(section, /Billing is not available here/u);

  // The request times itself out, and the status is the claim — so a
  // deployment with no billing is answered once rather than asked forever.
  assert.match(data, /export const BILLING_LOAD_TIMEOUT_MS = 10_000;/u);
  assert.match(data, /new AbortController\(\)/u);
  assert.match(
    data,
    /setTimeout\(\(\) => controller\.abort\(\), BILLING_LOAD_TIMEOUT_MS\)/u,
  );
  assert.match(data, /state\.billingStatus = "error"/u);
  assert.match(data, /state\.billingStatus = "unavailable"/u);
  assert.match(
    data,
    /export async function ensureBilling[\s\S]{0,400}if \(state\.billingStatus !== undefined\)/u,
  );
  assert.match(data, /export function resetBilling\(\)/u);
  assert.match(app, /case "billing-retry":\s*\n\s*resetBilling\(\);/u);

  // The existing actions are untouched.
  assert.match(app, /data-act="billing-portal"/u);
  assert.match(app, /data-act="billing-checkout"/u);
});

test("project controls separates repository, policy and tokens", async () => {
  const app = await publicFile("app.js");

  assert.match(
    app,
    /function projectControlsSection\(\)[\s\S]{0,700}approvalPolicySection\(\)\}\$\{apiTokensCard\(\)\}/u,
  );
  // Repository is read-only facts, as a definition list.
  assert.match(app, /function repositoryDefinitionList\(\)[\s\S]{0,600}definitionList\(\[/u);

  // Approval settings are rows with semantic switches and explicit minutes.
  const policy = app.slice(
    app.indexOf("function approvalPolicySection() {"),
    app.indexOf("function profileRow() {"),
  );
  assert.equal(policy.match(/act: "policy-toggle"/gu)?.length, 3);
  assert.match(policy, /class="st-unit" aria-hidden="true">min</u);
  assert.match(policy, /in minutes"/u);
  assert.match(policy, /stacked: true/u);
  assert.match(policy, /class="input st-textarea"/u);

  // Explicit save, only when something changed, and a confirmed discard.
  assert.match(app, /function policyDraftFrom\(policy\)/u);
  assert.match(app, /function policyDraftIsDirty\(draft, policy\)/u);
  assert.match(
    app,
    /selected === "project-controls" &&\s*\n\s*policyDraftIsDirty\(/u,
  );
  assert.match(app, /function discardPolicyDraft\(\)/u);
  assert.match(app, /async function savePolicy\(\)/u);
  // The payload shape the gateway takes is unchanged.
  assert.match(app, /policyPayload\(\{/u);
  assert.match(
    app,
    /await api\(`\/projects\/\$\{encodeURIComponent\(state\.projectId\)\}`, \{\s*\n\s*method: "PATCH",/u,
  );

  // Tokens: compact rows, a confirmed revoke, and no stored secret on screen.
  assert.match(app, /function revokeApiTokenConfirmed\(id\)/u);
  assert.match(app, /confirmDestructive\(\{/u);
  assert.match(app, /danger: true/u);
  const tokens = app.slice(
    app.indexOf("function apiTokensCard() {"),
    app.indexOf("function projectControlsSection() {"),
  );
  // Only the freshly minted secret is ever shown, and it is shown once.
  assert.match(tokens, /const minted = state\.newApiToken;/u);
  assert.doesNotMatch(tokens, /token\.secret|token\.token\b/u);
});

test("deployment is drawn only for whoever runs the deployment", async () => {
  const app = await publicFile("app.js");

  // Drawing this category is what fires the two requests behind it:
  // `deploymentCard` asks for the health of the whole control plane, and
  // `waitlistCard` for every address that ever asked for an account. So the
  // gate sits in front of the markup, not only in front of the sidebar row —
  // a stored category read back before the principal has arrived reaches the
  // render path and nothing else.
  const markup = app.slice(
    app.indexOf("function deploymentSection() {"),
    app.indexOf("function visibleSettingsSections() {"),
  );
  assert.match(
    markup,
    /case "deployment":[\s\S]{0,700}iAmSystemAdmin\(\) \? deploymentSection\(\) : generalSection\(\)/u,
  );

  // That branch is the only caller: twice in the file is the definition and
  // the guarded call, and the same for the two cards it is made of. Neither
  // can be reached without passing the gate.
  assert.equal(app.match(/\bdeploymentSection\(\)/gu)?.length, 2);
  assert.equal(app.match(/\bwaitlistCard\(\)/gu)?.length, 2);
  assert.equal(app.match(/\bdeploymentCard\(\)/gu)?.length, 2);

  // Both fetch as they render, which is the reason nothing may call them on
  // the chance that the answer will be allowed.
  assert.match(
    app,
    /function deploymentCard\(\) \{\s*\n\s*void ensureDeployment\(render\);/u,
  );
  assert.match(
    app,
    /function waitlistCard\(\)[\s\S]{0,400}void loadWaitlist\(\)/u,
  );
});

/* -------------------------------------------------------- accessibility */

test("the dialog is modal, labelled by its heading, and announces politely", async () => {
  const app = await publicFile("app.js");
  const { settingsPageHeader } = await settingsModule();

  assert.match(
    app,
    /<section class="settings-dialog" data-act="settings-dialog" role="dialog"\s*\n\s*aria-modal="true" aria-labelledby="settings-title">/u,
  );
  const header = settingsPageHeader({ title: "General", description: "x" });
  assert.match(header, /<h2 id="settings-title">General<\/h2>/u);
  assert.match(header, /aria-label="Close settings"/u);

  // Visible focus, reduced motion, and nothing that relies on colour alone.
  const styles = await publicFile("styles.css");
  assert.match(styles, /\.st-row:focus-visible,[\s\S]{0,200}outline: 2px solid var\(--accent\)/u);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]{0,400}\.settings-layer,/u,
  );
});
