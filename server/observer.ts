import { Core, frame } from "./core";

export type ObserverRequest = {
  terminalId: string;
  history: number;
  cols: number;
  rows: number;
};
export interface Observation { close(): void }
export type ObserverOutput = (bytes: Buffer, size?: { cols: number; rows: number }) => Promise<void>;
export type ObserverFactory = (
  request: ObserverRequest,
  output: ObserverOutput,
  failed: () => void,
) => Observation;

// One framed connection per observation. It never carries input or display facts.
// Frames may precede the attach reply; keep them until the channel is known.
export class Observer implements Observation {
  channel?: number;
  closed = false;
  queue: { channel: number; kind: number; body: Buffer }[] = [];
  pendingBytes = 0;
  pumping = false;
  size?: { cols: number; rows: number };
  get process() { return this.core.process; }
  constructor(
    request: ObserverRequest,
    private output: ObserverOutput,
    private failed: () => void,
    public core = new Core(),
  ) {
    this.core.onDisconnect = () => this.fail();
    this.core.onFrame = (f) => {
      if (this.closed) return;
      if (f.body.length > 16384 || this.pendingBytes + f.body.length > 1024 * 1024 || this.queue.length >= 1024) {
        this.fail();
        return;
      }
      this.pendingBytes += f.body.length;
      this.queue.push(f);
      void this.pump();
    };
    void this.core.call("terminal.attach", {
      terminal: request.terminalId,
      observe: true,
      history: request.history,
      cols: request.cols,
      rows: request.rows,
    }).then((reply) => {
      if (this.closed) return;
      if (!Number.isInteger(reply.channel) || reply.channel <= 0) throw Error("Invalid channel");
      this.size = { cols: reply.terminal?.cols ?? request.cols, rows: reply.terminal?.rows ?? request.rows };
      this.channel = reply.channel;
      void this.pump();
    }).catch(() => this.fail());
  }
  private async pump() {
    if (this.pumping || this.channel === undefined || this.closed) return;
    this.pumping = true;
    try {
      while (!this.closed && this.queue.length) {
        const f = this.queue.shift()!;
        if (f.channel !== this.channel) throw Error("Unexpected channel");
        if (f.kind === 2) { this.fail(); break; }
        if (f.kind !== 0) throw Error("Unexpected stream frame");
        await this.output(f.body, this.size);
        this.size = undefined;
        this.pendingBytes -= f.body.length;
        if (this.closed) break;
        const credit = Buffer.alloc(4);
        credit.writeUInt32LE(f.body.length);
        if (!this.core.process?.stdin.write(frame(this.channel, 1, credit)))
          throw Error("Observer backpressure");
      }
    } catch { this.fail(); }
    finally { this.pumping = false; }
  }
  private fail() {
    if (this.closed) return;
    this.close();
    this.failed();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.channel !== undefined)
      this.core.process?.stdin.write(frame(this.channel, 2, Buffer.alloc(0)));
    this.queue = [];
    this.pendingBytes = 0;
    this.core.close();
  }
}
export const observe: ObserverFactory = (request, output, failed) =>
  new Observer(request, output, failed);
