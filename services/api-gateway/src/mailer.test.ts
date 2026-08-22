import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import http from "node:http";

import {
  createMailer,
  mailDeliveryMode,
  parseSmtpUrl,
  sendMail,
} from "./mailer.js";

/**
 * A relay that answers every command with 250 and keeps the conversation.
 *
 * Enough of a server to prove the client speaks the protocol in the right
 * order and hands over a well-formed message. It never listens on anything
 * but the loopback interface, so this suite sends no mail anywhere.
 */
async function fakeRelay(options: { greeting?: string } = {}): Promise<{
  port: number;
  transcripts: string[][];
  /** Resolves once every connection so far has closed. */
  idle: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const transcripts: string[][] = [];
  const finished: Array<Promise<void>> = [];
  const server = net.createServer((socket) => {
    const lines: string[] = [];
    transcripts.push(lines);
    // The last thing the client says is QUIT, and it says it on its way out —
    // so a transcript read the moment `sendMail` resolves can be missing it.
    finished.push(
      new Promise<void>((resolve) => {
        socket.on("close", () => resolve());
      }),
    );
    let buffer = "";
    let inData = false;
    socket.setEncoding("utf8");
    socket.write(`220 ${options.greeting ?? "relay.test ESMTP"}\r\n`);
    socket.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (;;) {
        const index = buffer.indexOf("\r\n");
        if (index < 0) {
          return;
        }
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        lines.push(line);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 queued\r\n");
          }
          continue;
        }
        const command = line.toUpperCase();
        if (command.startsWith("EHLO")) {
          // Multi-line, and deliberately split the way a real server sends it:
          // the client has to wait for the final line before moving on.
          socket.write("250-relay.test\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE\r\n");
        } else if (command === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (command === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else if (command.startsWith("AUTH")) {
          socket.write("235 authenticated\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
    socket.on("error", () => {
      /* A client that hangs up mid-exchange is a case, not a failure. */
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The fake relay did not bind a port");
  }
  return {
    port: address.port,
    transcripts,
    idle: async () => {
      await Promise.all(finished);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

test("an SMTP URL names a host, a port, and optional credentials", () => {
  assert.deepEqual(parseSmtpUrl("smtp://relay.test"), {
    host: "relay.test",
    port: 587,
    implicitTls: false,
    username: undefined,
    password: undefined,
  });
  assert.deepEqual(parseSmtpUrl("smtps://user:pa%40ss@relay.test"), {
    host: "relay.test",
    port: 465,
    implicitTls: true,
    username: "user",
    // Percent-decoded, because an `@` in a password is ordinary and cannot be
    // written any other way inside a URL.
    password: "pa@ss",
  });
  for (const invalid of ["https://relay.test", "relay.test", "smtp://"]) {
    assert.throws(() => parseSmtpUrl(invalid), invalid);
  }
});

test("a message is delivered with its envelope, headers, and body", async (t) => {
  const relay = await fakeRelay();
  t.after(async () => {
    await relay.close();
  });

  await sendMail(
    {
      host: "127.0.0.1",
      port: relay.port,
      implicitTls: false,
      username: "postmaster",
      password: "secret",
    },
    "Kumi <no-reply@relay.test>",
    {
      to: "forgetful@example.com",
      subject: "Reset your Kumi password",
      text: "Open this link:\nhttp://localhost/#reset/pwr_1.secret\n",
    },
  );

  await relay.idle();
  const conversation = relay.transcripts[0] ?? [];
  const spoken = conversation.join("\n");
  assert.match(spoken, /^EHLO /mu);
  assert.match(spoken, /^AUTH PLAIN /mu);
  // The display name belongs in the header, never in the envelope.
  assert.equal(conversation.includes("MAIL FROM:<no-reply@relay.test>"), true);
  assert.equal(conversation.includes("RCPT TO:<forgetful@example.com>"), true);
  assert.match(spoken, /^Subject: Reset your Kumi password$/mu);
  assert.match(spoken, /^From: Kumi <no-reply@relay.test>$/mu);
  assert.match(spoken, /#reset\/pwr_1\.secret/u);
  assert.equal(conversation.includes("QUIT"), true);
});

test("a relay that refuses the recipient is reported, not swallowed", async (t) => {
  const relay = await fakeRelay();
  t.after(async () => {
    await relay.close();
  });

  // The address never reaches the wire: a message with nowhere to go is a
  // caller's mistake, and finding out at the relay would be worse.
  await assert.rejects(
    sendMail(
      { host: "127.0.0.1", port: relay.port, implicitTls: false, username: undefined, password: undefined },
      "no-reply@relay.test",
      { to: "not an address", subject: "s", text: "t" },
    ),
    /not a usable email address/iu,
  );
});

test("with no relay configured the message is logged rather than lost", async () => {
  const logged: string[] = [];
  const mailer = createMailer({ log: (line) => logged.push(line) });

  await mailer({
    to: "forgetful@example.com",
    subject: "Reset your Kumi password",
    text: "http://localhost/#reset/pwr_1.secret",
  });

  // A deployment with no mail relay can still recover an account, by reading
  // its own log. Silence here would be a feature that fails invisibly.
  assert.equal(logged.length, 1);
  assert.match(logged[0] ?? "", /forgetful@example\.com/u);
  assert.match(logged[0] ?? "", /#reset\/pwr_1\.secret/u);
  assert.match(logged[0] ?? "", /COORD_SMTP_URL/u);
});

test("a configured relay is used, with a default sender when none is named", async (t) => {
  const relay = await fakeRelay();
  t.after(async () => {
    await relay.close();
  });

  const mailer = createMailer({
    smtpUrl: `smtp://127.0.0.1:${String(relay.port)}`,
  });
  await mailer({ to: "forgetful@example.com", subject: "s", text: "t" });

  await relay.idle();
  const conversation = relay.transcripts[0] ?? [];
  assert.equal(conversation.includes("MAIL FROM:<no-reply@127.0.0.1>"), true);
});

/** A mail provider's HTTP API, on loopback, that records what it was sent. */
async function fakeMailApi(status = 200): Promise<{
  url: string;
  requests: { authorization: string | undefined; body: unknown }[];
  close: () => Promise<void>;
}> {
  const requests: { authorization: string | undefined; body: unknown }[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(status < 300 ? '{"id":"msg_1"}' : '{"message":"forbidden"}');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/emails`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

test("a mailer says whether it delivers or only logs", async (t) => {
  const relay = await fakeRelay();
  t.after(async () => {
    await relay.close();
  });

  assert.equal(mailDeliveryMode(createMailer({ log: () => {} })), "log");
  assert.equal(
    mailDeliveryMode(
      createMailer({ smtpUrl: `smtp://127.0.0.1:${String(relay.port)}` }),
    ),
    "smtp",
  );
  assert.equal(
    mailDeliveryMode(
      createMailer({ apiUrl: "https://api.example.com/emails", apiKey: "k" }),
    ),
    "api",
  );
  // A mailer handed in by a caller says nothing, and is trusted to deliver.
  assert.equal(mailDeliveryMode(async () => {}), undefined);
});

test("an HTTP mail API is used in preference to SMTP, and carries the key", async (t) => {
  const api = await fakeMailApi();
  const relay = await fakeRelay();
  t.after(async () => {
    await api.close();
    await relay.close();
  });

  const mailer = createMailer({
    apiUrl: api.url,
    apiKey: "test-key",
    smtpUrl: `smtp://127.0.0.1:${String(relay.port)}`,
    from: "Kumi <no-reply@example.com>",
  });
  await mailer({
    to: "new@example.com",
    subject: "Confirm your Kumi account",
    text: "Your Kumi confirmation code is 123456.",
  });

  assert.equal(api.requests.length, 1);
  const sent = api.requests[0];
  assert.equal(sent?.authorization, "Bearer test-key");
  assert.deepEqual(sent?.body, {
    from: "Kumi <no-reply@example.com>",
    to: ["new@example.com"],
    subject: "Confirm your Kumi account",
    text: "Your Kumi confirmation code is 123456.",
  });
  // The SMTP relay is untouched: one transport sends, not both.
  await relay.idle();
  assert.equal(relay.transcripts.length, 0);
});

test("a refusal from the mail API is an error, not a silent non-delivery", async (t) => {
  const api = await fakeMailApi(403);
  t.after(async () => {
    await api.close();
  });

  const mailer = createMailer({ apiUrl: api.url, apiKey: "test-key" });

  await assert.rejects(
    mailer({ to: "new@example.com", subject: "s", text: "t" }),
    /403/u,
  );
});
