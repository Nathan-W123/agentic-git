import path from "node:path";

import {
  identifierTokens,
  type RepositoryIndex,
} from "@coord/code-intelligence";

/**
 * What a task's objective probably touches, established before any agent has
 * read, planned, or run.
 *
 * Every other scope judgement in this coordinator starts from an agent's plan.
 * That is the earliest point a *declared* scope exists, and it is already too
 * late for one thing: by then the task is a single unit of work, and if that
 * unit spans half the repository the only remaining levers are detection,
 * sequencing, and repair. Estimation exists so intake has an opinion of its
 * own — a coarse, deterministic guess at the footprint, derived from the
 * objective text and the repository index, with no model call and nothing an
 * audit trail cannot replay.
 *
 * The guess is deliberately weak, and everything downstream is built to treat
 * it as weak. It never grants, withholds, or enforces anything. Its only
 * consumer is {@link ../task-decomposition.js}, which uses it to decide
 * whether a task is worth splitting, and which errs toward not splitting
 * whenever the estimate is thin.
 *
 * The mechanism is the same one plan grounding uses against declared names,
 * pointed at prose instead: break the objective into identifier fragments,
 * match those fragments against real symbols, real resource names, and real
 * path segments at the base revision, and keep what scores. A word that
 * matches most of the repository is discarded rather than believed — the
 * objective saying "test" is not evidence about which tests.
 */

/**
 * Prose and identifier fragments that carry no information about *where* work
 * lands.
 *
 * Two kinds are mixed here on purpose. Ordinary English filler ("the", "when",
 * "should") is noise in any repository. Generic engineering verbs and nouns
 * ("add", "update", "handler", "service") are noise because they are evenly
 * distributed: almost every module has a handler, so "handler" narrows
 * nothing. The nouns that survive — a domain name, a module name, a symbol —
 * are what actually localizes a change.
 */
const OBJECTIVE_STOP_WORDS = new Set([
  "a", "about", "above", "across", "add", "adding", "after", "again", "all",
  "allow", "already", "also", "always", "an", "and", "any", "anything", "api",
  "app", "apply", "are", "around", "as", "at", "back", "base", "be", "because",
  "been", "before", "behind", "being", "below", "best", "better", "between",
  "both", "break", "build", "but", "by", "call", "can", "cannot", "case",
  "change", "changes", "check", "class", "clean", "cleanup", "code", "common",
  "component", "config", "consider", "correct", "could", "create", "current",
  "currently", "data", "default", "delete", "do", "does", "doing", "done",
  "down", "drop", "due", "during", "each", "either", "else", "enable",
  "ensure", "error", "even", "every", "everything", "exist", "existing",
  "expect", "fail", "file", "files", "first", "fix", "fixed", "for", "from",
  "full", "function", "further", "generate", "generating", "get", "give",
  "go", "good", "handle",
  "handler", "has", "have", "help", "helper", "here", "how", "however", "if",
  "implement", "improve", "in", "include", "index", "init", "instead", "into",
  "is", "issue", "it", "its", "just", "keep", "kind", "known", "last", "let",
  "like", "line", "lines", "logic", "make", "makes", "many", "may", "method",
  "might", "module", "more", "most", "much", "must", "name", "need", "needs",
  "new", "no", "not", "note", "now", "number", "of", "off", "on", "once",
  "one", "only", "onto", "or", "other", "our", "out", "over", "own", "part",
  "pass", "path", "per", "please", "point", "possible", "prevent", "problem",
  "process", "properly", "provide", "put", "read", "reason", "record",
  "remove", "replace", "report", "request", "require", "response", "result",
  "return", "run", "same", "save", "see", "service", "set", "setup", "should",
  "show", "side", "similar", "simple", "since", "so", "some", "something",
  "source", "start", "state", "step", "still", "stop", "such", "support",
  "sure", "system", "take", "test", "tests", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "thing", "this", "those",
  "through", "time", "to", "todo", "too", "top", "try", "two", "type", "under",
  "until", "up", "update", "upon", "use", "used", "user", "using", "util",
  "utils", "value", "very", "want", "was", "way", "we", "well", "were",
  "what", "when", "where", "whether", "which", "while", "who", "why", "will",
  "with", "within", "without", "work", "would", "write", "you", "your",
]);

/** Manifests whose directory is treated as a module root. */
const MODULE_MANIFESTS = new Set([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "gemfile",
]);

/** Directories that are never anybody's module root. */
const IGNORED_PATH_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "vendor",
  ".git",
]);

const NAMED_FILE_SCORE = 6;
const NAMED_DIRECTORY_SCORE = 4;
const SYMBOL_EXACT_SCORE = 4;
const SYMBOL_TOKEN_SCORE = 3;
const RESOURCE_TOKEN_SCORE = 2;
const DIRECTORY_TOKEN_SCORE = 2;
const BASENAME_TOKEN_SCORE = 2;

export interface ScopeEstimationOptions {
  /** Most files an estimate may name. Default 40. */
  maxFiles?: number;
  /** Minimum accumulated score for a file to be in the estimate. Default 2. */
  minScore?: number;
  /**
   * A token matching more than this fraction of indexed files is discarded as
   * uninformative. Default 0.05.
   *
   * This was 0.15, which in a 435-file repository let a word naming a symbol
   * in sixty-five files count as localizing. It does not: "We have failed
   * builds fix please" survived on the single token "failed", matched every
   * file declaring `taskFailed`, `failedRuns`, `integrationFailures` and the
   * rest, and reported forty files as an *anchored* footprint. A blanket
   * claim was then granted against those forty, and forty files of an
   * error-handling codebase is most of the room — so a request that named
   * nothing at all sequenced everybody behind it.
   *
   * 0.05 is not a new number: {@link likelySymbolsIn} already draws this exact
   * line inside a file, where "a fragment a handful of declarations share is
   * evidence about that handful; one that half the file shares is evidence
   * about nothing". The same sentence is true of a repository, and the two
   * scales now say it the same way.
   *
   * Measured against real objectives from this repository: at 0.15 the three
   * vague ones anchored 40 files and the specific ones reached 95; at 0.05
   * every vague one falls to `none` — no claim, plan properly — and the
   * specific ones land between 6 and 38. Tightening further to 0.02 starts
   * cutting real footprints down to two files, which is a different failure.
   */
  ubiquityRatio?: number;
  /**
   * Below this many indexed files the ubiquity filter is skipped. Default 4.
   *
   * This defaulted to 20, on the reasoning that in a small repository every
   * token is proportionally ubiquitous and the ratio would punish words
   * unfairly. Replaying the estimator against recorded runs showed that to be
   * exactly backwards. A sixteen-file chess repository turned the filter
   * *off*, so "chess" and "game" — which name most of that repository and
   * localize nothing in it — were believed, and the resulting estimate had no
   * overlap at all with what the task really touched. Small repositories are
   * where a domain word is *most* ubiquitous, not least.
   *
   * The floor is now only what the ratio genuinely cannot express: with fewer
   * than four indexed files there is no footprint worth dividing anyway. The
   * `Math.max(3, …)` below already stops the ratio from punishing a token that
   * matches only a handful of files.
   */
  ubiquityMinimumFiles?: number;
  /** Shortest objective fragment that may match anything. Default 3. */
  minTokenLength?: number;
}

export type ScopeEstimateConfidence = "none" | "weak" | "anchored";

export interface EstimatedFile {
  path: string;
  score: number;
  /** Why this file is in the estimate, most specific evidence first. */
  reasons: string[];
  /**
   * Whether any reason was a scope statement rather than a coincidence: a
   * named path, a named directory, a real symbol, a real resource, or a
   * directory segment. A file matched only through its own basename is not
   * anchored — `orders.ts` and `orders/` are different strengths of evidence.
   */
  anchored: boolean;
}

/** One module's share of an estimate. */
export interface ModuleFootprint {
  /** Repository-relative module root; "" for files outside any module. */
  root: string;
  files: string[];
  score: number;
  anchored: boolean;
}

export interface ScopeEstimate {
  confidence: ScopeEstimateConfidence;
  revision: string;
  /** Objective fragments that survived stop-word and ubiquity filtering. */
  tokens: string[];
  /**
   * Content fragments of the objective that match nothing in the repository.
   *
   * The estimate is built only from {@link tokens}, so these are the part of
   * the request it is structurally blind to. An objective whose distinguishing
   * word appears here — "generate the *frontend*" against a repository with no
   * frontend — has been localized by its remaining words onto a subject it was
   * never about.
   */
  unmatchedTokens: string[];
  /**
   * Share of the repository's indexed files this estimate names, 0 to 1.
   *
   * The most direct proxy for precision available without knowing the truth.
   * A footprint that is a large fraction of the repository has not localized
   * anything: it has selected the repository and called it a task.
   */
  repositoryFraction: number;
  /** Real repository paths the objective named outright. */
  namedPaths: string[];
  /** Real repository directories the objective named outright. */
  namedDirectories: string[];
  files: EstimatedFile[];
  modules: ModuleFootprint[];
  /** Whether the index this was computed against was itself incomplete. */
  indexTruncated: boolean;
  notes: string[];
}

function isIgnoredPath(candidate: string): boolean {
  return candidate
    .split("/")
    .some((segment) => IGNORED_PATH_SEGMENTS.has(segment.toLowerCase()));
}

/**
 * Directories that own a build manifest, longest first.
 *
 * Module roots are read out of the repository rather than configured, because
 * the unit a split has to respect is the unit the repository already declares.
 * A repository with no manifests anywhere falls back to top-level directories,
 * which is the same idea at lower resolution.
 */
export function moduleRootsFrom(index: RepositoryIndex): string[] {
  const roots = new Set<string>();
  for (const candidate of index.paths) {
    if (isIgnoredPath(candidate)) {
      continue;
    }
    if (!MODULE_MANIFESTS.has(path.posix.basename(candidate).toLowerCase())) {
      continue;
    }
    const directory = path.posix.dirname(candidate);
    roots.add(directory === "." ? "" : directory);
  }
  // The repository root owning a manifest does not make every file its module:
  // it would swallow every deeper root when sorted by length. It stays only as
  // the implicit fallback in `moduleRootFor`.
  roots.delete("");
  if (roots.size === 0) {
    for (const candidate of index.paths) {
      if (isIgnoredPath(candidate)) {
        continue;
      }
      const [first] = candidate.split("/");
      if (first !== undefined && candidate.includes("/")) {
        roots.add(first);
      }
    }
  }
  return [...roots].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
}

/** The longest module root containing this file, or "" when none does. */
export function moduleRootFor(
  filePath: string,
  roots: readonly string[],
): string {
  for (const root of roots) {
    if (filePath === root || filePath.startsWith(`${root}/`)) {
      return root;
    }
  }
  return "";
}

/**
 * Folds regular English plurals onto their singular.
 *
 * Objectives are prose and code is not: someone writes "give invoices a
 * currency field" about a file that declares `createInvoice`. Applied
 * identically to both sides, so the two meet in the middle whatever the rule
 * does to an irregular word — a stem is only ever compared against another
 * stem, never against a real identifier.
 */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 4 && /(?:ch|sh|ss|x|z)es$/u.test(token)) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

/** Lowercased, stemmed, filtered identifier fragments of one prose word. */
function objectiveTokens(word: string, minLength: number): string[] {
  return identifierTokens(word)
    .map(stem)
    .filter(
      (token) =>
        token.length >= minLength &&
        !OBJECTIVE_STOP_WORDS.has(token) &&
        !/^\d+$/u.test(token),
    );
}

/** Stemmed identifier fragments of one repository name, for the token index. */
function indexTokens(name: string, minLength: number): string[] {
  return identifierTokens(name)
    .map(stem)
    .filter((token) => token.length >= minLength);
}

/** Path-shaped substrings of an objective, longest first. */
function pathCandidates(objective: string): string[] {
  const PATH_LIKE =
    /[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.*-]+)+|[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,5}/gu;
  const matches = objective.match(PATH_LIKE) ?? [];
  // Sentence punctuation rides along with the match, because "." and "-" are
  // legitimate inside a path and the regex cannot tell the two uses apart.
  return [
    ...new Set(
      matches
        .map((entry) => entry.replace(/^\.\//u, "").replace(/[.,;:]+$/u, ""))
        .filter((entry) => entry.length > 0),
    ),
  ].sort((left, right) => right.length - left.length);
}

interface Accumulator {
  score: number;
  reasons: string[];
  anchored: boolean;
}

function contribute(
  totals: Map<string, Accumulator>,
  filePath: string,
  score: number,
  reason: string,
  anchored: boolean,
): void {
  const existing = totals.get(filePath) ?? {
    score: 0,
    reasons: [],
    anchored: false,
  };
  existing.score += score;
  if (!existing.reasons.includes(reason)) {
    existing.reasons.push(reason);
  }
  existing.anchored = existing.anchored || anchored;
  totals.set(filePath, existing);
}

function addToken(
  map: Map<string, Set<string>>,
  token: string,
  filePath: string,
): void {
  const entry = map.get(token) ?? new Set<string>();
  entry.add(filePath);
  map.set(token, entry);
}

/**
 * Estimates which files an objective is likely to touch at one revision.
 *
 * Never throws on a thin objective or a thin index: an estimate that knows
 * nothing reports `confidence: "none"`, which every caller is required to read
 * as "do not act on this".
 */
export function estimateScope(
  objective: string,
  index: RepositoryIndex,
  options: ScopeEstimationOptions = {},
): ScopeEstimate {
  const maxFiles = options.maxFiles ?? 40;
  const minScore = options.minScore ?? 2;
  const ubiquityRatio = options.ubiquityRatio ?? 0.05;
  const ubiquityMinimumFiles = options.ubiquityMinimumFiles ?? 4;
  const minTokenLength = options.minTokenLength ?? 3;

  const notes: string[] = [];
  const indexedPaths = index.files
    .map((file) => file.path)
    .filter((candidate) => !isIgnoredPath(candidate));
  const allPaths = index.paths.filter((candidate) => !isIgnoredPath(candidate));
  const lowerToActual = new Map(
    allPaths.map((candidate) => [candidate.toLowerCase(), candidate]),
  );
  const directories = new Set<string>();
  for (const candidate of allPaths) {
    const segments = candidate.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      directories.add(segments.slice(0, depth).join("/"));
    }
  }

  // 1. Literal paths and directories. The strongest statement an objective can
  //    make about scope is to name the place, so these are resolved first and
  //    their words are not re-used as loose tokens.
  const namedPaths: string[] = [];
  const namedDirectories: string[] = [];
  const consumed = new Set<string>();
  for (const candidate of pathCandidates(objective)) {
    const lowered = candidate.toLowerCase().replace(/\/+$/u, "");
    const exact = lowerToActual.get(lowered);
    if (exact !== undefined) {
      namedPaths.push(exact);
      consumed.add(candidate.toLowerCase());
      continue;
    }
    const directory = [...directories].find(
      (entry) => entry.toLowerCase() === lowered,
    );
    if (directory !== undefined) {
      namedDirectories.push(directory);
      consumed.add(candidate.toLowerCase());
      continue;
    }
    // A path the objective named that no longer exists says something too, but
    // only that the objective is stale. Suffix matching is left to grounding,
    // which runs later against a real plan.
    const suffix = `/${lowered}`;
    const resolved = allPaths.filter((entry) =>
      entry.toLowerCase().endsWith(suffix),
    );
    if (resolved.length === 1 && resolved[0] !== undefined) {
      namedPaths.push(resolved[0]);
      consumed.add(candidate.toLowerCase());
    }
  }

  // 2. Loose identifier fragments from everything the objective did not spend
  //    on a literal path.
  const rawTokens = new Set<string>();
  for (const word of objective.split(/\s+/u)) {
    if (consumed.has(word.toLowerCase().replace(/[.,;:!?)("']+$/u, ""))) {
      continue;
    }
    for (const token of objectiveTokens(word, minTokenLength)) {
      rawTokens.add(token);
    }
  }

  // 3. Token indexes over the repository. Built once and shared, because the
  //    ubiquity filter needs to know how much of the repository each token
  //    would select before any of them is trusted.
  const symbolExact = new Map<string, Set<string>>();
  const symbolToken = new Map<string, Set<string>>();
  const resourceToken = new Map<string, Set<string>>();
  const directoryToken = new Map<string, Set<string>>();
  const basenameToken = new Map<string, Set<string>>();

  for (const file of index.files) {
    if (isIgnoredPath(file.path)) {
      continue;
    }
    for (const symbol of file.symbols) {
      addToken(symbolExact, stem(symbol.toLowerCase()), file.path);
      for (const token of indexTokens(symbol, minTokenLength)) {
        addToken(symbolToken, token, file.path);
      }
    }
    for (const resource of [
      ...file.apis,
      ...file.schemas,
      ...file.configKeys,
      ...file.services,
    ]) {
      for (const token of indexTokens(resource, minTokenLength)) {
        addToken(resourceToken, token, file.path);
      }
    }
    const segments = file.path.split("/");
    const basename = segments.pop() ?? "";
    for (const segment of segments) {
      for (const token of indexTokens(segment, minTokenLength)) {
        addToken(directoryToken, token, file.path);
      }
    }
    for (const token of indexTokens(
      basename.replace(/\.[^.]+$/u, ""),
      minTokenLength,
    )) {
      addToken(basenameToken, token, file.path);
    }
  }

  const ubiquityLimit =
    indexedPaths.length >= ubiquityMinimumFiles
      ? Math.max(3, Math.floor(indexedPaths.length * ubiquityRatio))
      : Number.POSITIVE_INFINITY;

  const tokens: string[] = [];
  const unmatchedTokens: string[] = [];
  for (const token of [...rawTokens].sort()) {
    const reach = new Set<string>([
      ...(symbolExact.get(token) ?? []),
      ...(symbolToken.get(token) ?? []),
      ...(resourceToken.get(token) ?? []),
      ...(directoryToken.get(token) ?? []),
      ...(basenameToken.get(token) ?? []),
    ]);
    if (reach.size === 0) {
      // The repository has never heard of this word. Recorded rather than
      // dropped: an objective built mostly out of words the index cannot see
      // is describing something that is not there yet, and the estimate that
      // survives is made of whatever *is* — which is not the same subject.
      unmatchedTokens.push(token);
      continue;
    }
    if (reach.size > ubiquityLimit) {
      notes.push(
        `"${token}" matches ${reach.size} indexed files and was discarded as ` +
          "too common to localize anything",
      );
      continue;
    }
    tokens.push(token);
  }

  // 4. Accumulate.
  const totals = new Map<string, Accumulator>();
  for (const named of namedPaths) {
    contribute(totals, named, NAMED_FILE_SCORE, "named in the objective", true);
  }
  for (const directory of namedDirectories) {
    const prefix = `${directory}/`;
    const under = allPaths.filter((candidate) => candidate.startsWith(prefix));
    for (const candidate of under) {
      contribute(
        totals,
        candidate,
        NAMED_DIRECTORY_SCORE,
        `under ${directory}, named in the objective`,
        true,
      );
    }
  }
  for (const token of tokens) {
    for (const filePath of symbolExact.get(token) ?? []) {
      contribute(totals, filePath, SYMBOL_EXACT_SCORE, `declares ${token}`, true);
    }
    for (const filePath of symbolToken.get(token) ?? []) {
      contribute(
        totals,
        filePath,
        SYMBOL_TOKEN_SCORE,
        `declares a symbol containing "${token}"`,
        true,
      );
    }
    for (const filePath of resourceToken.get(token) ?? []) {
      contribute(
        totals,
        filePath,
        RESOURCE_TOKEN_SCORE,
        `names a resource containing "${token}"`,
        true,
      );
    }
    for (const filePath of directoryToken.get(token) ?? []) {
      contribute(
        totals,
        filePath,
        DIRECTORY_TOKEN_SCORE,
        `sits under a directory named "${token}"`,
        true,
      );
    }
    for (const filePath of basenameToken.get(token) ?? []) {
      contribute(
        totals,
        filePath,
        BASENAME_TOKEN_SCORE,
        `is named after "${token}"`,
        false,
      );
    }
  }

  const ranked = [...totals.entries()]
    .filter(([, entry]) => entry.score >= minScore)
    .sort(
      ([leftPath, left], [rightPath, right]) =>
        right.score - left.score ||
        Number(right.anchored) - Number(left.anchored) ||
        leftPath.localeCompare(rightPath),
    );
  // Recorded here and read again below, where it decides the verdict rather
  // than only annotating it.
  const truncated = ranked.length > maxFiles;
  if (truncated) {
    notes.push(
      `${ranked.length} files scored above the threshold; kept the ${maxFiles} strongest`,
    );
  }
  const files: EstimatedFile[] = ranked
    .slice(0, maxFiles)
    .map(([filePath, entry]) => ({
      path: filePath,
      score: entry.score,
      reasons: entry.reasons,
      anchored: entry.anchored,
    }));

  const roots = moduleRootsFrom(index);
  const grouped = new Map<string, ModuleFootprint>();
  for (const file of files) {
    const root = moduleRootFor(file.path, roots);
    const footprint = grouped.get(root) ?? {
      root,
      files: [],
      score: 0,
      anchored: false,
    };
    footprint.files.push(file.path);
    footprint.score += file.score;
    footprint.anchored = footprint.anchored || file.anchored;
    grouped.set(root, footprint);
  }
  const modules = [...grouped.values()].sort(
    (left, right) => right.score - left.score || left.root.localeCompare(right.root),
  );
  for (const footprint of modules) {
    footprint.files.sort();
  }

  let confidence: ScopeEstimateConfidence;
  if (files.length === 0) {
    confidence = "none";
    notes.push(
      "nothing in this objective matches the repository at this revision; " +
        "its footprint is unknown",
    );
  } else if (truncated) {
    // The note already said this; the verdict did not, and only the verdict is
    // read. An estimate that scored more files than it can carry has not
    // located the work — it has run out of room, and the strongest forty of
    // ninety-five are neither the footprint nor a narrowing of it. Calling
    // that "anchored" is what let a truncated guess become a blanket claim,
    // and a blanket claim is the whole room. Demoted, the task plans properly
    // instead: one round trip, against everybody else's concurrency.
    confidence = "weak";
    notes.push(
      "more files scored than this estimate can name, so what it did not " +
        "localize is unknown rather than absent",
    );
  } else if (files.some((file) => file.anchored)) {
    confidence = "anchored";
  } else {
    confidence = "weak";
    notes.push(
      "the objective matched only file names, not any directory, symbol, or " +
        "declared resource",
    );
  }
  if (index.truncated) {
    notes.push(
      `the index skipped ${index.skippedFiles} files, so this estimate is a ` +
        "lower bound on the real footprint",
    );
  }

  const repositoryFraction =
    indexedPaths.length === 0 ? 0 : files.length / indexedPaths.length;
  if (repositoryFraction >= 0.35) {
    notes.push(
      `this estimate names ${(repositoryFraction * 100).toFixed(0)}% of the ` +
        "indexed repository, which is a selection rather than a localization",
    );
  }
  if (unmatchedTokens.length > 0) {
    // Stems, not the words as written: these are the fragments actually looked
    // up, and saying so is more useful than pretty-printing something that was
    // never searched for.
    notes.push(
      `no indexed name contains the fragment(s) ${unmatchedTokens
        .map((token) => `"${token}"`)
        .join(", ")}`,
    );
  }

  return {
    confidence,
    revision: index.revision,
    tokens,
    unmatchedTokens,
    repositoryFraction,
    namedPaths: [...new Set(namedPaths)].sort(),
    namedDirectories: [...new Set(namedDirectories)].sort(),
    files,
    modules,
    indexTruncated: index.truncated,
    notes,
  };
}

/**
 * Which declarations in one file an objective is likely to be about.
 *
 * The gap this fills is the one that makes everything finer than a file
 * unreachable in practice. Arbitration decides whether two plans want the
 * same *code* rather than the same path by asking what each occupies inside a
 * file — and a plan that named the file and no declarations occupies all of
 * it, by definition. Agents name files far more reliably than they name
 * functions, so that is the common case rather than the corner, and it makes
 * a whole-file lock the normal outcome however good the splitting is.
 *
 * So where an agent did not say, this reads its objective the same way
 * {@link estimateScope} reads one for files: the words that survive stop-word
 * filtering, matched against the names the index actually placed in the file.
 *
 * What counts as a match is decided by how rare a fragment is *in this file*,
 * which is the only measure that works on real names. Requiring every
 * fragment of a name would miss `chanHeader` for an objective about a header,
 * because "chan" is a house prefix no one writing prose will use. Requiring a
 * fragment unique to one declaration would miss `agentHistory`, because
 * `agentHistoryRows` sits beside it sharing every word it has — and those two
 * are the same piece of work, so claiming both is right rather than a
 * failure. A fragment a handful of declarations share is evidence about that
 * handful; one that half the file shares is evidence about nothing.
 *
 * Empty means the objective said nothing about this file's contents, which
 * callers must read as "occupies all of it" — the answer they already had.
 * This never widens a claim: it only narrows one that would be the whole file.
 */
export function likelySymbolsIn(
  objective: string,
  placed: readonly { name: string }[],
  options: { minTokenLength?: number } = {},
): string[] {
  const minTokenLength = options.minTokenLength ?? 3;
  const lowered = objective.toLowerCase();
  const words = new Set(
    lowered
      .split(/[^A-Za-z0-9_]+/u)
      .flatMap((word) => objectiveTokens(word, minTokenLength)),
  );
  if (words.size === 0 || placed.length === 0) {
    return [];
  }

  const frequency = new Map<string, number>();
  for (const entry of placed) {
    for (const token of new Set(indexTokens(entry.name, minTokenLength))) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  // A fragment is evidence while it still points at a small part of the file.
  // Scaled rather than fixed, so it means the same thing in a file of twenty
  // declarations as in one of two hundred, with a floor so a small file does
  // not make every fragment decisive.
  const ceiling = Math.max(3, Math.round(placed.length * 0.05));

  // Scored rather than filtered, because how *much* of a name an objective
  // accounts for is the difference between a claim and a coincidence.
  // `notificationBell` against "remove the notification bell" is the whole
  // name; `chanHeader` against the same words is one fragment of two, and the
  // first is a far better answer than the second wherever both exist.
  const scored: { name: string; matched: number; whole: boolean }[] = [];
  for (const entry of placed) {
    // The whole name written out is unambiguous however common its parts are.
    if (lowered.includes(entry.name.toLowerCase())) {
      scored.push({ name: entry.name, matched: Number.MAX_SAFE_INTEGER, whole: true });
      continue;
    }
    const tokens = [...new Set(indexTokens(entry.name, minTokenLength))];
    const matched = tokens.filter((token) => {
      const shared = frequency.get(token) ?? 0;
      // A fragment every declaration in the file carries has not chosen
      // between them — "total" in a file of `orderTotal` and `formatTotal` is
      // the file's subject, not a claim on half of it. The proportional
      // ceiling alone cannot see this, because its floor is larger than a
      // small file.
      return (
        words.has(token) &&
        shared > 0 &&
        shared < placed.length &&
        shared <= ceiling
      );
    }).length;
    if (matched > 0) {
      scored.push({ name: entry.name, matched, whole: false });
    }
  }
  if (scored.length === 0) {
    return [];
  }
  // Only the best answers the file has. A declaration the objective accounts
  // for twice over is not in the same class as one it brushes against, and
  // keeping both claims the second for nothing — which costs whoever wanted
  // it a turn.
  const best = scored.reduce((top, entry) => Math.max(top, entry.matched), 0);
  return scored
    .filter((entry) => entry.matched === best)
    .map((entry) => entry.name)
    .sort();
}
