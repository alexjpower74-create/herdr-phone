import { imageCommand } from "./image-command";
import { checkMedia } from "./upload-media";
import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile, stat, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { start } from "./index";
import { storageTransport } from "./upload-transport";
import { UploadProcesses } from "./upload-process";
import { Store } from "./security";
import { MAX_UPLOAD, UPLOAD_LIFETIME } from "./upload-manifest";
import { Uploads } from "./uploads";
import type { UploadTransport } from "./upload-transport";

async function harness(action: (ctx: any) => Promise<void>, transport?: UploadTransport) {
  const root = await mkdtemp(join(tmpdir(), "attachment-test-"));
  const previous = process.env.HERDR_PHONE_UPLOADS_DIR;
  process.env.HERDR_PHONE_UPLOADS_DIR = join(root, "files");
  let now = Date.now(), pid = 123, blocked = false, text = "Current dialog";
  let sendGate: Promise<void> | undefined;
  let onRead: (() => void) | undefined;
  const store = new Store(join(root, "state"), () => now);
  const first = await store.exchange(await store.pairing(), "First");
  const second = await store.exchange(await store.pairing(), "Second");
  const calls: any[] = [];
  const core = { async call(method: string, params: any) {
    calls.push({ method, params });
    if (method === "terminal.get") return { address: params.terminal, pid, created_ms: 456, state: "live", status: { state: blocked ? "blocked" : "idle" }, cols: 80, rows: 24 };
    if (method === "terminal.read") { onRead?.(); return { text, complete: true }; }
    if (method === "terminal.send") { if (sendGate) await sendGate; if (blocked && !params.force) throw { kind: "blocked" }; return {}; }
    throw Error("Unexpected RPC");
  } };
  const app = start({ port: 0, core, store, uploadTransport: transport });
  const request = (suffix: string, body?: any, token = first.token, id = "t1") => fetch(`http://127.0.0.1:${app.server.port}/api/terminals/${encodeURIComponent(id)}/${suffix}`, {
    method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, ...(body instanceof FormData || body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const upload = (bytes: string | Buffer, name = "sample.txt", type = "text/plain", token = first.token, id = "t1") => {
    const form = new FormData(); form.append("file", new File([bytes], name, { type })); return request("uploads", form, token, id);
  };
  try { await action({ app, root, store, core, calls, first, second, request, upload, changePID: () => pid++, setBlocked: (value: boolean) => blocked = value, changeDialog: () => text = "New dialog", advance: (ms: number) => now += ms, gateSend: (gate?: Promise<void>) => sendGate = gate, replaceOnRead: () => onRead = () => pid++ }); }
  finally { await app.stop(); if (previous === undefined) delete process.env.HERDR_PHONE_UPLOADS_DIR; else process.env.HERDR_PHONE_UPLOADS_DIR = previous; await rm(root, { recursive: true, force: true }); }
}
function executeImage(operation: "convert" | "identify", args: string[], options: any) {
  const argv = imageCommand(operation, args);
  return execFileSync(argv[0], argv.slice(1), options);
}
function image(format: string) {
  return executeImage("convert", ["-size", "8x6", "xc:red", `${format}:-`], { maxBuffer: MAX_UPLOAD, stdio: ["ignore", "pipe", "ignore"] });
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
    expect(executeImage("identify", ["-format", "%m %wx%h", path], { encoding: "utf8" })).toBe("JPEG 8x6");
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

test("multipart envelope, exact-one-file,20MiB input and32KiB JSON limits remain independent", async () => {
  await harness(async ({ upload, request }: any) => {
    expect((await upload(Buffer.alloc(MAX_UPLOAD + 1, 97))).status).toBe(413);
    const duplicate = new FormData(); duplicate.append("file", new File(["a"], "a.txt")); duplicate.append("file", new File(["b"], "b.txt"));
    expect((await request("uploads", duplicate)).status).toBe(400);
    const extra = new FormData(); extra.append("file", new File(["a"], "a.txt")); extra.append("path", "arbitrary");
    expect((await request("uploads", extra)).status).toBe(400);
    expect((await request("uploads", {})).status).toBe(400);
    expect((await request("uploads?path=arbitrary", duplicate)).status).toBe(400);
    expect((await request("send", { text: "x".repeat(32769) })).status).toBe(413);
    expect((await upload("ok")).status).toBe(201);
  });
});

test("pixel limit is checked before decoding an oversized image", async () => {
  const bytes = image("PNG");
  // Rewrite IHDR dimensions and its checksum so this remains a valid header.
  bytes.writeUInt32BE(100000, 16); bytes.writeUInt32BE(100000, 20);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(12, 29)) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  await harness(async ({ upload, store }: any) => {
    expect((await upload(bytes)).status).toBe(413);
    expect((await store.read()).uploads).toHaveLength(0);
  });
});

test("device byte/file quotas and machine file quota reserve atomically", async () => {
  await harness(async ({ upload, store, first, second }: any) => {
    await upload("seed");
    const seed = (await store.read()).uploads[0];
    const records = (count: number, size: number, deviceId = first.device.id) => Array.from({ length: count }, (_, n) => {
      const id = n.toString(16).padStart(48, "0"); return { ...seed, id, filename: id + ".txt", size, deviceId };
    });
    await store.transact((s: any) => s.uploads = records(26, MAX_UPLOAD));
    expect((await upload("over bytes")).status).toBe(429);
    await store.transact((s: any) => s.uploads = records(1024, 1));
    expect((await upload("over device count")).status).toBe(429);
    await store.transact((s: any) => s.uploads = records(4096, 1, second.device.id));
    expect((await upload("over machine count")).status).toBe(429);
    await store.transact((s: any) => s.uploads = []);
    expect((await upload("released")).status).toBe(201);
  });
});

test("four concurrent operations include pending body parsing, fifth fails before consuming it", async () => {
  await harness(async ({ app, first }: any) => {
    let release!: () => void, parsed = 0;
    const wait = new Promise<void>(resolve => release = resolve);
    const parse = async () => { parsed++; await wait; return new File(["valid"], "text.txt"); };
    const pending = Array.from({ length: 4 }, () => app.uploads.receive(first.device.id, "t1", parse));
    try {
      await expect(app.uploads.receive(first.device.id, "t1", parse)).rejects.toMatchObject({ status: 429 });
      expect(parsed).toBe(4);
    } finally { release(); }
    expect((await Promise.all(pending)).length).toBe(4);
  });
});

test("failed transfers clean only their own files and release reserved quota", async () => {
  const runner = new UploadProcesses(), actual = storageTransport(runner);
  const transport: UploadTransport = async (action, target, record, bytes, signal) => {
    const result = await actual(action, target, record, bytes, signal);
    if (action === "write") throw Error("Deliberate transfer acknowledgement failure");
    return result;
  };
  try {
    await harness(async ({ upload, store, root }: any) => {
      expect((await upload("will be removed")).status).toBe(503);
      expect((await store.read()).uploads).toHaveLength(0);
      const { readdir } = await import("node:fs/promises");
      const dirs = await readdir(join(root, "files"));
      expect((await Promise.all(dirs.map(d => readdir(join(root, "files", d))))).flat()).toHaveLength(0);
    }, transport);
  } finally { runner.close(); }
});

test("revocation during transfer cleans actual bytes before returning and publishes no ID", async () => {
  const runner = new UploadProcesses(), actual = storageTransport(runner);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
  const transport: UploadTransport = async (action, target, record, bytes, signal) => {
    const result = await actual(action, target, record, bytes, signal);
    if (action === "write") { entered(); await gate; }
    return result;
  };
  try {
    await harness(async ({ upload, store, first }: any) => {
      const pending = upload("private"); await started;
      await store.revoke(first.device.id); release();
      expect((await pending).status).toBe(401);
      expect((await store.read()).uploads).toHaveLength(0);
    }, transport);
  } finally { release(); runner.close(); }
});

test("terminal replacement after transfer returns conflict and removes stored file", async () => {
  const runner = new UploadProcesses(), actual = storageTransport(runner);
  let replace = () => {};
  const transport: UploadTransport = async (action, target, record, bytes, signal) => {
    const result = await actual(action, target, record, bytes, signal);
    if (action === "write") replace();
    return result;
  };
  try {
    await harness(async ({ upload, store, changePID }: any) => {
      replace = changePID;
      expect((await upload("old terminal")).status).toBe(409);
      expect((await store.read()).uploads).toHaveLength(0);
    }, transport);
  } finally { runner.close(); }
});

test("pruning removes only expired manifest-owned bytes and leaves unrelated sentinel", async () => {
  await harness(async ({ upload, app, store, advance, root }: any) => {
    await upload("expires");
    const record = (await store.read()).uploads[0], path = join(record.root, record.date, record.filename);
    const sentinel = join(record.root, record.date, "unrelated.txt"); await writeFile(sentinel, "keep");
    advance(UPLOAD_LIFETIME + 1); await app.uploads.prune();
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await readFile(sentinel, "utf8")).toBe("keep");
    expect((await store.read()).uploads).toHaveLength(0);
  });
});

test("symlink roots and replaced files are never followed", async () => {
  await harness(async ({ upload, request, store, root }: any) => {
    const file = (await (await upload("own")).json()).upload;
    const record = (await store.read()).uploads[0], path = join(record.root, record.date, record.filename);
    const outside = join(root, "outside.txt"); await writeFile(outside, "sentinel");
    await rm(path); await symlink(outside, path);
    expect((await request("send", { text: "", uploads: [file.id] })).status).toBe(409);
    expect(await readFile(outside, "utf8")).toBe("sentinel");
    await rm(join(root, "files"), { recursive: true });
    await mkdir(join(root, "outside")); await symlink(join(root, "outside"), join(root, "files"));
    expect((await upload("must not escape")).status).toBe(503);
    expect(await readFile(outside, "utf8")).toBe("sentinel");
  });
});

test("manifest corruption with unsupported ready MIME fails closed", async () => {
  await harness(async ({ upload, store }: any) => {
    await upload("ready");
    await store.transact((s: any) => s.uploads[0].type = "application/x-executable");
    await expect(store.read()).rejects.toMatchObject({ code: "state_invalid" });
  });
});

test("awaited shutdown aborts a delayed transfer, drains cleanup and permits no later writes", async () => {
  const runner = new UploadProcesses(), actual = storageTransport(runner);
  let entered!: () => void, writes = 0;
  const started = new Promise<void>(resolve => entered = resolve);
  const transport: UploadTransport = async (action, target, record, bytes, signal) => {
    if (action === "write") {
      await actual(action, target, record, bytes, signal); writes++; entered();
      await new Promise<void>((_, reject) => signal!.addEventListener("abort", () => reject(Error("Aborted transfer")), { once: true }));
      throw Error("Unreachable write");
    }
    return actual(action, target, record, bytes, signal);
  };
  try {
    await harness(async ({ upload, app, store }: any) => {
      const pending = upload("drain me").catch(() => undefined); await started;
      await app.stop();
      await pending;
      expect((await store.read()).uploads).toHaveLength(0);
      expect(writes).toBe(1);
      await expect(app.uploads.create("device", "t1", new File(["no"], "no.txt"))).rejects.toMatchObject({ code: "upload_unavailable" });
      expect(writes).toBe(1);
    }, transport);
  } finally { runner.close(); }
});

test("delayed serial send revalidates attachment identity when its turn actually dispatches", async () => {
  await harness(async ({ upload, request, calls, changePID, gateSend }: any) => {
    const file = (await (await upload("belongs to original")).json()).upload;
    let release!: () => void; const gate = new Promise<void>(resolve => release = resolve);
    gateSend(gate);
    const first = request("send", { text: "holding queue" });
    while (!calls.some((c: any) => c.method === "terminal.send")) await Bun.sleep(1);
    const second = request("send", { text: "", uploads: [file.id] });
    changePID(); release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(409);
    expect(calls.filter((c: any) => c.method === "terminal.send")).toHaveLength(1);
  });
});

test("force-screen IO cannot bypass final attachment incarnation validation", async () => {
  await harness(async ({ upload, request, calls, setBlocked, replaceOnRead }: any) => {
    const file = (await (await upload("original")).json()).upload;
    setBlocked(true);
    const screen = await (await request("screen")).json();
    replaceOnRead();
    expect((await request("send", { text: "", uploads: [file.id], force: true, screenId: screen.screenId })).status).toBe(409);
    expect(calls.filter((c: any) => c.method === "terminal.send")).toHaveLength(0);
  });
});

test("generated-name collision never overwrites or deletes an existing file", async () => {
  const runner = new UploadProcesses(), actual = storageTransport(runner);
  let existing: string | undefined;
  const transport: UploadTransport = async (action, target, record, bytes, signal) => {
    if (action === "write") {
      await mkdir(join(record.root, record.date), { recursive: true });
      existing = join(record.root, record.date, record.filename);
      await writeFile(existing, "unrelated pre-existing file", { mode: 0o600 });
    }
    return actual(action, target, record, bytes, signal);
  };
  try {
    await harness(async ({ upload, store }: any) => {
      expect((await upload("new content")).status).toBe(503);
      expect(await readFile(existing!, "utf8")).toBe("unrelated pre-existing file");
      expect((await store.read()).uploads).toHaveLength(0);
    }, transport);
  } finally { runner.close(); }
});

test("prune batch and deadline are bounded even when an expired remote target stalls", async () => {
  let removes = 0;
  const transport: UploadTransport = async (action, target, record, _bytes, signal) => {
    if (action === "remove") {
      removes++;
      await new Promise<void>((_, reject) => signal!.addEventListener("abort", () => reject(Error("Deadline")), { once: true }));
    }
    return { path: join(target.root, record.date, record.filename) };
  };
  await harness(async ({ upload, app, store, advance }: any) => {
    await upload("seed");
    const seed = (await store.read()).uploads[0];
    await store.transact((s: any) => s.uploads = Array.from({ length: 20 }, (_, n) => { const id = n.toString(16).padStart(48, "0"); return { ...seed, id, filename: id + ".txt" }; }));
    advance(UPLOAD_LIFETIME + 1);
    const started = performance.now(); await app.uploads.prune();
    expect(performance.now() - started).toBeLessThan(4000);
    expect(removes).toBeLessThanOrEqual(2);
    expect((await store.read()).uploads).toHaveLength(20);
  }, transport);
});

test("legacy convert/identify command layout validates and converts actual content without magick", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-tools-"));
  const oldPath = process.env.PATH;
  const png = image("PNG"), heic = image("HEIC");
  const runner = new UploadProcesses();
  try {
    await symlink("/usr/bin/convert", join(root, "convert"));
    await symlink("/usr/bin/identify", join(root, "identify"));
    process.env.PATH = root;
    expect(imageCommand("convert", ["-list", "format"])[0]).toBe(join(root, "convert"));
    expect((await checkMedia(png, runner)).type).toBe("image/png");
    const jpeg = await checkMedia(heic, runner);
    expect(jpeg.type).toBe("image/jpeg"); expect(jpeg.converted).toBe(true);
    await rm(join(root, "convert"));
    await expect(checkMedia(heic, runner)).rejects.toMatchObject({ status: 503, code: "conversion_unavailable" });
  } finally { process.env.PATH = oldPath; runner.close(); await rm(root, { recursive: true, force: true }); }
});

test("owned processing children have exited when cancellation drain resolves", async () => {
  const root = await mkdtemp(join(tmpdir(), "upload-child-")), path = join(root, "pid");
  const runner = new UploadProcesses(), controller = new AbortController();
  const command = "import os,sys,time;open(sys.argv[1],'w').write(str(os.getpid()));time.sleep(60)";
  const pending = runner.run(["python3", "-c", command, path], undefined, 10000, controller.signal);
  // Attach a rejection observer before cancellation.
  const result = pending.then(() => null, error => error);
  try {
    const deadline = Date.now() + 2000;
    while (!(await Bun.file(path).exists()) && Date.now() < deadline) await Bun.sleep(1);
    const pid = Number(await readFile(path, "utf8"));
    controller.abort(); await runner.close();
    expect((await result).code).toBe("upload_unavailable");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await runner.close(); await rm(root, { recursive: true, force: true }); }
});
