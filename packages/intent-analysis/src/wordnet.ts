import { readFileSync } from "node:fs";
import path from "node:path";

import database from "wordnet-db";

/**
 * A small reader for the WordNet 3.1 database files.
 *
 * The obvious move is to depend on `natural`, which wraps the same database.
 * It is not usable here: it pulls a dotenv implementation that writes banner
 * lines to stdout on import, and this library is loaded inside a coordinator
 * whose stdout is a protocol stream. The part of WordNet the intent signal
 * needs — the lemma index, synset words, and the antonym pointer — is a few
 * dozen lines of parsing against a file format that has been stable since
 * 2006, so it is read directly.
 *
 * The index files are ASCII-sorted by lemma and the data files are addressed
 * by byte offset, which is what WordNet's own format was designed for: a
 * lookup is a binary search plus one line read, and nothing has to be held in
 * a map. The files are read into buffers once, lazily, per part of speech.
 */

export type PartOfSpeech = "noun" | "verb" | "adj" | "adv";

const PARTS: readonly PartOfSpeech[] = ["noun", "verb", "adj", "adv"];

/** WordNet's own single-letter codes, as they appear inside pointer records. */
const POS_CODES: Record<string, PartOfSpeech> = {
  n: "noun",
  v: "verb",
  a: "adj",
  s: "adj",
  r: "adv",
};

interface Synset {
  words: string[];
  /** Antonym pointers: `[targetPos, targetOffset, targetWordNumber]`. */
  antonyms: Array<[PartOfSpeech, number, number]>;
}

function normalize(word: string): string {
  return word.toLowerCase().replaceAll(" ", "_");
}

/** WordNet writes multi-word entries with underscores; readers expect spaces. */
function present(word: string): string {
  return word.replaceAll("_", " ").toLowerCase();
}

export class WordNet {
  private readonly directory: string;

  private readonly indexes = new Map<PartOfSpeech, Buffer>();

  private readonly data = new Map<PartOfSpeech, Buffer>();

  private readonly synonymCache = new Map<string, string[]>();

  private readonly antonymCache = new Map<string, string[]>();

  public constructor(directory: string = database.path) {
    this.directory = directory;
  }

  /** Whether the database files are present and readable. */
  public available(): boolean {
    try {
      this.index("noun");
      return true;
    } catch {
      return false;
    }
  }

  private index(pos: PartOfSpeech): Buffer {
    const cached = this.indexes.get(pos);
    if (cached !== undefined) {
      return cached;
    }
    const buffer = readFileSync(path.join(this.directory, `index.${pos}`));
    this.indexes.set(pos, buffer);
    return buffer;
  }

  private dataFile(pos: PartOfSpeech): Buffer {
    const cached = this.data.get(pos);
    if (cached !== undefined) {
      return cached;
    }
    const buffer = readFileSync(path.join(this.directory, `data.${pos}`));
    this.data.set(pos, buffer);
    return buffer;
  }

  /**
   * The line beginning at or after `from`, as text.
   *
   * Both file kinds are line-oriented and the license header at the top of
   * each is distinguished by a leading space, which is also how WordNet's own
   * tools skip it.
   */
  private lineAt(buffer: Buffer, from: number): { text: string; end: number } {
    const end = buffer.indexOf(0x0a, from);
    const stop = end === -1 ? buffer.length : end;
    return { text: buffer.toString("latin1", from, stop).trimEnd(), end: stop };
  }

  private startOfLine(buffer: Buffer, at: number): number {
    const previous = buffer.lastIndexOf(0x0a, at);
    return previous === -1 ? 0 : previous + 1;
  }

  /** Synset offsets for a lemma, by binary search over the sorted index. */
  private offsetsFor(lemma: string, pos: PartOfSpeech): number[] {
    const buffer = this.index(pos);
    const needle = normalize(lemma);
    let low = 0;
    let high = buffer.length;
    while (low < high) {
      const middle = this.startOfLine(buffer, (low + high) >> 1);
      if (middle < low) {
        break;
      }
      const { text, end } = this.lineAt(buffer, middle);
      const key = text.slice(0, text.indexOf(" "));
      if (key === needle) {
        const fields = text.split(" ").filter((field) => field.length > 0);
        // ...synset_cnt ... p_cnt [ptr_symbol...] sense_cnt tagsense_cnt off...
        const senseCount = Number.parseInt(fields[2] ?? "0", 10);
        return fields
          .slice(fields.length - senseCount)
          .map((offset) => Number.parseInt(offset, 10))
          .filter((offset) => Number.isFinite(offset));
      }
      if (key < needle) {
        low = end + 1;
      } else {
        high = middle;
      }
    }
    return [];
  }

  private synsetAt(pos: PartOfSpeech, offset: number): Synset | undefined {
    const buffer = this.dataFile(pos);
    if (offset < 0 || offset >= buffer.length) {
      return undefined;
    }
    const { text } = this.lineAt(buffer, offset);
    const [head] = text.split(" | ");
    const fields = (head ?? "").split(" ").filter((field) => field.length > 0);
    // offset lex_filenum ss_type w_cnt (word lex_id)* p_cnt (ptr)*
    const wordCount = Number.parseInt(fields[3] ?? "0", 16);
    if (!Number.isFinite(wordCount)) {
      return undefined;
    }
    const words: string[] = [];
    for (let n = 0; n < wordCount; n += 1) {
      const word = fields[4 + n * 2];
      if (word !== undefined) {
        words.push(word);
      }
    }
    let cursor = 4 + wordCount * 2;
    const pointerCount = Number.parseInt(fields[cursor] ?? "0", 10);
    cursor += 1;
    const antonyms: Array<[PartOfSpeech, number, number]> = [];
    for (let n = 0; n < pointerCount; n += 1) {
      const symbol = fields[cursor];
      const target = fields[cursor + 1];
      const targetPos = fields[cursor + 2];
      const link = fields[cursor + 3];
      cursor += 4;
      if (symbol !== "!" || target === undefined || targetPos === undefined) {
        continue;
      }
      const resolved = POS_CODES[targetPos];
      if (resolved === undefined) {
        continue;
      }
      // The second half of the source/target field is the 1-based index of
      // the word in the *target* synset the antonymy applies to; 00 means the
      // whole synset.
      const targetWord = Number.parseInt((link ?? "0000").slice(2), 16);
      antonyms.push([
        resolved,
        Number.parseInt(target, 10),
        Number.isFinite(targetWord) ? targetWord : 0,
      ]);
    }
    return { words, antonyms };
  }

  /**
   * Every word sharing a synset with `lemma`, in any part of speech.
   *
   * This is deliberately the full synonym set rather than the first sense.
   * The signal that uses it corroborates rather than decides — it asks whether
   * two intents could be naming the same thing — so recall matters more than
   * sense precision at this layer, and the embedding score is what discounts
   * a match that is technically a synonym but not the intended sense.
   */
  public synonyms(lemma: string): string[] {
    const key = normalize(lemma);
    const cached = this.synonymCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const found = new Set<string>();
    for (const pos of PARTS) {
      for (const offset of this.offsetsFor(key, pos)) {
        const synset = this.synsetAt(pos, offset);
        for (const word of synset?.words ?? []) {
          found.add(present(word));
        }
      }
    }
    found.delete(present(key));
    const result = [...found].sort();
    this.synonymCache.set(key, result);
    return result;
  }

  /**
   * Words WordNet records as direct antonyms of `lemma`.
   *
   * This replaces a hand-written list of ten opposing pairs. That list was
   * the reason the shipped signal could not see the opposition in "enable
   * free delivery" against "charge for delivery": the pair it needed was not
   * one of the ten, and no list of ten is going to be.
   */
  public antonyms(lemma: string): string[] {
    const key = normalize(lemma);
    const cached = this.antonymCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const found = new Set<string>();
    for (const pos of PARTS) {
      for (const offset of this.offsetsFor(key, pos)) {
        const synset = this.synsetAt(pos, offset);
        for (const [targetPos, targetOffset, wordNumber] of synset?.antonyms ??
          []) {
          const target = this.synsetAt(targetPos, targetOffset);
          if (target === undefined) {
            continue;
          }
          const words =
            wordNumber > 0
              ? [target.words[wordNumber - 1]].filter(
                  (word): word is string => word !== undefined,
                )
              : target.words;
          for (const word of words) {
            found.add(present(word));
          }
        }
      }
    }
    const result = [...found].sort();
    this.antonymCache.set(key, result);
    return result;
  }
}

let shared: WordNet | undefined;

/** The process-wide database handle; the file buffers are worth sharing. */
export function wordNet(): WordNet {
  shared ??= new WordNet();
  return shared;
}
