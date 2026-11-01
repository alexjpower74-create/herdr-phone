import { ApiError, NetworkError, type Client } from "./client";
import type { ConversationPage } from "./types";

/** Saved messages have their own lifetime and never request terminal history. */
export class Conversation {
  readonly host = document.createElement("section");
  private status = document.createElement("p");
  private notices = document.createElement("div");
  private older = document.createElement("button");
  private retry = document.createElement("button");
  private list = document.createElement("div");
  private latest = document.createElement("button");
  private session: string | null = null;
  private cursor: string | null = null;
  private nodes = new Map<string, HTMLElement>();
  private entryRows = new Map<string, HTMLElement>();
  private cursorAlias: { id: string; node: HTMLElement } | null = null;
  private requests = new Set<AbortController>();
  private epoch = 0;
  private loadingOlder = false;
  private visible = false;
  private online = true;
  private initialized = false;
  private following = true;
  private scrollPosition = 0;
  private resize: ResizeObserver;
  private timer: ReturnType<typeof setInterval>;
  constructor(private client: Client, private id: string, online: boolean) {
    this.online = online;
    this.host.className = "conversation";
    this.host.hidden = true;
    this.host.setAttribute("aria-label", "Saved conversation");
    this.status.role = "status";
    this.status.className = "conversation-status";
    this.older.textContent = "Load older messages";
    this.older.onclick = () => void this.load(true);
    this.retry.textContent = "Retry conversation";
    this.retry.onclick = () => void this.load();
    this.retry.hidden = true;
    this.latest.textContent = "Latest messages";
    this.latest.className = "conversation-latest";
    this.latest.hidden = true;
    this.latest.onclick = () => { this.following = true; this.restorePosition(); };
    this.notices.role = "status";
    this.host.append(this.status, this.notices, this.retry, this.older, this.list, this.latest);
    this.host.addEventListener("scroll", () => {
      this.capturePosition();
      this.latest.hidden = this.following;
      if (this.host.scrollTop < 32 && this.cursor) void this.load(true);
    }, { passive: true });
    this.resize = new ResizeObserver(() => {
      if (!this.visible || !this.initialized) return;
      this.capturePosition();
      this.restorePosition();
    });
    this.resize.observe(this.host);
    this.resize.observe(this.list);
    document.addEventListener("visibilitychange", this.visibility);
    this.timer = setInterval(() => { if (this.visible && !document.hidden && this.online) void this.load(); }, 2500);
  }
  private visibility = () => {
    this.cancel();
    if (this.visible && !document.hidden && this.online) void this.load();
  };
  show(value: boolean, newest = false) {
    this.visible = value;
    this.host.hidden = !value;
    if (newest) { this.following = true; this.restorePosition(); }
    this.cancel();
    if (value && this.online) void this.load();
    else if (value) this.failure("Conversation is offline. Reconnect and retry.");
  }
  connection(online: boolean) {
    this.online = online;
    this.cancel();
    if (!online) this.failure("Conversation is offline. Reconnect and retry.");
    else if (this.visible) void this.load();
  }
  dispose() {
    this.cancel();
    clearInterval(this.timer);
    this.resize.disconnect();
    document.removeEventListener("visibilitychange", this.visibility);
  }
  private cancel() {
    this.epoch++;
    for (const request of this.requests) request.abort();
    this.requests.clear();
    this.loadingOlder = false;
    this.older.disabled = false;
  }
  private atBottom() { return this.host.scrollHeight - this.host.scrollTop - this.host.clientHeight < 40; }
  private capturePosition() {
    // Read native scrolling before its asynchronous event too. A shorter panel
    // or a loaded font can increase the bottom gap without the person moving.
    const top = this.host.scrollTop;
    if (Math.abs(top - this.scrollPosition) > 0.5) this.following = this.atBottom();
    this.scrollPosition = top;
  }
  private restorePosition() {
    this.latest.hidden = this.following;
    if (this.following) this.host.scrollTop = this.host.scrollHeight;
    this.scrollPosition = this.host.scrollTop;
  }
  private failure(message: string) {
    this.status.textContent = message;
    this.retry.hidden = false;
  }
  private turnNodes(turn: ConversationPage["turns"][number]) {
    const matches = new Set<HTMLElement>();
    const direct = this.nodes.get(turn.id);
    if (direct) matches.add(direct);
    for (const entry of turn.entries) {
      const row = this.entryRows.get(entry.id);
      if (row?.parentElement) matches.add(row.parentElement);
    }
    return [...matches].sort((a, b) => a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  }
  private async load(older = false) {
    if (!this.visible || document.hidden) return;
    if (older && (!this.cursor || this.loadingOlder)) return;
    // A page is a snapshot: serialize reads so an older snapshot cannot overwrite
    // a newer final turn, or clear another request's loading state.
    if (this.requests.size) return;
    const epoch = this.epoch, session = this.session;
    const controller = new AbortController();
    this.requests.add(controller);
    if (older) { this.loadingOlder = true; this.older.disabled = true; }
    if (!this.initialized) this.status.textContent = "Loading saved conversation…";
    try {
      const page = await this.client.conversation(this.id, older ? this.cursor! : undefined, controller.signal);
      if (epoch !== this.epoch || controller.signal.aborted) return;
      if (older && session !== this.session) return;
      if (!page.available) {
        this.cancel();
        this.list.replaceChildren(); this.nodes.clear(); this.entryRows.clear(); this.cursorAlias = null; this.initialized = false;
        this.session = null; this.cursor = null; this.older.hidden = true;
        this.notices.replaceChildren();
        const reasons = {
          not_found: "No saved conversation was found for this terminal.",
          not_configured: "Saved conversation is not configured for this machine.",
          ambiguous: "More than one saved conversation matches this terminal.",
          offline: "The conversation machine is offline. Reconnect it and retry.",
        };
        this.failure(page.reason ? reasons[page.reason] : "Saved conversation is unavailable for this terminal.");
        return;
      }
      const reset = !this.initialized || page.session !== this.session ||
        (!older && this.nodes.size > 0 &&
          !page.turns.some(turn => this.turnNodes(turn).length));
      if (reset) {
        this.cancel();
        this.nodes.clear(); this.entryRows.clear(); this.cursorAlias = null; this.list.replaceChildren(); this.session = page.session;
      }
      this.capturePosition();
      const follow = reset || (!older && this.following);
      const anchor = [...this.list.querySelectorAll<HTMLElement>("[data-entry]")].find(el => el.getBoundingClientRect().bottom > this.host.getBoundingClientRect().top);
      const offset = anchor?.getBoundingClientRect().top;
      const fragment = document.createDocumentFragment();
      const pageAliases = new Map<string, HTMLElement>();
      for (const turn of page.turns) {
        const matches = this.turnNodes(turn);
        let node = matches[0];
        if (!node) {
          node = document.createElement("article"); node.dataset.turn = turn.id;
          this.nodes.set(turn.id, node); fragment.append(node);
        }
        // A wider latest window may reveal that several loaded fragments are one turn.
        for (const other of matches.slice(1)) {
          node.append(...other.children);
          if (this.cursorAlias?.node === other) this.cursorAlias.node = node;
          for (const [id, alias] of pageAliases) if (alias === other) pageAliases.set(id, node);
          other.remove();
        }
        pageAliases.set(turn.id, node);
        // Older windows contribute a prefix; their snapshots never overwrite newer rows.
        const entries = new Map([...node.children].map(el => [(el as HTMLElement).dataset.entry, el as HTMLElement]));
        const keep = new Set<string>();
        const prefix = document.createDocumentFragment();
        const incoming = new Set(turn.entries.map(entry => entry.id));
        const nextRows: Array<HTMLElement | null> = [];
        let nextRow: HTMLElement | null = null;
        for (let index = turn.entries.length - 1; index >= 0; index--) {
          nextRows[index] = nextRow;
          nextRow = entries.get(turn.entries[index].id) ?? nextRow;
        }
        if (!older && turn.continuesPrevious) {
          for (const [id] of entries) {
            if (incoming.has(id!)) break;
            keep.add(id!);
          }
        }
        for (const [index, entry] of turn.entries.entries()) {
          keep.add(entry.id);
          let row = entries.get(entry.id);
          if (older && row) continue;
          if (!row) {
            row = document.createElement("div"); row.dataset.entry = entry.id;
            this.entryRows.set(entry.id, row);
            if (older) prefix.append(row);
            else {
              node.insertBefore(row, nextRows[index]);
            }
          }
          row.className = `conversation-entry conversation-${entry.role}`;
          row.dataset.role = entry.role;
          if (entry.role === "tool") { row.setAttribute("aria-label", "Tool summary"); row.dataset.collapsed = "true"; }
          const text = entry.role === "tool" ? entry.text.split(/\r?\n/)[0] : entry.text;
          if (row.textContent !== text) row.textContent = text;
        }
        if (older) node.prepend(prefix);
        else for (const [id, row] of entries) if (!keep.has(id!)) {
          row.remove(); this.entryRows.delete(id!);
        }
      }
      if (older) this.list.prepend(fragment); else this.list.append(fragment);
      if (reset || older) {
        this.cursor = page.nextCursor;
        const first = page.turns[0];
        if (!this.cursor) this.cursorAlias = null;
        else if (first) this.cursorAlias = first.continuesPrevious ? { id: first.id, node: pageAliases.get(first.id)! } : null;
      }
      // Retain only canonical, current-page and active-cursor aliases. Old latest
      // fragment IDs otherwise accumulate on every append for a long-lived turn.
      this.nodes.clear();
      for (const article of this.list.children) {
        const node = article as HTMLElement;
        this.nodes.set(node.dataset.turn!, node);
      }
      for (const [id, node] of pageAliases) this.nodes.set(id, node);
      if (this.cursorAlias) this.nodes.set(this.cursorAlias.id, this.cursorAlias.node);
      this.notices.replaceChildren();
      for (const warning of new Set(page.warnings ?? [])) {
        const message = warning === "long_output_trimmed" ? "[long output trimmed]" :
          warning === "scan_limited" ? "Older messages remain beyond this read window." : null;
        if (message) {
          const notice = document.createElement("p");
          notice.className = "conversation-status";
          notice.textContent = message;
          this.notices.append(notice);
        }
      }
      this.initialized = true;
      this.status.textContent = this.cursor ? "Saved conversation" : "Beginning of conversation";
      if (!this.cursor && !page.turns.length && !this.nodes.size) this.status.textContent = "No saved messages yet.";
      this.retry.hidden = true;
      this.older.hidden = !this.cursor;
      this.following = follow;
      if (!follow && anchor?.isConnected && offset !== undefined) this.host.scrollTop += anchor.getBoundingClientRect().top - offset;
      this.restorePosition();
    } catch (error) {
      if (epoch !== this.epoch || controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === "conversation_changed") {
        this.cancel(); this.initialized = false; void this.load();
      } else {
        const failures: Record<string, string> = {
          conversation_too_large: "This conversation page is too large to display.",
          conversation_busy: "Conversation readers are busy. Please retry shortly.",
          conversation_timeout: "Loading saved conversation timed out. Please retry.",
          conversation_unavailable: "The saved conversation reader is unavailable. Please retry.",
        };
        this.failure(error instanceof ApiError ? failures[error.code] ?? "Could not load saved conversation. Please retry." :
          error instanceof NetworkError ? "Could not reach the bridge. Check your connection and retry." :
          "Could not load saved conversation. Please retry.");
      }
    } finally {
      this.requests.delete(controller);
      if (epoch === this.epoch || !this.requests.size) { this.loadingOlder = false; this.older.disabled = false; }
    }
  }
}
