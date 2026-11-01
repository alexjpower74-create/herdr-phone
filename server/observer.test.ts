import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Observer, type ObserverFactory, type ObserverOutput } from "./observer";
import { start } from "./index";
import { Core } from "./core";
import { Store } from "./security";
const wait = async (condition: () => boolean) => {
  for (let i = 0; i < 300; i++) { if (condition()) return; await Bun.sleep(10); }
  throw Error("Condition not reached");
};
for (const order of ["before", "after"]) test(`observer preserves replay larger than initial credit, data ${order} reply`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "observer-test-"));
  const previous = { hc: process.env.HERDR_PHONE_HC, log: process.env.OBSERVER_LOG, order: process.env.OBSERVER_ORDER };
  process.env.HERDR_PHONE_HC = join(import.meta.dir, "fixtures/observer-core.ts");
  process.env.OBSERVER_LOG = join(dir, "wire");
  process.env.OBSERVER_ORDER = order;
  const expected = Buffer.from("\x1b[31m" + "row 🙂\r\n".repeat(65000));
  const chunks: Buffer[] = [];
  let size: any, failures = 0;
  const observer = new Observer({ terminalId: "remote/t1", history: 1000, cols: 80, rows: 24 }, async (bytes, metadata) => {
    chunks.push(bytes); if (metadata) size = metadata;
  }, () => failures++);
  try {
    await wait(() => chunks.reduce((n, b) => n + b.length, 0) === expected.length);
    expect(Buffer.concat(chunks)).toEqual(expected);
    expect(size).toEqual({ cols: 101, rows: 33 });
    expect(failures).toBe(0);
    await Bun.sleep(20);
    const frames = (await readFile(join(dir, "wire"), "utf8")).trim().split("\n").map(JSON.parse);
    expect(frames[0].body).toMatchObject({ method: "terminal.attach", params: { observe: true, history: 1000, terminal: "remote/t1", cols: 80, rows: 24 } });
    const stream = frames.filter((f: any) => f.channel !== 0);
    expect(stream.length).toBeGreaterThan(16);
    expect(stream.every((f: any) => f.channel === 7 && [1, 2].includes(f.kind))).toBe(true);
    expect(stream.filter((f: any) => f.kind === 1).reduce((n: number, f: any) => n + Buffer.from(f.body, "hex").readUInt32LE(), 0)).toBe(expected.length);
    observer.close();
    expect(observer.closed).toBe(true);
  } finally {
    observer.close();
    for (const [key, value] of Object.entries({ HERDR_PHONE_HC: previous.hc, OBSERVER_LOG: previous.log, OBSERVER_ORDER: previous.order }))
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await rm(dir, { recursive: true, force: true });
  }
});

class FakeCore {
  reads: any[] = [];
  cols = 80;
  finished = false;
  async call(method: string, p: any = {}) {
    if (method === "machine.list") return { machines: [] };
    if (method === "terminal.list") return { terminals: [] };
    if (method === "doc.get") return { value: { spaces: [] } };
    if (method === "terminal.get") return { address: p.terminal, cols: this.cols, rows: 24, state: this.finished ? "finished" : "live" };
    if (method === "terminal.read") { this.reads.push(p); return { text: "unchanged", complete: true }; }
    return {};
  }
}
async function socketFixture() {
  const dir = await mkdtemp(join(tmpdir(), "observer-ws-")), store = new Store(dir), core = new FakeCore();
  const paired = await store.exchange(await store.pairing(), "Phone");
  const observations: { request: any; output: ObserverOutput; fail: () => void; closed: boolean }[] = [];
  const observerFactory: ObserverFactory = (request, output, fail) => {
    const entry = { request, output, fail, closed: false }; observations.push(entry);
    return { close() { entry.closed = true; } };
  };
  const app = start({ port: 0, origin: "http://localhost", core, store, observerFactory });
  const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/api/ws`, { protocols: ["herdr-phone.v1", `auth.${paired.token}`], headers: { Origin: "http://localhost" } });
  const messages: any[] = [];
  ws.onmessage = e => messages.push(JSON.parse(String(e.data)));
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(Error("socket")); });
  return { app, ws, messages, observations, core, store, paired, async cleanup() { ws.close(); app.stop(); await rm(dir, { recursive: true, force: true }); } };
}
test("watch generation, history, ordering, dimensions, screen dedupe, unwatch and revoke", async () => {
  const f = await socketFixture();
  try {
    const watching = (watchId: string, history: number) => f.ws.send(JSON.stringify({ type: "watch", terminalId: "remote/t1", watchId, history }));
    watching("first", 500);
    await wait(() => f.observations.length === 1);
    const first = f.observations[0];
    await first.output(Buffer.from("\x1b[32mfirst"));
    await first.output(Buffer.from("second"));
    await wait(() => f.messages.filter(m => m.type === "output").length === 2);
    expect(f.messages.filter(m => m.type === "output").map(m => [m.watchId, m.seq, m.reset, m.history])).toEqual([["first", 0, true, 500], ["first", 1, false, 500]]);
    await wait(() => f.messages.some(m => m.type === "screen"));
    await Bun.sleep(800);
    expect(f.messages.filter(m => m.type === "screen")).toHaveLength(1);
    watching("history", 1000);
    await wait(() => f.observations.length === 2);
    expect(first.closed).toBe(true);
    await expect(first.output(Buffer.from("stale"))).rejects.toThrow();
    const second = f.observations[1];
    expect(second.request.history).toBe(1000);
    await second.output(Buffer.from("snapshot"));
    await wait(() => f.messages.some(m => m.type === "output" && m.watchId === "history"));
    expect(f.messages.find(m => m.type === "output" && m.watchId === "history")).toMatchObject({ seq: 0, reset: true, history: 1000 });
    f.ws.send(JSON.stringify({ type: "unwatch" }));
    await wait(() => second.closed);
    await expect(second.output(Buffer.from("stale"))).rejects.toThrow();
    watching("revoked", 500);
    await wait(() => f.observations.length === 3);
    await f.store.revoke(f.paired.device.id);
    const closed = new Promise<number>(resolve => f.ws.onclose = e => resolve(e.code));
    await expect(f.observations[2].output(Buffer.from("secret"))).rejects.toThrow();
    expect(await closed).toBe(4001);
    expect(f.observations[2].closed).toBe(true);
    expect(f.core.reads.every(p => p.lines === 0)).toBe(true);
  } finally { await f.cleanup(); }
});
test("invalid watch budgets are rejected and finished screens explicitly fall back", async () => {
  const f = await socketFixture();
  try {
    for (const history of [-1, 100001, 0.5, "500"]) {
      const count = f.messages.length;
      f.ws.send(JSON.stringify({ type: "watch", terminalId: "t1", watchId: "invalid", history }));
      await wait(() => f.messages.length > count);
    }
    expect(f.observations).toHaveLength(0);
    f.core.finished = true;
    f.ws.send(JSON.stringify({ type: "watch", terminalId: "t1", watchId: "finished", history: 0 }));
    await wait(() => f.messages.some(m => m.code === "observer_unavailable"));
    expect(f.messages.find(m => m.code === "observer_unavailable").watchId).toBe("finished");
    expect(f.observations).toHaveLength(0);
  } finally { await f.cleanup(); }
});

class ControlledCore extends Core {
  writes: { channel: number; kind: number; body: Buffer }[] = [];
  killed = false;
  resolveAttach!: (value: any) => void;
  override call() { return new Promise(resolve => this.resolveAttach = resolve); }
  constructor() {
    super();
    this.process = { stdin: { write: (bytes: Buffer) => {
      this.writes.push({ channel: bytes.readUInt32LE(), kind: bytes[4], body: bytes.subarray(9) }); return true;
    } } } as any;
  }
  override close() { this.killed = true; }
  data(bytes = Buffer.from("data"), kind = 0) { this.onFrame!({ channel: 7, kind, body: bytes }); }
  attach() { this.resolveAttach({ channel: 7, terminal: { cols: 80, rows: 24 } }); }
}
test("observer credits only delivered chunks, closes failures and bounds pending data", async () => {
  const core = new ControlledCore();
  let deliver!: () => void, failed = 0;
  const observer = new Observer({ terminalId: "t1", history: 500, cols: 80, rows: 24 }, () => new Promise<void>(resolve => deliver = resolve), () => failed++, core);
  core.data(); // first paint before the reply
  core.attach();
  await wait(() => !!deliver);
  expect(core.writes).toHaveLength(0);
  // While delivery is paused, the queue stays bounded and fails closed.
  for (let i = 0; i < 65; i++) core.data(Buffer.alloc(16384));
  expect(observer.closed).toBe(true);
  expect(core.killed).toBe(true);
  expect(failed).toBe(1);
  expect(core.writes.map(f => f.kind)).toEqual([2]);
  deliver();
  await Bun.sleep(0);
  expect(core.writes.map(f => f.kind)).toEqual([2]);
});
test("observer teardown after output rejection and core CLOSE preserves last data order", async () => {
  for (const reject of [true, false]) {
    const core = new ControlledCore(), seen: string[] = [];
    let failed = 0;
    const observer = new Observer({ terminalId: "t1", history: 0, cols: 80, rows: 24 }, async bytes => {
      seen.push(bytes.toString()); if (reject) throw Error("Slow consumer");
    }, () => failed++, core);
    core.data(Buffer.from("final"));
    core.data(Buffer.from("{}"), 2);
    core.attach();
    await wait(() => observer.closed);
    expect(seen).toEqual(["final"]);
    expect(failed).toBe(1);
    expect(core.writes.map(f => f.kind)).toEqual(reject ? [2] : [1, 2]);
    expect(core.killed).toBe(true);
  }
});
test("observer errors release the socket watch and prohibit late chunks", async () => {
  const f = await socketFixture();
  try {
    f.ws.send(JSON.stringify({ type: "watch", terminalId: "t1", watchId: "failed" }));
    await wait(() => f.observations.length === 1);
    const entry = f.observations[0];
    entry.fail();
    await wait(() => f.messages.some(m => m.code === "observer_unavailable"));
    expect(entry.closed).toBe(true);
    await expect(entry.output(Buffer.from("late"))).rejects.toThrow();
  } finally { await f.cleanup(); }
});
test("oversized observer output closes socket and releases channel", async () => {
  const f = await socketFixture();
  try {
    f.ws.send(JSON.stringify({ type: "watch", terminalId: "t1", watchId: "large" }));
    await wait(() => f.observations.length === 1);
    const closed = new Promise<number>(resolve => f.ws.onclose = e => resolve(e.code));
    await expect(f.observations[0].output(Buffer.alloc(16385))).rejects.toThrow();
    expect(await closed).toBe(1013);
    expect(f.observations[0].closed).toBe(true);
  } finally { await f.cleanup(); }
});

test("geometry changes release affected observations for a fresh replay via event or polling", async () => {
  for (const source of ["event", "poll"]) {
    const f = await socketFixture();
    try {
      f.ws.send(JSON.stringify({ type: "watch", terminalId: "remote/t1", watchId: "geometry" }));
      await wait(() => f.observations.length === 1);
      const closed = new Promise<number>(resolve => f.ws.onclose = e => resolve(e.code));
      await f.observations[0].output(Buffer.from("old-width"));
      if (source === "event") {
        f.app.consumeCoreEvent({ method: "event", params: { type: "size", terminal: "t9", data: { cols: 120, rows: 24 } } });
        expect(f.observations[0].closed).toBe(false);
        f.app.consumeCoreEvent({ method: "event", params: { type: "size", terminal: "remote/t1", data: { cols: 120, rows: 24 } } });
      } else f.core.cols = 120;
      expect(await closed).toBe(1012);
      expect(f.observations[0].closed).toBe(true);
      await expect(f.observations[0].output(Buffer.from("new-width"))).rejects.toThrow();
    } finally { await f.cleanup(); }
  }
});
