import assert from "node:assert/strict";
import test from "node:test";

/**
 * Settings search, exercised against the real module rather than its source.
 *
 * `screen-settings.js` is served to a browser, but it imports only the icon
 * set and touches no live state, no network and no router — which is exactly
 * what lets it be loaded here and asked real questions. The specifier is
 * built at run time so the type checker does not try to resolve an untyped
 * browser module it was never meant to see.
 */
type SearchResult = {
  row: string;
  section: string;
  sectionLabel: string;
  group: string;
  label: string;
  description: string;
  score: number;
};

type SettingsModule = {
  SETTINGS_SEARCH_INDEX: readonly {
    row: string;
    section: string;
    group: string;
    label: string;
    description: string;
    synonyms?: readonly string[];
  }[];
  searchSettings: (
    query: string,
    options?: { sections?: readonly string[] },
  ) => SearchResult[];
  settingsSearchResultRows: (
    results: readonly SearchResult[],
    activeIndex?: number,
  ) => string;
  settingsSearch: (input: {
    query?: string;
    results?: readonly SearchResult[];
    activeIndex?: number;
  }) => string;
  abbreviateCount: (value: number) => string;
  exactCountLabel: (value: number, noun?: string) => string;
};

async function settingsModule(): Promise<SettingsModule> {
  const url = new URL("../public/screen-settings.js", import.meta.url).href;
  return (await import(url)) as SettingsModule;
}

test("theme, dark and light all find General › Appearance", async () => {
  const { searchSettings } = await settingsModule();

  // The single most likely thing to be typed by somebody looking for the
  // theme control is a word that appears nowhere on the row: "dark". A search
  // over labels alone answers nothing, which is why the index carries
  // synonyms at all.
  for (const query of ["theme", "dark", "light", "Dark Mode", "night"]) {
    const top = searchSettings(query)[0];
    assert.notEqual(top, undefined, `"${query}" should find something`);
    assert.equal(top?.section, "general", `"${query}" → General`);
    assert.equal(top?.group, "Appearance", `"${query}" → Appearance`);
    assert.equal(top?.label, "Theme", `"${query}" → Theme`);
  }
});

test("search reads labels, descriptions, groups, sections and synonyms", async () => {
  const { searchSettings } = await settingsModule();

  // A label.
  assert.equal(searchSettings("protected paths")[0]?.row, "protected-paths");
  // A synonym nobody wrote on the row.
  assert.equal(searchSettings("logout")[0]?.row, "sign-out");
  assert.equal(searchSettings("stripe")[0]?.section, "billing");
  // A section name.
  assert.equal(
    searchSettings("integrations").every(
      (result) => result.section === "integrations",
    ),
    true,
  );
  // A group heading.
  assert.equal(
    searchSettings("approval policy").every(
      (result) => result.group === "Approval policy",
    ),
    true,
  );
  // Words only the supporting line carries.
  assert.equal(
    searchSettings("glob").some((result) => result.row === "protected-paths"),
    true,
  );
});

test("an exact label outranks a row that only mentions the word", async () => {
  const { searchSettings } = await settingsModule();
  const results = searchSettings("github");
  assert.equal(results[0]?.row, "github");
});

test("every term has to match, and a query nobody wrote returns nothing", async () => {
  const { searchSettings } = await settingsModule();

  assert.deepEqual(searchSettings("qwertyuiop"), []);
  assert.deepEqual(searchSettings(""), []);
  assert.deepEqual(searchSettings("   "), []);
  // Both words, not either: "theme billing" is a person asking for one thing
  // that does not exist, not for two things that do.
  assert.deepEqual(searchSettings("theme stripe"), []);
});

test("results are limited to the categories this account may open", async () => {
  const { searchSettings } = await settingsModule();
  const allowed = ["general", "agents"];
  const results = searchSettings("token", { sections: allowed });
  assert.equal(
    results.every((result) => allowed.includes(result.section)),
    true,
  );
  assert.equal(searchSettings("app tokens", { sections: allowed }).length, 0);
});

test("a result row shows the section and the setting name", async () => {
  const { searchSettings, settingsSearchResultRows } = await settingsModule();
  const results = searchSettings("theme");
  const html = settingsSearchResultRows(results, 0);

  assert.match(html, /class="st-result-path">General › Appearance</u);
  assert.match(html, /class="st-result-name">Theme</u);
  // Every result is a destination the keyboard can land on and the pointer
  // can press, and it carries both halves of where it goes.
  assert.match(html, /data-act="settings-search-go" data-value="general"/u);
  assert.match(html, /data-row="theme"/u);
  assert.match(html, /role="option" id="settings-search-option-0"/u);
  assert.match(html, /aria-selected="true"/u);
});

test("the search field is a combobox, and says when nothing matched", async () => {
  const { searchSettings, settingsSearch } = await settingsModule();

  const idle = settingsSearch({ query: "", results: [] });
  assert.match(idle, /role="combobox"/u);
  assert.match(idle, /aria-expanded="false"/u);
  assert.match(idle, /aria-label="Search settings"/u);
  // Nothing to clear when nothing has been typed.
  assert.doesNotMatch(idle, /data-act="settings-search-clear"/u);

  const found = settingsSearch({
    query: "theme",
    results: searchSettings("theme"),
    activeIndex: 0,
  });
  assert.match(found, /aria-expanded="true"/u);
  assert.match(found, /aria-activedescendant="settings-search-option-0"/u);
  assert.match(found, /data-act="settings-search-clear"/u);
  assert.match(found, /aria-live="polite"/u);

  const none = settingsSearch({ query: "qwertyuiop", results: [] });
  assert.match(none, /No settings match/u);
  assert.match(none, /No settings found/u);
});

test("large counts abbreviate while keeping their exact value", async () => {
  const { abbreviateCount, exactCountLabel } = await settingsModule();

  assert.equal(abbreviateCount(142_300_000), "142.3M");
  assert.equal(abbreviateCount(1_000), "1K");
  assert.equal(abbreviateCount(1_500), "1.5K");
  assert.equal(abbreviateCount(12_345), "12.3K");
  assert.equal(abbreviateCount(999), "999");
  assert.equal(abbreviateCount(0), "0");
  assert.equal(abbreviateCount(2_500_000_000), "2.5B");
  // Truncated, never rounded up: a recap that says 143M of something there
  // are 142.9M of has overstated it.
  assert.equal(abbreviateCount(142_990_000), "142.9M");
  assert.equal(abbreviateCount(-1_500), "-1.5K");
  assert.equal(abbreviateCount(Number.NaN), "0");

  // The exact figure is never thrown away — it is what a screen reader and a
  // tooltip are given.
  assert.equal(exactCountLabel(142_300_000, "tokens"), "142,300,000 tokens");
  assert.equal(exactCountLabel(1, "member"), "1 member");
  assert.equal(exactCountLabel(0), "0");
});

test("every indexed row names a real section and carries search words", async () => {
  const { SETTINGS_SEARCH_INDEX, searchSettings } = await settingsModule();
  const sections = new Set([
    "general",
    "agents",
    "integrations",
    "workspace",
    "billing",
    "project-controls",
  ]);
  for (const entry of SETTINGS_SEARCH_INDEX) {
    assert.equal(
      sections.has(entry.section),
      true,
      `${entry.row} names an unknown section`,
    );
    assert.notEqual(entry.group, "", `${entry.row} has no group`);
    // Its own label must find it, or nothing else stands a chance.
    assert.equal(
      searchSettings(entry.label).some((result) => result.row === entry.row),
      true,
      `${entry.row} cannot be found by its own label`,
    );
  }
});
