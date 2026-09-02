import assert from "node:assert/strict";
import test from "node:test";

import type { CoordinationStore, SubmittedTask } from "@coord/persistence";

import { createMcpTools, type McpAgent, type McpToolDeps } from "./mcp-tools.js";

/**
 * The decisions these tools make, without an HTTP server underneath them.
 *
 * `server.test.ts` covers the wiring — the token, the missing `Origin` header,
 * a message really reaching a channel. What is here is the part that has to be
 * right when the control plane answers something unexpected, which is exactly
 * what a live gateway is bad at arranging on demand.
 */

const AGENTS: McpAgent[] = [
  { name: "Claude (Nathan)", online: false, owner: "Nathan" },
  { name: "Codex (Sam)", online: true, owner: "Sam" },
];

function deps(overrides: Partial<McpToolDeps> = {}): {
  deps: McpToolDeps;
  posted: Array<{ content: string; channel?: string }>;
} {
  const posted: Array<{ content: string; channel?: string }> = [];
  return {
    posted,
    deps: {
      store: {} as CoordinationStore,
      assertScope: () => undefined,
      listRepositories: async () => [
        {
          projectId: "project_local",
          repository: { id: "payments", path: "/tmp/payments", branch: "main" },
          agents: AGENTS,
        },
      ],
      agentsIn: async () => AGENTS,
      post: async (input) => {
        posted.push({
          content: input.content,
          ...(input.channel === undefined ? {} : { channel: input.channel }),
        });
        return { taskIds: ["task_1"], channelSlug: "general" };
      },
      describeState: (status) => status,
      progressFor: async () => [],
      outcomeFor: async () => undefined,
      ...overrides,
    },
  };
}

function tool(name: string, overrides: Partial<McpToolDeps> = {}) {
  const built = deps(overrides);
  const found = createMcpTools(built.deps).find((entry) => entry.name === name);
  assert.ok(found, `no tool called ${name}`);
  return { run: found.run.bind(found), posted: built.posted };
}

const submit = {
  repository: "payments",
  agent: "Codex (Sam)",
  objective: "raise the retry ceiling",
};

test("an agent name is matched however the model capitalised it", async () => {
  // A model echoes back whatever `list_repositories` showed it, and a person
  // typing freehand matches nothing exactly.
  const { run, posted } = tool("submit_task");
  const said = await run({ ...submit, agent: "codex (sam)" });
  assert.equal(said.isError, undefined);
  assert.equal(posted.length, 1);
  assert.match(posted[0]?.content ?? "", /^@Codex \(Sam\) raise the retry/u);
});

test("a leading @ or # on an argument is taken off rather than doubled", async () => {
  const { run, posted } = tool("submit_task");
  await run({ ...submit, agent: "@Codex (Sam)", channel: "#build" });
  assert.match(posted[0]?.content ?? "", /^@Codex \(Sam\) /u);
  assert.equal(posted[0]?.channel, "build");
});

/**
 * The guard that stops "sent" being a lie.
 *
 * A message can land in a channel and start nothing — dispatch refuses a
 * personal agent, or the roster moved between being read and being dispatched
 * against. From the room that is visible; from an editor the only thing the
 * person sees is this sentence, so it has to be the true one.
 */
test("a post that started nothing is reported as a failure, not a task", async () => {
  const { run } = tool("submit_task", {
    post: async () => ({ taskIds: [], channelSlug: "general" }),
  });
  const said = await run(submit);
  assert.equal(said.isError, true);
  assert.match(said.content[0]?.text ?? "", /no task started/iu);
  assert.doesNotMatch(
    said.content[0]?.text ?? "",
    /Task task_/u,
    "quoted a task id it never received",
  );
});

test("reroute sends it to the other agent, and says who it went to", async () => {
  const { run, posted } = tool("submit_task");
  const said = await run({
    ...submit,
    agent: "Claude (Nathan)",
    when_offline: "reroute",
    reroute_to: "Codex (Sam)",
  });
  assert.equal(said.isError, undefined);
  // Rewritten the way the room's own prompt rewrites it: the mention moves,
  // the rest of the sentence does not.
  assert.equal(posted[0]?.content, "@Codex (Sam) raise the retry ceiling");
  assert.match(said.content[0]?.text ?? "", /@Codex \(Sam\)/u);
});

test("reroute without a target is refused before anything is posted", async () => {
  const { run, posted } = tool("submit_task");
  await assert.rejects(
    async () =>
      await run({ ...submit, agent: "Claude (Nathan)", when_offline: "reroute" }),
    /reroute_to is required/u,
  );
  assert.deepEqual(posted, []);

  const { run: second, posted: none } = tool("submit_task");
  const said = await second({
    ...submit,
    agent: "Claude (Nathan)",
    when_offline: "reroute",
    reroute_to: "Nobody",
  });
  assert.equal(said.isError, true);
  assert.deepEqual(none, []);
});

test("an offline agent that came back is simply used", async () => {
  // The liveness window is three minutes wide and the answer is re-checked on
  // the second call. Somebody who opened their laptop while being asked should
  // not have their work queued for a machine that is now listening.
  const { run } = tool("submit_task", {
    agentsIn: async () => [{ name: "Claude (Nathan)", online: true, owner: "Nathan" }],
  });
  const said = await run({ ...submit, agent: "Claude (Nathan)", when_offline: "queue" });
  assert.match(said.content[0]?.text ?? "", /running on their machine now/u);
});

test("an ambiguous repository name is refused rather than guessed", async () => {
  const twice: McpToolDeps["listRepositories"] = async () => [
    {
      projectId: "project_a",
      repository: { id: "payments", path: "/a", branch: "main" },
      agents: AGENTS,
    },
    {
      projectId: "project_b",
      repository: { id: "Payments", path: "/b", branch: "main" },
      agents: AGENTS,
    },
  ];
  const { run, posted } = tool("submit_task", { listRepositories: twice });
  // An exact match still wins — ambiguity is only ambiguity when nothing is
  // exact.
  assert.equal((await run(submit)).isError, undefined);
  assert.equal(posted.length, 1);

  // A bad argument throws rather than returning a refusal; `handleMcpMessage`
  // turns it into the same `isError` result on the way out, which is what
  // `mcp.test.ts` pins. What matters here is that it names both candidates and
  // posts nothing.
  const { run: loose, posted: nothing } = tool("submit_task", {
    listRepositories: twice,
  });
  await assert.rejects(
    async () => await loose({ ...submit, repository: "PAYMENTS" }),
    (error: Error) =>
      /more than one repository/u.test(error.message) &&
      /project_a/u.test(error.message) &&
      /project_b/u.test(error.message),
  );
  assert.deepEqual(nothing, [], "dispatched into a guessed repository");
});

test("task_status folds progress and outcome into one answer", async () => {
  const task: SubmittedTask = {
    id: "task_1",
    kind: "task",
    repositoryId: "payments",
    objective: "raise the retry ceiling",
    agentId: "anthropic",
    validationCommands: [],
    status: "claimed",
    submittedAt: new Date().toISOString(),
  } as unknown as SubmittedTask;
  const { run } = tool("task_status", {
    store: {
      getSubmittedTask: async () => task,
    } as unknown as CoordinationStore,
    describeState: () => "running now",
    progressFor: async () => ["reading src/retry.ts", "editing src/retry.ts"],
    outcomeFor: async () => undefined,
  });
  const said = await run({ task_id: "task_1" });
  const text = said.content[0]?.text ?? "";
  assert.match(text, /raise the retry ceiling/u);
  assert.match(text, /running now/u);
  assert.match(text, /editing src\/retry\.ts/u);
});
