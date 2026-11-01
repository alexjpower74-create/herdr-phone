import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile, stat, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { start } from "./index";
import { Store } from "./security";
import { MAX_UPLOAD, UPLOAD_LIFETIME } from "./upload-manifest";
import { Uploads } from "./uploads";
import type { UploadTransport } from "./upload-transport";

async function harness(action: (ctx: any) => Promise<void>, transport?: UploadTransport) {
  const root = await mkdtemp(join(tmpdir(), "attachment-test-"));
  const previous = process.env.HERDR_PHONE_UPLOADS_DIR;
  process.env.HERDR_PHONE_UPLOADS_DIR = join(root, "files");
  let now = Date.now(), pid = 123, blocked = false, text = "Current dialog";
  const store = new Store(join(root, "state"), () => now);
  const first = await store.exchange(await store.pairing(), "First");
  const second = await store.exchange(await store.pairing(), "Second");
  const calls: any[] = [];
  const core = { async call(method: string, params: any) {
    calls.push({ method, params });
    if (method === "terminal.get") return { address: params.terminal, pid, created_ms: 456, state: "live", status: { state: blocked ? "blocked" : "idle" }, cols: 80, rows: 24 };
    if (method === "terminal.read") return { text, complete: true };
    if (method === "terminal.send") { if (blocked && !params.force) throw { kind: "blocked" }; return {}; }
    throw Error("Unexpected RPC");
  } };
  const app = start({ port: 0, core, store, uploadTransport: transport });
  const request = (suffix: string, body?: any, token = first.token, id = "t1") => fetch(`http://127.0.0.1:${app.server.port}/api/terminals/${encodeURIComponent(id)}/${suffix}`, {
    method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, ...(body instanceof FormData || body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const upload = (bytes: string | Buffer, name = "sample.txt", type = "text/plain", token = first.token, id = "t1") => {
    const form = new FormData(); form.append("file", new File([bytes], name, { type })); return request("uploads", form, token, id);
  };
  try { await action({ app, root, store, core, calls, first, second, request, upload, changePID: () => pid++, setBlocked: (value: boolean) => blocked = value, changeDialog: () => text = "New dialog", advance: (ms: number) => now += ms }); }
  finally { app.stop(); if (previous === undefined) delete process.env.HERDR_PHONE_UPLOADS_DIR; else process.env.HERDR_PHONE_UPLOADS_DIR = previous; await rm(root, { recursive: true, force: true }); }
}
function image(format: string) {
  return execFileSync("magick", ["-size", "8x6", "xc:red", `${format}:-`], { maxBuffer: MAX_UPLOAD, stdio: ["ignore", "pipe", "ignore"] });
}
function pdf() {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>"];
  let body = "%PDF-1.4\n", offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

test("authenticated text upload is private and sends exactly one quoted generated path plus text", async () => {
  await harness(async ({ upload, request, store, root, calls }: any) => {
    expect((await upload("Hello", "file.txt", "text/plain", "wrong")).status).toBe(401);
    const response = await upload("Hello café 🐾", "../../unsafe\u0001.txt", "image/png");
    expect(response.status).toBe(201);
    const { upload: file } = await response.json();
    expect(file).toMatchObject({ name: "unsafe.txt", type: "text/plain", converted: false, size: Buffer.byteLength("Hello café 🐾") });
    expect(JSON.stringify(file)).not.toContain(root);
    const record = (await store.read()).uploads[0], path = join(record.root, record.date, record.filename);
    expect(await readFile(path, "utf8")).toBe("Hello café 🐾");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(record.root)).mode & 0o777).toBe(0o700);
    expect((await stat(join(record.root, record.date))).mode & 0o777).toBe(0o700);
    expect((await request("send", { text: "Review this", uploads: [file.id] })).status).toBe(200);
    expect(calls.filter((c: any) => c.method === "terminal.send")).toEqual([{ method: "terminal.send", params: { terminal: "t1", text: JSON.stringify(path) + "\n\nReview this", force: false } }]);
    expect((await request("send", { text: "", uploads: [file.id] })).status).toBe(200);
    expect(calls.at(-1).params.text).toBe(JSON.stringify(path));
  });
});

test("actual supported image/PDF bytes override filename and declared MIME; malformed/forbidden files fail", async () => {
  await harness(async ({ upload }: any) => {
    for (const format of ["PNG", "JPEG", "GIF", "WEBP"]) {
      const response = await upload(image(format), "wrong.exe", "application/octet-stream");
      expect(response.status).toBe(201);
      expect((await response.json()).upload.type).toBe("image/" + format.toLowerCase());
    }
    expect((await upload(pdf(), "wrong.txt")).status).toBe(201);
    for (const data of [Buffer.from([0,1,2,255]), Buffer.from("%PDF-1.4\ninvalid\n%%EOF"), image("PNG").subarray(0, 26), Buffer.from([255,216,255,0]), ""]) expect((await upload(data, "picture.png", "image/png")).status).toBe(415);
  });
});

test("genuine HEIC is converted into a decoded JPEG before storage", async () => {
  const bytes = image("HEIC");
  expect(bytes.subarray(4, 8).toString()).toBe("ftyp");
  await harness(async ({ upload, store }: any) => {
    const response = await upload(bytes, "camera.HEIC", "image/heic");
    expect(response.status).toBe(201);
    expect((await response.json()).upload).toMatchObject({ name: "camera.jpg", type: "image/jpeg", converted: true });
    const record = (await store.read()).uploads[0], path = join(record.root, record.date, record.filename);
    expect(execFileSync("magick", ["identify", "-format", "%m %wx%h", path], { encoding: "utf8" })).toBe("JPEG 8x6");
  });
});

test("upload IDs reject foreign devices, terminals, machines, expired files and terminal reuse before input", async () => {
  await harness(async ({ upload, request, second, calls, advance, changePID }: any) => {
    const file = (await (await upload("Private text")).json()).upload;
    for (const [token, id] of [[second.token, "t1"], [undefined, "t2"], [undefined, "remote/t1"]]) expect((await request("send", { text: "", uploads: [file.id] }, token, id)).status).toBe(409);
    expect((await request("send", { text: "x", uploads: ["../escape"] })).status).toBe(409);
    expect((await request("send", { text: "x", uploads: [file.id, file.id] })).status).toBe(409);
    changePID();
    expect((await request("send", { text: "", uploads: [file.id] })).status).toBe(409);
    advance(UPLOAD_LIFETIME + 1);
    expect((await request("send", { text: "", uploads: [file.id] })).status).toBe(409);
    expect(calls.filter((c: any) => c.method === "terminal.send")).toHaveLength(0);
  });
});

test("attachments preserve ordinary blocked rejection and explicit fresh-screen force", async () => {
  await harness(async ({ upload, request, calls, setBlocked, changeDialog }: any) => {
    const file = (await (await upload("Review")).json()).upload;
    setBlocked(true);
    expect((await request("send", { text: "Please read", uploads: [file.id] })).status).toBe(409);
    expect(calls.at(-1).params.force).toBe(false);
    const screen = await (await request("screen")).json();
    changeDialog();
    expect((await request("send", { text: "Please read", uploads: [file.id], force: true, screenId: screen.screenId })).status).toBe(409);
    const current = await (await request("screen")).json();
    expect((await request("send", { text: "Please read", uploads: [file.id], force: true, screenId: current.screenId })).status).toBe(200);
    expect(calls.at(-1).params.force).toBe(true);
  });
});
