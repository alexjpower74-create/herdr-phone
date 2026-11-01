import { readFile } from "node:fs/promises";
import { UploadProcesses } from "./upload-process";
import { Failure } from "./security";
import type { UploadRecord } from "./upload-manifest";

export type UploadTarget = { ssh?: string; root: string };
export type UploadTransport = (action: "write" | "check" | "remove", target: UploadTarget, record: UploadRecord, bytes?: Buffer, signal?: AbortSignal) => Promise<{ path?: string }>;
export function storageTransport(processes: UploadProcesses): UploadTransport {
  return async (action, target, record, bytes, signal) => {
    const script = await readFile(new URL("upload-storage.py", import.meta.url), "utf8");
    const argument = Buffer.from(JSON.stringify({ action, root: record.root, date: record.date, filename: record.filename, size: record.size, digest: record.digest })).toString("base64");
    const bootstrap = "import base64,sys;exec(base64.b64decode(sys.stdin.buffer.readline()))";
    const argv = target.ssh
      ? ["ssh", "-T", "-oBatchMode=yes", "-oConnectTimeout=3", "-oConnectionAttempts=1", "--", target.ssh, `python3 -c '${bootstrap}' '${argument}'`]
      : ["python3", "-c", bootstrap, argument];
    const input = Buffer.concat([Buffer.from(Buffer.from(script).toString("base64") + "\n"), bytes ?? Buffer.alloc(0)]);
    try {
      const result = JSON.parse((await processes.run(argv, input, 30000, signal)).toString());
      if (result.error) throw Error();
      if (action !== "remove" && (typeof result.path !== "string" || !result.path.startsWith("/") || result.path.includes("\0") || !result.path.endsWith(`/${record.date}/${record.filename}`))) throw Error();
      return result;
    } catch (e) {
      if (e instanceof Failure && ["upload_timeout", "upload_unavailable"].includes(e.code)) throw e;
      throw new Failure(503, "upload_unavailable", "Private upload storage is unavailable.");
    }
  };
}
