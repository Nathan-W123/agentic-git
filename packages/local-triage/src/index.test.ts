import assert from "node:assert/strict";
import test from "node:test";

import {
  CHATTER_PROTOTYPES,
  createChatterFilter,
  WORK_PROTOTYPES,
  speakerIsActor,
  type Embedder,
} from "./index.js";

/**
 * A filter that is allowed to be wrong in exactly one direction.
 *
 * Saying "chatter" about a request costs somebody an answer they have to ask
 * for again by @mentioning an agent. Saying "not sure" about actual chatter
 * costs one cheap model call. Everything below is about keeping the failures
 * on the second side, including every kind of breakage.
 */

/**
 * Embeds by hand, so the logic can be tested without a model.
 *
 * Two dimensions: the first is how much a text sounds like conversation, the
 * second how much it sounds like work. Prototypes get a pure axis each, and
 * a probe gets whatever the map says.
 */
function fakeEmbedder(scores: Record<string, [number, number]>): Embedder {
  return async (texts) =>
    texts.map((text) => {
      if (CHATTER_PROTOTYPES.includes(text)) {
        return [1, 0];
      }
      if (WORK_PROTOTYPES.includes(text)) {
        return [0, 1];
      }
      return scores[text] ?? [0, 0];
    });
}

test("only a decisive answer drops a message", async () => {
  const filter = createChatterFilter({
    margin: 0.2,
    embedder: fakeEmbedder({
      "good morning all": [0.9, 0.1],
      "fix the retry loop": [0.1, 0.9],
      // Nearer chatter, but not by the margin. This is the case the filter
      // exists to hand on rather than answer.
      "the build is fixed now": [0.6, 0.5],
    }),
  });

  assert.equal(await filter.readsAsChatter("good morning all"), true);
  assert.equal(await filter.readsAsChatter("fix the retry loop"), false);
  assert.equal(
    await filter.readsAsChatter("the build is fixed now"),
    false,
    "a close call belongs to the agent, not to this",
  );
});

test("a model that will not load lets everything through", async () => {
  // The control plane has to boot on a machine ONNX has no binary for, and a
  // room on that machine has to behave exactly as it did before this existed.
  const filter = createChatterFilter({
    margin: 0.2,
    embedder: async () => {
      throw new Error("no runtime for this platform");
    },
  });
  assert.equal(await filter.available(), false);
  assert.equal(await filter.readsAsChatter("good morning all"), false);
});

test("an embedding that throws mid-message lets that message through", async () => {
  let calls = 0;
  const filter = createChatterFilter({
    margin: 0.2,
    embedder: async (texts) => {
      calls += 1;
      if (calls > 1) {
        throw new Error("inference failed");
      }
      return texts.map((text) =>
        CHATTER_PROTOTYPES.includes(text) ? [1, 0] : [0, 1],
      );
    },
  });
  assert.equal(await filter.readsAsChatter("good morning all"), false);
});

test("the prototypes are embedded once, not once per message", async () => {
  let batches = 0;
  const filter = createChatterFilter({
    margin: 0.2,
    embedder: async (texts) => {
      batches += 1;
      return texts.map((text) =>
        CHATTER_PROTOTYPES.includes(text)
          ? [1, 0]
          : WORK_PROTOTYPES.includes(text)
            ? [0, 1]
            : [0.9, 0.1],
      );
    },
  });
  await Promise.all([
    filter.readsAsChatter("hello"),
    filter.readsAsChatter("morning"),
    filter.readsAsChatter("hey"),
  ]);
  // One for the prototypes, then one per message. Loading them per message
  // would make the cheap path cost more than the model call it replaces.
  assert.equal(batches, 4);
});

test("a message does not wait for a model that is still loading", async () => {
  // Loading is an import, a download the first time, and an ONNX session.
  // Whatever it costs, it is not allowed to be what a room is waiting on:
  // the message goes to the agent, and the load carries on behind it.
  let release: () => void = () => {};
  const loaded = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  const embed = (texts: readonly string[]): number[][] =>
    texts.map((text) =>
      CHATTER_PROTOTYPES.includes(text)
        ? [1, 0]
        : WORK_PROTOTYPES.includes(text)
          ? [0, 1]
          : [0.9, 0.1],
    );
  const filter = createChatterFilter({
    margin: 0.2,
    warmupBudgetMs: 10,
    embedder: async (texts) => {
      // The prototype pass is the load. Messages arriving during it must not
      // queue behind it.
      if (CHATTER_PROTOTYPES.includes(texts[0] ?? "")) {
        await loaded;
      }
      return embed(texts);
    },
  });

  assert.equal(
    await filter.readsAsChatter("good morning all"),
    false,
    "a message that arrives mid-load belongs to the agent, not to a queue",
  );

  release();
  assert.equal(await filter.available(), true);
  // And the work was not thrown away: the next message finds it ready.
  assert.equal(await filter.readsAsChatter("good morning all"), true);
});

test("a message does not wait indefinitely for its own embedding", async () => {
  const filter = createChatterFilter({
    margin: 0.2,
    decisionBudgetMs: 10,
    embedder: async (texts) => {
      if (CHATTER_PROTOTYPES.includes(texts[0] ?? "")) {
        return texts.map((text) =>
          CHATTER_PROTOTYPES.includes(text) ? [1, 0] : [0, 1],
        );
      }
      // A wedged inference session: never answers, never fails.
      return await new Promise<number[][]>(() => {});
    },
  });
  assert.equal(await filter.readsAsChatter("good morning all"), false);
});

test("an empty message is not classified at all", async () => {
  const filter = createChatterFilter({
    margin: 0.2,
    embedder: fakeEmbedder({}),
  });
  assert.equal(await filter.readsAsChatter("   "), false);
});

/**
 * The real model, on the messages a word list could not tell apart.
 *
 * Skipped where the model cannot be fetched or run — an offline build, a
 * platform without an ONNX binary — because the filter is optional by
 * design and a test for it must not be the thing that fails.
 */
test("the model separates conversation from requests", async (t) => {
  const filter = createChatterFilter();
  if (!(await filter.available())) {
    t.skip("the embedding model is not available in this environment");
    return;
  }

  // Every one of these is conversation, and several contain the exact verbs
  // a task-verb list matched on.
  for (const chatter of [
    "hi Ethan",
    "thanks!",
    "got it",
    "yo what's up",
    "the update went out this morning",
    "I finished the readme yesterday",
    "any update on the release?",
  ]) {
    assert.equal(
      await filter.readsAsChatter(chatter),
      true,
      `"${chatter}" should not have cost a model call`,
    );
  }

  // And none of these is dropped — including the two shapes that matter
  // most: the one that shares its words with the chatter above, and the
  // remark that only implies work.
  for (const work of [
    "update the readme",
    "change the background on settings to blue",
    "it looks like the background doesn't look great with gray",
    "can someone start building a chess engine",
    "audit the codebase for unused deps",
    "fix the login redirect",
    "this dropdown is broken on safari",
    // Work handed to the room rather than to a person. A task-verb list
    // missed all of these, because "own", "takers" and "a hand" describe
    // delegation and not the operation — and they are exactly the messages a
    // room most wants picked up.
    "any takers for the flaky auth ticket?",
    "who can own the release checklist?",
    "could someone take a look at the checkout failure?",
    "we could use a hand with the database migration",
    "looking for someone to pick up the accessibility pass",
  ]) {
    assert.equal(
      await filter.readsAsChatter(work),
      false,
      `"${work}" must reach the agent`,
    );
  }
});

/**
 * The real model, on messages a real deployment got wrong.
 *
 * Both prototype lists are the model's entire definition of what a channel
 * sounds like, so a gap in them is a gap in the product — and the gaps are not
 * guessable. These are the messages that found them, with the leans that were
 * measured before the prototypes were added:
 *
 *   "my name also appears right under the agent tab, that
 *    should be all the way at the bottom"                     -0.052  (live)
 *   "the agent tab shows the wrong thing at the bottom"       -0.029
 *   "people should be listed at the bottom, not under agents" -0.037
 *   "that was my fault, sorry"                                +0.111
 *
 * Appearance and behaviour were already covered — "the send button is the
 * wrong colour" scored +0.246 — so the list knew what a bug looks like and
 * what a bug does, and nothing about where a bug is. The apology is the mirror
 * gap: it names a fault, and every other way of naming a fault was work.
 *
 * Skipped where the model cannot be fetched or run, like its neighbour above:
 * the filter is optional by design and a test for it must not be the thing
 * that fails.
 */
test("the model reads placement complaints as work and apologies as conversation", async (t) => {
  const filter = createChatterFilter();
  if (!(await filter.available())) {
    t.skip("the embedding model is not available in this environment");
    return;
  }

  for (const work of [
    // The live message, verbatim.
    "my name also appears right under the agent tab, that should be all the way at the bottom with the other person",
    "the agent tab shows the wrong thing at the bottom",
    "people should be listed at the bottom, not under agents",
    "the pinned tab is above the channels, it should be below",
    // And the shapes that already worked, which must not regress.
    "the send button is the wrong colour",
    "the dropdown closes when you click inside it",
    "there is no way to unpin a message from the pinned sidetab",
  ]) {
    assert.equal(
      await filter.readsAsWork(work),
      true,
      `should read as work: ${work}`,
    );
  }

  for (const chatter of [
    "that was my fault, sorry",
    "my mistake, ignore that",
    "thanks, that helps",
    "good morning everyone",
    "congrats on shipping that",
    "i'm heading out, back in an hour",
  ]) {
    assert.equal(
      await filter.readsAsWork(chatter),
      false,
      `should not read as work: ${chatter}`,
    );
  }
});

/**
 * The four that actually did this, in a live channel, to real people.
 *
 * Each was an ordinary remark between two humans; each was dispatched to an
 * agent that then had to be stopped by hand. They are pinned literally rather
 * than paraphrased because the point is not that this shape of sentence is
 * handled — it is that *these sentences* were not.
 */
test("a remark about what the speaker is doing is not a request", () => {
  for (const said of [
    "I can probably wire back api pretty easily",
    "Claude is saying ur running old code that's why u can't connect",
    "im working on the accel applications - but i still think another way " +
      "of connecting it is necessary, think a nice duolingo-esque onboarding " +
      "experience",
    "we shipped 0.5.9 just now",
    "I'll push a fix after this call",
    "I already fixed that one yesterday",
    "I've been debugging the windows runner for an hour",
    "sounds like a caching issue on his end",
    "he said the dialog looked the same",
    "turns out it was the old build all along",
    "I think the onboarding could be smoother honestly",
  ]) {
    assert.equal(speakerIsActor(said), true, said);
  }

  // The fourth of them, and it is not caught here — recorded rather than
  // quietly dropped from the list. "Uninstall isnt needed just install" has
  // no subject at all: it is an imperative, and it is grammatically identical
  // to "remove the unused imports". What separates them is that one is about
  // somebody's laptop and the other about the repository, and that is subject
  // matter — the thing a word list was already removed from this path for
  // trying to enumerate. It still reaches the embedding, which reads it as
  // work (+0.186). Catching it needs a signal nobody has measured yet, and
  // guessing at one here would risk the recall the test below pins.
  assert.equal(speakerIsActor("Uninstall isnt needed just install"), false);
});

/**
 * And it costs no requests, which is the whole reason it is allowed to run
 * in front of the model rather than after it.
 *
 * A request for work does not have the person asking as its subject: it is an
 * imperative, or it addresses somebody, or it describes the product. None of
 * those are first person, so a rule about first person cannot reach them.
 */
test("a request for work is never read as the speaker acting", () => {
  for (const asked of [
    "please add a way to unpin a message from the pinned sidetab",
    "can you fix the retry loop",
    "the send button is the wrong colour",
    "add a dark mode toggle to settings",
    "the sidebar sections are in a strange order",
    "look into why the windows tests hang",
    "we should refactor the auth module",
    "remove the unused imports in that module",
    "my name is listed under the agents section instead of with the people",
    "audit the codebase for unused dependencies",
    "the login page loads far too slowly",
    "can someone add keyboard shortcuts to the chat",
    "migrate the sessions table to postgres",
    "the avatars are squashed on mobile",
    "investigate the memory leak in the worker",
    "the pinned tab should show newest first",
    "build a proper onboarding wizard",
    "the dropdown closes when you click inside it",
  ]) {
    assert.equal(speakerIsActor(asked), false, asked);
  }
});
