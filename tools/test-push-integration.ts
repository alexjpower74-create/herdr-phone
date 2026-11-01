// Explicit opt-in: this creates and removes one terminal in its own test space.
// The push receiver is local; no request is sent to a public push provider.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  createECDH,
  createDecipheriv,
  createPublicKey,
  hkdfSync,
  randomBytes,
  randomUUID,
  verify,
} from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "../server/core";
import { Store } from "../server/security";
import { start } from "../server/index";

if (process.env.HERDR_PHONE_INTEGRATION !== "1") {
  throw Error(
    "Set HERDR_PHONE_INTEGRATION=1 to run the disposable-terminal check.",
  );
}
const checkedSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const scratch = await mkdtemp(join(tmpdir(), "phone-push-proof-"));
const core = new Core();
const calls: string[] = [];
const call = core.call.bind(core);
core.call = (method, params) => {
  calls.push(method);
  return call(method, params);
};
const spaceId = `sp${randomUUID().replaceAll("-", "")}`;
const tabId = `tab${randomUUID().replaceAll("-", "")}`;
const name = `push-probe-${randomBytes(5).toString("hex")}`;
const origin = "https://phone.example.test";
const receiver = createECDH("prime256v1");
receiver.generateKeys();
const auth = randomBytes(16);
const endpoint = `https://web.push.apple.com/proof/${randomUUID()}`;
const received: any[] = [];
const otherNotifications: string[] = [];
let terminalId: string | undefined;
let app: ReturnType<typeof start> | undefined;
let receiverFailure: Error | undefined;
let wireCount = 0;
let testCount = 0;
let fake: ReturnType<typeof createReceiver> | undefined;
const report: any = {
  sha: checkedSha,
  transitions: [],
};

// Independent receiver for the single-record aes128gcm format in RFC 8291.
function decrypt(body: Buffer) {
  assert.equal(body[20], 65);
  const salt = body.subarray(0, 16);
  const sender = body.subarray(21, 86);
  const ciphertext = body.subarray(86);
  assert(ciphertext.length <= body.readUInt32BE(16));
  const info = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    receiver.getPublicKey(),
    sender,
  ]);
  const ikm = hkdfSync(
    "sha256",
    receiver.computeSecret(sender),
    auth,
    info,
    32,
  );
  const key = hkdfSync(
    "sha256",
    ikm,
    salt,
    Buffer.from("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = hkdfSync(
    "sha256",
    ikm,
    salt,
    Buffer.from("Content-Encoding: nonce\0"),
    12,
  );
  const decipher = createDecipheriv(
    "aes-128-gcm",
    Buffer.from(key),
    Buffer.from(nonce),
  );
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([
    decipher.update(ciphertext.subarray(0, -16)),
    decipher.final(),
  ]);
  let end = plain.length - 1;
  while (plain[end] === 0) end--;
  assert.equal(plain[end], 2, "Expected the final record delimiter");
  return JSON.parse(plain.subarray(0, end).toString());
}
function checkVapid(header: string | null) {
  const match = /^vapid t=([^, ]+), *k=([^, ]+)$/.exec(header || "");
  assert(match, "Missing VAPID authorization");
  const [encodedHeader, encodedPayload, signature] = match[1].split(".");
  assert.equal(
    JSON.parse(Buffer.from(encodedHeader, "base64url").toString()).alg,
    "ES256",
  );
  const claims = JSON.parse(
    Buffer.from(encodedPayload, "base64url").toString(),
  );
  assert.equal(claims.aud, "https://web.push.apple.com");
  assert.equal(claims.sub, origin);
  assert(
    claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 86400,
  );
  const publicKey = Buffer.from(match[2], "base64url");
  const key = createPublicKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: publicKey.subarray(1, 33).toString("base64url"),
      y: publicKey.subarray(33).toString("base64url"),
    },
  });
  assert(
    verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
  );
}
const createReceiver = () =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        assert.equal(request.method, "POST");
        assert.equal(request.headers.get("content-encoding"), "aes128gcm");
        assert.equal(request.headers.get("ttl"), "60");
        checkVapid(request.headers.get("authorization"));
        const body = Buffer.from(await request.arrayBuffer());
        assert(
          !body.includes(Buffer.from("Notification probe")),
          "Payload must be encrypted",
        );
        const payload = decrypt(body);
        assert(
          !JSON.stringify(payload).includes("DO_NOT_PUSH"),
          "Terminal facts leaked into push",
        );
        wireCount++;
        if (
          payload.url === `/#terminal=${encodeURIComponent(terminalId || "")}`
        )
          received.push(payload);
        else if (payload.body === "Notifications are on") testCount++;
        else otherNotifications.push("unrelated transition");
        return new Response(null, { status: 201 });
      } catch (error) {
        receiverFailure = error as Error;
        return new Response(null, { status: 400 });
      }
    },
  });
async function eventually(
  check: () => boolean | Promise<boolean>,
  label: string,
) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (receiverFailure) throw receiverFailure;
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw Error(label);
}
async function updateLayout(change: (value: any) => void) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const doc = await core.call("doc.get", { name: "herdr-app" });
    const value = structuredClone(doc.value);
    change(value);
    try {
      await core.call("doc.set", {
        name: "herdr-app",
        version: doc.version,
        value,
      });
      return;
    } catch (error: any) {
      if (!["conflict", "version_conflict"].includes(error.kind)) throw error;
    }
  }
  throw Error("Could not update the test space");
}
const desktop = () =>
  JSON.parse(execFileSync("herdr-app", ["status"], { encoding: "utf8" }));
const focus = (x: any) => [x.space, x.tab, x.focused_pane, x.agent];
let beforeFocus: unknown[] | undefined;
let generation = 0;
async function status(state: string) {
  const id = ++generation;
  await writeFile(join(scratch, "control.json"), JSON.stringify({ state, id }));
  await eventually(async () => {
    const facts = await core.call("terminal.get", { terminal: terminalId });
    return (
      facts.status?.state === state &&
      facts.status?.title === `DO_NOT_PUSH_STATUS_${id}`
    );
  }, `No real ${state} status`);
}

try {
  fake = createReceiver();
  beforeFocus = focus(desktop());
  const before = (await core.call("terminal.list", { all: true })).terminals;
  await writeFile(
    join(scratch, "status.ts"),
    `
const path = process.argv[2];
let previous = -1;
process.stdout.write("\\x1b]0;DO_NOT_PUSH_TERMINAL_TITLE\\x07DO_NOT_PUSH_SCREEN\\n");
setInterval(async () => {
  const command = await Bun.file(path).json().catch(() => null);
  if (!command || command.id === previous) return;
  previous = command.id;
  const title = Buffer.from("DO_NOT_PUSH_STATUS_" + command.id).toString("base64");
  const message = Buffer.from("DO_NOT_PUSH_MESSAGE").toString("base64");
  process.stdout.write("\\x1b]7501;state=" + command.state + ":app=notification-probe:title=" + title + ":msg=" + message + "\\x1b\\\\");
}, 50);
`,
  );
  await writeFile(
    join(scratch, "control.json"),
    JSON.stringify({ state: "idle", id: 0 }),
  );
  const made = await core.call("terminal.run", {
    argv: [
      process.execPath,
      join(scratch, "status.ts"),
      join(scratch, "control.json"),
    ],
    cwd: scratch,
    name,
    no_parent: true,
    no_notify: true,
    labels: { "herdr.space": spaceId, "herdr.tab": tabId },
  });
  terminalId = made.address;
  await updateLayout((value) => {
    value.spaces ||= [];
    let space = value.spaces.find((s: any) => s.id === spaceId);
    if (!space) {
      space = { id: spaceId, tabs: [] };
      value.spaces.push(space);
    }
    space.name = "Notification probe";
    space.folder = scratch;
    space.tabs = [
      {
        id: tabId,
        name: "Notification probe",
        root: {
          id: `p${randomUUID().replaceAll("-", "")}`,
          type: "block",
          content: { terminal: terminalId },
        },
      },
    ];
  });
  assert.deepEqual(
    focus(desktop()),
    beforeFocus,
    "Test creation moved desktop focus",
  );
  await status("idle");
  const store = new Store(join(scratch, "config"));
  const device = await store.exchange(
    await store.pairing(),
    "Integration probe",
  );
  app = start({
    port: 8792,
    origin,
    core,
    store,
    pushTransport: async (details) => {
      assert.equal(details.endpoint, endpoint);
      const response = await fetch(`http://127.0.0.1:${fake!.port}/push`, {
        method: details.method,
        headers: details.headers as Record<string, string>,
        body: details.body,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      return { statusCode: response.status };
    },
  });
  const api = (path: string, body?: object) =>
    fetch(`http://127.0.0.1:8792/api${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${device.token}`,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  assert.equal((await api("/push/key")).status, 200);
  assert.equal(
    (
      await api("/push/subscription", {
        endpoint,
        expirationTime: null,
        keys: {
          p256dh: receiver.getPublicKey().toString("base64url"),
          auth: auth.toString("base64url"),
        },
      })
    ).status,
    201,
  );
  await eventually(() => !!app!.notifications.ready, "No event baseline");
  assert.equal(received.length, 0);
  await status("working");
  await status("blocked");
  await eventually(() => received.length >= 1, "No blocked push");
  assert.equal(received.length, 1);
  assert.equal(received[0].body, "Notification probe needs you");
  report.transitions.push({
    state: "blocked",
    count: received.length,
    turn: (await core.call("terminal.get", { terminal: terminalId })).turn,
  });
  await status("blocked");
  await api("/state");
  const firstProcess = app.events!.process!;
  firstProcess.kill();
  await eventually(
    () => app!.events!.process !== firstProcess && !!app!.notifications.ready,
    "Event feed did not reconnect",
  );
  await status("blocked");
  await status("done");
  await eventually(() => received.length >= 2, "No done push");
  assert.equal(received.length, 2);
  assert.equal(received[1].body, "Notification probe finished");
  assert.notEqual(received[0].tag, received[1].tag);
  report.transitions.push({
    state: "done",
    count: received.length,
    turn: (await core.call("terminal.get", { terminal: terminalId })).turn,
  });
  await status("done");
  await api("/state");
  // Let the ordered event queue drain through an explicit later turn boundary.
  await status("idle");
  await eventually(
    () => app!.notifications.terminals.get(terminalId!)?.status === "idle",
    "Later status event did not reach the notification consumer",
  );
  await app.drainNotifications();
  assert.equal(received.length, 2, "Repeated reports or reconnect re-notified");
  assert.equal((await api("/push/test", {})).status, 202);
  await eventually(
    () => testCount >= 1,
    "Test push not received",
  );
  assert.equal(testCount, 1, "Send test delivered more than once");
  assert.equal(received.length, 2);
  assert(
    !calls.includes("terminal.read"),
    "Push delivery must not read terminal content",
  );
  assert(!calls.includes("terminal.attach"), "Push delivery must not attach");
  assert.deepEqual(focus(desktop()), beforeFocus, "Test changed desktop focus");
  const after = (await core.call("terminal.list", { all: true })).terminals;
  for (const t of before.filter((t: any) => t.state === "live")) {
    const unchanged = after.find((a: any) => a.address === t.address);
    if (unchanged)
      assert.deepEqual(
        [unchanged.cols, unchanged.rows],
        [t.cols, t.rows],
        "Existing terminal dimensions changed",
      );
  }
  Object.assign(report, {
    encrypted: true,
    vapidVerified: true,
    noContentReads: true,
    focusUnchanged: true,
    desktopSizesUnchanged: true,
    reconnectSilent: true,
    unrelatedTransitionsIgnored: otherNotifications.length,
    wireCount,
    testCount,
  });
} finally {
  const cleanupErrors: unknown[] = [];
  const attempt = async (action: () => unknown) => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  try {
    if (terminalId) {
      await attempt(async () => {
        const own = await core.call("terminal.get", { terminal: terminalId });
        assert(
          own.name === name && own.cwd === scratch,
          "Cleanup ownership mismatch",
        );
        await attempt(() =>
          core.call("terminal.kill", { terminal: terminalId }),
        );
        await attempt(() => core.call("terminal.rm", { terminal: terminalId }));
      });
      await attempt(() =>
        updateLayout((value) => {
          value.spaces = (value.spaces || []).filter(
            (s: any) => s.id !== spaceId,
          );
        }),
      );
      await attempt(async () => {
        const listing = await core.call("terminal.list", { all: true });
        assert(
          !listing.terminals.some((t: any) => t.address === terminalId),
          "Test terminal remains",
        );
        const layout = await core.call("doc.get", { name: "herdr-app" });
        assert(
          !layout.value.spaces.some((s: any) => s.id === spaceId),
          "Test space remains",
        );
        assert.deepEqual(
          focus(desktop()),
          beforeFocus,
          "Cleanup moved desktop focus",
        );
      });
    }
  } finally {
    await attempt(() => app?.stop());
    await attempt(() => core.close());
    await attempt(() => fake?.stop(true));
    await attempt(() => rm(scratch, { recursive: true, force: true }));
  }
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "Integration cleanup failed");
}
report.cleaned = true;
await mkdir("notes", { recursive: true });
await writeFile(
  "notes/push-integration-proof.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
