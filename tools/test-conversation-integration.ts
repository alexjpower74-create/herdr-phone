// Opt-in proof: saved messages belong to disposable processes in a separate space.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Core } from "../server/core";
import { Store } from "../server/security";
import { start } from "../server/index";

if (process.env.HERDR_PHONE_INTEGRATION !== "1") throw Error("Set HERDR_PHONE_INTEGRATION=1 for this disposable-process proof.");
const directory = resolve(process.env.CONVERSATION_PROOF_DIR || "notes/conversation-proof");
await mkdir(directory, { recursive: true });
const configPath = process.env.HERDR_PHONE_TRANSCRIPTS_CONFIG;
const configured = JSON.parse(await readFile(configPath || join(homedir(), ".config/herdr-phone/transcripts.json"), "utf8"));
const remoteEntry = Object.entries<any>(configured.machines).find(([id, value]) => id !== "local" && value.ssh);
assert(remoteEntry, "A configured remote machine is required for the remote proof");
const [remoteAlias, remoteConfig] = remoteEntry;
const scratch = await mkdtemp(join(tmpdir(), "phone-conversation-"));
const spaceId = `sp${randomUUID().replaceAll("-", "")}`;
const core = new Core();
const port = Number(process.env.CONVERSATION_WEB_PORT || 5197);
const origin = `http://127.0.0.1:${port}`;
const requireWeb = createRequire(new URL("../web/package.json", import.meta.url));
const { webkit } = requireWeb("@playwright/test");
const { createServer } = await import(new URL("../web/node_modules/vite/dist/node/index.js", import.meta.url).href);
const report: any = { sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), checks: [], cleaned: false };
let app: ReturnType<typeof start> | undefined, vite: any, browser: any, context: any;
let remoteRoot: string | undefined, beforeFocus: unknown, before: any[] = [];
const owned = new Map<string, { machine: string; root: string; name: string }>();
const methods: string[] = [];
const desktop = () => JSON.parse(execFileSync("herdr-app", ["status"], { encoding: "utf8" }));
const focus = (value: any) => [value.space, value.tab, value.focused_pane, value.agent];
const record = (name: string, detail: unknown = true) => report.checks.push({ name, detail });
async function eventually(fn: () => Promise<boolean>, label: string, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await fn()) return; await Bun.sleep(50); }
  throw Error(label);
}
async function remote(script: string, args: string[] = []) {
  const result = await core.call("machine.exec", { on: remoteAlias, argv: ["python3", "-c", script, ...args], timeout: 15 });
  assert.equal(result.code, 0, "Owned remote fixture operation failed");
  assert(!result.timed_out, "Remote fixture operation timed out");
  return Buffer.from(result.stdout, "base64").toString().trim();
}
async function file(machine: string, root: string, name: string) {
  return machine === "local" ? readFile(join(root, name), "utf8") : remote("import pathlib,sys;print(pathlib.Path(sys.argv[1]).read_text())", [join(root, name)]);
}
async function layout(machine: string, change: (value: any) => void) {
  for (let i = 0; i < 8; i++) {
    const args = { name: "herdr-app", ...(machine === "local" ? {} : { on: machine }) };
    const doc = await core.call("doc.get", args), value = structuredClone(doc.value);
    change(value);
    try { await core.call("doc.set", { ...args, version: doc.version, value }); return; }
    catch (e: any) { if (!["conflict", "version_conflict"].includes(e.kind)) throw e; }
  }
  throw Error("Owned layout update remained conflicted");
}
async function removeTerminal(id: string) {
  const own = owned.get(id)!;
  const terminal = await core.call("terminal.get", { terminal: id });
  assert.equal(terminal.name, own.name);
  assert.equal(terminal.cwd, own.root);
  assert.equal(terminal.labels["herdr.space"], spaceId);
  await core.call("terminal.kill", { terminal: id });
  await core.call("terminal.rm", { terminal: id });
  owned.delete(id);
  await layout(own.machine, value => { value.spaces = (value.spaces || []).filter((s: any) => s.id !== spaceId); });
}
const producer = String.raw`import os,sys,time,json,pathlib,uuid,subprocess,fcntl,termios,struct,select
root=pathlib.Path(sys.argv[1]);kind=sys.argv[2];root.mkdir(parents=True,exist_ok=True)
source=root/'logs';source.mkdir(exist_ok=True);index=root/'index';index.mkdir(exist_ok=True)
session=str(uuid.uuid4());path=source/(session+'.jsonl' if kind=='messages' else 'rollout-2026-11-01T00-00-00-'+session+'.jsonl')
f=path.open('w');clock='2026-11-01T00:00:00Z'
def emit(value): f.write(json.dumps(value,ensure_ascii=False)+'\n')
if kind=='responses':emit({'type':'session_meta','payload':{'id':session,'cwd':str(root)},'timestamp':clock})
for n in range(1,126):
 user='Message %03d: review this saved conversation.'%n
 reply='Reply %03d: the saved text remains readable, including caf\u00e9 and \U0001f43e.'%n
 if kind=='messages':
  emit({'type':'user','uuid':'u%03d'%n,'sessionId':session,'cwd':str(root),'message':{'role':'user','content':user}})
  emit({'type':'assistant','uuid':'a%03d'%n,'sessionId':session,'message':{'role':'assistant','content':[{'type':'text','text':reply},{'type':'thinking','thinking':'HIDDEN_REASONING'},{'type':'tool_use','id':'tool%03d'%n,'name':'Inspect file','input':{'secret':'HIDDEN_ARGUMENT'}}]}})
  emit({'type':'user','uuid':'r%03d'%n,'sessionId':session,'message':{'role':'user','content':[{'type':'tool_result','tool_use_id':'tool%03d'%n,'content':'HIDDEN_OUTPUT'}]}})
 else:
  emit({'type':'response_item','payload':{'type':'message','id':'u%03d'%n,'role':'user','content':[{'type':'input_text','text':user}]}})
  emit({'type':'response_item','payload':{'type':'message','id':'a%03d'%n,'role':'assistant','channel':'final','content':[{'type':'output_text','text':reply}]}})
  emit({'type':'response_item','payload':{'type':'message','id':'x%03d'%n,'role':'assistant','channel':'analysis','content':[{'type':'output_text','text':'HIDDEN_REASONING'}]}})
  emit({'type':'response_item','payload':{'type':'function_call','call_id':'tool%03d'%n,'name':'Inspect file','arguments':'HIDDEN_ARGUMENT'}})
  emit({'type':'response_item','payload':{'type':'function_call_output','call_id':'tool%03d'%n,'output':'HIDDEN_OUTPUT'}})
f.flush();os.fsync(f.fileno())
if kind=='messages':f.close()
if sys.platform=='darwin':
 start=subprocess.check_output(['ps','-p',str(os.getpid()),'-o','lstart='],text=True).strip();domain='darwin'
else:
 start=pathlib.Path('/proc/%s/stat'%os.getpid()).read_text().rsplit(')',1)[1].split()[19]
 domain='linux:'+pathlib.Path('/etc/machine-id').read_text().strip()+':'+os.readlink('/proc/%s/ns/pid'%os.getpid())
(index/('%s.json'%os.getpid())).write_text(json.dumps({'pid':os.getpid(),'sessionId':session,'cwd':str(root),'procStart':start,'pidDomain':domain,'startedAt':int(time.time()*1000)}))
(root/'ready.json').write_text(json.dumps({'pid':os.getpid(),'session':session}))
os.write(1,b'Conversation fixture ready\r\n')
while True:
 rows,cols,_,_=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\0'*8))
 (root/'size.json').write_text(json.dumps([cols,rows]))
 if select.select([0],[],[],0)[0]:
  data=os.read(0,65536)
  with (root/'input.bin').open('ab') as received: received.write(data)
 time.sleep(.05)
`;

try {
  beforeFocus = focus(desktop());
  assert((beforeFocus as any[]).every(Boolean), "Focus baseline missing");
  before = (await core.call("terminal.list", { all: true })).terminals;
  remoteRoot = await remote("import tempfile;print(tempfile.mkdtemp(prefix='phone-conversation-'))");
  assert(remoteRoot.startsWith("/") && remoteRoot.includes("phone-conversation-"));
  const config: any = { machines: { local: { sources: [] }, [remoteAlias]: { ssh: remoteConfig.ssh, sources: [] } } };
  for (const machine of ["local", remoteAlias]) for (const format of ["messages", "responses"]) {
    const root = join(machine === "local" ? scratch : remoteRoot, format);
    config.machines[machine].sources.push({ format, root: join(root, "logs"), ...(format === "messages" ? { sessions: join(root, "index") } : {}) });
  }
  const fixtureConfig = join(scratch, "transcripts.json");
  await writeFile(fixtureConfig, JSON.stringify(config), { mode: 0o600 });
  process.env.HERDR_PHONE_TRANSCRIPTS_CONFIG = fixtureConfig;
  const store = new Store(join(scratch, "device"));
  const paired = await store.exchange(await store.pairing(), "Conversation check");
  const rpc = { async call(method: string, params: any = {}) {
    methods.push(method);
    assert(["hello", "terminal.get", "terminal.read"].includes(method), `Unexpected bridge RPC: ${method}`);
    if (method.startsWith("terminal.")) assert(owned.has(params.terminal), "Bridge accessed an unrelated terminal");
    if (method === "terminal.read") assert.equal(params.lines, 0);
    return core.call(method, params);
  } };
  app = start({ port: 0, origin, store, core: rpc });
  let displayed: any;
  app.state.get = async () => ({ version: 1, revision: 1, machines: [{ id: "local", name: "Computer", online: true }], programs: [],
    spaces: displayed ? [{ id: "check", machineId: "local", name: "Conversation check", cwd: "", repo: null, branch: null, color: "#788ba8",
      tabs: [{ id: "messages", name: "Saved messages", terminals: [{ id: displayed.address, title: "Saved messages", state: "live", status: "idle", cols: displayed.cols, rows: displayed.rows }] }] }] : [] });
  vite = await createServer({ root: resolve("web"), configFile: false, server: { host: "127.0.0.1", port, strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${app.server.port}`, ws: true } } }, logLevel: "error" });
  await vite.listen();
  browser = await webkit.launch();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: false, serviceWorkers: "block" });
  await context.addInitScript((token: string) => { if (location.protocol === "http:") localStorage.setItem("herdr-phone.device", token); }, paired.token);
  for (const machine of ["local", remoteAlias]) for (const format of ["messages", "responses"]) {
    const root = join(machine === "local" ? scratch : remoteRoot, format), name = `conversation-check-${randomUUID().slice(0, 8)}`;
    if (machine === "local") { await mkdir(root); await writeFile(join(root, "producer.py"), producer); }
    else await remote("import pathlib,sys,base64;p=pathlib.Path(sys.argv[1]);p.mkdir();(p/'producer.py').write_bytes(base64.b64decode(sys.argv[2]))", [root, Buffer.from(producer).toString("base64")]);
    const tab = `tb${randomUUID().replaceAll("-", "")}`;
    const made = await core.call("terminal.run", { argv: ["python3", join(root, "producer.py"), root, format], cwd: root, name,
      ...(machine === "local" ? {} : { on: machine }), no_parent: true, no_notify: true, labels: { "herdr.space": spaceId, "herdr.tab": tab } });
    const id = made.address;
    owned.set(id, { machine, root, name });
    await layout(machine, value => { value.spaces ||= []; value.spaces.push({ id: spaceId, name: "Conversation check", folder: root,
      tabs: [{ id: tab, name: "Saved messages", root: { id: `p${randomUUID().replaceAll("-", "")}`, type: "block", content: { terminal: id.split("/").at(-1) } } }] }); });
    await eventually(async () => {
      try { return !!JSON.parse(await file(machine, root, "ready.json")).pid; }
      catch {
        const current = await core.call("terminal.get", { terminal: id });
        if (current.state === "finished") {
          const read = await core.call("terminal.read", { terminal: id, lines: 0 });
          throw Error(`Owned fixture exited: ${read.text}`);
        }
        return false;
      }
    }, "Fixture did not start");
    displayed = await core.call("terminal.get", { terminal: id });
    const size = [displayed.cols, displayed.rows];
    const headers = { Authorization: `Bearer ${paired.token}` };
    const endpoint = `http://127.0.0.1:${app.server.port}/api/terminals/${encodeURIComponent(id)}/conversation`;
    assert.equal((await fetch(endpoint)).status, 401);
    let cursor: string | null = null, all: any[] = [], pages = 0;
    do {
      const response = await fetch(endpoint + (cursor ? `?before=${encodeURIComponent(cursor)}` : ""), { headers });
      assert.equal(response.status, 200, `Conversation request failed: ${response.status}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body: any = await response.json();
      assert(body.available, `History unavailable: ${body.reason}`);
      assert(body.turns.length > 0 && body.turns.length <= 50);
      assert(!JSON.stringify(body).includes("HIDDEN_"), "Private reasoning or tool data escaped");
      all = [...body.turns, ...all]; cursor = body.nextCursor; pages++;
      assert(pages <= 3, "Pagination did not terminate");
    } while (cursor);
    assert.equal(all.length, 125);
    assert.equal(new Set(all.map(t => t.id)).size, 125);
    assert.deepEqual(all.flatMap(t => t.entries.filter((e: any) => e.role === "user").map((e: any) => e.text)), Array.from({ length: 125 }, (_, i) => `Message ${String(i + 1).padStart(3, "0")}: review this saved conversation.`));
    record(`${machine === "local" ? "local" : "remote"} ${format}: three exact pages`, { turns: all.length, pages });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    try {
      await page.goto(`${origin}/#terminal=${encodeURIComponent(id)}`);
      await page.getByRole("button", { name: "Conversation", exact: true }).tap();
      const panel = page.locator(".conversation");
      await panel.getByText("Message 125: review this saved conversation.", { exact: true }).waitFor();
      for (let attempt = 0; attempt < 12; attempt++) {
        if (await panel.getByText("Message 001: review this saved conversation.", { exact: true }).isVisible()) break;
        const box = await panel.boundingBox(); assert(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, -100000);
        await page.waitForTimeout(400);
      }
      const first = panel.getByText("Message 001: review this saved conversation.", { exact: true });
      await first.waitFor();
      const visible = await first.evaluate((el: HTMLElement) => {
        const r = el.getBoundingClientRect(), box = el.closest(".conversation")!.getBoundingClientRect();
        const x = Math.min(r.right - 2, Math.max(r.left + 2, (r.left + r.right) / 2));
        const y = Math.max(r.top + 2, box.top + 2);
        return y < Math.min(r.bottom, box.bottom) && el.contains(document.elementFromPoint(x, y));
      });
      assert(visible, "First message is not actually visible after real scrolling");
      assert.equal(await panel.locator('[data-role="user"]').count(), 125);
      assert.equal(await panel.locator('[data-role="tool"]').count(), 125);
      assert(!await panel.evaluate((el: HTMLElement) => el.scrollWidth > el.clientWidth + 1));
      assert.deepEqual(errors, []);
      await page.screenshot({ path: join(directory, `conversation-${machine === "local" ? "local" : "remote"}-${format}-webkit.png`) });
      record(`${machine === "local" ? "local" : "remote"} ${format}: first message visible with real wheel input`);
    } finally { await page.close(); }
    const inputBytes = machine === "local"
      ? await Bun.file(join(root, "input.bin")).exists().then(async exists => exists ? (await readFile(join(root, "input.bin"))).length : 0)
      : Number(await remote("import pathlib,sys;p=pathlib.Path(sys.argv[1]);print(p.stat().st_size if p.exists() else 0)", [join(root, "input.bin")]));
    assert.equal(inputBytes, 0, "Conversation access sent terminal input");
    assert.deepEqual(JSON.parse(await file(machine, root, "size.json")), size);
    const final = await core.call("terminal.get", { terminal: id });
    assert.deepEqual([final.cols, final.rows], size);
    await removeTerminal(id);
  }
  assert(methods.includes("terminal.get") && methods.every(method => ["terminal.get", "terminal.read", "hello"].includes(method)));
  record("Bridge performs only read RPCs; no terminal input or attach", [...new Set(methods)]);
  assert.deepEqual(focus(desktop()), beforeFocus);
  const after = (await core.call("terminal.list", { all: true })).terminals;
  for (const old of before) {
    const current = after.find((t: any) => t.address === old.address);
    if (current && old.state === "live") assert.deepEqual([current.cols, current.rows], [old.cols, old.rows]);
  }
  record("Desktop focus and existing terminal sizes preserved");
} finally {
  const errors: unknown[] = [];
  const attempt = async (fn: () => unknown) => { try { await fn(); } catch (e) { errors.push(e); } };
  try {
    await attempt(() => context?.close()); await attempt(() => browser?.close()); await attempt(() => vite?.close()); await attempt(() => app?.stop());
    for (const id of [...owned.keys()]) await attempt(() => removeTerminal(id));
    for (const machine of ["local", remoteAlias]) await attempt(() => layout(machine, value => { value.spaces = (value.spaces || []).filter((s: any) => s.id !== spaceId); }));
    if (remoteRoot) await attempt(() => remote("import pathlib,shutil,sys;p=pathlib.Path(sys.argv[1]);assert p.name.startswith('phone-conversation-') and not p.is_symlink();shutil.rmtree(p)", [remoteRoot!]));
    await attempt(() => { assert.deepEqual(focus(desktop()), beforeFocus); });
  } finally {
    await attempt(() => core.close());
    if (configPath === undefined) delete process.env.HERDR_PHONE_TRANSCRIPTS_CONFIG; else process.env.HERDR_PHONE_TRANSCRIPTS_CONFIG = configPath;
    await attempt(() => rm(scratch, { recursive: true, force: true }));
  }
  report.cleaned = errors.length === 0;
  await writeFile(join(directory, "proof.json"), JSON.stringify(report, null, 2) + "\n");
  if (errors.length) throw new AggregateError(errors, "Conversation proof cleanup failed");
}
console.log(JSON.stringify(report, null, 2));
