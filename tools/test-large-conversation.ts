// Generated large-file proof; optional live mode performs terminal.get and file reads only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Core } from "../server/core";
import { transcriptSource, type ConversationPage } from "../server/conversation";

const output = resolve(process.env.CONVERSATION_LARGE_PROOF_DIR || "notes/large-conversation-proof");
await mkdir(output, { recursive: true });
const report: any = {
  sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  checks: [], cleaned: false,
};
const MiB = 1024 * 1024;
const targetBytes = 300 * MiB;
const scratch = new Set<string>();
let liveClosed = true;
function texts(page: ConversationPage) {
  return page.turns.flatMap(turn => turn.entries.filter(entry => entry.role === "user").map(entry => entry.text));
}
function record(format: "messages" | "responses", n: number, role: "user" | "assistant", cwd: string) {
  const id = `${role}-${n}`, text = `${role === "user" ? "Question" : "Reply"} ${n}`;
  return JSON.stringify(format === "messages"
    ? { type: role, uuid: id, sessionId: "large-check", cwd, message: { role, content: text } }
    : { type: "response_item", payload: { type: "message", id, role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } }) + "\n";
}
async function generated(format: "messages" | "responses") {
  const root = await mkdtemp(join(tmpdir(), "phone-large-history-"));
  scratch.add(root);
  const path = join(root, "large-check.jsonl"), config = join(root, "config.json");
  const file = await open(path, "w+"), calls: string[] = [];
  let bytes = 0, source: ReturnType<typeof transcriptSource> | undefined;
  const put = async (value: string | Buffer) => {
    const data = typeof value === "string" ? Buffer.from(value) : value;
    let offset = 0;
    while (offset < data.length) {
      const result = await file.write(data, offset, data.length - offset, bytes);
      assert(result.bytesWritten > 0);
      offset += result.bytesWritten; bytes += result.bytesWritten;
    }
  };
  try {
    if (format === "responses") await put(JSON.stringify({ type: "session_meta", payload: { id: "large-check", cwd: process.cwd() } }) + "\n");
    await put(record(format, 0, "user", process.cwd()));
    await put(record(format, 0, "assistant", process.cwd()));
    // One record crosses several read windows. Remaining padding uses valid
    // ignored records; the fixture is streamed, never allocated as one string.
    await put('{"type":"progress","data":"');
    const block = Buffer.alloc(MiB, 120);
    for (let n = 0; n < 24; n++) await put(block);
    await put('"}\n');
    const prefix = '{"type":"progress","data":"', suffix = '"}\n';
    while (bytes < targetBytes) {
      const length = Math.min(MiB, targetBytes - bytes);
      if (length < prefix.length + suffix.length) { await put("\n"); continue; }
      await put(prefix); await put(block.subarray(0, length - prefix.length - suffix.length)); await put(suffix);
    }
    for (let n = 1; n <= 125; n++) {
      await put(record(format, n, "user", process.cwd()));
      await put(record(format, n, "assistant", process.cwd()));
    }
    await file.sync();
    assert(bytes >= targetBytes);
    await writeFile(config, JSON.stringify({ machines: { local: { sources: [{ format, root }] } } }));
    source = transcriptSource({ async call(method: string) {
      calls.push(method); assert.equal(method, "terminal.get", "Proof must not observe or modify a terminal");
      return { state: "live", pid: 1, created_ms: 1, foreground: { pid: process.pid, cwd: process.cwd() } };
    } }, config);
    const check: any = { format, bytes };
    report.checks.push(check);
    const started = performance.now();
    let page: ConversationPage;
    try { page = await source("t1"); }
    finally { check.latestMs = performance.now() - started; }
    const latestMs = check.latestMs;
    check.latestTurns = page.turns.length;
    assert.equal(page.available, true);
    assert(latestMs < 300, `Latest ${format} page took ${latestMs.toFixed(1)} ms; expected <300 ms`);
    assert.deepEqual(texts(page), Array.from({ length: 50 }, (_, i) => `Question ${76 + i}`));
    const pages = [page], cursors = new Set<string>(), session = page.session;
    let warned = false;
    while (page.nextCursor) {
      assert(!cursors.has(page.nextCursor), "Older cursor repeated without making progress");
      cursors.add(page.nextCursor);
      assert(cursors.size < 100, "Bounded pages failed to reach the beginning");
      page = await source("t1", page.nextCursor);
      assert.equal(page.available, true); assert.equal(page.session, session);
      warned ||= (page as any).warnings?.includes("long_output_trimmed") === true;
      pages.push(page);
    }
    const ordered = pages.toReversed().flatMap(texts);
    assert.deepEqual(ordered, Array.from({ length: 126 }, (_, i) => `Question ${i}`), "Every user message must reach the beginning once, in order");
    assert(warned, "The oversized record needs a visible trimming warning");
    const entryIds = pages.flatMap(p => p.turns.flatMap(t => t.entries.map(e => e.id)));
    assert.equal(new Set(entryIds).size, entryIds.length, "Bounded pages must not duplicate entries");
    assert(calls.length > 0 && calls.every(method => method === "terminal.get"));
    Object.assign(report.checks.at(-1), { pages: pages.length, emptyWindows: pages.filter(p => !p.turns.length).length, exactUserMessages: ordered.length, uniqueEntries: entryIds.length, trimmingNotice: warned, terminalMethods: [...new Set(calls)] });
  } finally {
    source?.close?.();
    try { await file.close(); }
    finally { await rm(root, { recursive: true, force: true }); scratch.delete(root); }
  }
}
async function live(terminal: string) {
  assert(/^(?:[A-Za-z0-9_-]+\/)?t[0-9a-z]+$/.test(terminal), "Invalid configured terminal address");
  const core = new Core(), methods: string[] = [];
  liveClosed = false;
  const source = transcriptSource({ async call(method: string, params: unknown) {
    assert.equal(method, "terminal.get", "Live proof permits terminal metadata only");
    methods.push(method); return core.call(method, params);
  } });
  try {
    let cursor: string | undefined, session: string | null = null;
    const ids = new Set<string>();
    for (let index = 0; index < 4; index++) {
      const started = performance.now(), page = await source(terminal, cursor);
      assert.equal(page.available, true, "Requested live saved conversation is unavailable");
      assert(page.turns.length > 0, "Requested live page contains no saved turns");
      if (index) assert.equal(page.session, session); else session = page.session;
      for (const turn of page.turns) for (const entry of turn.entries) {
        assert(!ids.has(entry.id), "Live pages contain duplicate entries"); ids.add(entry.id);
      }
      report.checks.push({ page: index, elapsedMs: performance.now() - started, turns: page.turns.length, entries: page.turns.reduce((n, t) => n + t.entries.length, 0), older: !!page.nextCursor, warnings: (page as any).warnings || [] });
      if (index < 3) assert(page.nextCursor, "Requested live proof needs three older pages");
      cursor = page.nextCursor ?? undefined;
    }
    assert(methods.length > 0 && methods.every(method => method === "terminal.get"));
    report.terminalMethods = [...new Set(methods)];
  } finally { try { source.close?.(); } finally { core.close(); liveClosed = true; } }
}
try {
  const terminal = process.env.CONVERSATION_LARGE_LIVE_TERMINAL;
  report.mode = terminal ? "live-read-only" : "generated";
  if (terminal) await live(terminal);
  else for (const format of ["messages", "responses"] as const) await generated(format);
  report.cleaned = true;
} catch (error: any) {
  report.failure = { code: error?.code, message: String(error?.message || "Proof failed") };
  throw error;
} finally {
  report.cleaned = scratch.size === 0 && liveClosed;
  await writeFile(join(output, "proof.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
