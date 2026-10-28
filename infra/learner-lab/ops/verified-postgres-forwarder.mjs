// Verified PostgreSQL TLS forwarder for the optional demo seeding wrapper
// (ADR-040, findings F5 and R2-F5). The accepted seeder only accepts a
// loopback *_demo URL, so the wrapper offers it 127.0.0.1 inside the ops
// container and opens the upstream connection here, the way node-postgres
// does: send SSLRequest, require exactly 'S', then a Node TLS handshake with
// rejectUnauthorized, the RDS CA bundle and servername = the RDS hostname.
// Node verifies the chain, the validity period and the hostname (against
// servername) before any PostgreSQL byte is forwarded. Anything else closes
// the client connection. The loopback hop never leaves the container's own
// network namespace.
//
// Negotiation always settles exactly once, within timeoutMs: on success, on
// any error, on an unexpected or malformed reply, on early EOF or close at any
// stage before the handshake completes, and on the absolute deadline. A
// failure detaches every listener and destroys both the TCP and TLS sockets.
import { Buffer } from "node:buffer";
import { connect as tcpConnect, createServer } from "node:net";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { connect as tlsConnect } from "node:tls";

// PostgreSQL SSLRequest: length 8, code 80877103.
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);
const SSL_ACCEPTED = 0x53; // 'S'
const SSL_REFUSED = 0x4e; // 'N'

export function verifiedUpstream({
  host,
  port,
  servername,
  ca,
  timeoutMs = 10_000,
}) {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host, port });
    let secure = null;
    let settled = false;
    const listeners = [];
    const listen = (emitter, event, handler) => {
      emitter.on(event, handler);
      listeners.push([emitter, event, handler]);
    };
    const detach = () => {
      for (const [emitter, event, handler] of listeners)
        emitter.removeListener(event, handler);
      listeners.length = 0;
    };
    const deadline = setTimeout(() => fail("UPSTREAM_TIMEOUT"), timeoutMs);
    function fail(code, detail) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      detach();
      // Destroyed sockets may still emit a late error; it must not crash the process.
      for (const stream of [secure, socket]) {
        if (!stream) continue;
        stream.on("error", () => {});
        stream.destroy();
      }
      reject(new Error(detail === undefined ? code : `${code}:${detail}`));
    }

    listen(socket, "error", (error) =>
      fail("UPSTREAM_CONNECT_FAILED", error.code ?? error.message),
    );
    listen(socket, "end", () => fail("UPSTREAM_CLOSED_BEFORE_TLS"));
    listen(socket, "close", () => fail("UPSTREAM_CLOSED_BEFORE_TLS"));
    listen(socket, "connect", () => socket.write(SSL_REQUEST));
    const onReply = (reply) => {
      socket.removeListener("data", onReply);
      // Exactly one byte may precede the handshake: no plaintext may be
      // smuggled in ahead of TLS.
      if (reply.length !== 1) return fail("UPSTREAM_SENT_DATA_BEFORE_TLS");
      if (reply[0] === SSL_REFUSED) return fail("UPSTREAM_REFUSED_TLS");
      if (reply[0] !== SSL_ACCEPTED)
        return fail("UPSTREAM_MALFORMED_SSL_REPLY");
      secure = tlsConnect({
        socket,
        servername,
        ca,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      });
      listen(secure, "error", (error) =>
        fail("UPSTREAM_TLS_REJECTED", error.code ?? error.message),
      );
      listen(secure, "end", () => fail("UPSTREAM_CLOSED_DURING_TLS"));
      listen(secure, "close", () => fail("UPSTREAM_CLOSED_DURING_TLS"));
      listen(secure, "secureConnect", () => {
        if (!secure.authorized)
          return fail(
            "UPSTREAM_TLS_UNAUTHORIZED",
            String(secure.authorizationError),
          );
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        detach();
        resolve(secure);
      });
    };
    listen(socket, "data", onReply);
  });
}

// Listens on 127.0.0.1 (ephemeral port) and forwards each client only after
// verifiedUpstream() succeeds. Rejections are passed to onRejected.
export async function createVerifiedPostgresForwarder({
  upstreamHost,
  upstreamPort,
  servername,
  ca,
  onRejected,
  timeoutMs = 10_000,
}) {
  if (!servername || !ca || ca.length === 0)
    throw new Error("FORWARDER_REQUIRES_SERVERNAME_AND_CA");
  const server = createServer((client) => {
    client.pause();
    client.on("error", () => client.destroy());
    verifiedUpstream({
      host: upstreamHost,
      port: upstreamPort,
      servername,
      ca,
      timeoutMs,
    }).then(
      (upstream) => {
        upstream.on("error", () => {});
        // The client may have gone away while the upstream was negotiating.
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        const close = () => {
          client.destroy();
          upstream.destroy();
        };
        client.on("close", close);
        upstream.on("error", close);
        upstream.on("close", close);
        client.pipe(upstream).pipe(client);
        client.resume();
      },
      (error) => {
        onRejected?.(error);
        client.destroy();
      },
    );
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  return {
    port: server.address().port,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

// The wrapper accepts only verify-full settings: the upstream URL must ask
// for verify-full, and no environment knob may downgrade verification.
export function assertVerifiedTlsSettings(
  sourceUrl,
  environment = process.env,
) {
  if ("STOCKWISE_SEED_PGSSLMODE" in environment)
    throw new Error("SEED_TLS_OVERRIDE_REFUSED");
  if (
    environment.PGSSLMODE !== undefined &&
    environment.PGSSLMODE !== "verify-full"
  ) {
    throw new Error("SEED_PGSSLMODE_MUST_BE_VERIFY_FULL");
  }
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("SEED_TLS_VERIFICATION_DISABLED");
  if (sourceUrl.searchParams.get("sslmode") !== "verify-full")
    throw new Error("SEED_SOURCE_MUST_BE_VERIFY_FULL");
}
