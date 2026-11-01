import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  open,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class Failure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const invalid = () =>
  new Failure(400, "invalid_input", "Invalid request.");
export const unauthorized = () =>
  new Failure(401, "unauthorized", "Pair this device to continue.");
type Device = { id: string; label: string; createdAt: string; hash: string };
type State = {
  version: 1;
  devices: Device[];
  pair?: { hash: string; expires: number; attempts: number };
  exchanges?: number[];
};
export const publicDevice = ({ id, label, createdAt }: Device) => ({
  id,
  label,
  createdAt,
});
export class Store {
  constructor(
    public dir = process.env.HERDR_PHONE_CONFIG_DIR ||
      join(homedir(), ".config", "herdr-phone"),
    public now = Date.now,
  ) {}
  async read(): Promise<State> {
    try {
      const s = JSON.parse(
        await readFile(join(this.dir, "state.json"), "utf8"),
      );
      if (
        !s ||
        s.version !== 1 ||
        !Array.isArray(s.devices) ||
        s.devices.some(
          (d: any) =>
            !d ||
            typeof d.id !== "string" ||
            typeof d.label !== "string" ||
            !/^[a-f0-9]{64}$/.test(d.hash) ||
            typeof d.createdAt !== "string",
        ) ||
        (s.pair &&
          (!/^[a-f0-9]{64}$/.test(s.pair.hash) ||
            !Number.isFinite(s.pair.expires) ||
            !Number.isInteger(s.pair.attempts))) ||
        (s.exchanges !== undefined &&
          (!Array.isArray(s.exchanges) ||
            s.exchanges.some((n: any) => !Number.isFinite(n))))
      )
        throw new Error("Invalid state");
      return s;
    } catch (e: any) {
      if (e.code === "ENOENT") return { version: 1, devices: [] };
      throw new Failure(503, "state_invalid", "Device state requires repair.");
    }
  }
  async transact<T>(fn: (s: State) => T | Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const lock = join(this.dir, "state.lock");
    const handle = await open(lock, "a", 0o600);
    await handle.chmod(0o600);
    await handle.close();
    // Kernel locks have no stale owner to recover. Closing the parent's pipe,
    // including process death, ends the holder and releases the lock.
    const holder = spawn(
      "flock",
      [
        "--exclusive",
        "--wait",
        "2",
        lock,
        "sh",
        "-c",
        "printf ready; cat >/dev/null",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    holder.stdin.on("error", () => {});
    holder.stderr.on("data", () => {});
    let acquired = false;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Failure(503, "state_locked", "Device state is busy."));
          }
        }, 2500);
        holder.stdout.once("data", () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        });
        const fail = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Failure(503, "state_locked", "Device state is busy."));
          }
        };
        holder.once("error", fail);
        holder.once("exit", fail);
      });
      acquired = true;
      const s = await this.read();
      const result = await fn(s);
      const path = join(this.dir, "state.json"),
        tmp = join(this.dir, `state.${randomBytes(8).toString("hex")}.tmp`);
      const file = await open(tmp, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(s));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, path);
      return result;
    } finally {
      holder.stdin.end();
      if (!acquired) holder.kill();
    }
  }
  async pairing() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = Array.from(
      randomBytes(8),
      (b) => alphabet[b % alphabet.length],
    ).join("");
    await this.transact((s) => {
      s.pair = { hash: hash(code), expires: this.now() + 600000, attempts: 0 };
    });
    return code;
  }
  async exchange(code: unknown, label: unknown) {
    if (
      typeof code !== "string" ||
      typeof label !== "string" ||
      !label.trim() ||
      label.trim().length > 64 ||
      code.length > 64
    )
      throw invalid();
    const result = await this.transact((s) => {
      const now = this.now();
      s.exchanges = (s.exchanges || []).filter((t) => t > now - 60000);
      if (s.exchanges.length >= 20)
        return { error: new Failure(429, "throttled", "Try again later.") };
      s.exchanges.push(now);
      const p = s.pair;
      if (!p || p.expires <= now || p.attempts >= 5) {
        delete s.pair;
        return { error: unauthorized() };
      }
      if (
        !timingSafeEqual(
          Buffer.from(p.hash, "hex"),
          Buffer.from(hash(code.trim().toUpperCase()), "hex"),
        )
      ) {
        if (++p.attempts >= 5) delete s.pair;
        return { error: unauthorized() };
      }
      delete s.pair;
      const token = randomBytes(32).toString("base64url");
      const device = {
        id: randomBytes(16).toString("hex"),
        label: label.trim(),
        createdAt: new Date(now).toISOString(),
        hash: hash(token),
      };
      s.devices.push(device);
      return { token, device: publicDevice(device) };
    });
    if ("error" in result) throw result.error;
    return result;
  }
  async auth(token: string | null) {
    if (!token || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw unauthorized();
    const d = (await this.read()).devices.find((d) =>
      timingSafeEqual(
        Buffer.from(d.hash, "hex"),
        Buffer.from(hash(token), "hex"),
      ),
    );
    if (!d) throw unauthorized();
    return publicDevice(d);
  }
  async list() {
    return (await this.read()).devices.map(publicDevice);
  }
  async revoke(query: string) {
    return this.transact((s) => {
      const found = s.devices.filter(
        (d) => d.id === query || d.label === query,
      );
      if (found.length !== 1)
        throw new Failure(409, "ambiguous_device", "Choose one device id.");
      s.devices = s.devices.filter((d) => d.id !== found[0].id);
      return found[0].id;
    });
  }
}
