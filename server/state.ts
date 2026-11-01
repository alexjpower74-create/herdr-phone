import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { RPC } from './core';
export function terminal(t: any) {
  return { id: t.address, title: t.name || t.title || t.address, state: t.state === 'finished' ? 'finished' : 'live', status: ['idle','working','done','blocked','error'].includes(t.status?.state) ? t.status.state : 'unknown', cols: t.cols, rows: t.rows };
}
function ids(node: any, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.content?.terminal === 'string') out.push(node.content.terminal);
  for (const child of node.children || []) ids(child, out);
  return out;
}
export class Snapshot {
  revision = 0; cached?: any; at = 0; inflight?: Promise<any>;
  layouts = new Map<string, any>();
  constructor(public core: RPC) {}
  async programs() {
    try { const p = JSON.parse(await readFile(process.env.HERDR_PHONE_PROGRAMS || join(homedir(), '.config', 'herdr-app', 'programs.json'), 'utf8')); return Object.entries(p.programs || {}).map(([id, v]: any) => ({ id, name: v.name || id })); } catch { return []; }
  }
  get(force = false): Promise<any> {
    if (!force && this.cached && Date.now() - this.at < 750) return Promise.resolve(this.cached);
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => { this.inflight = undefined; }); return this.inflight;
  }
  async refresh() {
    const [listing, machineList, programs] = await Promise.all([this.core.call('terminal.list', { all: true }), this.core.call('machine.list'), this.programs()]);
    const machines = [{ id: 'local', name: 'This computer', online: true }, ...(machineList.machines || []).filter((m: any) => !m.temporary).map((m: any) => ({ id: m.name, name: m.name, online: m.state === 'connected' }))];
    await Promise.all(machines.filter(m => m.online).map(async m => {
      try { const doc = await this.core.call('doc.get', { name: 'herdr-app', ...(m.id === 'local' ? {} : { on: m.id }) }); this.layouts.set(m.id, doc.value || { spaces: [] }); }
      catch (e) { if (m.id === 'local') throw e; m.online = false; }
    }));
    const all = new Map<string, any>(listing.terminals.map((t: any) => [t.address, t]));
    const spaces = machines.flatMap(m => {
      const qualify = (id: string) => m.id === 'local' || id.startsWith(m.id + '/') ? id : `${m.id}/${id}`;
      return (this.layouts.get(m.id)?.spaces || []).map((s: any) => ({
        id: qualify(s.id), machineId: m.id, name: s.name || 'Space', cwd: s.folder || '', repo: null, branch: null,
        color: /^#[a-f0-9]{6}$/i.test(s.color) ? s.color : '#6977b8',
        tabs: (s.tabs || []).map((tab: any) => {
          const ordered = ids(tab.root).map(qualify);
          for (const t of listing.terminals) if (t.labels?.['herdr.space'] === s.id && t.labels?.['herdr.tab'] === tab.id && (m.id === 'local' ? !t.address.includes('/') : t.address.startsWith(m.id + '/')) && !ordered.includes(t.address)) ordered.push(t.address);
          return { id: qualify(tab.id), name: tab.name || 'Terminal', terminals: ordered.filter(id => all.has(id)).map(id => terminal(all.get(id))) };
        })
      }));
    });
    const next = { version: 1, revision: this.revision, machines, spaces, programs };
    if (JSON.stringify({ ...this.cached, revision: 0 }) !== JSON.stringify({ ...next, revision: 0 })) this.revision++;
    next.revision = this.revision; this.cached = next; this.at = Date.now(); return next;
  }
}
