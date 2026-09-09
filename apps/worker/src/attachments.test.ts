import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { liftLocalImages } from "./attachments.js";

/** The eight bytes a PNG has to start with, and nothing else. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A workspace with the named files in it, and the paths outside it. */
async function workspace(
  files: Record<string, Buffer> = {},
): Promise<{ root: string; outside: string }> {
  const base = await mkdtemp(path.join(tmpdir(), "lift-"));
  const root = path.join(base, "workspace");
  await mkdir(root, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  return { root, outside: base };
}

/** An upload that always succeeds, recording what it was handed. */
function recorder(): {
  upload: (bytes: Buffer, contentType: string) => Promise<string>;
  calls: { bytes: number; contentType: string }[];
} {
  const calls: { bytes: number; contentType: string }[] = [];
  let next = 0;
  return {
    calls,
    upload: async (bytes, contentType) => {
      calls.push({ bytes: bytes.length, contentType });
      next += 1;
      return `${String(next).padStart(32, "0")}.png`;
    },
  };
}

test("a screenshot in the workspace becomes an attachment", async () => {
  const { root } = await workspace({ "shot.png": PNG });
  const { upload, calls } = recorder();
  const lifted = await liftLocalImages(
    "Here is the landing page: ![the hero](shot.png)",
    { workspacePath: root, upload },
  );
  assert.equal(
    lifted,
    "Here is the landing page: ![the hero](attachment:" +
      "00000000000000000000000000000001.png)",
  );
  assert.deepEqual(calls, [{ bytes: PNG.length, contentType: "image/png" }]);
});

test("a path outside the workspace is left as the agent wrote it", async () => {
  const { root, outside } = await workspace();
  await writeFile(path.join(outside, "secret.png"), PNG);
  const { upload, calls } = recorder();
  const text = "![secret](../secret.png) and ![absolute](/etc/logo.png)";
  assert.equal(await liftLocalImages(text, { workspacePath: root, upload }), text);
  // The whole point: nothing left the machine.
  assert.deepEqual(calls, []);
});

test("a remote image and an existing attachment are both untouched", async () => {
  const { root } = await workspace();
  const { upload, calls } = recorder();
  const text =
    "![web](https://example.com/a.png) ![stored](attachment:" +
    "0123456789abcdef0123456789abcdef.png)";
  assert.equal(await liftLocalImages(text, { workspacePath: root, upload }), text);
  assert.deepEqual(calls, []);
});

test("the same file named twice is uploaded once", async () => {
  const { root } = await workspace({ "shot.png": PNG });
  const { upload, calls } = recorder();
  const lifted = await liftLocalImages(
    "![a](shot.png) then again ![b](shot.png)",
    { workspacePath: root, upload },
  );
  assert.equal(calls.length, 1);
  assert.equal(
    lifted,
    "![a](attachment:00000000000000000000000000000001.png) then again " +
      "![b](attachment:00000000000000000000000000000001.png)",
  );
});

test("at most four images are lifted from one message", async () => {
  const files: Record<string, Buffer> = {};
  for (let i = 1; i <= 6; i += 1) {
    files[`shot-${String(i)}.png`] = PNG;
  }
  const { root } = await workspace(files);
  const { upload, calls } = recorder();
  const lifted = await liftLocalImages(
    [1, 2, 3, 4, 5, 6].map((i) => `![${String(i)}](shot-${String(i)}.png)`).join(" "),
    { workspacePath: root, upload },
  );
  assert.equal(calls.length, 4);
  // The two that did not fit read as the filenames they already were.
  assert.match(lifted, /!\[5\]\(shot-5\.png\)/u);
  assert.match(lifted, /!\[6\]\(shot-6\.png\)/u);
});

test("a marker whose file never appeared is left alone", async () => {
  const { root } = await workspace();
  const { upload, calls } = recorder();
  const text = "I could not take one: ![missing](shot.png)";
  assert.equal(await liftLocalImages(text, { workspacePath: root, upload }), text);
  assert.deepEqual(calls, []);
});

test("an oversized image is never read into memory", async () => {
  const { root } = await workspace({
    "huge.png": Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]),
  });
  const { upload, calls } = recorder();
  const text = "![huge](huge.png)";
  assert.equal(await liftLocalImages(text, { workspacePath: root, upload }), text);
  assert.deepEqual(calls, []);
});

test("a refused upload leaves the marker rather than losing the sentence", async () => {
  const { root } = await workspace({ "shot.png": PNG });
  const text = "Done: ![shot](shot.png)";
  assert.equal(
    await liftLocalImages(text, {
      workspacePath: root,
      upload: async () => undefined,
    }),
    text,
  );
});

test("a nested path inside the workspace is lifted", async () => {
  const { root } = await workspace({ "docs/img/chart.webp": PNG });
  const { upload } = recorder();
  const lifted = await liftLocalImages("![chart](docs/img/chart.webp)", {
    workspacePath: root,
    upload,
  });
  assert.match(lifted, /attachment:/u);
});

test("text with no image markers is returned without touching the disk", async () => {
  const { root } = await workspace();
  const text = "Nothing here, though I did read [the docs](docs/readme.md).";
  assert.equal(
    await liftLocalImages(text, {
      workspacePath: root,
      upload: async () => {
        throw new Error("should not upload");
      },
    }),
    text,
  );
});
