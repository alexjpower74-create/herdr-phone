import { imageCommand } from "./image-command";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Failure } from "./security";
import { MAX_UPLOAD } from "./upload-manifest";
import { UploadProcesses } from "./upload-process";

const unsupported = () => new Failure(415, "unsupported_file", "Unsupported or invalid file content.");
const tooLarge = () => new Failure(413, "too_large", "File size or image dimensions exceed the limit.");
export type CheckedMedia = { bytes: Buffer; type: string; extension: string; converted: boolean };
function identify(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "webp";
  if (/^%PDF-[12]\.\d/.test(bytes.subarray(0, 8).toString())) return "pdf";
  if (bytes.length >= 16 && bytes.subarray(4, 8).toString() === "ftyp") {
    const size = bytes.readUInt32BE(0);
    if (size < 16 || size > Math.min(bytes.length, 4096) || size % 4) throw unsupported();
    const brands = Array.from({ length: (size - 8) / 4 }, (_, i) => bytes.subarray(8 + i * 4, 12 + i * 4).toString("ascii"));
    if (brands.some(b => ["avif", "avis"].includes(b))) throw unsupported();
    if (brands.some(b => ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(b))) return "heic";
    throw unsupported();
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw Error();
    return "text";
  } catch { throw unsupported(); }
}
export async function checkMedia(bytes: Buffer, processes: UploadProcesses, signal?: AbortSignal): Promise<CheckedMedia> {
  if (!bytes.length) throw unsupported();
  if (bytes.length > MAX_UPLOAD) throw tooLarge();
  const kind = identify(bytes);
  // Bound dimensions directly before a decoder applies its own platform policy.
  if (kind === "png" && bytes.length >= 24 && bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 32000000) throw tooLarge();
  if (kind === "gif" && bytes.length >= 10 && bytes.readUInt16LE(6) * bytes.readUInt16LE(8) > 32000000) throw tooLarge();
  if (kind === "text") return { bytes, type: "text/plain", extension: "txt", converted: false };
  const dir = await mkdtemp(join(tmpdir(), "phone-upload-"));
  const path = join(dir, "input"), output = join(dir, "normalized.jpg");
  const started = Date.now();
  const run = (argv: string[], cap = 65536) => processes.run(argv, undefined, Math.max(1, 15000 - (Date.now() - started)), signal, cap);
  const limits = ["-limit", "memory", "128MiB", "-limit", "map", "0", "-limit", "disk", "1GiB", "-limit", "thread", "1", "-limit", "time", "15", "-define", `registry:temporary-path=${dir}`];
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    if (kind === "pdf") {
      if (!/%%EOF\s*$/.test(bytes.subarray(-1024).toString("latin1"))) throw unsupported();
      await run(["pdfinfo", "-f", "1", "-l", "1", path]);
      return { bytes, type: "application/pdf", extension: "pdf", converted: false };
    }
    if (kind === "heic") {
      const formats = (await run(imageCommand("convert", ["-list", "format"]))).toString();
      if (!/^\s*HEIC\*?\s+HEIC\s+rw/m.test(formats)) throw new Failure(503, "conversion_unavailable", "Image conversion is unavailable.");
    }
    const input = `${kind.toUpperCase()}:${path}`;
    const dimensions = (await run(imageCommand("identify", [...limits, "-ping", "-format", "%w %h\n", input]))).toString().trim().split("\n");
    let pixels = 0;
    if (dimensions.length > 1024) throw tooLarge();
    for (const row of dimensions) {
      const [width, height] = row.split(" ").map(Number);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw unsupported();
      pixels += width * height;
      if (pixels > 32000000) throw tooLarge();
    }
    if (kind === "heic") {
      await run(imageCommand("convert", [...limits, "-regard-warnings", `${input}[0]`, "-auto-orient", "-strip", "-quality", "90", `JPEG:${output}`]));
      if ((await stat(output)).size > MAX_UPLOAD) throw tooLarge();
      const converted = await readFile(output);
      if (converted[0] !== 255 || converted[1] !== 216 || converted[2] !== 255) throw unsupported();
      return { bytes: converted, type: "image/jpeg", extension: "jpg", converted: true };
    }
    // Decode the actual pixels, rather than trusting a magic prefix or metadata alone.
    await run(imageCommand("convert", [...limits, "-regard-warnings", input, "null:"]));
    return { bytes, type: `image/${kind}`, extension: kind === "jpeg" ? "jpg" : kind, converted: false };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
