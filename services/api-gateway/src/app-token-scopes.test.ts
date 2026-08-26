import assert from "node:assert/strict";
import test from "node:test";

import { ALL_PERMISSIONS } from "./authorization.js";
import { APP_TOKEN_SCOPES } from "./server.js";

/**
 * What a desktop app may do, checked against everything there is to do.
 *
 * This grant was wrong three times, and each time the same way: a permission
 * nobody thought about stayed off the list, and the wall was found by somebody
 * clicking a button in production. First pushing to GitHub, then answering a
 * question, then deleting a channel.
 *
 * The shape of the mistake is what matters. A list of what to *include* fails
 * silently the moment a permission exists that nobody considered — the app
 * simply cannot do it, and nothing says so until a person tries. So the list
 * is checked against the whole surface instead: every permission must be
 * either granted or deliberately withheld, and adding a ninth fails here until
 * somebody decides which it is.
 */

/**
 * The two the app is not trusted with, and the reason they are the only two.
 *
 * Both decide who may use this Kumi at all. Everything else is work — and a
 * token that cannot do the work is not a smaller risk, it is a broken app.
 */
const WITHHELD = ["manage_members", "manage_organization"] as const;

test("every permission is either granted to an app or deliberately withheld", () => {
  const granted = new Set<string>(APP_TOKEN_SCOPES);
  const withheld = new Set<string>(WITHHELD);
  const unclassified = ALL_PERMISSIONS.filter(
    (permission) => !granted.has(permission) && !withheld.has(permission),
  );
  assert.deepEqual(
    unclassified,
    [],
    `these permissions exist but nobody decided whether a desktop app may ` +
      `have them: ${unclassified.join(", ")}. Add each to APP_TOKEN_SCOPES ` +
      `or to WITHHELD in this test.`,
  );
});

test("nothing is both granted and withheld", () => {
  const granted = new Set<string>(APP_TOKEN_SCOPES);
  const both = WITHHELD.filter((permission) => granted.has(permission));
  assert.deepEqual(both, [], `granted and withheld at once: ${both.join(", ")}`);
});

test("the two withheld permissions are the ones that govern access", () => {
  // Stated as a test so that quietly withholding a third — which is how the
  // last three walls were built — has to be a deliberate edit here.
  assert.deepEqual([...WITHHELD], ["manage_members", "manage_organization"]);
});

test("an app can do the work its owner does", () => {
  // The specific ones that were missing, named so a narrowing regression
  // reports which capability it took away rather than a set difference.
  for (const permission of [
    "view",
    "submit_task",
    "run_task",
    "import_repository",
    "review",
    "manage_project",
  ]) {
    assert.ok(
      (APP_TOKEN_SCOPES as readonly string[]).includes(permission),
      `an app cannot work without ${permission}`,
    );
  }
});
