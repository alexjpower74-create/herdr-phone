import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { RPC } from "./core";
import { Failure } from "./security";

export type ConversationPage = {
  available: boolean;
  reason?: "not_configured" | "not_found" | "ambiguous" | "offline";
  session: string | null;
  revision: string;
  turns: { id: string; entries: { id: string; role: "user" | "assistant" | "tool"; text: string }[] }[];
  nextCursor: string | null;
};
export type TranscriptSource = ((terminalId: string, before?: string) => Promise<ConversationPage>) & { close?: () => void };
type Source = { format: "messages" | "responses"; root: string; sessions?: string };
type Machine = { ssh?: string; sources: Source[] };
type Cursor = { terminal: string; binding: string; size: number; digest: string; before: number; generation: string };
type Result = { binding: string; size: number; digest: string; fingerprint: number[]; turns: any[]; next: number | null; unchanged?: boolean; error?: string };
type Cached = { result: Result; generation: string; page: ConversationPage };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const unavailable = (reason: ConversationPage["reason"]): ConversationPage => ({ available: false, reason, session: null, revision: "", turns: [], nextCursor: null });
const changed = () => new Failure(409, "conversation_changed", "The saved conversation changed. Reload its latest messages.");
const invalidCursor = () => new Failure(400, "invalid_cursor", "Invalid conversation cursor.");

// No paths, targets, process arguments or transcript details cross the HTTP boundary.
export function transcriptSource(core: RPC, configPath = process.env.HERDR_PHONE_TRANSCRIPTS_CONFIG || join(homedir(), ".config/herdr-phone/transcripts.json")): TranscriptSource {
  const secret = randomBytes(32), cache = new Map<string, Cached>();
  let active = 0, stopped = false;
  const readers = new Set<() => void>();
  const sign = (payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");
  function encode(cursor: Cursor) {
    const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    return payload + "." + sign(payload);
  }
  function decode(before: string, terminal: string): Cursor {
    if (before.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(before)) throw invalidCursor();
    const [payload, signature] = before.split("."), expected = sign(payload);
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw invalidCursor();
    try {
      const value = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (value.terminal !== terminal || !Number.isSafeInteger(value.before) || value.before < 0 || !Number.isSafeInteger(value.size) || value.size < value.before || !/^[a-f0-9]{64}$/.test(value.binding) || !/^[a-f0-9]{64}$/.test(value.digest) || typeof value.generation !== "string") throw Error();
      return value;
    } catch { throw invalidCursor(); }
  }
  async function machine(id: string): Promise<Machine | undefined> {
    let raw: string;
    try {
      const f = Bun.file(configPath);
      if (f.size > 65536) throw Error();
      raw = await f.text();
    } catch (e: any) {
      if (e?.code === "ENOENT") return undefined;
      throw new Failure(503, "conversation_unavailable", "Saved conversation configuration is unavailable.");
    }
    try {
      const item = JSON.parse(raw).machines?.[id];
      if (!item) return undefined;
      if (!Array.isArray(item.sources) || item.sources.length > 16 || item.sources.some((s: any) => !["messages", "responses"].includes(s.format) || typeof s.root !== "string" || !/^(\/|~\/)/.test(s.root) || (s.sessions !== undefined && (typeof s.sessions !== "string" || !/^(\/|~\/)/.test(s.sessions))))) throw Error();
      if (id !== "local" && (typeof item.ssh !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(item.ssh))) throw Error();
      return item;
    } catch { throw new Failure(503, "conversation_unavailable", "Saved conversation configuration is unavailable."); }
  }
  async function run(config: Machine, request: any): Promise<Result> {
    if (stopped) throw new Failure(503, "conversation_unavailable", "Saved conversation reader is unavailable.");
    if (active >= 4) throw new Failure(429, "conversation_busy", "Saved conversation reader is busy. Try again.");
    active++;
    try {
      const script = await readFile(new URL("./conversation-reader.py", import.meta.url), "utf8");
      const argument = Buffer.from(JSON.stringify(request)).toString("base64");
      const argv = config.ssh
        ? ["ssh", "-T", "-oBatchMode=yes", "-oConnectTimeout=3", "-oConnectionAttempts=1", "--", config.ssh, `python3 - '${argument}'`]
        : ["python3", "-", argument];
      return await new Promise<Result>((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
        const chunks: Buffer[] = []; let bytes = 0, settled = false;
        const done = (error?: Error, result?: Result) => {
          if (settled) return;
          settled = true; clearTimeout(timer); readers.delete(cancel);
          child.stdin.destroy(); child.stdout.destroy();
          if (error) { child.kill("SIGKILL"); reject(error); } else resolve(result!);
        };
        const cancel = () => done(new Failure(503, "conversation_unavailable", "Saved conversation reader stopped."));
        readers.add(cancel);
        const timer = setTimeout(() => done(new Failure(503, "conversation_timeout", "Saved conversation read timed out.")), 12000);
        child.on("error", () => done(new Failure(503, "conversation_unavailable", "Saved conversation reader is unavailable.")));
        child.stdin.on("error", () => {});
        child.stdout.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 16 * 1024 * 1024) done(new Failure(413, "conversation_too_large", "Saved conversation page is too large."));
          else chunks.push(chunk);
        });
        child.on("close", (code) => {
          if (settled) return;
          if (code !== 0) return done(new Failure(503, "conversation_unavailable", "Saved conversation reader is unavailable."));
          try { done(undefined, JSON.parse(Buffer.concat(chunks).toString())); }
          catch { done(new Failure(503, "conversation_unavailable", "Saved conversation reader is unavailable.")); }
        });
        child.stdin.end(script);
      });
    } finally { active--; }
  }
  const source: TranscriptSource = async (terminalId, before) => {
    const cursor = before === undefined ? undefined : decode(before, terminalId);
    const machineId = terminalId.includes("/") ? terminalId.split("/")[0] : "local";
    const config = await machine(machineId);
    if (!config || !config.sources.length) {
      if (cursor) throw changed();
      return unavailable("not_configured");
    }
    let facts: any;
    try { facts = await core.call("terminal.get", { terminal: terminalId }); }
    catch (e: any) { if (cursor) throw changed(); return unavailable(e?.kind === "not_found" ? "not_found" : "offline"); }
    const pid = facts.foreground?.pid;
    if (facts.state !== "live" || !Number.isSafeInteger(pid) || pid <= 0) {
      if (cursor) throw changed();
      return unavailable("not_found");
    }
    const previous = cache.get(terminalId);
    const expected = cursor || (previous ? { binding: previous.result.binding, size: previous.result.size, digest: previous.result.digest } : undefined);
    const request = { pid, cwd: facts.foreground?.cwd, sources: config.sources, expected, before: cursor?.before, cached: !cursor ? previous?.result.fingerprint : undefined };
    let result = await run(config, request);
    let generation = cursor?.generation || previous?.generation || "";
    if (result.error === "changed" && !cursor) {
      generation = randomBytes(16).toString("hex");
      result = await run(config, { ...request, expected: undefined, cached: undefined });
    }
    if (result.error) {
      if (cursor || result.error === "changed") throw changed();
      cache.delete(terminalId);
      if (["not_found", "ambiguous"].includes(result.error)) return unavailable(result.error as "not_found" | "ambiguous");
      if (result.error === "limit") throw new Failure(413, "conversation_too_large", "Saved conversation exceeds the reader limit.");
      throw new Failure(503, "conversation_unavailable", "Saved conversation reader is unavailable.");
    }
    const current = await core.call("terminal.get", { terminal: terminalId });
    if (current.state !== "live" || current.foreground?.pid !== pid || current.foreground?.cwd !== facts.foreground?.cwd || current.pid !== facts.pid || current.created_ms !== facts.created_ms) throw changed();
    if (result.unchanged && previous) return previous.page;
    generation ||= result.binding;
    const session = hash(result.binding + generation);
    const page: ConversationPage = {
      available: true, session, revision: hash(session + result.digest),
      turns: result.turns.map(t => ({ id: hash(session + ":turn:" + t.id), entries: t.entries.map((e: any) => ({ ...e, id: hash(session + ":entry:" + e.id) })) })),
      nextCursor: result.next === null ? null : encode({ terminal: terminalId, binding: result.binding, size: result.size, digest: result.digest, before: result.next, generation }),
    };
    if (!cursor) {
      cache.delete(terminalId);
      if (cache.size >= 16) cache.delete(cache.keys().next().value!);
      cache.set(terminalId, { result, generation, page });
    }
    return page;
  };
  source.close = () => { stopped = true; for (const cancel of [...readers]) cancel(); cache.clear(); };
  return source;
}
