/**
 * Deterministic randomness for the property tests.
 *
 * Seeded so a convergence failure reproduces exactly: the seed is printed in
 * every assertion message, and re-running with it replays the same edit
 * interleaving. Not exported from the package index — this is test scaffolding
 * that happens to need compiling alongside the sources.
 */

import { OperationBuilder, type TextOperation } from "./text-operation.js";

/** mulberry32: small, fast, and good enough to shake out transform bugs. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const ALPHABET = "abcdefgh \n\t{}();";

export function randomText(random: () => number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    const position = Math.floor(random() * ALPHABET.length);
    text += ALPHABET[position] ?? "a";
  }
  return text;
}

/**
 * Builds a random operation over `text`. Insertions do not advance through the
 * base document, so the loop is bounded by a step count as well as by length.
 */
export function randomOperation(
  random: () => number,
  text: string,
): TextOperation {
  const builder = new OperationBuilder();
  let index = 0;
  let steps = 0;
  while (index < text.length && steps < 200) {
    steps += 1;
    const remaining = text.length - index;
    const chunk = 1 + Math.floor(random() * Math.min(remaining, 8));
    const choice = random();
    if (choice < 0.45) {
      builder.retain(chunk);
      index += chunk;
    } else if (choice < 0.75) {
      builder.delete(chunk);
      index += chunk;
    } else {
      builder.insert(randomText(random, 1 + Math.floor(random() * 5)));
    }
  }
  builder.retain(text.length - index);
  if (random() < 0.3) {
    builder.insert(randomText(random, 1 + Math.floor(random() * 4)));
  }
  return builder.build();
}
