import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Observer, type ObserverFactory, type ObserverOutput } from "./observer";
import { start } from "./index";
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
    f.core.cols = 120;
    await wait(() => f.messages.some(m => m.type === "screen" && m.cols === 120));
    await first.output(Buffer.from("resized"));
    await wait(() => f.messages.some(m => m.type === "output" && m.cols === 120));
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
