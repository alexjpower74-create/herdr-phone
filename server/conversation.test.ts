import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, appendFile, open, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transcriptSource, type TranscriptSource } from "./conversation";
import { start } from "./index";
import { Store } from "./security";

async function fixture(format: "messages" | "responses", action: (ctx: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "conversation-test-"));
  const path = join(root, "sample-session.jsonl"), config = join(root, "config.json");
  const original = await readFile(new URL(`fixtures/conversation-${format}.jsonl`, import.meta.url), "utf8");
  await writeFile(path, original.replaceAll("/work/sample", process.cwd()));
  const file = await open(path, "r");
  await writeFile(config, JSON.stringify({ machines: { local: { sources: [{ format, root }] } } }));
  let foreground = process.pid;
  const calls: string[] = [];
  const core = { async call(method: string) {
    calls.push(method);
    if (method !== "terminal.get") throw Error("Unexpected terminal observation");
    return { state: "live", pid: 123, created_ms: 456, foreground: { pid: foreground, cwd: process.cwd() } };
  } };
  const source = transcriptSource(core, config);
  try { await action({ source, path, config, root, file, calls, core, replacePID: () => foreground = 2147483647 }); }
  finally { await file.close(); await rm(root, { recursive: true, force: true }); }
}
for (const format of ["messages", "responses"] as const) {
  test(`${format}: text and bounded tool names, no internal records or duplicate events`, async () => {
    await fixture(format, async ({ source, calls }: any) => {
      const page = await source("t1");
      expect(page.available).toBe(true);
      expect(page.turns).toHaveLength(2);
      expect(page.turns[0].entries.map((e: any) => e.text)).toEqual(["First question", "First reply", "read_file"]);
      expect(page.turns[1].entries.map((e: any) => e.text)).toEqual(["Second question", "Extra paragraph", "Second reply"]);
      expect(JSON.stringify(page)).not.toContain("PRIVATE_");
      expect(JSON.stringify(page)).not.toContain(process.cwd());
      expect(page.nextCursor).toBeNull();
      expect(await source("t1")).toEqual(page);
      expect(calls.every((c: string) => c === "terminal.get")).toBe(true);
    });
  });
}
const user = (n: number) => JSON.stringify({ type: "response_item", payload: { type: "message", id: `user-${n}`, role: "user", content: [{ type: "input_text", text: `Question ${n}` }] } }) + "\n";
const reply = (text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", id: "appended-reply", role: "assistant", content: [{ type: "output_text", text }] } });

test("125 turns page newest chronologically to beginning; append updates same last turn; cursor survives append", async () => {
  await fixture("responses", async ({ source, path }: any) => {
    await appendFile(path, Array.from({ length: 125 }, (_, n) => user(n)).join(""));
    const latest = await source("t1");
    expect(latest.turns).toHaveLength(50);
    expect(latest.turns[0].entries[0].text).toBe("Question 75");
    const partial = reply("Still working");
    await appendFile(path, partial);
    const waiting = await source("t1");
    expect(waiting.turns).toEqual(latest.turns);
    await appendFile(path, "\n");
    const updated = await source("t1");
    expect(updated.session).toBe(latest.session);
    expect(updated.turns.at(-1).id).toBe(latest.turns.at(-1).id);
    expect(updated.turns.at(-1).entries.at(-1).text).toBe("Still working");
    expect(updated.revision).not.toBe(latest.revision);
    const older = await source("t1", latest.nextCursor);
    expect(older.turns).toHaveLength(50);
    expect(older.turns[0].entries[0].text).toBe("Question 25");
    const first = await source("t1", older.nextCursor);
    expect(first.turns).toHaveLength(27);
    expect(first.turns[0].entries[0].text).toBe("First question");
    expect(first.nextCursor).toBeNull();
    await expect(source("t2", latest.nextCursor)).rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
    await expect(source("t1", latest.nextCursor + "x")).rejects.toMatchObject({ status: 400 });
  });
});

test("cursor rejects same-size prefix rewrite, replacement and changed process; latest reset gets new session", async () => {
  await fixture("responses", async ({ source, path, replacePID }: any) => {
    await appendFile(path, Array.from({ length: 60 }, (_, n) => user(n)).join(""));
    const first = await source("t1");
    const content = await readFile(path, "utf8");
    await writeFile(path, content.replace("First question", "Other question"));
    await expect(source("t1", first.nextCursor)).rejects.toMatchObject({ code: "conversation_changed" });
    const reset = await source("t1");
    expect(reset.session).not.toBe(first.session);
    await rename(path, path + ".old");
    await writeFile(path, content);
    await expect(source("t1", reset.nextCursor)).rejects.toMatchObject({ code: "conversation_changed" });
    replacePID();
    await expect(source("t1", first.nextCursor)).rejects.toMatchObject({ code: "conversation_changed" });
  });
});

test("unrelated newest-by-cwd files never resolve, multiple verified descriptors are ambiguous", async () => {
  await fixture("responses", async ({ root, path, file, source }: any) => {
    const other = join(root, "other.jsonl");
    await writeFile(other, await readFile(path));
    const fd = await open(other, "r");
    try { expect((await source("t1")).reason).toBe("ambiguous"); }
    finally { await fd.close(); }
    await file.close();
    expect((await source("t1")).reason).toBe("not_found");
  });
});

test("route requires auth, accepts only a single before, rechecks revocation and never observes terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "conversation-route-"));
  const store = new Store(root), device = await store.exchange(await store.pairing(), "Test");
  const seen: any[] = [];
  const source: TranscriptSource = async (...args) => { seen.push(args); return { available: true, session: "opaque", revision: "revision", turns: [], nextCursor: null }; };
  const core = { async call() { throw Error("No terminal RPC allowed"); } };
  const app = start({ port: 0, store, core, transcriptSource: source });
  const url = `http://127.0.0.1:${app.server.port}/api/terminals/remote%2Ft1/conversation`;
  const get = (suffix = "", token = device.token) => fetch(url + suffix, { headers: { Authorization: `Bearer ${token}` } });
  try {
    expect((await get("", "wrong")).status).toBe(401);
    expect(seen).toHaveLength(0);
    const response = await get("?before=opaque-cursor");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(seen).toEqual([["remote/t1", "opaque-cursor"]]);
    expect((await get("?before=a&before=b")).status).toBe(400);
    expect((await get("?path=arbitrary")).status).toBe(400);
    await store.revoke(device.device.id);
    expect((await get()).status).toBe(401);
  } finally { app.stop(); await rm(root, { recursive: true, force: true }); }
});

test("PID index without open descriptor validates process start, cwd, domain and session", async () => {
  if (process.platform !== "linux") return;
  await fixture("messages", async ({ file, path, config, root, source }: any) => {
    await file.close();
    const raw = (await readFile(`/proc/${process.pid}/stat`, "utf8")).split(")").at(-1)!.trim().split(/\s+/);
    const { readlink } = await import("node:fs/promises");
    const domain = `linux:${(await readFile("/etc/machine-id", "utf8")).trim()}:${await readlink(`/proc/${process.pid}/ns/pid`)}`;
    const index = { pid: process.pid, sessionId: "sample-session", cwd: process.cwd(), procStart: raw[19], pidDomain: domain, startedAt: Date.now() };
    const indexPath = join(root, `${process.pid}.json`);
    await writeFile(config, JSON.stringify({ machines: { local: { sources: [{ format: "messages", root, sessions: root }] } } }));
    await writeFile(indexPath, JSON.stringify(index));
    expect((await source("t1")).available).toBe(true);
    for (const bad of [{ procStart: "0" }, { pidDomain: "wrong" }, { cwd: "/missing" }, { sessionId: "unrelated" }, { pid: 1 }]) {
      await writeFile(indexPath, JSON.stringify({ ...index, ...bad }));
      expect((await source("t1")).reason).toBe("not_found");
    }
    await writeFile(indexPath, JSON.stringify(index));
    expect((await source("t1")).turns).toHaveLength(2);
  });
});

test("same-ID final reply snapshots replace text without duplicate entries", async () => {
  await fixture("responses", async ({ source, path }: any) => {
    await appendFile(path, reply("Working") + "\n");
    const first = await source("t1");
    await appendFile(path, reply("Finished") + "\n");
    const second = await source("t1");
    expect(second.turns.at(-1).id).toBe(first.turns.at(-1).id);
    expect(second.turns.at(-1).entries).toHaveLength(first.turns.at(-1).entries.length);
    expect(second.turns.at(-1).entries.at(-1)).toEqual({ ...first.turns.at(-1).entries.at(-1), text: "Finished" });
  });
});

test("resource limits return explicit errors instead of truncating transcript data", async () => {
  await fixture("responses", async ({ source, path }: any) => {
    await appendFile(path, "x".repeat(4 * 1024 * 1024 + 1));
    await expect(source("t1")).rejects.toMatchObject({ status: 413, code: "conversation_too_large" });
  });
});

test("terminal identity is rechecked after saved file IO", async () => {
  await fixture("responses", async ({ root, core }: any) => {
    let count = 0;
    const source = transcriptSource({ async call(method: string) {
      const facts = await core.call(method);
      return ++count === 1 ? facts : { ...facts, created_ms: 999 };
    } }, join(root, "config.json"));
    await expect(source("t1")).rejects.toMatchObject({ status: 409, code: "conversation_changed" });
  });
});

test("revocation during a saved-history read rejects response and stop releases the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "conversation-revoke-"));
  const store = new Store(root), device = await store.exchange(await store.pairing(), "Test");
  let entered!: () => void, release!: () => void, closed = false;
  const started = new Promise<void>(resolve => entered = resolve), wait = new Promise<void>(resolve => release = resolve);
  const source: TranscriptSource = async () => { entered(); await wait; return { available: true, session: "opaque", revision: "revision", turns: [], nextCursor: null }; };
  source.close = () => { closed = true; };
  const app = start({ port: 0, store, core: { async call() { throw Error(); } }, transcriptSource: source });
  try {
    const response = fetch(`http://127.0.0.1:${app.server.port}/api/terminals/t1/conversation`, { headers: { Authorization: `Bearer ${device.token}` } });
    await started;
    await store.revoke(device.device.id);
    release();
    expect((await response).status).toBe(401);
  } finally { release(); app.stop(); await rm(root, { recursive: true, force: true }); }
  expect(closed).toBe(true);
});
