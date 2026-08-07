/**
 * The development / held-out split for intent-signal work, registered before
 * the signal it evaluates was written.
 *
 * The previous round of this work was rejected for validating a signal on the
 * same data it was tuned on, so the split has to be fixed in advance and the
 * rule has to be mechanical — a split chosen after seeing which pairs the
 * model gets right is not a split.
 *
 * ## Why split by agent rather than by run
 *
 * The obvious split is by run: tune on one team-queue run, test on another.
 * It is not a split at all. All three runs execute the same ten scenario
 * tasks, so the same ten objectives and near-identical agent phrasings appear
 * on both sides — a lexical signal tuned on `task_handling_fee` in run A is
 * being tested on `task_handling_fee` in run B. Runs vary the sample, not the
 * population.
 *
 * The scenario assigns five agent ids two tasks each, deliberately spread so
 * that "no single agent owns a whole band". That makes agent id a grouping
 * variable that cuts across the bands rather than along them, which is exactly
 * what a group split needs: holding out an agent holds out its tasks' intent
 * prose entirely, in every run, while leaving both labels represented on both
 * sides.
 *
 * ## The rule
 *
 * Development: `codex-a`, `codex-b`, `codex-c` — the first three agent ids in
 * the order the scenario declares them. Held out: `codex-d`, `codex-e`.
 *
 * A pair belongs to the held-out set when *either* task is owned by a
 * held-out agent. A pair with one development task and one held-out task is
 * held out, not development: the point is that no held-out intent string is
 * ever seen during tuning, and a mixed pair would show one.
 *
 * That gives, per run, 15 development pairs (6 positive) and 30 held-out
 * pairs (6 positive). Six positives is a small denominator and every number
 * computed on it should be read with that in mind; it is, however, six real
 * agent-written intent strings against a label registered before any run
 * happened, which is the property that was missing.
 *
 * ## What is not in either set
 *
 * `docs/benchmarks/data/grounding/*replan-substitution*` holds 44 real agent
 * intents for `task_checkout_fee`, one per sample. Every pairing of two of
 * them is the same task against itself, so the set carries no negatives and
 * cannot measure precision. It is used only as a recall floor: a signal that
 * cannot recognise forty phrasings of one task as the same work is not worth
 * measuring further. It is held out too — nothing here is tuned on it.
 */

/**
 * The seed tree the recorded runs were executed against.
 *
 * Intent grounding scores a sentence against a repository index, so the tree
 * is an input to the measurement exactly as much as the prose is. The recorded
 * intents were written by agents looking at *this* tree; grounding them
 * against a later one would be scoring sentences against a repository their
 * authors never saw, and it would do so silently, because the evaluation
 * scripts rebuild the index from `TEAM_QUEUE_SCENARIO.seed` on every run.
 *
 * This is a live hazard rather than a hypothetical. The scenario's partial
 * band is documented as tasks that "each own a different pricing module that
 * `total.js` imports", which is true of `discount.js` and `tax.js` and false
 * of `src/format/money.js` — nothing imports it. That inconsistency is a real
 * reason to want to change the seed, and changing it must invalidate these
 * numbers rather than quietly improve them.
 *
 * So the fingerprint is pinned. Edit the seed and every recorded evaluation
 * fails loudly until someone decides, in the open, what the old numbers now
 * mean.
 */
export const REGISTERED_SEED_SHA256 =
  "aa97bae419e9dd0b909c7cbdd8a545df43857d7a1715524dac78a5e1fd41d314";

/** The fingerprint of a scenario seed, as {@link REGISTERED_SEED_SHA256}. */
export function seedFingerprint(seed, createHash) {
  const hash = createHash("sha256");
  for (const [file, contents] of Object.entries(seed).sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    hash.update(`path:${file}\nbytes:${contents.length}\n${contents}\n--\n`);
  }
  return hash.digest("hex");
}

/** Throws unless the seed is the one the recorded runs were executed against. */
export function assertRegisteredSeed(seed, createHash) {
  const actual = seedFingerprint(seed, createHash);
  if (actual !== REGISTERED_SEED_SHA256) {
    throw new Error(
      "the team-queue seed has changed since these runs were recorded\n" +
        `  registered ${REGISTERED_SEED_SHA256}\n` +
        `  current    ${actual}\n` +
        "The recorded intents were written against the registered tree. " +
        "Grounding them\nagainst this one scores sentences against a " +
        "repository their authors never saw.\nRecord fresh runs against the " +
        "new seed, or evaluate at the old revision — do not\nre-score the old " +
        "corpus and report the result as a correction.",
    );
  }
}

/** Agent ids whose tasks may be used for development. */
export const DEVELOPMENT_AGENTS = new Set(["codex-a", "codex-b", "codex-c"]);

/** Agent ids whose tasks are held out and read exactly once, at the end. */
export const HELD_OUT_AGENTS = new Set(["codex-d", "codex-e"]);

/**
 * Task ownership, restated here rather than imported.
 *
 * The split has to stay fixed even if the scenario is edited later, so the
 * assignment it was registered against is written down literally. A
 * consistency check against the live scenario is in `intent-signal-report.mjs`
 * and fails loudly rather than silently re-splitting.
 */
export const TASK_AGENTS = {
  task_handling_fee: "codex-a",
  task_free_delivery: "codex-b",
  task_card_surcharge: "codex-c",
  task_loyalty_tier: "codex-d",
  task_zero_rated_goods: "codex-e",
  task_rounding: "codex-a",
  task_webhook_retry: "codex-b",
  task_audit_ip: "codex-c",
  task_export_created_at: "codex-d",
  task_search_email: "codex-e",
};

/** Which side of the split a pair of scenario task ids falls on. */
export function splitOf(leftTaskId, rightTaskId) {
  const held =
    HELD_OUT_AGENTS.has(TASK_AGENTS[leftTaskId]) ||
    HELD_OUT_AGENTS.has(TASK_AGENTS[rightTaskId]);
  return held ? "held-out" : "development";
}

/**
 * A second split, registered 2026-08-06, because the first one cannot measure
 * observed contention at all.
 *
 * ## The defect in the original split
 *
 * The original rule holds out `codex-d` and `codex-e`. The deep band —
 * `task_handling_fee`, `task_free_delivery`, `task_card_surcharge` — is owned
 * by `codex-a`, `codex-b` and `codex-c`, which is *exactly* the development
 * half. Every collision that actually happens in this scenario is deep against
 * deep, because all three deep tasks edit `src/pricing/total.js`. A held-out
 * pair needs `codex-d` or `codex-e`, so the held-out half contains **no**
 * observed-contending pair, and precision against observed truth is 0% there
 * whatever the signal does. Ten live runs of `team-queue-wired` confirmed it:
 * `pos=0` on all 270 held-out pairs.
 *
 * The original rule was written to satisfy "no single agent owns a whole
 * band". It does. That turns out to be the weaker of the two properties a
 * group split needs — the one that matters is that **every band is
 * represented on both sides**, and grouping by agent alone does not give it.
 *
 * ## The rule
 *
 * For each band, hold out the alphabetically last agent owning a task in it:
 *
 * - deep (`codex-a`, `codex-b`, `codex-c`) -> `codex-c`
 * - partial (`codex-a`, `codex-d`, `codex-e`) -> `codex-e`
 * - independent (`codex-b`, `codex-c`, `codex-d`, `codex-e`) -> `codex-e`
 *
 * giving held-out `codex-c`, `codex-e` and development `codex-a`, `codex-b`,
 * `codex-d`. The rule is mechanical and stated before it was scored, which is
 * the property that makes it a split rather than a choice. It is *not* chosen
 * because it makes any number better.
 *
 * The result keeps the same 30/15 pair shape as the original, and puts
 * positives of both kinds on both sides: 4 designed positives held out and 2
 * in development, 2 observed-contending pairs held out and 1 in development.
 *
 * ## What it is not yet good for
 *
 * **The frozen thresholds were tuned on the original development half, which
 * included `codex-c`.** So this split's held-out half contains prose that was
 * seen during tuning, and measuring *today's* parameters against it is
 * contaminated for every `codex-c` pair. This split is clean for the next
 * tuning cycle, not retroactively. Any number computed on it now must say so.
 */
export const BAND_STRATIFIED_HELD_OUT_AGENTS = new Set(["codex-c", "codex-e"]);

export const BAND_STRATIFIED_DEVELOPMENT_AGENTS = new Set([
  "codex-a",
  "codex-b",
  "codex-d",
]);

export function bandStratifiedSplitOf(leftTaskId, rightTaskId) {
  const held =
    BAND_STRATIFIED_HELD_OUT_AGENTS.has(TASK_AGENTS[leftTaskId]) ||
    BAND_STRATIFIED_HELD_OUT_AGENTS.has(TASK_AGENTS[rightTaskId]);
  return held ? "held-out" : "development";
}

/** The two registered splits, by the name `--split-rule` selects them with. */
export const SPLIT_RULES = {
  registered: {
    splitOf,
    development: DEVELOPMENT_AGENTS,
    heldOut: HELD_OUT_AGENTS,
    measuresObservedContention: false,
  },
  "band-stratified": {
    splitOf: bandStratifiedSplitOf,
    development: BAND_STRATIFIED_DEVELOPMENT_AGENTS,
    heldOut: BAND_STRATIFIED_HELD_OUT_AGENTS,
    measuresObservedContention: true,
  },
};
