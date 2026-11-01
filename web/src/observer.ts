import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import type { Frame } from "./types";

type Output = Extract<Frame, { type: "output" }>;
export type BufferAnchor = { text: string; index: number; offset: number; view: "read" | "mirror" };
export const terminalOptions: ITerminalOptions = {
  fontFamily: "JetBrains Mono", fontSize: 14, lineHeight: 1.15,
  scrollback: 100000, screenReaderMode: true, disableStdin: true,
  theme: { background: "#101114", foreground: "#d8d8df", cursor: "#d8d8df" },
};
export function bufferText(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return Array.from({ length: buffer.length }, (_, i) =>
    buffer.getLine(i)?.translateToString(true) ?? "").join("\n");
}

// Replays into an offscreen buffer. History snapshots replace rather than append
// to the displayed buffer. No input or geometry ever travels back to the host.
export class ObserverDisplay {
  watchId = "";
  history = 500;
  seq = -1;
  active = false;
  resets = 0;
  private decoder = new TextDecoder();
  private staging?: Terminal;
  private host?: HTMLElement;
  private timeout?: ReturnType<typeof setTimeout>;
  private readyFrame = 0;
  private anchor?: BufferAnchor;
  private failed = false;
  private pendingBytes = 0;
  constructor(
    private getCurrent: () => Terminal | undefined,
    private swap: (terminal: Terminal, host: HTMLElement, anchor?: BufferAnchor, index?: number) => void,
    private changed: () => void,
    private status: (message: string) => void,
  ) {}
  watch(watchId: string, history: number, anchor?: BufferAnchor) {
    this.clearStaging();
    this.watchId = watchId;
    this.history = history;
    this.seq = -1;
    this.decoder = new TextDecoder();
    this.anchor = anchor;
    this.failed = false;
    this.pendingBytes = 0;
    const id = watchId;
    this.timeout = setTimeout(() => {
      if (id !== this.watchId) return;
      this.failed = true;
      this.clearStaging();
      this.status(anchor ? "History could not preserve your position. Reopen the tab to retry." :
        "Plain screen · colour and history observation unavailable");
    }, 5000);
  }
  private clearStaging() {
    clearTimeout(this.timeout);
    cancelAnimationFrame(this.readyFrame);
    this.readyFrame = 0;
    this.staging?.dispose();
    this.staging = undefined;
    this.host?.remove();
    this.host = undefined;
  }
  private anchorIndex(target: Terminal) {
    if (!this.anchor) return -1;
    const buffer = target.buffer.active;
    const expected = this.anchor.index + Math.max(0,
      buffer.length - (this.getCurrent()?.buffer.active.length ?? 0));
    let index = -1, distance = Infinity;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer.getLine(i)?.translateToString(true) !== this.anchor.text) continue;
      if (Math.abs(i - expected) < distance) {
        index = i;
        distance = Math.abs(i - expected);
      }
    }
    return index;
  }
  unavailable() {
    this.failed = true;
    this.clearStaging();
    this.status(this.active ? "Observation ended · retained snapshot" : "Plain screen · colour and history observation unavailable");
  }
  dispose() {
    this.clearStaging();
    this.watchId = "";
    this.active = false;
  }
  output(frame: Output) {
    if (frame.watchId !== this.watchId || this.failed ||
        !Number.isSafeInteger(frame.seq) || frame.seq < 0 || frame.seq <= this.seq) return;
    if (frame.seq !== this.seq + 1 || (frame.seq === 0) !== frame.reset ||
        frame.history !== this.history) {
      this.failed = true;
      this.clearStaging();
      this.status("Terminal stream interrupted. Reopen the tab to reconnect.");
      return;
    }
    if (!Number.isInteger(frame.cols) || !Number.isInteger(frame.rows) ||
        frame.cols < 1 || frame.cols > 1000 || frame.rows < 1 || frame.rows > 500) return;
    this.seq = frame.seq;
    if (frame.reset) {
      this.resets++;
      this.host = document.createElement("div");
      this.host.className = "terminal-canvas observer-staging";
      this.host.style.visibility = "hidden";
      document.querySelector(".terminal-viewport")?.append(this.host);
      this.staging = new Terminal({ ...terminalOptions, cols: frame.cols, rows: frame.rows });
      this.staging.open(this.host);
    }
    const target = this.staging ?? this.getCurrent();
    if (!target) return;
    if (target.cols !== frame.cols || target.rows !== frame.rows) target.resize(frame.cols, frame.rows);
    const id = this.watchId;
    try {
      const bytes = Uint8Array.from(atob(frame.data), c => c.charCodeAt(0));
      this.pendingBytes += bytes.length;
      if (this.pendingBytes > 1024 * 1024) { this.unavailable(); return; }
      target.write(this.decoder.decode(bytes, { stream: true }), () => {
        if (id !== this.watchId || this.failed) return;
        this.pendingBytes -= bytes.length;
        if (!this.staging) { this.changed(); return; }
        if (this.anchor && this.anchorIndex(target) < 0) return;
        if (this.readyFrame) return;
        // Swap at a parsed byte boundary. Output may keep arriving continuously;
        // the same emulator consumes queued bytes after it becomes visible.
        const commit = () => {
            if (id !== this.watchId || !this.staging || !this.host) return;
            this.readyFrame = 0;
            const index = this.anchor ? this.anchorIndex(this.staging) : -1;
            if (this.anchor && index < 0) return;
            clearTimeout(this.timeout);
            const next = this.staging, host = this.host;
            this.staging = undefined;
            this.host = undefined;
            this.active = true;
            host.style.visibility = "";
            host.classList.remove("observer-staging");
            this.swap(next, host, this.anchor, index);
            this.changed();
        };
        this.readyFrame = requestAnimationFrame(() => {
          this.readyFrame = requestAnimationFrame(commit);
        });
      });
    } catch {
      this.failed = true;
      this.clearStaging();
      this.status("Unable to decode terminal output. Reopen the tab to retry.");
    }
  }
}
