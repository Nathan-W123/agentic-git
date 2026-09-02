/**
 * Which tenant this machine works for.
 *
 * Split out of `worker.mjs`, and holding no Electron, for the reason
 * `mcp-consent.mjs` holds none: the answer decides whether its owner's agents
 * are reachable at all, and a decision that consequential should be testable
 * without starting an application.
 */

/**
 * The organization and project this machine should poll.
 *
 * Asked of the server rather than configured, because the app already holds a
 * credential that can answer it and a person should not have to know their own
 * organization's id to run an agent.
 *
 * It used to take the first the server listed, on the reasoning that a
 * single-tenant install has only one. That stopped being true the moment a
 * second person signed up: signing up creates an organization, so everybody
 * invited to a team belongs to at least two. See {@link placeOfWork} for what
 * separates them.
 *
 * `getJson` is a parameter so this can be exercised without a server.
 */
export async function discoverTenancy(server, token, getJson) {
  const orgs = await getJson(server, token, "/api/v1/organizations");
  const candidates = (orgs?.organizations ?? []).filter(
    (entry) => typeof entry?.id === "string" && entry.id !== "",
  );
  if (candidates.length === 0) {
    throw new Error("This account is not a member of any organization");
  }
  let fallback;
  for (const organization of candidates) {
    const found = await placeOfWork(server, token, organization.id, getJson);
    if (found === undefined) {
      continue;
    }
    if (found.repositories > 0) {
      return { organizationId: organization.id, ...found };
    }
    // A project with nothing in it is somewhere this machine could register
    // and never be given a thing. Remembered in case none of them have a
    // repository, and passed over while any of them do.
    fallback = fallback ?? { organizationId: organization.id, ...found };
  }
  return fallback ?? { organizationId: candidates[0].id };
}

/**
 * The first project in one organization, and whether it holds any work.
 *
 * The repository count is the whole point. Signing up creates an
 * organization *and* an empty project inside it, so everybody who was later
 * invited to a team belongs to at least two — their own, and the one they
 * actually work in — and both of them have a project. Registering against
 * the first the server happened to list therefore put a perfectly healthy
 * machine in the wrong tenant: its owner's agents stayed grey in the room
 * they were invited to, because the control plane only looks for machines
 * inside the project's own organization, and nothing anywhere said which one
 * this machine had joined.
 *
 * A repository is what separates the two. It is added deliberately, by
 * somebody, to the place work happens; the project made for you at signup
 * has none.
 */
async function placeOfWork(server, token, organizationId, getJson) {
  try {
    const projects = await getJson(
      server,
      token,
      `/api/v1/organizations/${encodeURIComponent(organizationId)}/projects`,
    );
    const project = projects?.projects?.[0];
    if (project?.id === undefined) {
      return undefined;
    }
    const repositories = await getJson(
      server,
      token,
      `/api/v1/projects/${encodeURIComponent(project.id)}/repositories`,
    ).catch(() => undefined);
    return {
      projectId: project.id,
      projectName: project.name,
      repositories: (repositories?.repositories ?? []).length,
    };
  } catch {
    // An organization this account cannot read projects for is not one to
    // register against; the next candidate may still answer.
    return undefined;
  }
}

