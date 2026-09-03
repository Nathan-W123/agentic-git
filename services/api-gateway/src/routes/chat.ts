/**
 * The dashboard's direct provider chat.
 *
 * A conversation with one agent, outside any room. It streams, which is why
 * it does not look like anything else in here.
 *
 * Returns `true` when it answered the request. Order is behaviour: the first
 * branch that matches wins, exactly as it did when all of this was one
 * `if`-chain, and `server.ts` calls the groups in the order they were
 * written in.
 */

import {
  deriveCallSign,
  localAgentsOnly,
} from "@coord/shared-types";
import {
  normalizeCodexRateLimits,
  readCodexSubscriptionUsage,
} from "../codex-subscription-usage.js";
import {
  HttpError,
  chatMessagesField,
  objectBody,
  stringField,
} from "../field-validation.js";
import type {
  ChatProviderOperations,
} from "../gateway-types.js";
import {
  matchPath,
} from "../gateway-util.js";
import {
  API_PREFIX,
} from "../http-util.js";
import {
  codexUsageReport,
  defaultChannelAgentName,
  hasUsageWindows,
} from "../vendors.js";
import type { ApiGateway } from "../server.js";
import type { AuthenticatedRouteRequest } from "./context.js";

export async function routeChat(
  gw: ApiGateway,
  req: AuthenticatedRouteRequest,
): Promise<boolean> {
  const { context, request, response, url, method, path, principal } = req;

  // ---- Direct provider chat (dashboard panel) ---------------------------
  // Connections are per authenticated user; a user can only ever spend
  // their own key. No organization permission is involved because nothing
  // here touches projects, repositories, or canonical state.
  if (path.startsWith(`${API_PREFIX}/chat/`)) {
    const chatOperations = gw.options.operations.chatProviders;
    if (chatOperations === undefined) {
      throw new HttpError(
        501,
        "not_supported",
        "This deployment does not support provider chat",
      );
    }
    const performChat = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        const code = (error as { code?: unknown }).code;
        if (
          error instanceof Error &&
          typeof status === "number" &&
          typeof code === "string"
        ) {
          throw new HttpError(status, code, error.message);
        }
        throw error;
      }
    };
    const identity = {
      userId: principal.user.id,
      systemAdmin: principal.user.systemAdmin,
    };

    if (path === `${API_PREFIX}/chat/providers` && method === "GET") {
      const listed = await performChat(() => chatOperations.list(identity));
      gw.sendJson(response, 200, {
        // Deployment-wide, and sent here because this is the response the
        // Settings screen loads. It also arrives on a channel's roster, but
        // Settings can be opened without ever visiting a channel — and when
        // it was, the screen fell back to "false" and drew the connect
        // button for agents that already existed.
        localAgentsOnly: localAgentsOnly(),
        providers: await gw.describeProviders(principal.user.id, listed),
      });
      return true;
    }
    const chatProviderMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/chat/providers/(anthropic|openai|google|cursor|copilot|kiro)$`,
        "u",
      ),
    );
    const chatProviderActionMatch = matchPath(
      path,
      new RegExp(
        `^${API_PREFIX}/chat/providers/(anthropic|openai|google|cursor|copilot|kiro)` +
          `/(signin|options|settings|usage|credential|device-auth|agent)$`,
        "u",
      ),
    );
    if (chatProviderActionMatch !== undefined) {
      const [provider = "", action = ""] = chatProviderActionMatch;
      if (action === "signin" && method === "POST") {
        gw.sendJson(response, 200, {
          signIn: await performChat(() =>
            chatOperations.signIn({
              systemAdmin: identity.systemAdmin,
              provider,
            }),
          ),
        });
        return true;
      }
      if (action === "agent" && method === "POST") {
        // Creating an agent without handing this server a vendor credential.
        //
        // The roster used to be built by walking the credential store, so
        // connecting an agent meant a vendor sign-in whose credential local
        // execution then never reads — the CLI runs under the machine's own
        // login. Two sign-ins, one of them for nothing, and a stored secret
        // this deployment is responsible for and does not use.
        //
        // The durable record keyed by (user, provider) is what an agent
        // actually is. This writes one. A credential may still be linked
        // afterwards, and is what server-side execution and the usage
        // figures need — but it is no longer the price of having an agent.
        const agentBody = objectBody(await gw.readJson(request));
        const visibilityField = stringField(
          agentBody["visibility"],
          "visibility",
          { max: 20, optional: true },
        );
        if (
          visibilityField !== undefined &&
          visibilityField !== "personal" &&
          visibilityField !== "org"
        ) {
          throw new HttpError(
            400,
            "invalid_request",
            'visibility must be "personal" or "org"',
          );
        }
        const owner = await gw.options.store.getUser(identity.userId);
        if (owner === undefined) {
          throw new HttpError(404, "not_found", "User was not found");
        }
        const existing = (
          await gw.options.store.listAgentCallSigns().catch((): [] => [])
        ).find(
          (sign) =>
            sign.userId === identity.userId && sign.provider === provider,
        );
        // A name is only ever assigned once. Re-running this must not rename
        // an agent people have learned, which is the same rule
        // `assignCallSign` follows on the credential path.
        // A name is derived, not dealt. `defaultChannelAgentName` returns
        // "Claude (Nathan)" when there is no call sign — a *label*, and
        // storing it here would freeze the placeholder as the agent's
        // permanent name, which is the exact complaint the durable table
        // was added to fix. So a sign is derived from the agent's own
        // identity, and the label is only the fallback for a deployment
        // that has exhausted the pantheon.
        const taken = new Set(
          (await gw.options.store.listAgentCallSigns().catch((): [] => []))
            .map((sign) => sign.callSign),
        );
        const callSign =
          existing?.callSign ??
          stringField(agentBody["callSign"], "callSign", {
            max: 40,
            optional: true,
          }) ??
          // The same name every time this account asks, which is what makes
          // disconnecting and reconnecting give an agent back rather than
          // give back a stranger. See `deriveCallSign`.
          deriveCallSign(identity.userId, provider, taken) ??
          defaultChannelAgentName({
            provider,
            userName: owner.displayName,
          });
        const agent = await gw.options.store.setAgentCallSign(
          identity.userId,
          provider,
          callSign,
          visibilityField ?? existing?.visibility ?? "personal",
        );
        gw.sendJson(response, 200, { agent });
        return true;
      }
      if (action === "credential" && method === "POST") {
        if (chatOperations.connectCredential === undefined) {
          throw new HttpError(
            501,
            "unsupported",
            "This deployment does not accept per-user provider credentials",
          );
        }
        const body = objectBody(await gw.readJson(request));
        const kind = stringField(body["kind"], "kind", { max: 20 }) ?? "";
        if (!["oauth_token", "api_key", "session_file"].includes(kind)) {
          throw new HttpError(
            400,
            "invalid_request",
            "kind must be oauth_token, api_key or session_file",
          );
        }
        // The secret is read but never echoed: the response is the same
        // provider list every other action returns, so nothing that reaches
        // a log or a browser carries it.
        // A session file is a whole JSON document and runs well past the
        // limit that suits a pasted key, so the cap follows the kind.
        const secret =
          stringField(body["secret"], "secret", {
            max: kind === "session_file" ? 64_000 : 4096,
          }) ?? "";
        const label = stringField(body["label"], "label", {
          max: 80,
          optional: true,
        });
        // Absent means "personal" throughout the stack — see
        // `CredentialVisibility` in @coord/workspace-manager — so an old
        // client that never sends this field keeps the behavior it always
        // had.
        const visibilityField = stringField(body["visibility"], "visibility", {
          max: 20,
          optional: true,
        });
        if (
          visibilityField !== undefined &&
          !["personal", "org"].includes(visibilityField)
        ) {
          throw new HttpError(
            400,
            "invalid_request",
            "visibility must be personal or org",
          );
        }
        const visibility = visibilityField as "personal" | "org" | undefined;
        gw.sendJson(response, 200, {
          providers: await performChat(() =>
            // Non-null assertion is unnecessary; the guard above narrowed it.
            (chatOperations.connectCredential as NonNullable<
              ChatProviderOperations["connectCredential"]
            >)({
              userId: identity.userId,
              systemAdmin: identity.systemAdmin,
              provider,
              kind,
              secret,
              ...(label === undefined ? {} : { label }),
              ...(visibility === undefined ? {} : { visibility }),
            }),
          ),
        });
        return true;
      }
      if (action === "device-auth") {
        if (chatOperations.deviceAuth === undefined) {
          throw new HttpError(
            501,
            "unsupported",
            "This deployment does not support device authorization",
          );
        }
        const deviceAuth = chatOperations.deviceAuth;
        // The flow id travels in the query string rather than the path so
        // the whole family stays on one route shape. It is a random opaque
        // identifier and is scoped to the caller server-side regardless.
        // `searchParams.get` answers `null` for an absent parameter, and
        // `null` is not `undefined`, so it has to be normalised before
        // `stringField` will treat it as optional rather than as the wrong
        // type. Starting a flow legitimately names none, and without this
        // the start request is refused with "flow must be a string".
        const flowId =
          stringField(
            new URL(request.url ?? "", "http://localhost").searchParams.get(
              "flow",
            ) ?? undefined,
            "flow",
            { max: 64, optional: true },
          ) ?? "";
        // A POST naming no flow starts one; a POST naming a flow answers
        // it. Same route, and which it is is a property of the request
        // rather than something the caller has to select.
        if (method === "POST" && flowId.length === 0) {
          gw.sendJson(response, 200, {
            deviceAuth: await performChat(() =>
              deviceAuth.start({ userId: identity.userId, provider }),
            ),
          });
          return true;
        }
        if (flowId.length === 0) {
          throw new HttpError(400, "invalid_request", "flow is required");
        }
        if (method === "POST") {
          const submitCode = deviceAuth.submitCode;
          if (submitCode === undefined) {
            throw new HttpError(
              501,
              "unsupported",
              "This deployment cannot accept a sign-in code",
            );
          }
          const body = objectBody(await gw.readJson(request));
          const code = stringField(body["code"], "code", { max: 512 }) ?? "";
          gw.sendJson(response, 200, {
            deviceAuth: await performChat(() =>
              submitCode({ userId: identity.userId, flowId, code }),
            ),
          });
          return true;
        }
        if (method === "GET") {
          gw.sendJson(response, 200, {
            deviceAuth: await performChat(() =>
              deviceAuth.status({ userId: identity.userId, flowId }),
            ),
          });
          return true;
        }
        if (method === "DELETE") {
          await performChat(() =>
            deviceAuth.cancel({ userId: identity.userId, flowId }),
          );
          gw.sendJson(response, 200, { cancelled: true });
          return true;
        }
      }
      if (action === "options" && method === "GET") {
        gw.sendJson(response, 200, {
          options: await performChat(() =>
            chatOperations.options({ provider, userId: identity.userId }),
          ),
        });
        return true;
      }
      if (action === "usage" && method === "GET") {
        // Whose agent this is about, when it is not the caller's. The
        // service decides whether to answer: an org-wide connection is one
        // anybody may put to work, and a personal one stays private.
        const owner = url.searchParams.get("owner") ?? undefined;
        const recordedUsage = await performChat(() =>
          chatOperations.usage({
            provider,
            userId: identity.userId,
            ...(owner === undefined || owner === "" ? {} : { ownerId: owner }),
          }),
        );
        let usage = recordedUsage;
        if (
          provider === "openai" &&
          (owner === undefined || owner === "" || owner === identity.userId) &&
          !hasUsageWindows(recordedUsage)
        ) {
          const liveSnapshot = await (
            gw.options.codexUsageReader ?? readCodexSubscriptionUsage
          )().catch(() => undefined);
          const snapshot = normalizeCodexRateLimits(liveSnapshot);
          if (snapshot !== undefined) {
            usage = codexUsageReport(snapshot);
          }
        }
        // Kumi's own accounting, added to whatever the vendor said. It is
        // the only figure available for a vendor that publishes no quota,
        // and it is worth having beside one that does: a percentage says
        // how much ceiling is left, this says what the work cost.
        const spend = await gw.agentSpend(
          owner === undefined || owner === "" ? identity.userId : owner,
          provider,
        );
        const merged =
          spend !== undefined &&
          typeof usage === "object" &&
          usage !== null &&
          !Array.isArray(usage)
            ? { ...(usage as Record<string, unknown>), spend }
            : usage;
        gw.sendJson(response, 200, { usage: merged });
        return true;
      }
      if (action === "usage" && method === "POST") {
        // Reported by the machine that holds the vendor login, which is the
        // only place the number is about the right account. This is what
        // makes the second sign-in unnecessary: nothing has to be stored
        // here for the figure to be readable.
        const reportOperation = chatOperations.reportUsage;
        if (reportOperation === undefined) {
          throw new HttpError(
            501,
            "not_supported",
            "This deployment does not take usage readings from machines",
          );
        }
        const body = objectBody(await gw.readJson(request));
        // Only ever about the caller's own agent. A reading is a claim about
        // an account, and the only account somebody may make claims about is
        // their own.
        const raw = stringField(body["raw"], "raw", { max: 64_000 }) ?? "";
        gw.sendJson(response, 200, {
          usage: await performChat(() =>
            reportOperation({
              userId: identity.userId,
              provider,
              raw,
            }),
          ),
        });
        return true;
      }
      if (action === "settings" && method === "POST") {
        const body = objectBody(await gw.readJson(request));
        const model = stringField(body["model"], "model", {
          max: 120,
          optional: true,
        });
        const effort = stringField(body["effort"], "effort", {
          max: 20,
          optional: true,
        });
        // The agent's name, and the reason this route is what Settings
        // renames through: a call sign is held on the account, so one write
        // here is the agent's name in every repository at once. `min: 0`
        // because an empty string is the documented "clear it" value.
        const callSign = stringField(body["callSign"], "callSign", {
          max: 40,
          min: 0,
          optional: true,
        });
        // Only the two the credential store understands. A free string here
        // would reach the connection file and decide, wrongly, whose
        // credential a teammate's prompt spends.
        const visibility = stringField(body["visibility"], "visibility", {
          max: 10,
          optional: true,
        });
        if (
          visibility !== undefined &&
          visibility !== "personal" &&
          visibility !== "org"
        ) {
          throw new HttpError(
            400,
            "invalid_visibility",
            "Visibility must be personal or org",
          );
        }
        const providers = await performChat(() =>
          chatOperations.setSettings({
            userId: identity.userId,
            provider,
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { effort }),
            ...(callSign === undefined ? {} : { callSign }),
            ...(visibility === undefined ? {} : { visibility }),
          }),
        );
        // Visibility belongs to the agent record when no credential holds it.
        //
        // The credential store is where it lives for an agent that has a
        // credential, because there it decides whose secret a teammate's
        // prompt may spend. An agent running on its owner's machine has no
        // credential here at all, and the durable record carries the column
        // for exactly this case — see `AgentCallSign.visibility`, which says
        // so. Written after the service call so a refusal there leaves this
        // untouched.
        if (visibility === "personal" || visibility === "org") {
          const existing = (
            await gw.options.store.listAgentCallSigns().catch((): [] => [])
          ).find(
            (sign) =>
              sign.userId === identity.userId && sign.provider === provider,
          );
          if (existing !== undefined) {
            await gw.options.store
              .setAgentCallSign(
                identity.userId,
                provider,
                // The name is unchanged; this write is about the column
                // beside it, and the store's upsert takes both together.
                callSign ?? existing.callSign,
                visibility,
              )
              .catch(() => undefined);
          }
        }
        // A rename is account-wide, so nothing per-repository may go on
        // shadowing it: an override naming this agent in one channel wins
        // over the call sign there (`resolveChannelAgentPresentation`), and
        // leaving those standing is exactly the "renamed it and the other
        // repositories kept the old name" complaint. Roles, models and
        // efforts set in a channel are that channel's decision and stay.
        if (callSign !== undefined) {
          await gw.options.store.clearChannelAgentNameOverrides(
            `${identity.userId}:${provider}`,
          );
          await gw.options.store.appendAudit(undefined, {
            type: "channel_agent_overridden",
            data: {
              agentId: `${identity.userId}:${provider}`,
              name: callSign,
              scope: "account",
            },
          });
        }
        gw.sendJson(response, 200, {
          // Through the same decorator the GET uses. Returning the service's
          // list raw is what emptied the Agents tab on every settings write:
          // the browser replaces its provider list with this response, and
          // without `exists` every agent that has no credential reads as one
          // that does not exist.
          providers: await gw.describeProviders(identity.userId, providers),
        });
        return true;
      }
      throw new HttpError(405, "method_not_allowed", "Unsupported method");
    }
    if (chatProviderMatch !== undefined) {
      const provider = chatProviderMatch[0] ?? "";
      if (method === "POST") {
        // Sign-in based connection: the body carries nothing sensitive.
        await gw.readJson(request).catch(() => undefined);
        gw.sendJson(response, 200, {
          providers: await performChat(() =>
            chatOperations.connect({ ...identity, provider }),
          ),
        });
        return true;
      }
      if (method === "DELETE") {
        await performChat(() =>
          chatOperations.disconnect({ userId: identity.userId, provider }),
        );
        // The names this agent was given in particular rooms go with it,
        // for a stronger version of the reason a rename clears them. An
        // override naming this agent in one channel outranks its call sign
        // there, and the key is `${userId}:${provider}` — which the *next*
        // agent dealt for this account and this vendor will also be. Left
        // standing, they would hand a brand-new agent the removed one's
        // name in every room the removed one had been named in. Roles,
        // models and efforts are that channel's decision about a seat
        // rather than a name for this agent, and stay.
        await gw.options.store.clearChannelAgentNameOverrides(
          `${identity.userId}:${provider}`,
        );
        gw.sendJson(response, 200, { disconnected: true });
        return true;
      }
    }
    if (path === `${API_PREFIX}/chat/complete` && method === "POST") {
      const body = objectBody(await gw.readJson(request));
      const provider = stringField(body["provider"], "provider", { max: 20 }) ?? "";
      if (![
        "anthropic",
        "openai",
        "google",
        "cursor",
        "copilot",
        "kiro",
      ].includes(provider)) {
        throw new HttpError(400, "invalid_request", "provider is unknown");
      }
      const cliSessionId = stringField(body["cliSessionId"], "cliSessionId", {
        max: 64,
        optional: true,
      });
      gw.sendJson(response, 200, {
        reply: await performChat(() =>
          chatOperations.complete({
            ...identity,
            provider,
            messages: body["messages"],
            ...(cliSessionId === undefined ? {} : { cliSessionId }),
          }),
        ),
      });
      return true;
    }
    if (path === `${API_PREFIX}/chat/stream` && method === "POST") {
      const streamOperation = chatOperations.completeStream;
      if (streamOperation === undefined) {
        throw new HttpError(
          501,
          "not_supported",
          "Streaming chat is not configured on this deployment",
        );
      }
      const body = objectBody(await gw.readJson(request));
      const provider =
        stringField(body["provider"], "provider", { max: 20 }) ?? "";
      if (![
        "anthropic",
        "openai",
        "google",
        "cursor",
        "copilot",
        "kiro",
      ].includes(provider)) {
        throw new HttpError(400, "invalid_request", "provider is unknown");
      }
      const cliSessionId = stringField(
        body["cliSessionId"],
        "cliSessionId",
        { max: 64, optional: true },
      );
      // Checked before the stream is opened, so an over-long turn comes
      // back as an ordinary 400 the composer can read out. Once the 200
      // headers are written the only place left to say it is inside the
      // event stream, where the panel shows it as a failed turn.
      const messages = chatMessagesField(body["messages"]);
      // Newline-delimited JSON: one event per line, flushed immediately so
      // the browser sees progress rather than a buffered reply.
      response.setHeader("Content-Type", "application/x-ndjson");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Accel-Buffering", "no");
      response.writeHead(200);
      const write = (event: unknown) => {
        if (!response.writableEnded) {
          response.write(`${JSON.stringify(event)}\n`);
        }
      };
      try {
        const reply = await performChat(() =>
          streamOperation(
            {
              ...identity,
              provider,
              messages,
              ...(cliSessionId === undefined ? {} : { cliSessionId }),
            },
            write,
          ),
        );
        write({ type: "done", reply });
      } catch (error) {
        const failure =
          error instanceof HttpError
            ? { code: error.code, message: error.message }
            : {
                code: "chat_failed",
                message:
                  error instanceof Error ? error.message : String(error),
              };
        write({ type: "error", ...failure });
      }
      response.end();
      return true;
    }
    throw new HttpError(404, "not_found", "Route was not found");
  }

  return false;
}
