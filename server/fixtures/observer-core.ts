#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { Frames, frame } from "../core";
const decoder = new Frames();
let hello = true, credit = 256 * 1024, position = 0;
const bytes = Buffer.from("\x1b[31m" + "row 🙂\r\n".repeat(65000));
const log = (v: unknown) => appendFileSync(process.env.OBSERVER_LOG!, JSON.stringify(v) + "\n");
function pump() {
  while (credit && position < bytes.length) {
    const n = Math.min(16384, credit, bytes.length - position);
    process.stdout.write(frame(7, 0, bytes.subarray(position, position + n)));
    position += n;
    credit -= n;
  }
}
process.stdin.on("data", (data: Buffer) => {
  if (hello) {
    hello = false;
    process.stdout.write('{"id":0,"result":{"framed":true,"generation":1}}\n');
    return;
  }
  for (const f of decoder.feed(data)) {
    log({ channel: f.channel, kind: f.kind, body: f.kind === 0 ? JSON.parse(f.body.toString()) : f.body.toString("hex") });
    if (f.channel === 0) {
      const request = JSON.parse(f.body.toString());
      const reply = frame(0, 0, Buffer.from(JSON.stringify({ id: request.id, result: { channel: 7, terminal: { cols: 101, rows: 33 } } })));
      if (process.env.OBSERVER_ORDER === "before") { pump(); process.stdout.write(reply); }
      else { process.stdout.write(reply); pump(); }
    } else if (f.kind === 1) { credit += f.body.readUInt32LE(); pump(); }
    else if (f.kind === 2) process.exit(0);
  }
});
