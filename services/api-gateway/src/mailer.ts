import { createConnection, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";

/**
 * Just enough SMTP to deliver the one message this control plane sends.
 *
 * A password reset link is worthless unless it reaches the mailbox, and the
 * project takes no third-party dependencies for something this small: the
 * conversation is EHLO, optional STARTTLS, optional AUTH, MAIL/RCPT/DATA,
 * QUIT. Anything a provider offers beyond that — pipelining, DSN, 8BITMIME —
 * is optional for the sender, so declining all of it is a complete client
 * rather than a partial one.
 *
 * When no relay is configured the mailer still exists: it writes the link to
 * the log instead of dropping it. A single-operator deployment with no mail
 * relay can then recover an account by reading its own logs, which is the
 * difference between a feature that degrades and one that silently fails.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailerOptions {
  /**
   * `smtp://user:pass@host:587` or `smtps://…` for implicit TLS. Absent means
   * log-only delivery.
   */
  smtpUrl?: string | undefined;
  /** Envelope and header sender. Defaults to `no-reply@<smtp host>`. */
  from?: string | undefined;
  /** Where log-only delivery writes. Defaults to `console.info`. */
  log?: ((message: string) => void) | undefined;
  /** Milliseconds to wait for any single server reply. */
  timeoutMs?: number | undefined;
}

/** Delivers one message, or throws if the relay refuses it. */
export type Mailer = (message: MailMessage) => Promise<void>;

export interface SmtpEndpoint {
  host: string;
  port: number;
  /** TLS from the first byte, rather than negotiated with STARTTLS. */
  implicitTls: boolean;
  username: string | undefined;
  password: string | undefined;
}

export function parseSmtpUrl(value: string): SmtpEndpoint {
  const url = new URL(value);
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    throw new Error(`SMTP URL must use smtp: or smtps:, not ${url.protocol}`);
  }
  const implicitTls = url.protocol === "smtps:";
  const port =
    url.port === "" ? (implicitTls ? 465 : 587) : Number.parseInt(url.port, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`SMTP URL has an invalid port: ${url.port}`);
  }
  if (url.hostname === "") {
    throw new Error("SMTP URL must name a host");
  }
  return {
    host: url.hostname,
    port,
    implicitTls,
    username: url.username === "" ? undefined : decodeURIComponent(url.username),
    password: url.password === "" ? undefined : decodeURIComponent(url.password),
  };
}

interface SmtpReply {
  code: number;
  text: string;
}

/**
 * Reads SMTP replies off a socket.
 *
 * A reply is one or more lines; every line but the last has a hyphen after
 * the code. Lines are buffered until that final line arrives, because the
 * capability list a server sends after EHLO routinely spans a dozen of them
 * and arrives split across whatever TCP segments it likes.
 */
function createReplyReader(socket: Socket): {
  read: () => Promise<SmtpReply>;
  detach: () => void;
} {
  let buffer = "";
  let collected: string[] = [];
  const queue: SmtpReply[] = [];
  let waiting: ((reply: SmtpReply) => void) | undefined;
  let failWaiting: ((error: Error) => void) | undefined;
  let failure: Error | undefined;

  const deliver = (reply: SmtpReply): void => {
    if (waiting !== undefined) {
      const resolve = waiting;
      waiting = undefined;
      failWaiting = undefined;
      resolve(reply);
    } else {
      queue.push(reply);
    }
  };

  const fail = (error: Error): void => {
    failure = error;
    if (failWaiting !== undefined) {
      const reject = failWaiting;
      waiting = undefined;
      failWaiting = undefined;
      reject(error);
    }
  };

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) {
        return;
      }
      const line = buffer.slice(0, index).replace(/\r$/u, "");
      buffer = buffer.slice(index + 1);
      collected.push(line.slice(4));
      if (/^\d{3} /u.test(line)) {
        const reply = {
          code: Number.parseInt(line.slice(0, 3), 10),
          text: collected.join("\n"),
        };
        collected = [];
        deliver(reply);
      }
    }
  };

  const onError = (error: Error): void => {
    fail(error);
  };
  const onClose = (): void => {
    fail(new Error("SMTP connection closed before the exchange finished"));
  };

  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);

  return {
    read: () =>
      new Promise<SmtpReply>((resolve, reject) => {
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        if (failure !== undefined) {
          reject(failure);
          return;
        }
        waiting = resolve;
        failWaiting = reject;
      }),
    detach: () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    },
  };
}

function write(socket: Socket, line: string): void {
  socket.write(`${line}\r\n`);
}

function expect(reply: SmtpReply, codes: number[], step: string): void {
  if (!codes.includes(reply.code)) {
    throw new Error(`SMTP ${step} failed: ${reply.code} ${reply.text}`);
  }
}

/**
 * Escapes a message body for the DATA command.
 *
 * A line consisting of a single dot ends the message, so a body line that
 * begins with one gets a second — the transparency rule every SMTP client
 * has to implement or lose the tail of anything containing such a line.
 */
function dotStuff(body: string): string {
  return body
    .split(/\r?\n/u)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

function buildMessage(
  message: MailMessage,
  from: string,
  messageId: string,
  date: string,
): string {
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Date: ${date}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${dotStuff(message.text)}\r\n`;
}

/** An address with no display name or angle brackets, for MAIL FROM/RCPT TO. */
function envelopeAddress(value: string): string {
  const match = /<([^>]*)>/u.exec(value);
  const address = (match?.[1] ?? value).trim();
  if (!/^[^\s<>,;]+@[^\s<>,;]+$/u.test(address)) {
    throw new Error(`Not a usable email address: ${value}`);
  }
  return address;
}

/** Delivers one message over SMTP, opening and closing its own connection. */
export async function sendMail(
  endpoint: SmtpEndpoint,
  from: string,
  message: MailMessage,
  options: { timeoutMs?: number | undefined } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const sender = envelopeAddress(from);
  const recipient = envelopeAddress(message.to);
  let socket: Socket = endpoint.implicitTls
    ? connectTls({ host: endpoint.host, port: endpoint.port })
    : createConnection({ host: endpoint.host, port: endpoint.port });
  socket.setTimeout(timeoutMs, () => {
    socket.destroy(new Error("SMTP server did not answer in time"));
  });
  let reader = createReplyReader(socket);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once(endpoint.implicitTls ? "secureConnect" : "connect", () =>
        resolve(),
      );
      socket.once("error", reject);
    });
    expect(await reader.read(), [220], "greeting");

    const greet = async (): Promise<string> => {
      write(socket, "EHLO localhost");
      const reply = await reader.read();
      expect(reply, [250], "EHLO");
      return reply.text.toUpperCase();
    };
    let capabilities = await greet();

    if (!endpoint.implicitTls && capabilities.includes("STARTTLS")) {
      write(socket, "STARTTLS");
      expect(await reader.read(), [220], "STARTTLS");
      reader.detach();
      const plain = socket;
      socket = connectTls({ socket: plain, servername: endpoint.host });
      socket.setTimeout(timeoutMs, () => {
        socket.destroy(new Error("SMTP server did not answer in time"));
      });
      reader = createReplyReader(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", () => resolve());
        socket.once("error", reject);
      });
      capabilities = await greet();
    }

    if (endpoint.username !== undefined && endpoint.password !== undefined) {
      if (capabilities.includes("AUTH") && capabilities.includes("PLAIN")) {
        // PLAIN is authzid NUL authcid NUL password with an empty
        // authzid, so the payload genuinely begins with a NUL byte.
        const secret = Buffer.from(
          `\u0000${endpoint.username}\u0000${endpoint.password}`,
          "utf8",
        ).toString("base64");
        write(socket, `AUTH PLAIN ${secret}`);
        expect(await reader.read(), [235], "AUTH");
      } else {
        write(socket, "AUTH LOGIN");
        expect(await reader.read(), [334], "AUTH");
        write(socket, Buffer.from(endpoint.username, "utf8").toString("base64"));
        expect(await reader.read(), [334], "AUTH");
        write(socket, Buffer.from(endpoint.password, "utf8").toString("base64"));
        expect(await reader.read(), [235], "AUTH");
      }
    }

    write(socket, `MAIL FROM:<${sender}>`);
    expect(await reader.read(), [250], "MAIL FROM");
    write(socket, `RCPT TO:<${recipient}>`);
    expect(await reader.read(), [250, 251], "RCPT TO");
    write(socket, "DATA");
    expect(await reader.read(), [354], "DATA");
    socket.write(
      buildMessage(
        message,
        from,
        `${Date.now().toString(36)}.${process.pid.toString(36)}@lattice`,
        new Date().toUTCString(),
      ),
    );
    write(socket, ".");
    expect(await reader.read(), [250], "message");
    // Ended rather than dropped, so the QUIT reaches the relay: destroying the
    // socket in the `finally` below can discard a write that has not flushed.
    await new Promise<void>((resolve) => {
      socket.end("QUIT\r\n", () => {
        resolve();
      });
    });
  } finally {
    reader.detach();
    socket.destroy();
  }
}

/**
 * The mailer this deployment can actually use.
 *
 * Never throws at construction for a missing relay: mail is not required to
 * run a control plane, and a deployment that has none should still boot, still
 * accept a reset request, and still put the link somewhere its operator can
 * reach it.
 */
export function createMailer(options: MailerOptions = {}): Mailer {
  const log = options.log ?? ((line: string) => console.info(line));
  const configured = (options.smtpUrl ?? "").trim();
  if (configured === "") {
    return async (message) => {
      log(
        `[mail] No COORD_SMTP_URL is configured, so this message was not sent. ` +
          `To: ${message.to}\nSubject: ${message.subject}\n${message.text}`,
      );
    };
  }
  const endpoint = parseSmtpUrl(configured);
  const from =
    (options.from ?? "").trim() === ""
      ? `no-reply@${endpoint.host}`
      : (options.from ?? "").trim();
  return async (message) => {
    await sendMail(endpoint, from, message, {
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
  };
}
