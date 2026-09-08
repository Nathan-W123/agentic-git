/**
 * Shapes: what has to differ, and what must not.
 *
 * The two failure modes are opposite and both fatal. A shape that misses a
 * real change lets the conflict this exists for through — which is where the
 * index already was, since a name never changes when a type does. A shape
 * that fires on a reformat, a rename of a parameter, or a reordered field
 * produces a mechanism people learn to click past, which is worse than not
 * having one: it spends the credibility that the real warnings need.
 */

import assert from "node:assert/strict";
import test from "node:test";

import ts from "typescript";

import { contractChanges, shapeOf, type SymbolShape } from "./contract-shape.js";

/** Every exported declaration in a snippet, shaped. */
function shapes(source: string): Map<string, SymbolShape> {
  const file = ts.createSourceFile(
    "sample.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found = new Map<string, SymbolShape>();
  const visit = (node: ts.Node): void => {
    const exported = ts.canHaveModifiers(node)
      ? (ts.getModifiers(node) ?? []).some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      : false;
    const named = (node as ts.NamedDeclaration).name;
    if (exported && named !== undefined && ts.isIdentifier(named)) {
      const shape = shapeOf(node, named.text, file);
      if (shape !== undefined) {
        found.set(shape.symbol, shape);
      }
    }
    if (
      ts.isVariableStatement(node) &&
      (ts.getModifiers(node) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    ) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const shape = shapeOf(declaration, declaration.name.text, file);
          if (shape !== undefined) {
            found.set(shape.symbol, shape);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function digest(source: string, symbol: string): string {
  const shape = shapes(source).get(symbol);
  assert.ok(shape !== undefined, `no shape for ${symbol}`);
  return shape.digest;
}

test("a type change is a different contract; a rename or a reformat is not", () => {
  // The case the whole thing exists for. Nothing about the *name* moved.
  assert.notEqual(
    digest("export function sign(password: string): string {}", "sign"),
    digest("export function sign(password: number): string {}", "sign"),
  );
  // The return type is half of a signature and is checked as such.
  assert.notEqual(
    digest("export function sign(p: string): string {}", "sign"),
    digest("export function sign(p: string): Promise<string> {}", "sign"),
  );

  // And the things that are not contract. A caller passes arguments by
  // position: renaming a parameter cannot break one, and a mechanism that
  // said it did would fire on every tidy-up anybody ever makes.
  assert.equal(
    digest("export function sign(password: string): string {}", "sign"),
    digest("export function sign(secret: string): string {}", "sign"),
  );
  // Formatting and comments, likewise.
  assert.equal(
    digest("export function sign(p: string): string {}", "sign"),
    digest(
      `export function sign(
         // the caller's own secret
         p: string,
       ): string {}`,
      "sign",
    ),
  );
});

test("optionality and rest change what a call may legally be", () => {
  const required = "export function f(a: string): void {}";
  assert.notEqual(digest(required, "f"), digest("export function f(a?: string): void {}", "f"));
  // A default makes a parameter optional to every caller, so it is the same
  // contract as `?` and a different one from neither.
  assert.equal(
    digest("export function f(a?: string): void {}", "f"),
    digest("export function f(a: string = 'x'): void {}", "f"),
  );
  assert.notEqual(digest(required, "f"), digest("export function f(...a: string[]): void {}", "f"));
  // Adding a parameter is a contract change even when it is optional: it is
  // not, but every implementation of the interface has to grow it.
  assert.notEqual(digest(required, "f"), digest("export function f(a: string, b?: number): void {}", "f"));
});

test("an interface changes on its fields, not on their order", () => {
  const original = "export interface User { id: string; email: string }";
  assert.notEqual(
    digest(original, "User"),
    digest("export interface User { id: number; email: string }", "User"),
  );
  // Optionality is a contract: a consumer reading `email` unconditionally
  // breaks when it becomes optional, and nothing textual would say so.
  assert.notEqual(
    digest(original, "User"),
    digest("export interface User { id: string; email?: string }", "User"),
  );
  // Order is not.
  assert.equal(
    digest(original, "User"),
    digest("export interface User { email: string; id: string }", "User"),
  );
  // Nor is a comment on a field.
  assert.equal(
    digest(original, "User"),
    digest(
      `export interface User {
         /** Stable for the life of the account. */
         id: string;
         email: string;
       }`,
      "User",
    ),
  );
  // What it extends is part of what it promises.
  assert.notEqual(
    digest(original, "User"),
    digest("export interface User extends Person { id: string; email: string }", "User"),
  );
});

test("a class publishes its public surface and hides the rest", () => {
  const original = `export class Session {
    private secret: string;
    public token(): string { return ""; }
  }`;
  // Rewriting the inside is not a contract change. Treating it as one would
  // put every refactor in front of the same gate as an interface change.
  assert.equal(
    digest(original, "Session"),
    digest(
      `export class Session {
         private secret: number;
         private cache = new Map();
         public token(): string { return ""; }
       }`,
      "Session",
    ),
  );
  assert.notEqual(
    digest(original, "Session"),
    digest(
      `export class Session {
         private secret: string;
         public token(): Promise<string> { return null as never; }
       }`,
      "Session",
    ),
  );
  // The constructor is how it is built, and every caller depends on it.
  assert.notEqual(
    digest(original, "Session"),
    digest(
      `export class Session {
         constructor(ttl: number) {}
         private secret: string;
         public token(): string { return ""; }
       }`,
      "Session",
    ),
  );
});

test("an enum's order is contract, because position is value", () => {
  // The one place sorting would be wrong: a member with no initializer takes
  // its number from where it sits, so moving one renumbers it and everything
  // after it — a change no name and no type records.
  assert.notEqual(
    digest("export enum Level { Low, High }", "Level"),
    digest("export enum Level { High, Low }", "Level"),
  );
  assert.notEqual(
    digest("export enum Level { Low = 1 }", "Level"),
    digest("export enum Level { Low = 2 }", "Level"),
  );
});

test("what is left to inference is marked, not silently called stable", () => {
  const inferred = shapes("export function next() { return 1; }").get("next");
  assert.equal(inferred?.inferred, true);
  // And the honest consequence: this cannot see the change, so the digest is
  // the same. The flag is what lets a warning say "not watched" rather than
  // implying a silence it has not earned.
  assert.equal(
    digest("export function next() { return 1; }", "next"),
    digest("export function next() { return 'one'; }", "next"),
  );

  const annotated = shapes("export function next(): number { return 1; }").get("next");
  assert.equal(annotated?.inferred, undefined);

  // A `const` with no annotation is the same story, and its value is
  // deliberately not part of the shape: reading the literal would make every
  // bumped constant a contract change while still missing the typed ones.
  const constant = shapes("export const LIMIT = 30;").get("LIMIT");
  assert.equal(constant?.inferred, true);
  assert.equal(
    digest("export const LIMIT = 30;", "LIMIT"),
    digest("export const LIMIT = 90;", "LIMIT"),
  );
  assert.notEqual(
    digest("export const LIMIT: number = 30;", "LIMIT"),
    digest("export const LIMIT: string = '30';", "LIMIT"),
  );
});

test("a diff names what moved, counts a removal, and ignores an arrival", () => {
  const before = new Map([["src/auth.ts", [...shapes(
    "export function sign(p: string): string {}\nexport interface User { id: string }\nexport type Gone = 1;",
  ).values()]]]);
  const after = new Map([["src/auth.ts", [...shapes(
    "export function sign(p: number): string {}\nexport interface User { id: string }\nexport type Fresh = 2;",
  ).values()]]]);

  const changes = contractChanges(before, after);
  assert.deepEqual(
    changes.map((change) => [change.symbol, change.after === "(removed)"]),
    [
      // Sorted by file then symbol, so a diff reads the same way twice.
      ["Gone", true],
      ["sign", false],
    ],
  );
  // `User` did not move and `Fresh` did not exist: adding an export cannot
  // break a consumer, because nothing can depend on a name that was not
  // there. A mechanism that reported every new export would fire on every
  // feature branch ever opened.
  assert.equal(
    changes.some((change) => ["User", "Fresh"].includes(change.symbol)),
    false,
  );
  const signed = changes.find((change) => change.symbol === "sign");
  assert.match(signed?.before ?? "", /string/u);
  assert.match(signed?.after ?? "", /number/u);
});

test("a file that has gone entirely takes its contracts with it", () => {
  const before = new Map([
    ["src/gone.ts", [...shapes("export function f(): void {}").values()]],
  ]);
  const changes = contractChanges(before, new Map());
  assert.deepEqual(
    changes.map((change) => [change.file, change.symbol, change.after]),
    [["src/gone.ts", "f", "(removed)"]],
  );
});

test("the shape is what a person reads; the digest is what decides", () => {
  const shape = shapes("export function sign(password: string): string {}").get("sign");
  // Two fields with two jobs. `(:string): string` is the right thing to
  // compare and the wrong thing to put in front of somebody.
  assert.equal(shape?.shape, "(password: string): string");
  // And the digest ignores the name, which is why the rename above is not a
  // change while everything in this file's first test still is.
  assert.equal(
    shape?.digest,
    shapes("export function sign(secret: string): string {}").get("sign")?.digest,
  );
  assert.notEqual(
    shape?.shape,
    shapes("export function sign(secret: string): string {}").get("sign")?.shape,
  );
});
