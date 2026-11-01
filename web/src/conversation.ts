import { ApiError, type Client } from "./client";
import type { ConversationPage } from "./types";

/** Saved messages have their own lifetime and never request terminal history. */
export class Conversation {
  readonly host = document.createElement("section");
  private status = document.createElement("p");
  private older = document.createElement("button");
  private retry = document.createElement("button");
  private list = document.createElement("div");
  private latest = document.createElement("button");
  private session: string | null = null;
  private cursor: string | null = null;
  private nodes = new Map<string, HTMLElement>();
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
    this.host.append(this.status, this.retry, this.older, this.list, this.latest);
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
  show(value: boolean) {
    this.visible = value;
    this.host.hidden = !value;
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
        this.list.replaceChildren(); this.nodes.clear(); this.initialized = false;
        this.session = null; this.cursor = null; this.older.hidden = true;
        this.failure(page.reason === "offline" ? "Conversation is offline. Reconnect and retry." : "Saved conversation is unavailable for this terminal.");
        return;
      }
      const reset = !this.initialized || page.session !== this.session ||
        (!older && this.nodes.size > 0 &&
          !page.turns.some(turn => this.nodes.has(turn.id)));
      if (reset) {
        this.cancel();
        this.nodes.clear(); this.list.replaceChildren(); this.session = page.session;
      }
      this.capturePosition();
      const follow = reset || (!older && this.following);
      const anchor = [...this.list.children].find(el => el.getBoundingClientRect().bottom > this.host.getBoundingClientRect().top);
      const offset = anchor?.getBoundingClientRect().top;
      const fragment = document.createDocumentFragment();
      for (const turn of page.turns) {
        let node = this.nodes.get(turn.id);
        if (!node) {
          node = document.createElement("article"); node.dataset.turn = turn.id;
          this.nodes.set(turn.id, node); fragment.append(node);
        }
        // Reconcile entries within the changed turn, retaining all other DOM and selection.
        const entries = new Map([...node.children].map(el => [(el as HTMLElement).dataset.entry, el as HTMLElement]));
        const keep = new Set<string>();
        for (const entry of turn.entries) {
          keep.add(entry.id);
          let row = entries.get(entry.id);
          if (!row) { row = document.createElement("div"); row.dataset.entry = entry.id; node.append(row); }
          row.className = `conversation-entry conversation-${entry.role}`;
          row.dataset.role = entry.role;
          if (entry.role === "tool") { row.setAttribute("aria-label", "Tool summary"); row.dataset.collapsed = "true"; }
          const text = entry.role === "tool" ? entry.text.split(/\r?\n/)[0] : entry.text;
          if (row.textContent !== text) row.textContent = text;
        }
        for (const [id, row] of entries) if (!keep.has(id!)) row.remove();
      }
      if (older) this.list.prepend(fragment); else this.list.append(fragment);
      if (reset || older) this.cursor = page.nextCursor;
      this.initialized = true;
      this.status.textContent = this.cursor ? "Saved conversation" : "Beginning of conversation";
      if (!page.turns.length && !this.nodes.size) this.status.textContent = "No saved messages yet.";
      this.retry.hidden = true;
      this.older.hidden = !this.cursor;
      this.following = follow;
      if (!follow && anchor?.isConnected && offset !== undefined) this.host.scrollTop += anchor.getBoundingClientRect().top - offset;
      this.restorePosition();
    } catch (error) {
      if (epoch !== this.epoch || controller.signal.aborted) return;
      if (error instanceof ApiError && error.code === "conversation_changed") {
        this.cancel(); this.initialized = false; void this.load();
      } else this.failure("Could not load saved conversation. Retry when connected.");
    } finally {
      this.requests.delete(controller);
      if (epoch === this.epoch || !this.requests.size) { this.loadingOlder = false; this.older.disabled = false; }
    }
  }
}
