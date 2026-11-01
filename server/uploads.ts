import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RPC } from "./core";
import { Store, Failure, unauthorized } from "./security";
import { MAX_UPLOAD, UPLOAD_LIFETIME, publicUpload, type UploadRecord, type UploadedFile } from "./upload-manifest";
import { checkMedia } from "./upload-media";
import { UploadProcesses } from "./upload-process";
import { storageTransport, type UploadTransport, type UploadTarget } from "./upload-transport";

const unavailable = () => new Failure(409, "upload_unavailable", "Attachment is unavailable for this device and terminal.");
const capacity = () => new Failure(429, "upload_capacity", "Attachment storage is at capacity. Try again later.");
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function uploadIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8 || new Set(value).size !== value.length || value.some(id => typeof id !== "string" || !/^[a-f0-9]{48}$/.test(id))) throw unavailable();
  return value;
}
export function incarnation(facts: any): string {
  if (facts?.state !== "live" || !Number.isSafeInteger(facts.pid) || facts.pid <= 0 || !Number.isSafeInteger(facts.created_ms) || facts.created_ms <= 0) throw unavailable();
  return digest(JSON.stringify([facts.pid, facts.created_ms]));
}
function displayName(name: string, converted: boolean): string {
  let safe = name.split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, "").trim().slice(0, 120) || "Attachment";
  if (converted) safe = safe.replace(/\.[^.]*$/, "") + ".jpg";
  return safe;
}

export class Uploads {
  private processes = new UploadProcesses();
  private storageProcesses = new UploadProcesses();
  private transport: UploadTransport;
  private active = 0;
  private stopped = false;
  private controllers = new Set<AbortController>();
  private pruning?: Promise<void>;
  private configPath: string;
  constructor(private core: RPC, private store: Store, transport?: UploadTransport) {
    this.transport = transport ?? storageTransport(this.storageProcesses);
    this.configPath = process.env.HERDR_PHONE_TRANSCRIPTS_CONFIG || join(homedir(), ".config/herdr-phone/transcripts.json");
  }
  close() {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    this.processes.close();
    // Storage children observe the same abort signal; cleanup uses fresh bounded readers.
  }
  async target(machine: string): Promise<UploadTarget> {
    if (machine === "local") return { root: process.env.HERDR_PHONE_UPLOADS_DIR || join(homedir(), ".cache/herdr-phone/uploads") };
    try {
      const file = Bun.file(this.configPath);
      if (file.size > 65536) throw Error();
      const item = JSON.parse(await file.text()).machines?.[machine];
      if (!item || typeof item.ssh !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(item.ssh) || (item.uploadsDir !== undefined && (typeof item.uploadsDir !== "string" || !/^(\/|~\/)/.test(item.uploadsDir)))) throw Error();
      return { ssh: item.ssh, root: item.uploadsDir || "~/.cache/herdr-phone/uploads" };
    } catch { throw new Failure(503, "upload_unavailable", "Private upload storage is unavailable."); }
  }
  private machine(id: string) { return id.includes("/") ? id.split("/")[0] : "local"; }
  private checkDevice(state: Awaited<ReturnType<Store["read"]>>, device: string) {
    if (!state.devices.some(d => d.id === device)) throw unauthorized();
  }
  async prune() {
    if (this.pruning) return this.pruning;
    const work = async () => {
      const state = await this.store.read(), now = this.store.now();
      const expired = (state.uploads || []).filter(r => r.expiresAt <= now || (r.status === "pending" && r.createdAt + 15 * 60000 <= now));
      for (const record of expired) {
        try {
          const target = await this.target(record.machine);
          if (target.root !== record.root) continue;
          await this.transport("remove", target, record);
          await this.store.transact(s => { s.uploads = (s.uploads || []).filter(r => r.id !== record.id); });
        } catch { /* Retain metadata/quota until its owned file can be removed safely. */ }
      }
    };
    this.pruning = work();
    try { await this.pruning; } finally { this.pruning = undefined; }
  }
  create(device: string, id: string, file: File, signal?: AbortSignal): Promise<UploadedFile> {
    return this.receive(device, id, async () => file, signal);
  }
  async receive(device: string, id: string, parse: () => Promise<File>, signal?: AbortSignal): Promise<UploadedFile> {
    if (this.stopped || signal?.aborted) throw new Failure(503, "upload_unavailable", "Upload was cancelled.");
    if (this.active >= 4) throw capacity();
    this.active++;
    try { return await this.process(device, id, await parse(), signal); }
    finally { this.active--; }
  }
  private async process(device: string, id: string, file: File, signal?: AbortSignal): Promise<UploadedFile> {
    if (this.stopped || signal?.aborted) throw new Failure(503, "upload_unavailable", "Upload was cancelled.");
    if (file.size > MAX_UPLOAD) throw new Failure(413, "too_large", "File is too large.");
    if (!file.size) throw new Failure(415, "unsupported_file", "Unsupported or invalid file content.");
    const controller = new AbortController(), abort = () => controller.abort();
    this.controllers.add(controller); signal?.addEventListener("abort", abort, { once: true });
    let reserved = false, record: UploadRecord | undefined, target: UploadTarget | undefined;
    try {
      await this.prune();
      const facts = await this.core.call("terminal.get", { terminal: id });
      const binding = incarnation(facts), machine = this.machine(id);
      target = await this.target(machine);
      if (!/^(\/|~\/)/.test(target.root) || target.root.split("/").includes("..")) throw unavailable();
      const now = this.store.now(), key = randomBytes(24).toString("hex");
      record = { id: key, name: displayName(file.name, false), type: "", size: MAX_UPLOAD, converted: false,
        deviceId: device, terminalId: id, incarnation: binding, machine, root: target.root,
        date: new Date(now).toISOString().slice(0, 10), filename: key + ".txt", createdAt: now, expiresAt: now + UPLOAD_LIFETIME, status: "pending", digest: "" };
      await this.store.transact(s => {
        this.checkDevice(s, device);
        const all = s.uploads || [], deviceFiles = all.filter(r => r.deviceId === device), machineFiles = all.filter(r => r.machine === machine);
        if (all.length >= 16384 || deviceFiles.length >= 1024 || machineFiles.length >= 4096 || deviceFiles.reduce((n, r) => n + r.size, MAX_UPLOAD) > 512 * 1024 * 1024 || machineFiles.reduce((n, r) => n + r.size, MAX_UPLOAD) > 2 * 1024 * 1024 * 1024) throw capacity();
        (s.uploads ||= []).push(record!);
      });
      reserved = true;
      const media = await checkMedia(Buffer.from(await file.arrayBuffer()), this.processes, controller.signal);
      record = { ...record, type: media.type, converted: media.converted, name: displayName(file.name, media.converted), filename: key + "." + media.extension };
      await this.store.transact(s => {
        this.checkDevice(s, device);
        const stored = s.uploads?.find(r => r.id === key);
        if (!stored) throw unavailable();
        stored.filename = record!.filename;
      });
      record = { ...record, size: media.bytes.length, digest: digest(media.bytes) };
      if (controller.signal.aborted) throw unavailable();
      await this.transport("write", target, record, media.bytes, controller.signal);
      if (controller.signal.aborted || this.stopped || incarnation(await this.core.call("terminal.get", { terminal: id })) !== binding) throw unavailable();
      record.status = "ready";
      await this.store.transact(s => {
        this.checkDevice(s, device);
        const index = s.uploads?.findIndex(r => r.id === key) ?? -1;
        if (index < 0 || record!.expiresAt <= this.store.now()) throw unavailable();
        s.uploads![index] = record!;
      });
      return publicUpload(record);
    } catch (error) {
      if (reserved && record && target) {
        let removed = false;
        try { await this.transport("remove", target, record); removed = true; } catch { /* Prune retries safely. */ }
        if (removed) await this.store.transact(s => { s.uploads = (s.uploads || []).filter(r => r.id !== record!.id); }).catch(() => {});
      }
      throw error;
    } finally {
      this.controllers.delete(controller); signal?.removeEventListener("abort", abort);
    }
  }
  async recheck(device: string, id: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const binding = incarnation(await this.core.call("terminal.get", { terminal: id }));
    await this.store.transact(s => {
      this.checkDevice(s, device);
      for (const key of ids) {
        const r = s.uploads?.find(r => r.id === key);
        if (!r || r.status !== "ready" || r.expiresAt <= this.store.now() || r.deviceId !== device || r.terminalId !== id || r.machine !== this.machine(id) || r.incarnation !== binding) throw unavailable();
      }
    });
  }
  async paths(device: string, id: string, ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const binding = incarnation(await this.core.call("terminal.get", { terminal: id }));
    const state = await this.store.read(); this.checkDevice(state, device);
    const paths: string[] = [];
    for (const key of ids) {
      const record = state.uploads?.find(r => r.id === key);
      if (!record || record.status !== "ready" || record.deviceId !== device || record.terminalId !== id || record.machine !== this.machine(id) || record.incarnation !== binding || record.expiresAt <= this.store.now()) throw unavailable();
      const target = await this.target(record.machine);
      if (target.root !== record.root) throw unavailable();
      try { paths.push((await this.transport("check", target, record)).path!); }
      catch { throw unavailable(); }
    }
    if (incarnation(await this.core.call("terminal.get", { terminal: id })) !== binding) throw unavailable();
    await this.store.transact(s => {
      this.checkDevice(s, device);
      for (const key of ids) {
        const r = s.uploads?.find(r => r.id === key);
        if (!r || r.status !== "ready" || r.expiresAt <= this.store.now() || r.deviceId !== device || r.incarnation !== binding) throw unavailable();
      }
    });
    return paths;
  }
}
