# Setting Up Email

The control plane sends the single-use link behind **Forgotten your
password?**, and — where a deployment asks for it — the six-digit code that
confirms a new account at sign-up. Both go through the same mailer, and until
it is configured neither one leaves the machine: the message is written to the
control plane's log instead, prefixed `[mail]`.

**Sign-up does not need any of this.** Email confirmation is off by default,
so signing up creates the account and enters the app with nothing emailed. Set
`COORD_REQUIRE_EMAIL_CONFIRMATION=1` once the steps below are done and tested
if you want new accounts to prove their address first. Password recovery is
the reason to set mail up either way.

This page is the whole checklist. The per-variable reference lives in the
[deployment guide](deployment.md#environment-reference-control-plane).

## What you actually need

Three things:

1. An account with a mail provider that will send on your behalf.
2. A **From** address that provider has verified — usually by proving you own
   the domain.
3. Three environment variables set on the deployment, and a restart.

There is nothing to install: the mailer is part of the control plane and takes
no third-party dependency.

## Step 1 — Pick a transport

| | HTTPS mail API | SMTP relay |
| --- | --- | --- |
| Variables | `COORD_MAIL_API_URL`, `COORD_MAIL_API_KEY` | `COORD_SMTP_URL` |
| Works on Railway, Fly, serverless | **Yes** | No — outbound SMTP ports are blocked |
| Works on your own VM or Docker host | Yes | Yes |

**Use the HTTPS API unless you have a reason not to.** Hosting platforms
routinely block the outbound SMTP ports, and a blocked relay does not fail
quickly or clearly: the connection sits there until it times out, so a reset
link never arrives and sign-up with confirmation turned on ends at "The
confirmation email could not be delivered". This is the reason a deployment on
Railway can look correctly configured and still never deliver anything.

If both are set, the API wins.

## Step 2 — Verify a sender address

Whichever transport you choose, the provider will only send as an address it
has authorised. With a provider like Resend that means adding your domain,
putting the DNS records it gives you (SPF/DKIM) on that domain, and waiting for
it to show as verified. With an SMTP relay it means using the address tied to
the relay account.

Set that address as `COORD_MAIL_FROM`. A display name is allowed:
`Lattice <no-reply@example.com>`.

Leaving it unset means `no-reply@<the mail host>`, which almost every provider
refuses to send as — so treat `COORD_MAIL_FROM` as required, not optional.

## Step 3 — Set the variables

Using [Resend](https://resend.com) as the worked example — any provider whose
endpoint accepts a JSON body of `{from, to, subject, text}` works the same way,
and the API key is sent as `Authorization: Bearer …`:

```
COORD_MAIL_API_URL=https://api.resend.com/emails
COORD_MAIL_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx
COORD_MAIL_FROM=Lattice <no-reply@your-domain.example>
```

For an SMTP relay instead:

```
COORD_SMTP_URL=smtp://user:password@smtp.example.com:587
COORD_MAIL_FROM=Lattice <no-reply@your-domain.example>
```

`smtp://…:587` negotiates STARTTLS when the relay offers it; `smtps://…:465`
is TLS from the first byte. Percent-encode an `@` in the password (`%40`).

Where to put them:

- **Railway** — the service's *Variables* tab. Saving them redeploys the
  service.
- **Docker Compose** — a `.env` file beside `docker-compose.yml`. The four mail
  variables are already forwarded in the `control-plane` service's
  `environment:` block; a variable that is not listed there never reaches the
  container.
- **Plain `node apps/web/dist/index.js`** — the process environment, however
  your supervisor sets it.

## Step 4 — Set the public URL, for reset links

`COORD_PUBLIC_URL` is the absolute origin this deployment is reached at, and it
is what the password-reset link is built from:

```
COORD_PUBLIC_URL=https://latt.up.railway.app
```

Unset, the link is built from the `Host` header of the request that asked for
it — right behind a router that sets it, wrong anywhere a client can choose it.
Set it. `COORD_PASSWORD_RESET_TTL_MINUTES` controls how long that link stays
usable (60 minutes by default).

## Step 5 — Restart and check

Restart the control plane, then confirm all three:

1. **The boot log is quiet.** With no transport configured the server warns
   once at startup:

   ```
   [mail] No COORD_MAIL_API_URL or COORD_SMTP_URL is configured. Password
   reset links will be written to this log instead of being emailed.
   ```

   Seeing that after a restart means the variables did not reach the process.

2. **A reset link arrives.** Use **Forgotten your password?** once and confirm
   `POST /api/v1/auth/password-reset` mails a working link to an address you
   can read.

3. **Only then, if you want it, turn confirmation on.** Set
   `COORD_REQUIRE_EMAIL_CONFIRMATION=1`, restart, and sign up with an address
   you can read: `POST /api/v1/auth/register` answers `"delivery": "mailbox"`
   when the message was handed to the provider and `"delivery": "log"` when it
   was not, and entering the code at `POST /api/v1/auth/register/confirm`
   creates the account.

## When it still does not arrive

- **Sign-up fails with "The confirmation email could not be delivered."** Only
  happens with `COORD_REQUIRE_EMAIL_CONFIRMATION=1`. The
  provider refused, or the relay could not be reached. The control plane logs
  the provider's own words — a `403`/`422` here is nearly always a `From`
  address the provider has not verified. On Railway with `COORD_SMTP_URL` set,
  it is the blocked port; switch to the HTTPS API.
- **Sign-up succeeds but nothing arrives.** Check spam, then check the
  provider's own delivery log. A domain without SPF/DKIM records in place is
  the usual reason mail is filtered.
- **The code stops working after a deploy.** Pending confirmations are held in
  memory, so a restart invalidates them — sign up again. For the same reason,
  a multi-instance deployment must route both sign-up steps to the same
  instance.
- **Nothing is configured and somebody is locked out.** The message is in the
  control plane's log with the `[mail]` prefix, code and reset link included.
  That is a real recovery path for a single-operator deployment and no answer
  at all for a shared one.

If you close self-service sign-up with `COORD_ALLOW_REGISTRATION=0`, only the
password-reset message remains — mail is still worth configuring, because it is
the only way anyone recovers an account without you reading the log.
