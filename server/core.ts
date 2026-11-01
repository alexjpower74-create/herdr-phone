import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export function frame(channel: number, kind: number, body: Buffer): Buffer {
  const header = Buffer.alloc(9);
  header.writeUInt32LE(channel);
  header[4] = kind;
  header.writeUInt32LE(body.length, 5);
  return Buffer.concat([header, body]);
}
export class Frames {
  buffer = Buffer.alloc(0);
  feed(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const output: { channel: number; kind: number; body: Buffer }[] = [];
    while (this.buffer.length >= 9) {
      const length = this.buffer.readUInt32LE(5);
      if (length > 8 * 1024 * 1024) throw new Error("Oversized core frame");
      if (this.buffer.length < length + 9) break;
      output.push({
        channel: this.buffer.readUInt32LE(0),
        kind: this.buffer[4],
        body: this.buffer.subarray(9, length + 9),
      });
      this.buffer = this.buffer.subarray(length + 9);
    }
    return output;
  }
}
export interface RPC {
  call(method: string, params?: Record<string, unknown>): Promise<any>;
}
export class Core implements RPC {
  process?: ChildProcessWithoutNullStreams;
  pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      process: ChildProcessWithoutNullStreams;
    }
  >();
  id = 0;
  connected = false;
  starting?: Promise<void>;
  stopped = false;
  async connect() {
    if (this.connected) return;
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const proc = spawn(process.env.HERDR_PHONE_HC || "hc", ["connect"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.process = proc;
      let hello = Buffer.alloc(0),
        ready = false,
        ended = false;
      const frames = new Frames();
      const fail = () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        if (this.process === proc) this.connected = false;
        if (!ready) reject(new Error("Core unavailable"));
        for (const [id, p] of this.pending)
          if (p.process === proc) {
            clearTimeout(p.timer);
            p.reject(new Error("Core disconnected"));
            this.pending.delete(id);
          }
        proc.kill();
      };
      const timer = setTimeout(fail, 5000);
      proc.on("error", fail);
      proc.on("exit", fail);
      proc.stdin.on("error", fail);
      proc.stderr.on("data", () => {});
      proc.stdout.on("data", (chunk: Buffer) => {
        try {
          if (ended) return;
          if (!ready) {
            hello = Buffer.concat([hello, chunk]);
            if (hello.length > 65536) throw new Error("Invalid handshake");
            const nl = hello.indexOf(10);
            if (nl < 0) return;
            const answer = JSON.parse(hello.subarray(0, nl).toString());
            if (!answer.result?.framed || answer.result.generation !== 1)
              throw new Error("Invalid handshake");
            ready = true;
            this.connected = true;
            clearTimeout(timer);
            resolve();
            chunk = hello.subarray(nl + 1);
          }
          for (const f of frames.feed(chunk)) {
            if (f.channel !== 0 || f.kind !== 0) continue;
            const answer = JSON.parse(f.body.toString());
            const p = this.pending.get(answer.id);
            if (!p) continue;
            this.pending.delete(answer.id);
            clearTimeout(p.timer);
            if (answer.error)
              p.reject(
                Object.assign(new Error("Core request failed"), {
                  kind: answer.error.data?.kind,
                }),
              );
            else p.resolve(answer.result);
          }
        } catch {
          fail();
        }
      });
      proc.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 0,
          method: "hello",
          params: { framed: true, generation: 1 },
        }) + "\n",
      );
    }).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  async call(method: string, params = {}): Promise<any> {
    if (this.stopped) throw new Error("Core stopped");
    await this.connect();
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Core timeout"));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer, process: this.process! });
      this.process!.stdin.write(
        frame(
          0,
          0,
          Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })),
        ),
      );
    });
  }
  close() {
    this.stopped = true;
    this.process?.kill();
  }
}

// A separate notification connection keeps event backpressure independent of RPCs.
// Plain notification mode does not open any terminal observation channel.
export class EventFeed {
  process?: ChildProcessWithoutNullStreams;
  timer?: ReturnType<typeof setTimeout>;
  stopped = false;
  delay = 250;
  constructor(
    public changed: () => void,
    public disconnected: () => void,
  ) {
    this.open();
  }
  open() {
    if (this.stopped) return;
    const proc = spawn(process.env.HERDR_PHONE_HC || "hc", ["connect"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = proc;
    let buffer = Buffer.alloc(0),
      ended = false;
    let silence: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(silence);
      silence = setTimeout(end, 40000);
    };
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(silence);
      proc.kill();
      this.disconnected();
      if (!this.stopped) {
        this.timer = setTimeout(() => this.open(), this.delay);
        this.delay = Math.min(10000, this.delay * 2);
      }
    };
    proc.on("exit", end);
    proc.on("error", end);
    proc.stdin.on("error", end);
    proc.stderr.on("data", () => {});
    proc.stdout.on("data", (chunk: Buffer) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 8 * 1024 * 1024) throw Error("Event limit");
        let nl;
        while ((nl = buffer.indexOf(10)) >= 0) {
          const message = JSON.parse(buffer.subarray(0, nl).toString());
          buffer = buffer.subarray(nl + 1);
          arm();
          if (message.error) throw Error("Subscription rejected");
          if (message.id === 1) {
            proc.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "events.subscribe",
                params: {},
              }) + "\n",
            );
          } else if (
            message.id === 2 ||
            message.method === "event" ||
            message.method === "missed"
          ) {
            this.delay = 250;
            this.changed();
          }
        }
      } catch {
        end();
      }
    });
    arm();
    proc.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "hello",
        params: { generation: 1 },
      }) + "\n",
    );
  }
  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.process?.kill();
  }
}
