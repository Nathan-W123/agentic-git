/**
 * The two routing primitives every request path needs, kept apart from the
 * gateway itself so a module that only wants to name a route does not have to
 * import the server to get one.
 */

/**
 * Every route this gateway serves sits under one version prefix, so the
 * version is stated once rather than spelled into ninety-odd route literals.
 */
export const API_PREFIX = "/api/v1";
