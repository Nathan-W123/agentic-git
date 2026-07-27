# API Tokens

Cookie sessions only work in a browser. Every headless participant — the CLI,
remote workers, and agents — authenticates with a bearer token instead.

```http
Authorization: Bearer coord_pat_<id>.<secret>
```

## Wire format

`coord_pat_<id>.<secret>`

The fixed `coord_pat_` prefix makes a leaked credential recognisable to secret
scanners and greppable in logs. The id travels in the clear so verification is
one indexed lookup rather than a comparison against every stored token.

The separator is a **dot**, not an underscore: both halves are base64url, whose
alphabet includes `-` and `_`. Splitting on an underscore cuts inside the id
whenever one happens to contain it, which made roughly one token in six fail to
authenticate at random.

## Storage

Only a SHA-256 digest of the secret is persisted. The plaintext exists exactly
once, in the response that created it, and cannot be recovered — only revoked
and reissued.

A fast digest is correct here. Unlike a password, the secret carries 256 bits of
entropy, so there is nothing to brute force and no reason to pay scrypt's cost
on every request.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/v1/auth/tokens` | Session-only. Returns the plaintext once. |
| `GET` | `/api/v1/auth/tokens` | Metadata only; never the secret. |
| `DELETE` | `/api/v1/auth/tokens/{id}` | Idempotent revocation. |

```jsonc
// POST /api/v1/auth/tokens
{
  "name": "ci-worker",
  "scopes": ["view", "run_task"],
  "organizationId": "org_...",   // optional; binds the token to one org
  "expiresInDays": 90            // optional; 0 means never
}
```

## Scopes

Scopes use the same vocabulary as role permissions: `view`, `submit_task`,
`run_task`, `import_repository`, `review`, `manage_project`, `manage_members`,
`manage_organization`.

**Effective permission is the intersection of the owner's role and the token's
scopes.** A token can only ever narrow what its owner could already do, never
widen it — requesting a scope the role does not grant is refused at creation
with `scope_exceeds_role`. A token bound to an organization is refused outside
it with `token_organization_mismatch`.

Routes that never authorize against an existing organization — creating one,
and the system-admin endpoints — assert the scope explicitly. Without that a
narrowly scoped token would pass straight through them.

## Rules that make revocation meaningful

- **A token cannot mint another token.** Creation requires an interactive
  session. Otherwise a leaked credential could refresh itself forever and
  revocation would mean nothing.
- **Revocation is immediate and final.** A second revoke does not rewrite when
  or why the first happened.
- **Records are kept, not deleted**, so the audit trail shows the credential
  existed. Expired tokens are swept separately by `deleteExpiredApiTokens`.
- **Disabling a user disables their tokens** on the next request.

## CSRF and origin

Bearer requests skip CSRF verification. CSRF protects cookie authentication,
where a browser attaches the credential automatically; a bearer token is never
attached on its own, so there is no cross-site request to forge. Cookie
sessions still require `X-CSRF-Token` on every mutating request.

## Failure behaviour

Every rejection — unknown id, wrong secret, revoked, expired, malformed,
disabled user — returns the same `401` and the same message, so a caller cannot
distinguish these states by probing.

`last_used_at` is written at most once a minute. It exists so operators can
find stale credentials, not as an access log; a write per request would cost
more than the signal is worth.

## Audit

Issuing and revoking append `api_token_issued` and `api_token_revoked` to the
hash-chained audit log, including the scopes granted and the organization
binding.
