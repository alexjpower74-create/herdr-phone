// Opt-in proof: uploads and paste input target disposable terminals only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Core } from "../server/core";
import { Store } from "../server/security";
import { start } from "../server/index";

if (process.env.HERDR_PHONE_INTEGRATION !== "1") throw Error("Set HERDR_PHONE_INTEGRATION=1 for the disposable upload proof.");
const directory = resolve(process.env.ATTACHMENT_PROOF_DIR || "notes/attachment-proof");
await mkdir(directory, { recursive: true });
const previousConfig = process.env.HERDR_PHONE_TRANSCRIPTS_CONFIG, previousRoot = process.env.HERDR_PHONE_UPLOADS_DIR;
const configured = JSON.parse(await readFile(previousConfig || join(homedir(), ".config/herdr-phone/transcripts.json"), "utf8"));
const remoteEntry = Object.entries<any>(configured.machines).find(([id, value]) => id !== "local" && value.ssh);
assert(remoteEntry, "A remote SSH mapping is required");
const [remoteAlias, remoteConfig] = remoteEntry;
const scratch = await mkdtemp(join(tmpdir(), "phone-attachment-"));
const spaceId = `sp${randomUUID().replaceAll("-", "")}`, core = new Core();
const port = Number(process.env.ATTACHMENT_WEB_PORT || 5200), origin = `http://127.0.0.1:${port}`;
const { webkit } = createRequire(new URL("../web/package.json", import.meta.url))("@playwright/test");
const { createServer } = await import(new URL("../web/node_modules/vite/dist/node/index.js", import.meta.url).href);
const report: any = { sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), checks: [], cleaned: false };
const owned = new Map<string, { root: string; machine: string; name: string }>();
const writes: { terminal: string; text: string }[] = [];
let app: ReturnType<typeof start> | undefined, vite: any, browser: any, context: any;
let remoteRoot: string | undefined, beforeFocus: unknown, before: any[] = [], displayed: any;
const focus = () => { const s = JSON.parse(execFileSync("herdr-app", ["status"], { encoding: "utf8" })); return [s.space, s.tab, s.focused_pane, s.agent]; };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const record = (name: string, detail: unknown = true) => report.checks.push({ name, detail });
async function eventually(fn: () => Promise<boolean>, message: string, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return; await Bun.sleep(50); }
  throw Error(message);
}
async function remote(script: string, args: string[] = []) {
  const result = await core.call("machine.exec", { on: remoteAlias, argv: ["python3", "-c", script, ...args], timeout: 15 });
  assert.equal(result.code, 0, "Owned remote operation failed"); assert(!result.timed_out);
  return Buffer.from(result.stdout, "base64").toString().trim();
}
async function bytes(machine: string, path: string) {
  if (machine === "local") return readFile(path);
  return Buffer.from(await remote("import pathlib,base64,sys;print(base64.b64encode(pathlib.Path(sys.argv[1]).read_bytes()).decode())", [path]), "base64");
}
async function layout(machine: string, change: (value: any) => void) {
  for (let i = 0; i < 8; i++) {
    const args = { name: "herdr-app", ...(machine === "local" ? {} : { on: machine }) };
    const doc = await core.call("doc.get", args), value = structuredClone(doc.value); change(value);
    try { await core.call("doc.set", { ...args, version: doc.version, value }); return; }
    catch (e: any) { if (!["conflict", "version_conflict"].includes(e.kind)) throw e; }
  }
  throw Error("Owned space update conflicted");
}
async function removeTerminal(id: string) {
  const own = owned.get(id)!, current = await core.call("terminal.get", { terminal: id });
  assert.equal(current.cwd, own.root); assert.equal(current.name, own.name); assert.equal(current.labels["herdr.space"], spaceId);
  await core.call("terminal.kill", { terminal: id }); await core.call("terminal.rm", { terminal: id }); owned.delete(id);
  await layout(own.machine, value => { value.spaces = (value.spaces || []).filter((s: any) => s.id !== spaceId); });
}
const producer = String.raw`import os,sys,tty,time,pathlib,select,json,fcntl,termios,struct
root=pathlib.Path(sys.argv[1]);tty.setraw(0)
capture=(root/'input.bin').open('wb',buffering=0)
(root/'ready.json').write_text(json.dumps({'pid':os.getpid()}))
os.write(1,b'Attachment check ready\r\n')
while True:
 rows,cols,_,_=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\0'*8))
 (root/'size.json').write_text(json.dumps([cols,rows]))
 if select.select([0],[],[],.05)[0]:capture.write(os.read(0,65536))
`;
try {
  beforeFocus = focus(); assert((beforeFocus as any[]).every(Boolean));
  before = (await core.call("terminal.list", { all: true })).terminals;
  remoteRoot = await remote("import tempfile;print(tempfile.mkdtemp(prefix='phone-attachment-'))");
  assert(remoteRoot.startsWith("/") && remoteRoot.includes("phone-attachment-"));
  const localUploads = join(scratch, "uploads"), remoteUploads = join(remoteRoot, "uploads");
  const testConfig = join(scratch, "machines.json");
  await writeFile(testConfig, JSON.stringify({ machines: { local: { sources: [] }, [remoteAlias]: { ssh: remoteConfig.ssh, sources: [], uploadsDir: remoteUploads } } }), { mode: 0o600 });
  process.env.HERDR_PHONE_UPLOADS_DIR = localUploads; process.env.HERDR_PHONE_TRANSCRIPTS_CONFIG = testConfig;
  const photo = join(scratch, "photo.png"), note = join(scratch, "note.txt"), pdf = join(scratch, "sample.pdf"), heic = join(scratch, "photo.heic");
  execFileSync("magick", ["-size", "64x32", "xc:#24527d", photo], { stdio: "ignore" });
  execFileSync("magick", [photo, heic], { stdio: "ignore" });
  await writeFile(note, "Attachment text: caf\u00e9 and punctuation + ? !\n");
  await writeFile(pdf, "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
  const store = new Store(join(scratch, "device"));
  const paired = await store.exchange(await store.pairing(), "Upload check");
  const other = await store.exchange(await store.pairing(), "Other device");
  const rpc = { async call(method: string, params: any = {}) {
    assert(["hello", "terminal.get", "terminal.read", "terminal.send"].includes(method), `Unexpected bridge RPC ${method}`);
    if (method.startsWith("terminal.")) assert(owned.has(params.terminal), "Bridge addressed an unrelated terminal");
    if (method === "terminal.read") assert.equal(params.lines, 0);
    if (method === "terminal.send") writes.push({ terminal: params.terminal, text: params.text });
    return core.call(method, params);
  } };
  app = start({ port: 0, origin, core: rpc, store });
  app.state.get = async () => ({ version: 1, revision: 1, machines: [{ id: "local", name: "Computer", online: true }], programs: [], spaces: displayed ? [{ id: "check", machineId: "local", name: "Attachment check", cwd: "", repo: null, branch: null, color: "#788ba8", tabs: [{ id: "files", name: "Files", terminals: [{ id: displayed.address, title: "File check", state: "live", status: "idle", cols: displayed.cols, rows: displayed.rows }] }] }] : [] });
  vite = await createServer({ root: resolve("web"), configFile: false, server: { host: "127.0.0.1", port, strictPort: true, proxy: { "/api": { target: `http://127.0.0.1:${app.server.port}`, ws: true } } }, logLevel: "error" });
  await vite.listen(); browser = await webkit.launch();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: "block" });
  await context.addInitScript((token: string) => { if (location.protocol === "http:") localStorage.setItem("herdr-phone.device", token); }, paired.token);
  for (const machine of ["local", remoteAlias]) {
    const root = join(machine === "local" ? scratch : remoteRoot, "terminal"), name = `attachment-check-${randomUUID().slice(0, 8)}`;
    if (machine === "local") { await mkdir(root); await writeFile(join(root, "producer.py"), producer); }
    else await remote("import pathlib,sys,base64;p=pathlib.Path(sys.argv[1]);p.mkdir();(p/'producer.py').write_bytes(base64.b64decode(sys.argv[2]))", [root, Buffer.from(producer).toString("base64")]);
    const tab = `tb${randomUUID().replaceAll("-", "")}`;
    const made = await core.call("terminal.run", { argv: ["python3", join(root, "producer.py"), root], cwd: root, name, ...(machine === "local" ? {} : { on: machine }), no_parent: true, no_notify: true, labels: { "herdr.space": spaceId, "herdr.tab": tab } });
    const id = made.address; owned.set(id, { root, name, machine });
    await layout(machine, value => { value.spaces ||= []; value.spaces.push({ id: spaceId, name: "Attachment check", folder: root, tabs: [{ id: tab, name: "Files", root: { id: `p${randomUUID().replaceAll("-", "")}`, type: "block", content: { terminal: id.split("/").at(-1) } } }] }); });
    await eventually(async () => { try { return !!JSON.parse((await bytes(machine, join(root, "ready.json"))).toString()).pid; } catch { return false; } }, "Fixture did not become ready");
    displayed = await core.call("terminal.get", { terminal: id });
    const size = [displayed.cols, displayed.rows];
    const endpoint = `http://127.0.0.1:${app.server.port}/api/terminals/${encodeURIComponent(id)}`;
    const upload = async (data: Uint8Array, filename: string, token = paired.token) => {
      const body = new FormData(); body.append("file", new Blob([data]), filename);
      return fetch(`${endpoint}/uploads`, { method: "POST", headers: { Authorization: `Bearer ${token}`, Origin: origin }, body });
    };
    const photoBytes = await readFile(photo);
    assert.equal((await upload(photoBytes, "photo.png", "invalid-token")).status, 401);
    const initial = await upload(photoBytes, "wrong-extension.txt");
    assert.equal(initial.status, 201, `Valid image upload failed: ${initial.status}`);
    const initialBody: any = await initial.json(); assert.equal(initialBody.upload.type, "image/png");
    assert.equal((await upload(Buffer.from([77, 90, 0, 1, 2, 3]), "fake.png")).status, 415);
    assert.equal((await upload(new Uint8Array(20 * 1024 * 1024 + 1), "large.txt")).status, 413);
    const foreign = await fetch(`${endpoint}/send`, { method: "POST", headers: { Authorization: `Bearer ${other.token}`, Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ text: "Must not arrive", uploads: [initialBody.upload.id] }) });
    assert.equal(foreign.status, 409); assert.equal((await bytes(machine, join(root, "input.bin"))).length, 0);
    record(`${machine === "local" ? "local" : "remote"} upload authentication, sniffing, limits and ownership`);
    const page = await context.newPage(), errors: string[] = [], uploaded: any[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("response", async (response: any) => { if (response.url().endsWith("/uploads") && response.status() === 201) uploaded.push((await response.json()).upload); });
    try {
      await page.goto(`${origin}/#terminal=${encodeURIComponent(id)}`);
      const picker = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Attach files", exact: true }).tap();
      const selected = machine === "local" ? [photo, note, pdf] : [heic, note];
      await (await picker).setFiles(selected);
      await page.getByRole("button", { name: "Remove note.txt", exact: true }).waitFor();
      assert.equal(uploaded.length, 0, "Selection must remain local until Send");
      await page.locator(".terminal-input").tap(); await page.keyboard.insertText("Review the selected files.");
      await page.screenshot({ path: join(directory, `attachments-${machine === "local" ? "local" : "remote"}-webkit.png`) });
      const start = writes.length;
      await page.getByRole("button", { name: "Send", exact: true }).tap();
      await eventually(async () => writes.length === start + 1, "Send did not reach owned terminal", 30000);
      const sent = writes[start]; assert.equal(sent.terminal, id);
      await eventually(async () => (await bytes(machine, join(root, "input.bin"))).equals(Buffer.from(sent.text + "\r")), "Raw paste bytes differ from one acknowledged message");
      await eventually(async () => uploaded.length === selected.length, "Upload response count mismatch");
      const pathLines = sent.text.split("\n").filter(line => line.startsWith('"')).map(line => JSON.parse(line));
      assert.equal(pathLines.length, selected.length); assert(sent.text.endsWith("\n\nReview the selected files."));
      for (let i = 0; i < pathLines.length; i++) {
        const path = pathLines[i], uploadRoot = machine === "local" ? localUploads : remoteUploads;
        assert(path.startsWith(uploadRoot + "/"), "Paste path is outside owned upload root");
        const info = machine === "local" ? { mode: (await stat(path)).mode & 0o777, size: (await stat(path)).size } : JSON.parse(await remote("import os,stat,json,sys;s=os.stat(sys.argv[1]);print(json.dumps({'mode':stat.S_IMODE(s.st_mode),'size':s.st_size}))", [path]));
        assert.equal(info.mode, 0o600); assert.equal(info.size, uploaded[i].size);
        const stored = await bytes(machine, path);
        if (selected[i] === heic) { assert.equal(uploaded[i].type, "image/jpeg"); assert(uploaded[i].converted); assert.equal(stored[0], 0xff); assert.equal(stored[1], 0xd8); }
        else assert.equal(digest(stored), digest(await readFile(selected[i])));
      }
      assert.deepEqual(errors, []); assert.equal(writes.length, start + 1);
      record(`${machine === "local" ? "local" : "remote"} real picker upload and exact single paste`, { files: selected.length, bytes: Buffer.byteLength(sent.text + "\r"), normalizedImage: machine !== "local" });
      await eventually(async () => (await page.locator(".terminal-input").inputValue()) === "", "Successful draft did not clear");
    } finally { await page.close(); }
    assert.deepEqual(JSON.parse((await bytes(machine, join(root, "size.json"))).toString()), size);
    const final = await core.call("terminal.get", { terminal: id }); assert.deepEqual([final.cols, final.rows], size);
    await removeTerminal(id);
  }
  assert.deepEqual(focus(), beforeFocus);
  const after = (await core.call("terminal.list", { all: true })).terminals;
  for (const old of before) { const current = after.find((t: any) => t.address === old.address); if (current && old.state === "live") assert.deepEqual([current.cols, current.rows], [old.cols, old.rows]); }
  record("Existing sizes and desktop focus unchanged; both throwaways removed");
} finally {
  const errors: unknown[] = [];
  const attempt = async (fn: () => unknown) => { try { await fn(); } catch (e) { errors.push(e); } };
  try {
    await attempt(() => context?.close()); await attempt(() => browser?.close()); await attempt(() => vite?.close()); await attempt(() => app?.stop());
    for (const id of [...owned.keys()]) await attempt(() => removeTerminal(id));
    for (const machine of ["local", remoteAlias]) await attempt(() => layout(machine, value => { value.spaces = (value.spaces || []).filter((s: any) => s.id !== spaceId); }));
    if (remoteRoot) await attempt(() => remote("import pathlib,shutil,sys;p=pathlib.Path(sys.argv[1]);assert p.name.startswith('phone-attachment-') and not p.is_symlink();shutil.rmtree(p)", [remoteRoot!]));
    await attempt(() => assert.deepEqual(focus(), beforeFocus));
  } finally {
    await attempt(() => core.close()); await attempt(() => rm(scratch, { recursive: true, force: true }));
    if (previousConfig === undefined) delete process.env.HERDR_PHONE_TRANSCRIPTS_CONFIG; else process.env.HERDR_PHONE_TRANSCRIPTS_CONFIG = previousConfig;
    if (previousRoot === undefined) delete process.env.HERDR_PHONE_UPLOADS_DIR; else process.env.HERDR_PHONE_UPLOADS_DIR = previousRoot;
  }
  report.cleaned = errors.length === 0;
  await writeFile(join(directory, "proof.json"), JSON.stringify(report, null, 2) + "\n");
  if (errors.length) throw new AggregateError(errors, "Attachment proof cleanup failed");
}
console.log(JSON.stringify(report, null, 2));
