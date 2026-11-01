import { spawn } from "node:child_process";
import { Failure } from "./security";

/** Bounded child lifecycle shared by content checks and private storage. */
export class UploadProcesses {
  private active = new Set<() => void>();
  private stopped = false;
  close() { this.stopped = true; for (const cancel of [...this.active]) cancel(); }
  run(argv: string[], input: Uint8Array = new Uint8Array(), timeout = 15000, signal?: AbortSignal, maxOutput = 65536): Promise<Buffer> {
    if (this.stopped || signal?.aborted) return Promise.reject(new Failure(503, "upload_unavailable", "Upload was cancelled."));
    return new Promise((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, MAGICK_THREAD_LIMIT: "1" } });
      const chunks: Buffer[] = []; let total = 0, settled = false;
      const finish = (error?: Error, output?: Buffer) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.active.delete(cancel); signal?.removeEventListener("abort", cancel);
        child.stdin.destroy(); child.stdout.destroy();
        if (error) { child.kill("SIGKILL"); reject(error); } else resolve(output!);
      };
      const cancel = () => finish(new Failure(503, "upload_unavailable", "Upload was cancelled."));
      const timer = setTimeout(() => finish(new Failure(503, "upload_timeout", "Upload processing timed out.")), timeout);
      this.active.add(cancel); signal?.addEventListener("abort", cancel, { once: true });
      child.on("error", (e: any) => finish(new Failure(503, e.code === "ENOENT" ? "conversion_unavailable" : "upload_unavailable", "Upload processing is unavailable.")));
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxOutput) finish(new Failure(413, "too_large", "File content exceeds the processing limit."));
        else chunks.push(chunk);
      });
      child.on("close", code => {
        if (code === 0) finish(undefined, Buffer.concat(chunks));
        else finish(new Failure(415, "unsupported_file", "Unsupported or invalid file content."));
      });
      child.stdin.end(input);
    });
  }
}
