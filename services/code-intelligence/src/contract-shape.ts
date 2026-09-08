/**
 * The written shape of an exported declaration — its contract, not its name.
 *
 * The index has always recorded *which* symbols a file exports. That is enough
 * to notice two branches editing one symbol, and blind to the case that
 * actually breaks a build after a clean merge: one branch changes
 * `password: string` to `password: number`, another goes on calling it with a
 * string, Git reports no conflict because no line either of them wrote
 * disagrees, and the name — the only thing recorded — is identical on both
 * sides. Nothing anywhere could tell those two branches apart from two
 * branches that never met.
 *
 * So a shape is the declaration reduced to what a caller depends on: the
 * parameters and their types, the return type, the members of an interface,
 * the values of an enum. Formatting, comments and member order are removed,
 * because none of them is a contract and a reformat is not a breaking change.
 * Two digests differ exactly when the written contract differs.
 *
 * **Written is the operative word, and the limit worth stating.** This reads
 * the syntax tree, not a type checker: there is no program here, no imports
 * resolved, no inference. `export function next() { return 1 }` has no written
 * return type, and this says so — `inferred` — rather than recording "returns
 * nothing" and calling a later change to `return "1"` no change at all. An
 * unknown is the one answer that must never be mistaken for an answer, which
 * is the same rule `symbolRangesUnknown` follows a few files away.
 */

import { createHash } from "node:crypto";

import ts from "typescript";

/** What a declaration is, coarsely — enough to read a diff by. */
export type ShapeKind =
  | "function"
  | "interface"
  | "type"
  | "class"
  | "enum"
  | "variable";

export interface SymbolShape {
  symbol: string;
  kind: ShapeKind;
  /**
   * The contract as somebody reads it: `(password: string): string`.
   *
   * Normalized against formatting, comments and member order, and otherwise
   * left legible — this is what a warning shows, and `(:string): string` is
   * not something to put in front of a person.
   */
  shape: string;
  /**
   * What actually decides whether the contract moved.
   *
   * Hashed from a stricter form than {@link shape}: parameter *names* are
   * stripped, because a caller passes by position and renaming an argument
   * cannot break one. Two fields rather than one because they have different
   * jobs — this one has to be exactly the contract, that one has to be
   * readable, and a single string cannot be both.
   */
  digest: string;
  /**
   * Set when part of the contract is left to inference and so is invisible
   * here — an unannotated return type, a `const` with no type.
   *
   * A consumer of an inferred symbol cannot be told its contract changed,
   * because nothing written down did. Recorded rather than hidden so a
   * warning can say "this one is not being watched" instead of implying a
   * silence it has not earned.
   */
  inferred?: boolean;
}

/** Comments and whitespace are not contract. */
function normalize(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/\/\/[^\n]*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function typeText(node: ts.TypeNode | undefined, file: ts.SourceFile): string {
  return node === undefined ? "" : normalize(node.getText(file));
}

function typeParameters(
  node: {
    typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> | undefined;
  },
  file: ts.SourceFile,
): string {
  const declared = node.typeParameters;
  if (declared === undefined || declared.length === 0) {
    return "";
  }
  return `<${declared.map((entry) => normalize(entry.getText(file))).join(", ")}>`;
}

/**
 * One parameter. Named for a reader, unnamed for the comparison.
 *
 * Renaming a parameter changes nothing for a positional caller, and a rename
 * that invalidated every consumer would make the whole mechanism something
 * people learn to click past. Optionality and rest are kept in both: each
 * changes what a call may legally be.
 */
function parameter(
  node: ts.ParameterDeclaration,
  file: ts.SourceFile,
  named: boolean,
): string {
  const rest = node.dotDotDotToken === undefined ? "" : "...";
  const optional =
    node.questionToken !== undefined || node.initializer !== undefined ? "?" : "";
  const type = typeText(node.type, file) || "?";
  const name =
    named && ts.isIdentifier(node.name) ? normalize(node.name.getText(file)) : "";
  return `${rest}${name}${optional}: ${type}`;
}

function parameters(
  node: { parameters: ts.NodeArray<ts.ParameterDeclaration> },
  file: ts.SourceFile,
  named: boolean,
): string {
  return `(${node.parameters
    .map((entry) => parameter(entry, file, named))
    .join(", ")})`;
}

/** A member of an interface, a type literal, or a class's public surface. */
function member(
  node: ts.TypeElement | ts.ClassElement,
  file: ts.SourceFile,
  named: boolean,
): string {
  const name =
    "name" in node && node.name !== undefined
      ? normalize(node.name.getText(file))
      : "";
  if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
    const optional = node.questionToken === undefined ? "" : "?";
    return `${name}${optional}: ${typeText(node.type, file) || "?"}`;
  }
  if (ts.isMethodSignature(node) || ts.isMethodDeclaration(node)) {
    const optional =
      "questionToken" in node && node.questionToken !== undefined ? "?" : "";
    return `${name}${optional}${typeParameters(node, file)}${parameters(node, file, named)}: ${typeText(node.type, file) || "?"}`;
  }
  if (ts.isConstructorDeclaration(node)) {
    return `constructor${parameters(node, file, named)}`;
  }
  if (ts.isIndexSignatureDeclaration(node)) {
    return `[index]${parameters(node, file, named)}: ${
      typeText(node.type, file) || "?"
    }`;
  }
  if (ts.isCallSignatureDeclaration(node)) {
    return `()${parameters(node, file, named)}: ${
      typeText(node.type, file) || "?"
    }`;
  }
  // Getters and setters are a property to whoever reads them, and anything
  // else is printed whole rather than dropped: an unrecognised member that
  // vanished from the shape would be a contract change nobody could see.
  return normalize(node.getText(file));
}

/** Whether a class member is part of what callers can reach. */
function isPublic(node: ts.ClassElement): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !(modifiers ?? []).some(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword ||
      modifier.kind === ts.SyntaxKind.ProtectedKeyword,
  );
}

/**
 * Members, one per line, sorted.
 *
 * Sorted because moving a field is not a contract change and a mechanism that
 * invalidated consumers over a reorder would be one people route around.
 */
function members(entries: readonly string[]): string {
  return [...entries].sort((left, right) => left.localeCompare(right)).join("; ");
}

function digestOf(shape: string): string {
  return createHash("sha256").update(shape).digest("hex").slice(0, 16);
}

function shaped(
  symbol: string,
  kind: ShapeKind,
  build: (named: boolean) => string,
  inferred: boolean,
): SymbolShape {
  return {
    symbol,
    kind,
    shape: build(true),
    digest: digestOf(`${kind} ${build(false)}`),
    ...(inferred ? { inferred: true } : {}),
  };
}

/**
 * The contract a declaration publishes, or `undefined` for a node that
 * publishes none this can read.
 *
 * `symbol` is passed in rather than read off the node because the name a file
 * exports something under is not always the name it was declared with —
 * `export { internal as public }` — and the caller is what knows which one it
 * is recording.
 */
export function shapeOf(
  node: ts.Node,
  symbol: string,
  file: ts.SourceFile,
): SymbolShape | undefined {
  if (ts.isFunctionDeclaration(node)) {
    return shaped(
      symbol,
      "function",
      (named) =>
        `${typeParameters(node, file)}${parameters(node, file, named)}: ${
          typeText(node.type, file) || "?"
        }`,
      node.type === undefined,
    );
  }
  if (ts.isInterfaceDeclaration(node)) {
    const heritage = (node.heritageClauses ?? [])
      .map((clause) => normalize(clause.getText(file)))
      .join(" ");
    return shaped(
      symbol,
      "interface",
      (named) =>
        `${typeParameters(node, file)}${
          heritage === "" ? "" : ` ${heritage}`
        } {${members(node.members.map((entry) => member(entry, file, named)))}}`,
      false,
    );
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return shaped(
      symbol,
      "type",
      () => `${typeParameters(node, file)} = ${typeText(node.type, file)}`,
      false,
    );
  }
  if (ts.isClassDeclaration(node)) {
    const heritage = (node.heritageClauses ?? [])
      .map((clause) => normalize(clause.getText(file)))
      .join(" ");
    // Only what a caller can reach. A private field is an implementation
    // detail, and treating a change to one as a contract change would put
    // every refactor of a class's insides in front of the same gate as a
    // change to its outside.
    return shaped(
      symbol,
      "class",
      (named) =>
        `${typeParameters(node, file)}${
          heritage === "" ? "" : ` ${heritage}`
        } {${members(
          node.members.filter(isPublic).map((entry) => member(entry, file, named)),
        )}}`,
      false,
    );
  }
  if (ts.isEnumDeclaration(node)) {
    // Declaration order, not sorted, and this is the one place that matters:
    // a member with no initializer takes its value from its position, so
    // moving one silently renumbers it and everything after it.
    return shaped(
      symbol,
      "enum",
      () =>
        `{${node.members
          .map((entry) => {
            const name = normalize(entry.name.getText(file));
            return entry.initializer === undefined
              ? name
              : `${name} = ${normalize(entry.initializer.getText(file))}`;
          })
          .join("; ")}}`,
      false,
    );
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    // The annotation, and nothing from the initializer. `export const limit =
    // 30` has no written type; what it is today is inference, and reading the
    // literal as the contract would make every value change a contract change
    // while still missing the ones that matter.
    return shaped(
      symbol,
      "variable",
      () => `: ${typeText(node.type, file) || "?"}`,
      node.type === undefined,
    );
  }
  return undefined;
}

/** One symbol whose written contract differs between two revisions. */
export interface ContractChange {
  file: string;
  symbol: string;
  kind: ShapeKind;
  before: string;
  after: string;
}

/**
 * Which exported contracts differ, comparing one revision's shapes to another.
 *
 * A symbol that has *gone* is a change and a symbol that has *arrived* is not:
 * removing an export breaks every consumer of it, and adding one cannot break
 * anybody, because nothing can be depending on a name that did not exist. The
 * asymmetry is the point — a mechanism that treated every new export as a
 * contract change would fire on every feature branch ever opened.
 */
export function contractChanges(
  before: ReadonlyMap<string, readonly SymbolShape[]>,
  after: ReadonlyMap<string, readonly SymbolShape[]>,
): ContractChange[] {
  const changes: ContractChange[] = [];
  for (const [file, was] of before) {
    const now = new Map(
      (after.get(file) ?? []).map((shape) => [shape.symbol, shape]),
    );
    for (const shape of was) {
      const current = now.get(shape.symbol);
      if (current === undefined) {
        changes.push({
          file,
          symbol: shape.symbol,
          kind: shape.kind,
          before: shape.shape,
          after: "(removed)",
        });
        continue;
      }
      if (current.digest !== shape.digest) {
        changes.push({
          file,
          symbol: shape.symbol,
          kind: current.kind,
          before: shape.shape,
          after: current.shape,
        });
      }
    }
  }
  return changes.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.symbol.localeCompare(right.symbol),
  );
}
