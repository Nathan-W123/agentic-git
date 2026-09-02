import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

/* Imported by URL for the reason `mcp-consent.test.ts` is: on Windows an
   absolute path is not a valid import specifier, and this suite runs on the
   Windows runner during a release build. `tenancy.mjs` is importable at all
   because it deliberately holds no Electron. */
const electronDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "electron",
);

interface Tenancy {
  organizationId: string;
  projectId?: string;
  projectName?: string;
  repositories?: number;
}

type GetJson = (server: string, token: string, route: string) => Promise<unknown>;

async function load(): Promise<{
  discoverTenancy: (server: string, token: string, getJson: GetJson) => Promise<Tenancy>;
}> {
  return (await import(
    pathToFileURL(path.join(electronDir, "tenancy.mjs")).href
  )) as unknown as {
    discoverTenancy: (server: string, token: string, getJson: GetJson) => Promise<Tenancy>;
  };
}

/**
 * A server with two organizations: the one signing up made for you, and the
 * one you were invited to. Both have a project; only the second has anywhere
 * to work.
 */
function serverWith(
  organizations: string[],
  repositoriesByProject: Record<string, number>,
  seen: string[] = [],
): GetJson {
  return async (_server, _token, route) => {
    seen.push(route);
    if (route === "/api/v1/organizations") {
      return { organizations: organizations.map((id) => ({ id, name: id })) };
    }
    const projects = /\/organizations\/([^/]+)\/projects$/u.exec(route);
    if (projects !== null) {
      const org = projects[1] ?? "";
      return { projects: [{ id: `project_of_${org}`, name: `Project of ${org}` }] };
    }
    const repositories = /\/projects\/([^/]+)\/repositories$/u.exec(route);
    if (repositories !== null) {
      const count = repositoriesByProject[repositories[1] ?? ""] ?? 0;
      return {
        repositories: Array.from({ length: count }, (_value, index) => ({
          id: `repo_${String(index)}`,
        })),
      };
    }
    throw new Error(`unexpected route ${route}`);
  };
}

/**
 * The bug this exists for.
 *
 * Signing up creates an organization, so everybody invited to a team belongs
 * to at least two — and both have a project, because signing up creates one of
 * those too. Taking whichever the server listed first put a running, healthy
 * machine in the wrong tenant: the control plane only looks for machines
 * inside the project's own organization, so its owner's agents stayed grey in
 * the room they had just been invited to, with the app cheerfully reporting
 * that it was running agents on this machine.
 */
test("a machine joins the organization that has work, not the first one listed", async () => {
  const { discoverTenancy } = await load();

  // Personal organization first, as the server may well list it.
  const chosen = await discoverTenancy(
    "https://kumi.example",
    "token",
    serverWith(
      ["org_personal", "org_team"],
      { project_of_org_personal: 0, project_of_org_team: 3 },
    ),
  );
  assert.equal(chosen.organizationId, "org_team");
  assert.equal(chosen.projectId, "project_of_org_team");

  // Order is not what decides it: the same answer with the team first.
  const reversed = await discoverTenancy(
    "https://kumi.example",
    "token",
    serverWith(
      ["org_team", "org_personal"],
      { project_of_org_personal: 0, project_of_org_team: 3 },
    ),
  );
  assert.equal(reversed.organizationId, "org_team");
});

test("one organization, or none with repositories, still resolves", async () => {
  const { discoverTenancy } = await load();

  // The ordinary single-tenant install, unchanged.
  const single = await discoverTenancy(
    "https://kumi.example",
    "token",
    serverWith(["org_local"], { project_of_org_local: 1 }),
  );
  assert.equal(single.organizationId, "org_local");
  assert.equal(single.projectId, "project_of_org_local");

  // Nobody has added a repository yet. Registering somewhere is still better
  // than refusing to start, so the first candidate carries it.
  const empty = await discoverTenancy(
    "https://kumi.example",
    "token",
    serverWith(["org_a", "org_b"], {}),
  );
  assert.equal(empty.organizationId, "org_a");
  assert.equal(empty.projectId, "project_of_org_a");
});

test("an organization that cannot be read is passed over, not fatal", async () => {
  const { discoverTenancy } = await load();
  const getJson: GetJson = async (_server, _token, route) => {
    if (route === "/api/v1/organizations") {
      return {
        organizations: [{ id: "org_forbidden" }, { id: "org_team" }],
      };
    }
    if (route.includes("org_forbidden")) {
      throw new Error("403");
    }
    if (route.endsWith("/projects")) {
      return { projects: [{ id: "project_team", name: "Team" }] };
    }
    return { repositories: [{ id: "repo_1" }] };
  };
  const chosen = await discoverTenancy("https://kumi.example", "token", getJson);
  assert.equal(chosen.organizationId, "org_team");
});

test("an account in no organization says so rather than registering nowhere", async () => {
  const { discoverTenancy } = await load();
  await assert.rejects(
    async () =>
      await discoverTenancy("https://kumi.example", "token", async () => ({
        organizations: [],
      })),
    /not a member of any organization/u,
  );
});
