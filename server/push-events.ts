export type NotificationKind = "blocked" | "done";
export type Notice = { terminal: string; turn: number; kind: NotificationKind };
type Ledger = {
  turn: number;
  createdMs?: number;
  status: string | null;
  seen: Set<NotificationKind>;
  present: boolean;
};
const kind = (state: unknown): NotificationKind | undefined =>
  state === "blocked" || state === "done" ? state : undefined;
const counter = (n: unknown): n is number =>
  Number.isSafeInteger(n) && (n as number) >= 0;

// Consume only the ordered subscription feed. HTTP snapshots are never inputs.
// The core emits status, then turn, when leaving working. Wait for that turn
// rather than synthesizing a counter from status changes.
export class PushEvents {
  seq = -1;
  ready = false;
  terminals = new Map<string, Ledger>();
  disconnect() {
    this.ready = false;
  }
  baseline(snapshot: any) {
    if (
      !snapshot ||
      !counter(snapshot.seq) ||
      !Array.isArray(snapshot.terminals)
    ) {
      this.disconnect();
      return;
    }
    if (this.ready && snapshot.seq < this.seq) return;
    this.seq = snapshot.seq;
    this.ready = true;
    for (const entry of this.terminals.values()) entry.present = false;
    for (const t of snapshot.terminals) this.seed(t);
    this.trim();
  }
  seed(t: any) {
    if (typeof t?.address !== "string" || !counter(t.turn)) return;
    const previous = this.terminals.get(t.address);
    const createdMs = counter(t.created_ms) ? t.created_ms : undefined;
    const sameTerminal =
      previous &&
      (createdMs === undefined ||
        previous.createdMs === undefined ||
        previous.createdMs === createdMs);
    const entry: Ledger =
      sameTerminal && previous.turn >= t.turn
        ? previous
        : {
            turn: t.turn,
            createdMs,
            status: null,
            seen: new Set(),
            present: true,
          };
    entry.createdMs = createdMs ?? entry.createdMs;
    entry.present = true;
    entry.status = t.status?.state ?? null;
    const k = kind(entry.status);
    if (k) entry.seen.add(k);
    this.terminals.set(t.address, entry);
  }
  trim() {
    // Current terminals each keep their complete current-turn ledger. Only
    // absent terminal tombstones are evicted; no per-turn history accumulates.
    const absent = [...this.terminals].filter(([, entry]) => !entry.present);
    for (const [id] of absent.slice(0, Math.max(0, absent.length - 1024)))
      this.terminals.delete(id);
  }
  consume(message: any): Notice[] {
    if (message?.id === 2 && message.result) {
      this.baseline(message.result);
      return [];
    }
    if (message?.method === "missed") {
      this.baseline(message.params);
      return [];
    }
    if (message?.method !== "event" || !this.ready) return [];
    const e = message.params;
    if (!counter(e?.seq) || e.seq <= this.seq) return [];
    this.seq = e.seq;
    const id = e.terminal;
    if (typeof id !== "string") return [];
    if (e.type === "created" || e.type === "restarted") {
      this.seed(e.data?.record || e.data);
      this.trim();
      return [];
    }
    const entry = this.terminals.get(id);
    if (!entry) return [];
    if (e.type === "removed") {
      entry.present = false;
      this.trim();
      return [];
    }
    let k: NotificationKind | undefined;
    if (e.type === "status") {
      const before = entry.status;
      entry.status = e.data?.status?.state ?? null;
      // A preceding working status means the next explicit turn event owns
      // the transition. Ordinary repeated reports have no separate turn.
      if (before !== "working") k = kind(entry.status);
    } else if (e.type === "turn") {
      if (!counter(e.data?.turn) || e.data.turn < entry.turn) return [];
      if (e.data.turn > entry.turn) {
        entry.turn = e.data.turn;
        entry.seen.clear();
      }
      entry.status = e.data.state ?? null;
      k = kind(entry.status);
    }
    if (!k || entry.seen.has(k)) return [];
    entry.seen.add(k);
    return [{ terminal: id, turn: entry.turn, kind: k }];
  }
}
const clean = (name: unknown): string =>
  typeof name === "string"
    ? name
        .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200)
    : "";
export function notification(
  notice: Notice,
  snapshot: any,
  layouts: Map<string, any>,
) {
  let name = "A terminal";
  for (const space of snapshot?.spaces || []) {
    const tab = space.tabs?.find((tab: any) =>
      tab.terminals?.some((t: any) => t.id === notice.terminal),
    );
    if (!tab) continue;
    const qualify = (id: string) =>
      space.machineId === "local" || id.startsWith(space.machineId + "/")
        ? id
        : `${space.machineId}/${id}`;
    const rawSpace = layouts
      .get(space.machineId)
      ?.spaces?.find(
        (raw: any) =>
          typeof raw.id === "string" && qualify(raw.id) === space.id,
      );
    const rawTab = rawSpace?.tabs?.find(
      (raw: any) => typeof raw.id === "string" && qualify(raw.id) === tab.id,
    );
    const parts = [clean(rawSpace?.name), clean(rawTab?.name)].filter(Boolean);
    name = [...new Set(parts)].join(" / ") || name;
    break;
  }
  const suffix = notice.kind === "blocked" ? " needs you" : " finished";
  return {
    title: "Herdr",
    body: name.slice(0, 240 - suffix.length) + suffix,
    tag: `${notice.terminal}/${notice.turn}/${notice.kind}`,
    url: `/#terminal=${encodeURIComponent(notice.terminal)}`,
  };
}
