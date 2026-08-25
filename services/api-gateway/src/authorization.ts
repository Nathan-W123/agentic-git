import type {
  CoordinationStore,
  Organization,
  OrganizationRole,
  ProjectRecord,
  RepositoryGrant,
} from "@coord/persistence";

import {
  AuthenticationError,
  type AuthenticatedPrincipal,
} from "./auth.js";

export type Permission =
  | "view"
  | "submit_task"
  | "run_task"
  | "import_repository"
  | "review"
  | "manage_project"
  | "manage_members"
  | "manage_organization";

const ROLE_PERMISSIONS: Readonly<Record<OrganizationRole, ReadonlySet<Permission>>> = {
  viewer: new Set(["view"]),
  developer: new Set([
    "view",
    "submit_task",
    "run_task",
    "import_repository",
  ]),
  admin: new Set([
    "view",
    "submit_task",
    "run_task",
    "import_repository",
    "review",
    "manage_project",
    "manage_members",
  ]),
  owner: new Set([
    "view",
    "submit_task",
    "run_task",
    "import_repository",
    "review",
    "manage_project",
    "manage_members",
    "manage_organization",
  ]),
};

export interface AuthorizedOrganization {
  organization: Organization;
  role: OrganizationRole;
}

export interface AuthorizedProject extends AuthorizedOrganization {
  project: ProjectRecord;
  /**
   * Repositories the caller may see, or `undefined` for "all of them".
   *
   * Undefined rather than a list because an organization role reaches every
   * repository, including ones created after this request — a snapshot list
   * would silently become wrong.
   */
  repositories: ReadonlySet<string> | undefined;
}

/** Roles in ascending order of what they can do, for taking the higher of two. */
const ROLE_RANK: Readonly<Record<OrganizationRole, number>> = {
  viewer: 0,
  developer: 1,
  admin: 2,
  owner: 3,
};

function higherRole(
  left: OrganizationRole | undefined,
  right: OrganizationRole | undefined,
): OrganizationRole | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return ROLE_RANK[left] >= ROLE_RANK[right] ? left : right;
}

function roleFor(
  principal: AuthenticatedPrincipal,
  organizationId: string,
): OrganizationRole | undefined {
  if (principal.user.systemAdmin) {
    return "owner";
  }
  return principal.memberships.find(
    (membership) => membership.organizationId === organizationId,
  )?.role;
}

export const ALL_PERMISSIONS: readonly Permission[] = [
  "view",
  "submit_task",
  "run_task",
  "import_repository",
  "review",
  "manage_project",
  "manage_members",
  "manage_organization",
];

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}

/** Permissions a role confers, used to bound what a token may be granted. */
export function permissionsForRole(
  role: OrganizationRole,
): readonly Permission[] {
  return ALL_PERMISSIONS.filter((permission) =>
    ROLE_PERMISSIONS[role].has(permission),
  );
}

/**
 * Refuses a token used outside the organization it was bound to.
 *
 * The binding is a property of the credential, not of the user's memberships:
 * no role in the target organization could ever make the request succeed. It
 * is therefore checked before the role, so the caller is told the credential
 * itself is confined rather than the misleading generic `forbidden`.
 */
function assertTokenOrganization(
  principal: AuthenticatedPrincipal,
  organizationId: string,
): void {
  const token = principal.token;
  if (
    token !== undefined &&
    token.organizationId !== undefined &&
    token.organizationId !== organizationId
  ) {
    throw new AuthenticationError(
      "This token is bound to a different organization",
      403,
      "token_organization_mismatch",
    );
  }
}

/**
 * Enforces a token scope where there is no organization to authorize against.
 *
 * Creating an organization and the system-admin endpoints never reach
 * {@link authorizeOrganization}, so without this a narrowly scoped token would
 * pass straight through them.
 */
export function assertTokenScope(
  principal: AuthenticatedPrincipal,
  permission: Permission,
): void {
  const token = principal.token;
  if (token !== undefined && !token.scopes.includes(permission)) {
    throw new AuthenticationError(
      `This token does not carry the "${permission}" scope`,
      403,
      "token_scope_missing",
    );
  }
}

function assertPermission(
  role: OrganizationRole | undefined,
  permission: Permission,
): asserts role is OrganizationRole {
  if (role === undefined || !ROLE_PERMISSIONS[role].has(permission)) {
    throw new AuthenticationError(
      "You do not have permission to perform this action",
      403,
      "forbidden",
    );
  }
}

export async function authorizeOrganization(
  store: CoordinationStore,
  principal: AuthenticatedPrincipal,
  organizationId: string,
  permission: Permission,
): Promise<AuthorizedOrganization> {
  assertTokenOrganization(principal, organizationId);
  const organization = await store.getOrganization(organizationId);
  if (organization === undefined) {
    throw new AuthenticationError(
      "Organization was not found",
      404,
      "not_found",
    );
  }
  const role = roleFor(principal, organizationId);
  assertPermission(role, permission);
  // Effective permission is the intersection of role and scope, so a token
  // can only ever narrow what its owner could already do.
  assertTokenScope(principal, permission);
  return { organization, role };
}

/**
 * Authorizes a project, honouring per-repository grants.
 *
 * Access comes from either of two places now: an organization role, which
 * reaches everything, or a grant on a single repository, which reaches only
 * that one. Somebody with a grant and no organization role is a real case —
 * that is the whole point of sharing one repository — so this cannot simply
 * require an organization role and stop.
 *
 * The effective role is the higher of the two, and `repositories` records what
 * that role may be exercised on. Callers reading repository-shaped data must
 * narrow by it, or per-repository access leaks through the lists.
 */
export async function authorizeProject(
  store: CoordinationStore,
  principal: AuthenticatedPrincipal,
  projectId: string,
  permission: Permission,
): Promise<AuthorizedProject> {
  const project = await store.getProject(projectId);
  if (project === undefined) {
    throw new AuthenticationError(
      "Project was not found",
      404,
      "not_found",
    );
  }
  assertTokenOrganization(principal, project.organizationId);
  const organization = await store.getOrganization(project.organizationId);
  if (organization === undefined) {
    throw new AuthenticationError("Organization was not found", 404, "not_found");
  }

  const organizationRole = roleFor(principal, project.organizationId);
  const grants =
    organizationRole === undefined
      ? await grantsInProject(store, principal, project)
      : [];
  const grantRole = grants.reduce<OrganizationRole | undefined>(
    (highest, grant) => higherRole(highest, grant.role),
    undefined,
  );
  const role = higherRole(organizationRole, grantRole);
  assertPermission(role, permission);
  assertTokenScope(principal, permission);

  if (project.archived && permission !== "view") {
    throw new AuthenticationError(
      "Archived projects are read-only",
      409,
      "project_archived",
    );
  }
  return {
    project,
    organization,
    role,
    repositories:
      organizationRole === undefined
        ? new Set(grants.map((grant) => grant.repositoryId))
        : undefined,
  };
}

/** The caller's grants, limited to repositories this project actually owns. */
async function grantsInProject(
  store: CoordinationStore,
  principal: AuthenticatedPrincipal,
  project: ProjectRecord,
): Promise<RepositoryGrant[]> {
  const grants = await store.listGrantsForUser(principal.user.id);
  if (grants.length === 0) {
    return [];
  }
  const repositories = await store.listProjectRepositories(project.id);
  const owned = new Set(repositories.map((repository) => repository.id));
  return grants.filter((grant) => owned.has(grant.repositoryId));
}

/**
 * Authorizes one named repository.
 *
 * A project-level check is not enough once access can be per repository: a
 * developer granted one repository would otherwise pass every route that only
 * proves they can reach the project, and the repository id in the path would
 * never be examined at all.
 *
 * This does not delegate to {@link authorizeProject}, on purpose. That
 * function answers a project-wide question — "can this caller reach
 * *something* here" — by folding every grant the caller holds *anywhere in
 * the project* into one role, and only even looks at grants when the caller
 * has no organization role at all. Both shortcuts are wrong for a decision
 * about one repository:
 *
 * - Skipping grants whenever an organization role exists means a grant is
 *   never able to *elevate* an existing member — the entire point of
 *   repository-scoped promotion ("co-owner"). A viewer additionally granted
 *   `owner` on one repository must get that elevation on that repository.
 * - Folding every grant in the project into one role means a grant on
 *   repository A could leak permission into repository B just because both
 *   sit in the same project, for a caller with no organization role. Two
 *   repositories granted at different levels must not blend.
 *
 * So this composes organization role with the grant on *this exact
 * repository* — nothing else — and only falls back to "every grant in the
 * project" for the same narrow purpose `authorizeProject` already uses it
 * for: telling a caller who cannot reach the project at all (403, same as
 * any other stranger) apart from one who can reach the project but not this
 * particular repository (404, so the answer cannot be used to discover what
 * a team has).
 */
export async function authorizeRepository(
  store: CoordinationStore,
  principal: AuthenticatedPrincipal,
  projectId: string,
  repositoryId: string,
  permission: Permission,
): Promise<AuthorizedProject> {
  const project = await store.getProject(projectId);
  if (project === undefined) {
    throw new AuthenticationError(
      "Project was not found",
      404,
      "not_found",
    );
  }
  assertTokenOrganization(principal, project.organizationId);
  const organization = await store.getOrganization(project.organizationId);
  if (organization === undefined) {
    throw new AuthenticationError("Organization was not found", 404, "not_found");
  }

  const organizationRole = roleFor(principal, project.organizationId);
  const grants =
    organizationRole === undefined
      ? await grantsInProject(store, principal, project)
      : await store.listGrantsForUser(principal.user.id);
  const repositoryGrant = grants.find(
    (grant) => grant.repositoryId === repositoryId,
  );

  if (organizationRole === undefined) {
    if (grants.length === 0) {
      // No organization role and no grant anywhere in this project: this
      // caller cannot reach the project at all, the same 403 an unrelated
      // stranger gets from every other project-scoped route.
      throw new AuthenticationError(
        "You do not have permission to perform this action",
        403,
        "forbidden",
      );
    }
    if (repositoryGrant === undefined) {
      // Reaches the project through some other grant, but not this
      // repository — the same answer as a repository that does not exist.
      throw new AuthenticationError(
        "Repository was not found",
        404,
        "not_found",
      );
    }
  }

  const role = higherRole(organizationRole, repositoryGrant?.role);
  assertPermission(role, permission);
  // Checked against the permission actually requested, not "view" — a token
  // scoped to exactly one permission (e.g. `manage_project` without `view`)
  // is a legitimate configuration (see the `api-tokens` route), and must not
  // be refused for lacking a scope this function never needed from it.
  assertTokenScope(principal, permission);

  if (project.archived && permission !== "view") {
    throw new AuthenticationError(
      "Archived projects are read-only",
      409,
      "project_archived",
    );
  }

  return {
    project,
    organization,
    role,
    repositories:
      organizationRole === undefined ? new Set([repositoryId]) : undefined,
  };
}

export function canAssignRole(
  actorRole: OrganizationRole,
  targetRole: OrganizationRole,
): boolean {
  if (actorRole === "owner") {
    return true;
  }
  return actorRole === "admin" && targetRole !== "owner";
}
