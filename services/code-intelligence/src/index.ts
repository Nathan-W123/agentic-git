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

export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "json"
  | "yaml"
  | "sql"
  | "prisma";

export interface IndexedFile {
  path: string;
  language: SupportedLanguage;
  bytes: number;
  symbols: string[];
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

  const visit = (node: ts.Node): void => {
    const declaration = namedDeclaration(node);
    if (declaration !== undefined) {
      symbols.add(declaration);
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
  };
  visit(file);

  return {
    path: filePath,
    language,
    bytes: Buffer.byteLength(source),
    symbols: uniqueStrings([...symbols]),
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

    const maxFiles = this.options.maxFiles ?? 5_000;
    const maxFileBytes = this.options.maxFileBytes ?? 2 * 1024 * 1024;
    const maxTotalBytes = this.options.maxTotalBytes ?? 50 * 1024 * 1024;
    const repositoryFiles = await this.repositories.listFiles(repository, revision);
    const candidates = repositoryFiles.filter((filePath) =>
      SOURCE_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase()),
    );
    const files: IndexedFile[] = [];
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
        files.push(
          language === "typescript" || language === "javascript"
            ? analyzeScript(filePath, source, language)
            : analyzeDataFile(filePath, source, language),
        );
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
      truncated: skippedFiles > 0,
      skippedFiles,
    };
    this.cache.set(key, structuredClone(index));
    while (this.cache.size > (this.options.maxCacheEntries ?? 100)) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
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
