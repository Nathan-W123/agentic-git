import path from "node:path";

import {
  RepositoryService,
  type CanonicalRepository,
} from "@coord/repository-service";
import {
  uniqueRepositoryPaths,
  uniqueStrings,
  type AgentPlan,
  type PlanResourceRef,
} from "@coord/shared-types";
import ts from "typescript";

import {
  braceSymbolRanges,
  pythonSymbolRanges,
  rubySymbolRanges,
  type BraceLanguage,
} from "./symbol-ranges.js";

export {
  groundPlan,
  identifierTokens,
  GENERIC_IDENTIFIER_TOKENS,
} from "./plan-grounding.js";
export {
  assessGroundedIntent,
  groundedIntentAssessor,
  groundIntent,
  DEFAULT_GROUNDED_INTENT_OPTIONS,
  DEFAULT_INTENT_GROUNDING_OPTIONS,
  type GroundedIntentConflict,
  type GroundedIntentOptions,
  type IntentConflictVerdict,
  type IntentGrounding,
  type IntentGroundingOptions,
  type IntentRelation,
  type IntentTarget,
} from "./intent-grounding.js";

export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "ruby"
  | BraceLanguage
  | "json"
  | "yaml"
  | "sql"
  | "prisma";

/**
 * Where one symbol lives in the file, in 1-based inclusive line numbers.
 *
 * Recorded so a withheld symbol can be held to something. Ownership can name
 * a symbol, but a changeset is a set of file patches, and without knowing
 * which lines a symbol occupies there is no way to ask whether a patch touched
 * it. These are base-revision coordinates, which is exactly what the old side
 * of a diff hunk is measured in.
 */
export interface SymbolRange {
  name: string;
  startLine: number;
  endLine: number;
}

/**
 * One call site, attributed to the declared symbol whose body contains it.
 *
 * `referencedSymbols` records what a *file* mentions, which is enough to ask
 * whether two files are connected and not enough to ask how. This says which
 * function does the calling, so `orderTotal -> discountRate` is a fact the
 * index can state rather than one a caller has to infer from "total.js
 * mentions discountRate somewhere".
 *
 * Call expressions only. A symbol read as a value — `DELIVERY` inside
 * `orderTotal` — is not recorded here, and a caller that needs value
 * dependencies must not read an absent edge as "does not use it".
 */
export interface SymbolCall {
  /** The declared symbol whose body contains the call. */
  from: string;
  /** The identifier being called. May be declared in another file, or nowhere. */
  to: string;
}

export interface IndexedFile {
  path: string;
  language: SupportedLanguage;
  bytes: number;
  symbols: string[];
  /**
   * Empty for a file whose language the indexer does not parse into an AST.
   * Callers must not read that as "this file has no symbols" — use
   * {@link CodeIntelligenceService.symbolRangesInFile}, which distinguishes
   * the two, before deciding anything enforcement depends on.
   */
  symbolRanges: SymbolRange[];
  /**
   * Set when this file's language has declarations worth placing but this
   * file's could not be placed — a syntax error, brackets that do not
   * balance, no interpreter to ask.
   *
   * Without it an unreadable file is indistinguishable from an empty one:
   * both carry `symbolRanges: []`, and "declares nothing" is safe to enforce
   * a withholding against while "could not read" is emphatically not.
   */
  symbolRangesUnknown?: boolean;
  /** Call edges inside this file, attributed to the calling symbol. */
  symbolCalls: SymbolCall[];
  imports: string[];
  dependencies: string[];
  referencedSymbols: string[];
  apis: string[];
  schemas: string[];
  configKeys: string[];
  tests: string[];
  services: string[];
}

/** Paths enrichment treats as tests in their own right. */
const TEST_FILE_PATH =
  /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\./u;

export interface DependencyEdge {
  fromFile: string;
  toFile?: string;
  resource: string;
  kind: "import" | "symbol" | "service";
}

export interface RepositoryIndex {
  repositoryId: string;
  revision: string;
  generatedAt: string;
  files: IndexedFile[];
  edges: DependencyEdge[];
  /**
   * Every path in the repository at this revision, indexed or not. `files`
   * only holds what the indexer parsed, so "does this declared path exist" is
   * a question only this complete list can answer — a README is real even
   * though no AST was built for it.
   */
  paths: string[];
  truncated: boolean;
  skippedFiles: number;
}

export interface ChangedResources {
  symbols: string[];
  apis: string[];
  schemas: string[];
  configKeys: string[];
  tests: string[];
  services: string[];
}

export interface CodeIntelligenceOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxCacheEntries?: number;
}

const SOURCE_EXTENSIONS = new Map<string, SupportedLanguage>([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".py", "python"],
  [".pyi", "python"],
  [".rb", "ruby"],
  [".rake", "ruby"],
  [".go", "go"],
  [".rs", "rust"],
  [".java", "java"],
  [".cs", "csharp"],
  [".c", "c"],
  [".h", "c"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".cxx", "cpp"],
  [".hpp", "cpp"],
  [".hh", "cpp"],
  [".php", "php"],
  [".swift", "swift"],
  [".kt", "kotlin"],
  [".kts", "kotlin"],
  [".scala", "scala"],
  [".json", "json"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".sql", "sql"],
  [".prisma", "prisma"],
]);

const HTTP_METHODS = new Set([
  "all",
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
]);

const DECLARATION_KINDS = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
]);

function namedDeclaration(node: ts.Node): string | undefined {
  if (!DECLARATION_KINDS.has(node.kind) || (!("name" in node))) {
    return undefined;
  }
  const name = (node as ts.NamedDeclaration).name;
  return name !== undefined && ts.isIdentifier(name) ? name.text : undefined;
}

function stringArgument(node: ts.CallExpression, index = 0): string | undefined {
  const argument = node.arguments[index];
  return argument !== undefined &&
    (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : undefined;
}

function scriptKind(filePath: string): ts.ScriptKind {
  const extension = path.posix.extname(filePath).toLowerCase();
  if (extension === ".tsx") {
    return ts.ScriptKind.TSX;
  }
  if (extension === ".jsx") {
    return ts.ScriptKind.JSX;
  }
  return [".js", ".mjs", ".cjs"].includes(extension)
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
}

function analyzeScript(
  filePath: string,
  source: string,
  language: "typescript" | "javascript",
): IndexedFile {
  const file = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(filePath),
  );
  const symbols = new Set<string>();
  const imports = new Set<string>();
  const dependencies = new Set<string>();
  const referencedSymbols = new Set<string>();
  const apis = new Set<string>();
  const schemas = new Set<string>();
  const configKeys = new Set<string>();
  const tests = new Set<string>();
  const services = new Set<string>();
  const ranges = new Map<string, SymbolRange>();
  const calls = new Map<string, Set<string>>();

  /**
   * The declared symbols currently being descended through, innermost last.
   *
   * A call is attributed to the innermost one. Nothing is attributed at file
   * scope: a call in a module's top-level body belongs to the module, and this
   * index has no symbol standing for that.
   */
  const enclosing: string[] = [];

  /** The symbol a node opens a body for, if it opens one. */
  const opensScope = (node: ts.Node): string | undefined => {
    const declared = namedDeclaration(node);
    if (declared !== undefined) {
      return declared;
    }
    if (
      (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name)
    ) {
      return node.name.text;
    }
    // `const handler = () => {...}` reads as a declaration of `handler` to
    // anyone editing it, and the calls inside belong to it rather than to
    // whatever encloses the assignment.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      return node.name.text;
    }
    return undefined;
  };

  const record = (name: string, node: ts.Node): void => {
    const start = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
    const end = file.getLineAndCharacterOfPosition(node.getEnd()).line;
    const existing = ranges.get(name);
    // A name declared more than once (an overload, a re-export) spans from the
    // first to the last, which is the conservative reading: an edit anywhere
    // between them counts as touching it.
    ranges.set(name, {
      name,
      startLine: Math.min(existing?.startLine ?? start + 1, start + 1),
      endLine: Math.max(existing?.endLine ?? end + 1, end + 1),
    });
  };

  const visit = (node: ts.Node): void => {
    const scope = opensScope(node);
    if (scope !== undefined) {
      enclosing.push(scope);
    }
    const declaration = namedDeclaration(node);
    if (declaration !== undefined) {
      symbols.add(declaration);
      record(declaration, node);
      if (/(?:Service|Client|Repository|Gateway|Worker)$/u.test(declaration)) {
        services.add(declaration);
      }
      if (
        /(?:Schema|Entity|Model|Record|Payload|Input|Migration)$/u.test(
          declaration,
        ) ||
        /(?:schema|migration|model)/iu.test(filePath)
      ) {
        schemas.add(declaration);
      }
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      symbols.add(node.name.text);
      // The whole statement, not just the declarator: `export const value = 1`
      // is one thing to an agent editing it, and the modifiers are part of it.
      record(
        node.name.text,
        ts.isVariableDeclarationList(node.parent) &&
          ts.isVariableStatement(node.parent.parent)
          ? node.parent.parent
          : node,
      );
    }

    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      imports.add(node.moduleSpecifier.text);
      dependencies.add(node.moduleSpecifier.text);
    }

    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (
        ts.isIdentifier(expression) &&
        expression.text === "require"
      ) {
        const imported = stringArgument(node);
        if (imported !== undefined) {
          imports.add(imported);
          dependencies.add(imported);
        }
      }
      const caller = enclosing[enclosing.length - 1];
      const callee = ts.isIdentifier(expression)
        ? expression.text
        : ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : undefined;
      if (caller !== undefined && callee !== undefined && caller !== callee) {
        const targets = calls.get(caller) ?? new Set<string>();
        targets.add(callee);
        calls.set(caller, targets);
      }
      if (ts.isIdentifier(expression)) {
        referencedSymbols.add(expression.text);
        if (["describe", "it", "test"].includes(expression.text)) {
          const name = stringArgument(node);
          if (name !== undefined) {
            tests.add(name);
          }
        }
      }
      if (
        ts.isPropertyAccessExpression(expression) &&
        HTTP_METHODS.has(expression.name.text.toLowerCase())
      ) {
        const route = stringArgument(node);
        if (route !== undefined && route.startsWith("/")) {
          apis.add(`${expression.name.text.toUpperCase()} ${route}`);
        }
      }
      if (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "object" &&
        ts.isIdentifier(expression.expression) &&
        ["z", "schema", "yup"].includes(expression.expression.text)
      ) {
        schemas.add(`${filePath}#object`);
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "process" &&
      node.expression.name.text === "env"
    ) {
      configKeys.add(node.name.text);
    }

    ts.forEachChild(node, visit);
    if (scope !== undefined) {
      enclosing.pop();
    }
  };
  visit(file);

  return {
    path: filePath,
    language,
    bytes: Buffer.byteLength(source),
    symbols: uniqueStrings([...symbols]),
    symbolRanges: [...ranges.values()].sort(
      (left, right) =>
        left.startLine - right.startLine || left.name.localeCompare(right.name),
    ),
    symbolCalls: [...calls]
      .flatMap(([from, targets]) =>
        [...targets].sort().map((to) => ({ from, to })),
      )
      .sort(
        (left, right) =>
          left.from.localeCompare(right.from) ||
          left.to.localeCompare(right.to),
      ),
    imports: uniqueStrings([...imports]),
    dependencies: uniqueStrings([...dependencies]),
    referencedSymbols: uniqueStrings([...referencedSymbols]),
    apis: uniqueStrings([...apis]),
    schemas: uniqueStrings([...schemas]),
    configKeys: uniqueStrings([...configKeys]),
    tests: uniqueStrings([...tests]),
    services: uniqueStrings([...services]),
  };
}

function flattenJsonKeys(
  value: unknown,
  prefix = "",
  output: string[] = [],
): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return output;
  }
  for (const [key, entry] of Object.entries(value)) {
    const qualified = prefix.length === 0 ? key : `${prefix}.${key}`;
    output.push(qualified);
    flattenJsonKeys(entry, qualified, output);
  }
  return output;
}

/** Languages whose declarations a scanner in this package can place. */
/**
 * Languages whose declarations this package can place well enough to enforce
 * a withholding against. Everything else is arbitrated a whole file at a time.
 */
const RANGEABLE_LANGUAGES = new Set<SupportedLanguage>([
  "typescript",
  "javascript",
  "python",
  "ruby",
  "go",
  "rust",
  "java",
  "csharp",
  "c",
  "cpp",
  "php",
  "swift",
  "kotlin",
  "scala",
]);

const BRACE_LANGUAGES = new Set<string>([
  "go",
  "rust",
  "java",
  "csharp",
  "c",
  "cpp",
  "php",
  "swift",
  "kotlin",
  "scala",
]);

/**
 * A file in a language this package scans rather than parses.
 *
 * Only the declarations are read. Imports, APIs, schemas and call edges are
 * left empty rather than guessed: they drive enrichment and conflict scoring,
 * where a wrong answer is worse than no answer, and the thing symbol-level
 * admission actually needs is the spans.
 *
 * `symbolRanges` empty means the scanner read the file and found nothing;
 * `undefined` from the scanner means it could not read the file, and is
 * recorded here as an unparsed file so `symbolRangesInFile` says "no idea".
 */
function analyzeScannedFile(
  filePath: string,
  source: string,
  language: SupportedLanguage,
  ranges: SymbolRange[] | undefined,
): IndexedFile {
  return {
    path: filePath,
    language,
    bytes: Buffer.byteLength(source),
    symbols: (ranges ?? []).map((range) => range.name),
    symbolRanges: ranges ?? [],
    ...(ranges === undefined ? { symbolRangesUnknown: true } : {}),
    symbolCalls: [],
    imports: [],
    dependencies: [],
    referencedSymbols: [],
    apis: [],
    schemas: [],
    configKeys: [],
    tests: [],
    services: [],
  };
}

function analyzeDataFile(
  filePath: string,
  source: string,
  language: Exclude<SupportedLanguage, "typescript" | "javascript">,
): IndexedFile {
  const configKeys = new Set<string>();
  const schemas = new Set<string>();
  const services = new Set<string>();
  if (language === "json") {
    try {
      flattenJsonKeys(JSON.parse(source) as unknown).forEach((key) =>
        configKeys.add(key),
      );
    } catch {
      // Invalid data is still indexed as a file; validation owns syntax errors.
    }
  } else if (language === "yaml") {
    for (const match of source.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*:/gmu)) {
      if (match[1] !== undefined) {
        configKeys.add(match[1]);
      }
    }
  } else if (language === "sql") {
    for (const match of source.matchAll(
      /\b(?:CREATE|ALTER)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?([A-Za-z0-9_.-]+)/giu,
    )) {
      if (match[1] !== undefined) {
        schemas.add(`table:${match[1]}`);
      }
    }
  } else {
    for (const match of source.matchAll(/^\s*model\s+([A-Za-z0-9_]+)/gmu)) {
      if (match[1] !== undefined) {
        schemas.add(`model:${match[1]}`);
      }
    }
  }
  if (/docker-compose|compose\.ya?ml$/iu.test(filePath)) {
    for (const match of source.matchAll(/^\s{2}([A-Za-z0-9_.-]+)\s*:/gmu)) {
      if (match[1] !== undefined) {
        services.add(match[1]);
      }
    }
  }
  return {
    path: filePath,
    language,
    bytes: Buffer.byteLength(source),
    symbols: [],
    // Not parsed into an AST, so nothing can be located inside it.
    symbolRanges: [],
    symbolCalls: [],
    imports: [],
    dependencies: [],
    referencedSymbols: [],
    apis: [],
    schemas: uniqueStrings([...schemas]),
    configKeys: uniqueStrings([...configKeys]),
    tests: [],
    services: uniqueStrings([...services]),
  };
}

function resolveImport(
  fromFile: string,
  imported: string,
  files: ReadonlySet<string>,
): string | undefined {
  if (!imported.startsWith(".")) {
    return undefined;
  }
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), imported),
  );
  const sourceBase = /\.(?:c|m)?jsx?$/u.test(base)
    ? base.replace(/\.(?:c|m)?jsx?$/u, "")
    : base;
  const candidates = [
    base,
    ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"].map(
      (extension) => `${sourceBase}${extension}`,
    ),
    ...[".ts", ".tsx", ".js", ".jsx", ".json"].map((extension) =>
      path.posix.join(base, `index${extension}`),
    ),
  ];
  return candidates.find((candidate) => files.has(candidate));
}

export class CodeIntelligenceService {
  private readonly cache = new Map<string, RepositoryIndex>();
  /**
   * Builds already running, keyed exactly like the cache.
   *
   * The cache only helps a second caller who arrives after the first has
   * finished. Once one service is shared for a process's lifetime, tasks plan
   * in parallel and the interesting case is the other one: two callers ask for
   * the same uncached index at the same time, and without this they would both
   * walk the whole repository to produce two identical indexes. Sharing the
   * in-flight build is safe because indexing is a read of one fixed revision —
   * there is nothing for the two to disagree about — and each caller still
   * receives its own copy below.
   */
  private readonly inFlight = new Map<string, Promise<RepositoryIndex>>();

  public constructor(
    private readonly repositories = new RepositoryService(),
    private readonly options: CodeIntelligenceOptions = {},
  ) {
    for (const [name, value] of Object.entries(options)) {
      if (value === undefined) {
        continue;
      }
      if (!Number.isSafeInteger(value) || Number(value) < 1) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
  }

  public async index(
    repository: CanonicalRepository,
    revision: string,
  ): Promise<RepositoryIndex> {
    const key = `${repository.path}\0${revision}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return structuredClone(cached);
    }
    const running = this.inFlight.get(key);
    if (running !== undefined) {
      return structuredClone(await running);
    }
    // Cached inside the build's own continuation, so the entry is in place
    // before the in-flight record is dropped and a caller arriving between the
    // two finds the finished index rather than starting a second build.
    const build = this.build(repository, revision).then((index) => {
      // The cache keeps the canonical copy and every caller gets a clone of
      // it, so no caller can mutate what a later one is handed.
      this.cache.set(key, index);
      while (this.cache.size > (this.options.maxCacheEntries ?? 100)) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (oldest === undefined) {
          break;
        }
        this.cache.delete(oldest);
      }
      return index;
    });
    this.inFlight.set(key, build);
    try {
      return structuredClone(await build);
    } finally {
      if (this.inFlight.get(key) === build) {
        this.inFlight.delete(key);
      }
    }
  }

  private async build(
    repository: CanonicalRepository,
    revision: string,
  ): Promise<RepositoryIndex> {
    const maxFiles = this.options.maxFiles ?? 5_000;
    const maxFileBytes = this.options.maxFileBytes ?? 2 * 1024 * 1024;
    const maxTotalBytes = this.options.maxTotalBytes ?? 50 * 1024 * 1024;
    const repositoryFiles = await this.repositories.listFiles(repository, revision);
    const candidates = repositoryFiles.filter((filePath) =>
      SOURCE_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase()),
    );
    const files: IndexedFile[] = [];
    /** Python sources, answered in one batch once every file has been read. */
    const pythonSources = new Map<string, string>();
    let totalBytes = 0;
    let skippedFiles = 0;

    // Each read is a `git show`, so a file-at-a-time loop costs one process
    // launch per source file and spends most of its time waiting on spawn
    // rather than on git. Reads run a chunk at a time instead.
    //
    // The budget below is order-dependent — whether a file is included depends
    // on the total accepted before it — so the accounting stays strictly
    // sequential over `candidates`, and only the fetching is overlapped. A
    // chunk whose budget runs out mid-way discards the reads it had already
    // started, which is what the sequential version did by never issuing them;
    // the resulting index is identical either way.
    const readAhead = 16;
    for (let offset = 0; offset < candidates.length; offset += readAhead) {
      if (files.length >= maxFiles || totalBytes >= maxTotalBytes) {
        skippedFiles += candidates.length - offset;
        break;
      }
      const chunk = candidates.slice(offset, offset + readAhead);
      const sources = await Promise.all(
        chunk.map(
          async (filePath) =>
            await this.repositories.readFile(repository, revision, filePath),
        ),
      );

      for (const [chunkIndex, filePath] of chunk.entries()) {
        if (files.length >= maxFiles || totalBytes >= maxTotalBytes) {
          skippedFiles += 1;
          continue;
        }
        const source = sources[chunkIndex] ?? "";
        const bytes = Buffer.byteLength(source);
        if (bytes > maxFileBytes || totalBytes + bytes > maxTotalBytes) {
          skippedFiles += 1;
          continue;
        }
        totalBytes += bytes;
        const language = SOURCE_EXTENSIONS.get(
          path.posix.extname(filePath).toLowerCase(),
        );
        if (language === undefined) {
          continue;
        }
        if (language === "typescript" || language === "javascript") {
          files.push(analyzeScript(filePath, source, language));
        } else if (language === "python") {
          // Held back for the batch: one interpreter answers for every Python
          // file in the repository rather than one per file.
          pythonSources.set(filePath, source);
          files.push(analyzeScannedFile(filePath, source, language, undefined));
        } else if (language === "ruby") {
          files.push(
            analyzeScannedFile(filePath, source, language, rubySymbolRanges(source)),
          );
        } else if (BRACE_LANGUAGES.has(language)) {
          files.push(
            analyzeScannedFile(
              filePath,
              source,
              language,
              braceSymbolRanges(source, language as BraceLanguage),
            ),
          );
        } else {
          files.push(analyzeDataFile(filePath, source, language));
        }
      }
    }

    // One interpreter for the repository. A file the reader could not answer
    // for simply keeps the empty placeholder recorded above, and
    // `symbolRangesInFile` reports it as unreadable rather than as empty.
    const pythonAnswers = await pythonSymbolRanges(pythonSources);
    for (const file of files) {
      const ranges = pythonAnswers.get(file.path);
      if (ranges !== undefined) {
        file.symbolRanges = ranges;
        file.symbols = ranges.map((range) => range.name);
        delete file.symbolRangesUnknown;
      }
    }

    const allPaths = new Set(repositoryFiles);
    const edges: DependencyEdge[] = [];
    for (const file of files) {
      for (const imported of file.imports) {
        const target = resolveImport(file.path, imported, allPaths);
        edges.push({
          fromFile: file.path,
          ...(target === undefined ? {} : { toFile: target }),
          resource: target ?? imported,
          kind: "import",
        });
      }
      for (const service of file.services) {
        edges.push({
          fromFile: file.path,
          resource: service,
          kind: "service",
        });
      }
    }

    const index: RepositoryIndex = {
      repositoryId: repository.id,
      revision,
      generatedAt: new Date().toISOString(),
      files,
      edges,
      paths: [...repositoryFiles].sort(),
      truncated: skippedFiles > 0,
      skippedFiles,
    };
    return index;
  }

  /**
   * The resources {@link enrichPlan} would attribute to one file.
   *
   * Enrichment is one-way: a plan naming a file ends up claiming that file's
   * symbols, APIs and schemas, and afterwards nothing records where any of
   * them came from. Partial admission needs the inverse — if a file is
   * withheld, which of the plan's claims exist only because of it? — so the
   * attribution lives here, beside the projection it has to agree with.
   */
  /**
   * Where each symbol lives in one file, or `undefined` when that cannot be
   * known — the file is not in the index, or its language is not parsed into
   * an AST.
   *
   * The distinction is the whole point. An empty array means "parsed, and it
   * declares nothing"; `undefined` means "no idea what is in here". Only the
   * first is safe to enforce a withheld symbol against, because only the first
   * lets a patch be checked for touching it.
   */
  public symbolRangesInFile(
    index: RepositoryIndex,
    filePath: string,
  ): SymbolRange[] | undefined {
    const file = index.files.find((entry) => entry.path === filePath);
    if (file === undefined) {
      return undefined;
    }
    return RANGEABLE_LANGUAGES.has(file.language) &&
      file.symbolRangesUnknown !== true
      ? file.symbolRanges
      : undefined;
  }

  public resourcesInFile(
    index: RepositoryIndex,
    filePath: string,
  ): PlanResourceRef[] {
    const file = index.files.find((entry) => entry.path === filePath);
    if (file === undefined) {
      return [];
    }
    const refs = (
      resourceType: PlanResourceRef["resourceType"],
      ids: readonly string[],
    ): PlanResourceRef[] =>
      ids.map((resourceId) => ({ resourceType, resourceId }));
    return [
      ...refs("symbol", file.symbols),
      ...refs("api", file.apis),
      ...refs("schema", file.schemas),
      ...refs("configuration", file.configKeys),
      ...refs("test", file.tests),
      ...refs("service", file.services),
      ...(TEST_FILE_PATH.test(file.path)
        ? refs("test", [file.path])
        : []),
    ];
  }

  /**
   * Conservatively projects indexed resources for every file an agent plans
   * to modify. This catches consumers and shared contracts before editing.
   */
  public enrichPlan(plan: AgentPlan, index: RepositoryIndex): AgentPlan {
    const selected = new Set(plan.expectedFiles);
    const files = index.files.filter((file) => selected.has(file.path));
    const dependencyFiles = index.edges
      .filter((edge) => selected.has(edge.fromFile) && edge.toFile !== undefined)
      .map((edge) => `file:${edge.toFile}`);
    const enriched: AgentPlan = {
      ...structuredClone(plan),
      // Kept before it is widened, because the widening is lossy in the one
      // place it matters. Every symbol of every declared file goes into
      // `expectedSymbols` below, which is what makes two plans comparable —
      // and what would make a holder claim every function in a file it
      // shares, leaving a co-editor the gaps between them. Symbol-level
      // withholding reads this instead.
      //
      // The first enrichment wins: running twice must not record the widened
      // set as though the agent had asked for it.
      // Every list, not just the symbols. All of them are widened below from
      // the contents of the declared files, and all of them are read
      // somewhere as a claim — so all of them need the agent's own words kept.
      declared: plan.declared ?? {
        symbols: [...plan.expectedSymbols],
        // Widened below with every file this plan's files import and every
        // symbol they reference, so the agent's own list has to be kept: an
        // enriched dependency crossing another plan's resources is worth
        // twenty-five points, and neither agent asked for any of it.
        dependencies: [...plan.dependencies],
        apis: [...(plan.expectedApis ?? [])],
        schemas: [...(plan.expectedSchemas ?? [])],
        configKeys: [...(plan.expectedConfigKeys ?? [])],
        tests: [...(plan.expectedTests ?? [])],
        services: [...(plan.expectedServices ?? [])],
      },
      expectedSymbols: uniqueStrings([
        ...plan.expectedSymbols,
        ...files.flatMap((file) => file.symbols),
      ]),
      expectedApis: uniqueStrings([
        ...(plan.expectedApis ?? []),
        ...files.flatMap((file) => file.apis),
      ]),
      expectedSchemas: uniqueStrings([
        ...(plan.expectedSchemas ?? []),
        ...files.flatMap((file) => file.schemas),
      ]),
      expectedConfigKeys: uniqueStrings([
        ...(plan.expectedConfigKeys ?? []),
        ...files.flatMap((file) => file.configKeys),
      ]),
      expectedTests: uniqueStrings([
        ...(plan.expectedTests ?? []),
        ...files.flatMap((file) => file.tests),
        ...files
          .filter((file) => TEST_FILE_PATH.test(file.path))
          .map((file) => file.path),
      ]),
      expectedServices: uniqueStrings([
        ...(plan.expectedServices ?? []),
        ...files.flatMap((file) => file.services),
      ]),
      dependencies: uniqueStrings([
        ...plan.dependencies,
        ...dependencyFiles,
        ...files.flatMap((file) => file.dependencies),
        ...files.flatMap((file) => file.referencedSymbols.map((symbol) => `symbol:${symbol}`)),
      ]),
      intent: plan.intent ?? plan.objective,
    };
    enriched.expectedFiles = uniqueRepositoryPaths(enriched.expectedFiles);
    return enriched;
  }

  public changedSymbols(
    changedFiles: readonly string[],
    index: RepositoryIndex,
  ): string[] {
    return this.changedResources(changedFiles, index).symbols;
  }

  public changedResources(
    changedFiles: readonly string[],
    index: RepositoryIndex,
  ): ChangedResources {
    const changed = new Set(changedFiles);
    const files = index.files.filter((file) => changed.has(file.path));
    return {
      symbols: uniqueStrings(files.flatMap((file) => file.symbols)),
      apis: uniqueStrings(files.flatMap((file) => file.apis)),
      schemas: uniqueStrings(files.flatMap((file) => file.schemas)),
      configKeys: uniqueStrings(files.flatMap((file) => file.configKeys)),
      tests: uniqueStrings(files.flatMap((file) => file.tests)),
      services: uniqueStrings(files.flatMap((file) => file.services)),
    };
  }

  public clear(repositoryId?: string): void {
    if (repositoryId === undefined) {
      this.cache.clear();
      return;
    }
    for (const [key, index] of this.cache) {
      if (index.repositoryId === repositoryId) {
        this.cache.delete(key);
      }
    }
  }
}
