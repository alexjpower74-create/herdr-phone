import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import { configuredPrograms } from "./spaces";
import type { RPC } from "./core";
export function terminal(t: any) {
  return {
    id: t.address,
    title: t.name || t.title || t.address,
    state: t.state === "finished" ? "finished" : "live",
    status: ["idle", "working", "done", "blocked", "error"].includes(
      t.status?.state,
    )
      ? t.status.state
      : "unknown",
    cols: t.cols,
    rows: t.rows,
  };
}
function ids(node: any, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  if (typeof node.content?.terminal === "string")
    out.push(node.content.terminal);
  for (const child of node.children || []) ids(child, out);
  return out;
}
export class Snapshot {
  revision = 0;
  cached?: any;
  at = 0;
  inflight?: Promise<any>;
  layouts = new Map<string, any>();
  metadata = new Map<
    string,
    { at: number; repo: string | null; branch: string | null }
  >();
  constructor(public core: RPC) {}
  programCache = new Map<string, { at: number; programs: any[] }>();
  async programs(machine = "local") {
    try {
      const cached = this.programCache.get(machine);
      if (cached && Date.now() - cached.at < 30000) return cached.programs;
      const programs = (await configuredPrograms(this.core, machine)).map(
        ({ id, name }) => ({ id, name, machineId: machine }),
      );
      this.programCache.set(machine, { at: Date.now(), programs });
      return programs;
    } catch {
      return [];
    }
  }
  async colors() {
    try {
      const shared = JSON.parse(
        await readFile(
          process.env.HERDR_PHONE_SHARED ||
            join(homedir(), ".config/herdr-app/shared.json"),
          "utf8",
        ),
      );
      return shared["space.colors"] || shared.space?.colors || {};
    } catch {
      return {};
    }
  }
  folder(s: any, machine: string, all: Map<string, any>): string {
    for (const tab of s.tabs || []) {
      const ordered = ids(tab.root).map((id) =>
        machine === "local" || id.includes("/") ? id : `${machine}/${id}`,
      );
      for (const t of all.values()) {
        if (
          t.labels?.["herdr.space"] === s.id &&
          t.labels?.["herdr.tab"] === tab.id &&
          (machine === "local"
            ? !t.address.includes("/")
            : t.address.startsWith(machine + "/")) &&
          !ordered.includes(t.address)
        )
          ordered.push(t.address);
      }
      for (const id of ordered) {
        const t = all.get(id);
        if (t?.state === "live" && (t.foreground?.cwd || t.cwd))
          return t.foreground?.cwd || t.cwd;
      }
    }
    return s.folder || "";
  }
  get(force = false): Promise<any> {
    if (!force && this.cached && Date.now() - this.at < 750)
      return Promise.resolve(this.cached);
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }
  async refresh() {
    const [listing, machineList, localPrograms, colors] = await Promise.all([
      this.core.call("terminal.list", { all: true }),
      this.core.call("machine.list"),
      this.programs(),
      this.colors(),
    ]);
    const machines = [
      {
        id: "local",
        name: process.env.HERDR_PHONE_LOCAL_NAME?.trim() || "This computer",
        online: true,
      },
      ...(machineList.machines || [])
        .filter((m: any) => !m.temporary)
        .map((m: any) => ({
          id: m.name,
          name: m.name.charAt(0).toUpperCase() + m.name.slice(1),
          online: m.state === "connected",
        })),
    ];
    const programs = [
      ...localPrograms,
      ...(
        await Promise.all(
          machines
            .slice(1)
            .map((m) =>
              m.online
                ? this.programs(m.id)
                : Promise.resolve(this.programCache.get(m.id)?.programs || []),
            ),
        )
      ).flat(),
    ];
    await Promise.all(
      machines
        .filter((m) => m.online)
        .map(async (m) => {
          try {
            const doc = await this.core.call("doc.get", {
              name: "herdr-app",
              ...(m.id === "local" ? {} : { on: m.id }),
            });
            this.layouts.set(m.id, doc.value || { spaces: [] });
          } catch (e) {
            if (m.id === "local") throw e;
            m.online = false;
          }
        }),
    );
    const all = new Map<string, any>(
      listing.terminals.map((t: any) => [t.address, t]),
    );
    for (const m of machines.filter((m) => !m.online))
      for (const s of this.cached?.spaces || [])
        if (s.machineId === m.id)
          for (const tab of s.tabs)
            for (const t of tab.terminals)
              if (!all.has(t.id))
                all.set(t.id, {
                  address: t.id,
                  name: t.title,
                  state: t.state,
                  status: { state: t.status },
                  cols: t.cols,
                  rows: t.rows,
                  cwd: s.cwd,
                });
    await Promise.all(
      machines
        .filter((m) => m.online)
        .flatMap((m) =>
          (this.layouts.get(m.id)?.spaces || []).map(async (s: any) => {
            const folder = this.folder(s, m.id, all);
            const key = `${m.id}:${folder}`;
            if (
              !folder ||
              Date.now() - (this.metadata.get(key)?.at || 0) < 30000
            )
              return;
            const meta = {
              at: Date.now(),
              repo: null as string | null,
              branch: null as string | null,
            };
            this.metadata.set(key, meta);
            try {
              const result = await this.core.call("machine.exec", {
                ...(m.id === "local" ? {} : { on: m.id }),
                cwd: folder,
                argv: [
                  "git",
                  "rev-parse",
                  "--path-format=absolute",
                  "--git-common-dir",
                  "--abbrev-ref",
                  "HEAD",
                ],
                timeout: 1,
              });
              if (result.code === 0 && !result.timed_out) {
                const lines = Buffer.from(result.stdout, "base64")
                  .toString()
                  .trim()
                  .split("\n");
                if (lines.length === 2) {
                  meta.repo = basename(lines[0].replace(/\/\.git\/?$/, ""));
                  meta.branch = lines[1] === "HEAD" ? null : lines[1];
                }
              }
            } catch {}
          }),
        ),
    );
    const spaces = machines.flatMap((m) => {
      const qualify = (id: string) =>
        m.id === "local" || id.startsWith(m.id + "/") ? id : `${m.id}/${id}`;
      return (this.layouts.get(m.id)?.spaces || []).map((s: any) => {
        const folder = this.folder(s, m.id, all);
        const palette: Record<string, string> = {
          ansi6: "#22a99a",
          ansi3: "#e3814f",
          ansi4: "#5b8def",
          ansi5: "#8b7cf6",
          ansi2: "#3fae6a",
          ansi1: "#d9649a",
        };
        const color = colors[qualify(s.id)] || s.color || "ansi4";
        return {
          id: qualify(s.id),
          machineId: m.id,
          name: s.name || basename(s.folder || "") || "Space",
          cwd: folder,
          repo: this.metadata.get(`${m.id}:${folder}`)?.repo || null,
          branch: this.metadata.get(`${m.id}:${folder}`)?.branch || null,
          color: /^#[a-f0-9]{6}$/i.test(color)
            ? color
            : palette[color] || palette.ansi4,
          tabs: (s.tabs || []).map((tab: any, index: number) => {
            const ordered = ids(tab.root).map(qualify);
            for (const t of listing.terminals)
              if (
                t.labels?.["herdr.space"] === s.id &&
                t.labels?.["herdr.tab"] === tab.id &&
                (m.id === "local"
                  ? !t.address.includes("/")
                  : t.address.startsWith(m.id + "/")) &&
                !ordered.includes(t.address)
              )
                ordered.push(t.address);
            return {
              id: qualify(tab.id),
              name: tab.name || `Tab ${index + 1}`,
              terminals: ordered
                .filter((id) => all.has(id))
                .map((id) => terminal(all.get(id))),
            };
          }),
        };
      });
    });
    const next = {
      version: 1,
      revision: this.revision,
      machines,
      spaces,
      programs,
    };
    if (
      JSON.stringify({ ...this.cached, revision: 0 }) !==
      JSON.stringify({ ...next, revision: 0 })
    )
      this.revision++;
    next.revision = this.revision;
    this.cached = next;
    this.at = Date.now();
    return next;
  }
}
