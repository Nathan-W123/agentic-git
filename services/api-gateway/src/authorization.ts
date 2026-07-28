import type {
  CoordinationStore,
  Organization,
  OrganizationRole,
  ProjectRecord,
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
  reviewer: new Set(["view", "review"]),
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
  const { organization, role } = await authorizeOrganization(
    store,
    principal,
    project.organizationId,
    permission,
  );
  if (project.archived && permission !== "view") {
    throw new AuthenticationError(
      "Archived projects are read-only",
      409,
      "project_archived",
    );
  }
  return { project, organization, role };
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
