import { Uploads, uploadIds } from "./uploads";
import { MAX_UPLOAD, UPLOAD_ENVELOPE } from "./upload-manifest";
import type { UploadTransport } from "./upload-transport";
import { transcriptSource, type TranscriptSource } from "./conversation";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { Core, EventFeed, type RPC } from "./core";
import { Store, Failure, invalid, unauthorized } from "./security";
import { Snapshot, terminal } from "./state";
import { createSpace } from "./spaces";
import { detectPrompt } from "./prompts";
import { Push, endpoint, subscription, type PushTransport } from "./push";
import { observe, type ObserverFactory, type Observation } from "./observer";
import { randomBytes } from "node:crypto";
import { PushEvents, notification } from "./push-events";

type SocketData = {
  token: string;
  deviceId: string;
  watch?: string;
  watchId?: string;
  messageId?: number;
  generation?: number;
  history?: number;
  observer?: Observation;
  screenKey?: string;
  cols?: number;
  rows?: number;
  busy?: boolean;
  revision?: number;
  connected?: boolean;
};
const keys = new Set([
  "shift+tab",
  "esc",
  "up",
  "down",
  "enter",
  "ctrl+c",
  "backspace",
  "tab",
  "left",
  "right",
  "delete",
  "home",
  "end",
]);
export function validateKeys(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 128 ||
    value.some(
      (k) =>
        typeof k !== "string" || (!keys.has(k) && !/^[A-Za-z0-9]$/.test(k)),
    )
  )
    throw invalid();
  return value;
}
export function coreKeys(input: string[]) {
  return validateKeys(input).map((key) =>
    /^[A-Z]$/.test(key) ? `shift+${key.toLowerCase()}` : key,
  );
}
export function validateText(text: unknown): string {
  if (
    typeof text !== "string" ||
    !text.length ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cs}]/u.test(text)
  )
    throw invalid();
  if (Buffer.byteLength(text) > 4096)
    throw new Failure(413, "too_large", "Input is too large.");
  return text;
}
export function screenDigest(id: string, text: string, facts: any): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        id,
        text,
        facts.state,
        facts.status,
        facts.turn,
        facts.status_ms,
      ]),
    )
    .digest("hex");
}
export function start(
  options: {
    port?: number;
    origin?: string;
    core?: RPC;
    store?: Store;
    staticDir?: string;
    pushTransport?: PushTransport;
    observerFactory?: ObserverFactory;
    transcriptSource?: TranscriptSource;
    uploadTransport?: UploadTransport;
  } = {},
) {
  const port = options.port ?? Number(process.env.HERDR_PHONE_PORT || 8790);
  const origin =
    options.origin ||
    process.env.HERDR_PHONE_ORIGIN ||
    `http://127.0.0.1:${port}`;
  if (new URL(origin).origin !== origin)
    throw new Error("Configure an exact origin");
  const core = options.core || new Core(),
    store = options.store || new Store(),
    state = new Snapshot(core);
  const uploads = new Uploads(core, store, options.uploadTransport);
  void uploads.prune().catch(() => {});
  const conversations = options.transcriptSource ?? transcriptSource(core);
  const push = new Push(store, origin, options.pushTransport);
  const sockets = new Set<any>(),
    queues = new Map<string, Promise<any>>();
  const observerFactory = options.observerFactory ?? (core instanceof Core ? observe : undefined);
  function release(ws: any) {
    ws.data.generation = (ws.data.generation || 0) + 1;
    const observer = ws.data.observer;
    ws.data.observer = undefined;
    try { observer?.close(); } catch { /* Teardown must not escape an event callback. */ }
    ws.data.watch = undefined;
    ws.data.screenKey = undefined;
  }
  function closeSocket(ws: any, code = 1013, reason = "Slow consumer") {
    release(ws);
    sockets.delete(ws);
    try { ws.close(code, reason); } catch { /* The transport may already be gone. */ }
  }
  function notify(ws: any, value: any) {
    try { send(ws, value); }
    catch { closeSocket(ws); }
  }
  function send(ws: any, value: any) {
    if (!sockets.has(ws)) throw Error("Socket closed");
    // A queued send has ambiguous delivery. Close instead of acknowledging it
    // to the core and letting an unbounded replay build behind the phone.
    try {
      if (ws.getBufferedAmount() > 128 * 1024 || ws.send(JSON.stringify(value)) <= 0)
        throw Error("Socket backpressure");
    } catch (e) { closeSocket(ws); throw e; }
  }
  async function watch(ws: any, id: string, watchId: string, history: number) {
    release(ws);
    ws.data.watch = id;
    ws.data.watchId = watchId;
    ws.data.history = history;
    const generation = ws.data.generation;
    const current = () => sockets.has(ws) && ws.data.generation === generation;
    let seq = 0;
    let failed = false;
    let observation: Observation | undefined;
    try {
      const facts = terminal(await core.call("terminal.get", { terminal: id }));
      await store.auth(ws.data.token);
      if (!current()) return;
      ws.data.cols = facts.cols;
      ws.data.rows = facts.rows;
      const unavailable = () => {
        if (!current() || failed) return;
        failed = true;
        try { observation?.close(); } catch { /* Already released or disconnected. */ }
        ws.data.observer = undefined;
        notify(ws, { type: "error", terminalId: id, watchId,
          code: "observer_unavailable", message: "Live observation unavailable. Showing current screen only." });
      };
      if (facts.state !== "live" || !observerFactory) unavailable();
      else {
        const observer = observerFactory({ terminalId: id, history, cols: facts.cols, rows: facts.rows }, async (bytes, size) => {
          await store.auth(ws.data.token).catch((e) => { closeSocket(ws, 4001, "Device revoked"); throw e; });
          if (!current() || failed) throw Error("Superseded observation");
          if (bytes.length > 16384) { closeSocket(ws); throw Error("Oversized output"); }
          if (size) { ws.data.cols = size.cols; ws.data.rows = size.rows; }
          send(ws, { type: "output", terminalId: id, watchId, history,
            cols: ws.data.cols, rows: ws.data.rows, seq, reset: seq === 0,
            data: bytes.toString("base64") });
          seq++;
        }, unavailable);
        observation = observer;
        if (!current() || failed) observer.close();
        else ws.data.observer = observer;
      }
      void tick(ws);
    } catch (e) {
      if (!current()) return;
      if (e instanceof Failure && e.status === 401) closeSocket(ws, 4001, "Device revoked");
      else notify(ws, { type: "error", terminalId: id, watchId, code: "observer_unavailable", message: "Live observation unavailable. Showing current screen only." });
    }
  }
  const root = resolve(
    options.staticDir || process.env.HERDR_PHONE_STATIC_DIR || "web/dist",
  );
  const json = (body: any, status = 200) =>
    Response.json(body, {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  const error = (e: any) => {
    if (!(e instanceof Failure) && e?.kind === "blocked")
      e = new Failure(
        409,
        "terminal_blocked",
        "This terminal is waiting for a choice.",
      );
    if (!(e instanceof Failure) && e?.kind === "not_found")
      e = new Failure(404, "not_found", "Resource not found.");
    if (
      !(e instanceof Failure) &&
      ["conflict", "blocked", "version_conflict"].includes(e?.kind)
    )
      e = new Failure(
        409,
        "conflict",
        "Core state conflicts with this request.",
      );
    return json(
      {
        error: {
          code: e instanceof Failure ? e.code : "core_unavailable",
          message: e instanceof Failure ? e.message : "Core unavailable.",
        },
      },
      e instanceof Failure ? e.status : 503,
    );
  };
  const auth = (req: Request) =>
    store.auth(
      req.headers
        .get("Authorization")
        ?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1] || null,
    );
  async function body(req: Request) {
    if (!req.headers.get("content-type")?.startsWith("application/json"))
      throw invalid();
    if (Number(req.headers.get("content-length")) > 32768)
      throw new Failure(413, "too_large", "Request is too large.");
    const reader = req.body?.getReader();
    if (!reader) throw invalid();
    let size = 0;
    const parts = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 32768) {
        await reader.cancel();
        throw new Failure(413, "too_large", "Request is too large.");
      }
      parts.push(value);
    }
    try {
      const value = JSON.parse(Buffer.concat(parts).toString());
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw invalid();
      return value;
    } catch {
      throw invalid();
    }
  }
  async function multipart(req: Request): Promise<File> {
    const contentType = req.headers.get("content-type") || "";
    if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) throw invalid();
    if (Number(req.headers.get("content-length")) > MAX_UPLOAD + UPLOAD_ENVELOPE) throw new Failure(413, "too_large", "File is too large.");
    const reader = req.body?.getReader();
    if (!reader) throw invalid();
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_UPLOAD + UPLOAD_ENVELOPE) { await reader.cancel(); throw new Failure(413, "too_large", "File is too large."); }
      chunks.push(part.value);
    }
    let form: FormData;
    try { form = await new Request("http://upload.invalid", { method: "POST", headers: { "content-type": contentType }, body: Buffer.concat(chunks) }).formData(); }
    catch { throw invalid(); }
    const parts = [...form.entries()];
    if (parts.length !== 1 || parts[0][0] !== "file" || !(parts[0][1] instanceof File)) throw invalid();
    const file = parts[0][1];
    if (file.size > MAX_UPLOAD || bytes - file.size > UPLOAD_ENVELOPE) throw new Failure(413, "too_large", "File is too large.");
    return file;
  }
  function serial(id: string, action: () => Promise<any>) {
    const previous = queues.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    queues.set(id, next);
    void next
      .finally(() => {
        if (queues.get(id) === next) queues.delete(id);
      })
      .catch(() => {});
    return next;
  }
  async function screen(id: string) {
    const [t, read] = await Promise.all([
      core.call("terminal.get", { terminal: id }),
      core.call("terminal.read", { terminal: id, lines: 0 }),
    ]);
    const screenId = screenDigest(id, read.text, t);
    return {
      terminal: terminal(t),
      text: read.text,
      complete: read.complete,
      screenId,
      prompt: detectPrompt(
        read.text,
        terminal(t).status,
        screenId,
        read.complete,
      ),
    };
  }
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: MAX_UPLOAD + UPLOAD_ENVELOPE,
    async fetch(req, srv) {
      try {
        const url = new URL(req.url),
          path = url.pathname;
        const requestOrigin = req.headers.get("origin");
        if (requestOrigin && requestOrigin !== origin)
          throw new Failure(401, "origin_rejected", "Origin rejected.");
        if (path.startsWith("/api/") && url.search && !/^\/api\/terminals\/[^/]+\/conversation$/.test(path)) throw invalid();
        if (path === "/api/health" && req.method === "GET") {
          try {
            await core.call("hello", { generation: 1 });
            return json({ ok: true, version: "1", core: "connected" });
          } catch {
            return json({ ok: false, version: "1", core: "disconnected" }, 503);
          }
        }
        if (path === "/api/pair" && req.method === "POST") {
          const b = await body(req);
          return json(await store.exchange(b.code, b.label), 201);
        }
        if (path === "/api/ws") {
          if (requestOrigin !== origin) throw unauthorized();
          const protocols = (req.headers.get("sec-websocket-protocol") || "")
            .split(",")
            .map((s) => s.trim());
          const credentials = protocols.filter((s) => s.startsWith("auth."));
          if (!protocols.includes("herdr-phone.v1") || credentials.length !== 1)
            throw unauthorized();
          const token = credentials[0].slice(5),
            device = await store.auth(token);
          if (
            srv.upgrade(req, {
              data: { token, deviceId: device.id },
              headers: { "Sec-WebSocket-Protocol": "herdr-phone.v1" },
            })
          )
            return;
          throw invalid();
        }
        if (path.startsWith("/api/")) {
          const device = await auth(req);
          if (path === "/api/device" && req.method === "GET")
            return json({ device });
          if (path === "/api/device" && req.method === "DELETE") {
            await store.revoke(device.id);
            for (const ws of sockets)
              if (ws.data.deviceId === device.id)
                closeSocket(ws, 4001, "Device revoked");
            return new Response(null, { status: 204 });
          }
          if (path === "/api/push/key" && req.method === "GET")
            return json({ publicKey: (await push.keys()).publicKey });
          if (path === "/api/push/subscription" && req.method === "GET") {
            const current = await push.current(device.id);
            return json({
              enabled: !!current,
              endpoint: current?.endpoint ?? null,
            });
          }
          if (path === "/api/push/subscription" && req.method === "POST") {
            await store.setSubscription(
              device.id,
              subscription(await body(req), store.now()),
            );
            return json({ ok: true }, 201);
          }
          if (path === "/api/push/subscription" && req.method === "DELETE") {
            const b = await body(req);
            await store.removeSubscription(device.id, endpoint(b.endpoint));
            return new Response(null, { status: 204 });
          }
          if (path === "/api/push/test" && req.method === "POST") {
            const b = await body(req);
            if (Object.keys(b).length) throw invalid();
            await push.send(device.id, {
              title: "Herdr",
              body: "Notifications are on",
              tag: randomBytes(16).toString("hex"),
              url: "/",
            });
            return json({ ok: true }, 202);
          }
          if (path === "/api/state" && req.method === "GET")
            return json(await state.get());
          if (path === "/api/spaces" && req.method === "POST") {
            const result = await createSpace(core, await body(req));
            state.at = 0;
            return json(result, 201);
          }
          const match = path.match(
            /^\/api\/terminals\/([^/]+)\/(screen|keys|send|prompt|conversation|uploads)$/,
          );
          if (match) {
            let id;
            try {
              id = decodeURIComponent(match[1]);
            } catch {
              throw invalid();
            }
            if (!/^(?:[A-Za-z0-9_.-]+\/)?t[a-zA-Z0-9]+$/.test(id))
              throw invalid();
            if (match[2] === "uploads" && req.method === "POST") {
              return json({ upload: await uploads.receive(device.id, id, () => multipart(req), req.signal) }, 201);
            }
            if (match[2] === "conversation" && req.method === "GET") {
              if ([...url.searchParams.keys()].some(k => k !== "before") || url.searchParams.getAll("before").length > 1) throw invalid();
              const result = await conversations(id, url.searchParams.get("before") ?? undefined);
              await auth(req);
              return json(result);
            }
            if (match[2] === "screen" && req.method === "GET")
              return json(await screen(id));
            if (req.method === "POST" && !["screen", "conversation", "uploads"].includes(match[2])) {
              const b = await body(req);
              if (match[2] === "prompt") {
                if (
                  typeof b.promptId !== "string" ||
                  typeof b.optionId !== "string"
                )
                  throw invalid();
                await serial(id, async () => {
                  const current = await screen(id);
                  const choice =
                    current.prompt?.id === b.promptId
                      ? current.prompt.options.find(
                          (option) => option.id === b.optionId,
                        )
                      : undefined;
                  if (!choice)
                    throw new Failure(
                      409,
                      "stale_prompt",
                      "The dialog changed. Review it again.",
                    );
                  await core.call("terminal.keys", {
                    terminal: id,
                    keys: coreKeys(choice.keys),
                  });
                });
              } else if (match[2] === "send") {
                const attachments = uploadIds(b.uploads);
                const text = attachments.length && b.text === "" ? "" : validateText(b.text);
                if (b.force !== undefined && typeof b.force !== "boolean")
                  throw invalid();
                if (b.force === true && typeof b.screenId !== "string")
                  throw invalid();
                await serial(id, async () => {
                  await auth(req);
                  const paths = await uploads.paths(device.id, id, attachments);
                  const message = paths.length ? paths.map(path => JSON.stringify(path)).join("\n") + (text ? "\n\n" + text : "") : text;
                  if (b.force === true) {
                    const current = await screen(id);
                    if (
                      current.terminal.status !== "blocked" ||
                      current.screenId !== b.screenId
                    )
                      throw new Failure(
                        409,
                        "stale_prompt",
                        "The dialog changed. Review it again.",
                      );
                  }
                  await auth(req);
                  await uploads.recheck(device.id, id, attachments);
                  await core.call("terminal.send", {
                    terminal: id,
                    text: message,
                    force: b.force === true,
                  });
                });
              } else {
                const input = coreKeys(b.keys);
                await serial(id, () =>
                  core.call("terminal.keys", { terminal: id, keys: input }),
                );
              }
              return json({ ok: true });
            }
          }
          throw new Failure(404, "not_found", "Resource not found.");
        }
        if (!["GET", "HEAD"].includes(req.method))
          throw new Failure(404, "not_found", "Resource not found.");
        let name;
        try {
          name = decodeURIComponent(path);
        } catch {
          throw invalid();
        }
        if (
          name.includes("\0") ||
          name.split("/").some((p) => p.startsWith("."))
        )
          throw invalid();
        const candidate = resolve(
          root,
          "." + (name === "/" ? "/index.html" : name),
        );
        const actual = await realpath(candidate).catch(() => "");
        if (!actual.startsWith(root + sep))
          throw new Failure(404, "not_found", "Resource not found.");
        const file = Bun.file(actual);
        if (!(await file.exists()))
          throw new Failure(404, "not_found", "Resource not found.");
        return new Response(req.method === "HEAD" ? null : file, {
          headers: {
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy":
              "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
            "Referrer-Policy": "no-referrer",
          },
        });
      } catch (e) {
        return error(e);
      }
    },
    websocket: {
      maxPayloadLength: 2048,
      backpressureLimit: 256 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        sockets.add(ws);
        void tick(ws);
      },
      async message(ws, raw) {
        const messageId = ws.data.messageId = (ws.data.messageId || 0) + 1;
        try {
          await store.auth(ws.data.token);
          if (!sockets.has(ws) || ws.data.messageId !== messageId) return;
          const msg = JSON.parse(String(raw));
          if (msg.type === "unwatch") { release(ws); return; }
          if (
            msg.type !== "watch" ||
            typeof msg.terminalId !== "string" ||
            !/^(?:[A-Za-z0-9_.-]+\/)?t[a-zA-Z0-9]+$/.test(msg.terminalId) ||
            (msg.watchId !== undefined && (typeof msg.watchId !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(msg.watchId))) ||
            (msg.history !== undefined && (!Number.isInteger(msg.history) || msg.history < 0 || msg.history > 100000))
          ) throw invalid();
          void watch(ws, msg.terminalId, msg.watchId ?? randomBytes(12).toString("hex"), msg.history ?? 500);
        } catch (e) {
          if (e instanceof Failure && e.status === 401) closeSocket(ws, 4001, "Device revoked");
          else notify(ws, { type: "error", code: "invalid_request", message: "Request rejected." });
        }
      },
      close(ws) { release(ws); sockets.delete(ws); },
    },
  });
  async function tick(ws: any) {
    if (ws.data.busy) return;
    ws.data.busy = true;
    try {
      await store.auth(ws.data.token);
      const snapshot = await state.get();
      await store.auth(ws.data.token);
      if (!sockets.has(ws)) return;
      if (ws.data.connected !== true) {
        send(ws, { type: "connection", connected: true });
        ws.data.connected = true;
      }
      if (ws.data.revision !== snapshot.revision) {
        send(ws, { type: "state", state: snapshot });
        ws.data.revision = snapshot.revision;
      }
      const id = ws.data.watch, generation = ws.data.generation;
      if (id) {
        const s = await screen(id);
        await store.auth(ws.data.token);
        if (sockets.has(ws) && ws.data.generation === generation && ws.data.watch === id) {
          if (ws.data.observer && (ws.data.cols !== s.terminal.cols || ws.data.rows !== s.terminal.rows)) {
            closeSocket(ws, 1012, "Terminal dimensions changed");
            return;
          }
          ws.data.cols = s.terminal.cols;
          ws.data.rows = s.terminal.rows;
          const value = { type: "screen", terminalId: id, watchId: ws.data.watchId,
            cols: s.terminal.cols, rows: s.terminal.rows, text: s.text,
            screenId: s.screenId, prompt: s.prompt };
          const key = JSON.stringify(value);
          if (key !== ws.data.screenKey) { send(ws, value); ws.data.screenKey = key; }
        }
      }
    } catch (e) {
      if (e instanceof Failure && e.status === 401)
        closeSocket(ws, 4001, "Device revoked");
      else {
        ws.data.connected = false;
        ws.data.revision = undefined;
        if (sockets.has(ws)) {
          notify(ws, { type: "connection", connected: false });
          closeSocket(ws, 1012, "Core reconnecting");
        }
      }
    } finally {
      ws.data.busy = false;
    }
  }
  const notifications = new PushEvents();
  let stopped = false;
  let delivery = Promise.resolve();
  let pendingNotices = 0;
  const consumeEvent = (message: any) => {
    if (stopped) return;
    const event = message?.method === "event" ? message.params : undefined;
    if (event?.type === "size" && typeof event.terminal === "string") {
      for (const ws of sockets)
        if (ws.data.watch === event.terminal)
          closeSocket(ws, 1012, "Terminal dimensions changed");
    }
    for (const notice of notifications.consume(message)) {
      if (pendingNotices >= 128) continue;
      pendingNotices++;
      delivery = delivery
        .then(async () => {
          if (stopped) return;
          const snapshot = await state.get();
          if (stopped) return;
          await push.broadcast(notification(notice, snapshot, state.layouts));
        })
        .catch(() => {})
        .finally(() => {
          pendingNotices--;
        });
    }
  };
  const events =
    core instanceof Core
      ? new EventFeed(
          () => {
            state.at = 0;
          },
          () => {
            notifications.disconnect();
            state.at = 0;
            for (const ws of sockets) {
              ws.data.connected = false;
              ws.data.revision = undefined;
              closeSocket(ws, 1012, "Core reconnecting");
            }
          },
          consumeEvent,
        )
      : undefined;
  const interval = setInterval(() => {
    for (const ws of sockets) void tick(ws);
  }, 750);
  return {
    server,
    sockets,
    state,
    store,
    core,
    uploads,
    push,
    notifications,
    events,
    drainNotifications: () => delivery,
    consumeCoreEvent: consumeEvent,
    stop() {
      stopped = true;
      conversations.close?.();
      uploads.close();
      push.stopped = true;
      events?.close();
      clearInterval(interval);
      for (const ws of sockets) closeSocket(ws, 1001, "Server stopped");
      server.stop(true);
      if (core instanceof Core) core.close();
    },
  };
}
if (import.meta.main) {
  const app = start();
  console.log(`Bridge listening on loopback port ${app.server.port}`);
}
