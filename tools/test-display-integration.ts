// Opt-in only: all output and viewer changes target one disposable terminal.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, rename, rm, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { Core, frame } from "../server/core";
import { Store } from "../server/security";
import { start } from "../server/index";

if (process.env.HERDR_PHONE_INTEGRATION !== "1") throw Error("Set HERDR_PHONE_INTEGRATION=1 for this disposable-terminal proof.");
const baseline = process.env.DISPLAY_BASELINE === "1";
const label = baseline ? "before" : "after";
const directory = resolve(process.env.DISPLAY_PROOF_DIR || `notes/display-${label}`);
await mkdir(directory, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "phone-display-"));
const spaceId = `sp${randomUUID().replaceAll("-", "")}`;
const tabId = `tb${randomUUID().replaceAll("-", "")}`;
const name = `display-probe-${randomUUID().slice(0, 8)}`;
const core = new Core(), desktopCore = new Core();
const originalHc = process.env.HERDR_PHONE_HC;
const realHc = execFileSync("which", ["hc"], { encoding: "utf8" }).trim();
const port = Number(process.env.DISPLAY_WEB_PORT || 5193);
const origin = `http://127.0.0.1:${port}`;
const requireWeb = createRequire(new URL("../web/package.json", import.meta.url));
const { webkit } = requireWeb("@playwright/test");
const { createServer } = await import(new URL("../web/node_modules/vite/dist/node/index.js", import.meta.url).href);
const report: any = { sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), label, checks: [], sizes: [] };
let app: ReturnType<typeof start> | undefined, vite: any, browser: any, context: any;
let sizingObserver: { close(): void } | undefined;
let terminalId: string | undefined, desktopChannel: number | undefined, beforeFocus: unknown;
let before: any[] = [], commandId = 0;
const desktop = () => JSON.parse(execFileSync("herdr-app", ["status"], { encoding: "utf8" }));
const focus = (value: any) => [value.space, value.tab, value.focused_pane, value.agent];
function check(test: string, passed: boolean, detail?: unknown) { report.checks.push({ test, passed, detail }); }
async function eventually(fn: () => Promise<boolean>, message: string, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await fn()) return; await Bun.sleep(40); }
  throw Error(message);
}
async function layout(change: (value: any) => void) {
  for (let i = 0; i < 8; i++) {
    const doc = await core.call("doc.get", { name: "herdr-app" });
    const value = structuredClone(doc.value); change(value);
    try { await core.call("doc.set", { name: "herdr-app", version: doc.version, value }); return; }
    catch (e: any) { if (!["conflict", "version_conflict"].includes(e.kind)) throw e; }
  }
  throw Error("Could not update owned test space");
}
async function command(mode: string) {
  const id = ++commandId;
  await writeFile(join(scratch, "next.json"), JSON.stringify({ mode, id }));
  await rename(join(scratch, "next.json"), join(scratch, "control.json"));
  await eventually(async () => {
    try { return JSON.parse(await readFile(join(scratch, "ack.json"), "utf8")).id === id; }
    catch { return false; }
  }, `Producer did not acknowledge ${mode}`);
}
async function size(step: string, expected: number[]) {
  await eventually(async () => {
    const t = await core.call("terminal.get", { terminal: terminalId });
    let kernel;
    try { kernel = JSON.parse(await readFile(join(scratch, "size.json"), "utf8")); } catch { return false; }
    return t.cols === expected[0] && t.rows === expected[1] && JSON.stringify(kernel) === JSON.stringify(expected);
  }, `Size changed unexpectedly at ${step}`, 4000);
  report.sizes.push({ step, size: expected });
}
async function inspect(page: any, cells = false) {
  return page.evaluate(async (withCells: boolean) => {
    const path = "/src/main.ts";
    const module = await import(/* @vite-ignore */ path);
    return module.inspectTerminal?.(withCells) ?? null;
  }, cells);
}
async function settle(page: any) {
  await page.locator(".terminal-viewport").evaluate((el: HTMLElement) => new Promise<void>((done, fail) => {
    let last = el.scrollTop, stable = 0, tick = 0;
    const timeout = setTimeout(() => { cancelAnimationFrame(tick); fail(Error("Scroll did not settle")); }, 5000);
    const sample = () => { const next = el.scrollTop; stable = Math.abs(last - next) < 0.1 ? stable + 1 : 0; last = next;
      if (stable >= 6) { clearTimeout(timeout); done(); } else tick = requestAnimationFrame(sample); };
    tick = requestAnimationFrame(sample);
  }));
}
async function scrollTop(page: any) {
  const box = await page.locator(".terminal-viewport").boundingBox();
  assert(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100000);
  await settle(page);
}
async function choose(page: any, view: "read" | "mirror") {
  const current = await page.locator(".terminal-viewport").getAttribute("data-view");
  if (current !== view) await page.getByRole("button", { name: view === "read" ? "Show readable text" : "Show desktop mirror", exact: true }).tap();
}
async function auditRecords() {
  return (await Promise.all((await readdir(scratch)).filter((f) => f.startsWith("wire-")).map(async (f) =>
    (await readFile(join(scratch, f), "utf8")).trim().split("\n").filter(Boolean).map((s) => JSON.parse(s))))).flat();
}
async function recordersStopped() {
  await eventually(async () => {
    try {
      const records = await auditRecords();
      const started = records.filter((r) => r.phase === "started");
      return started.every((r) => records.some((v) => v.phase === "stopped" && v.wrapperPid === r.wrapperPid) &&
        [r.wrapperPid, r.childPid].every((pid) => { try { process.kill(pid, 0); return false; } catch (e: any) { return e.code === "ESRCH"; } }));
    } catch { return false; }
  }, "Recorder or owned core connection did not exit", 7000);
}
async function recovered(page: any, expected: number[], oldWatch: string | undefined) {
  if (baseline) return;
  await eventually(async () => {
    const current = await inspect(page);
    return current?.observer && current.watchId !== oldWatch &&
      current.size.cols === expected[0] && current.size.rows === expected[1] &&
      current.rows[0]?.text.trimEnd() === "You: show the checks" &&
      current.rows[1]?.text.trimEnd() === "Terminal: checks are running" &&
      current.rows[2]?.text.trimEnd() === "Stable line stays in place" &&
      /^Spinner: [|/\\-] \d+$/.test(current.rows[3]?.text.trimEnd());
  }, "Fresh observer did not recover exact rows after desktop geometry changed");
  check(`browser recovered exact content at ${expected.join("x")}`, true);
}

try {
  beforeFocus = focus(desktop());
  assert((beforeFocus as unknown[]).every((value) => typeof value === "string" && value.length > 0), "Desktop focus baseline is incomplete");
  await core.connect(); await desktopCore.connect();
  before = (await core.call("terminal.list", { all: true })).terminals;
  await writeFile(join(scratch, "producer.py"), String.raw`import os,sys,time,json,fcntl,termios,struct,tty
root=sys.argv[1]
tty.setraw(0)
last=-1
mode='idle'
tick=0
def emit(s): os.write(1,s.encode())
def save(name,value):
 p=os.path.join(root,name)
 with open(p+'.tmp','w') as f: json.dump(value,f)
 os.replace(p+'.tmp',p)
while True:
 rows,cols,_,_=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\0'*8))
 save('size.json',[cols,rows])
 try:
  with open(os.path.join(root,'control.json')) as f: c=json.load(f)
 except Exception: c=None
 if c and c['id']!=last:
  last=c['id'];mode=c['mode']
  if mode=='spinner':
   emit('\x1bc\x1b[3J\x1b[H\x1b[48;2;36;82;125mYou: show the checks\x1b[0m\r\nTerminal: checks are running\r\nStable line stays in place\r\n')
  elif mode=='history':
   emit('\x1bc\x1b[3J\x1b[H')
   for n in range(1,3001): emit('LINE %04d numbered output\r\n'%n)
  save('ack.json',{'id':last})
 if mode=='spinner':
  emit('\x1b[4;1HSpinner: '+ '|/-\\'[tick%4] + ' %06d'%tick+'\x1b[K')
  tick+=1
 time.sleep(.04)
`);
  const made = await core.call("terminal.run", { argv: ["python3", join(scratch, "producer.py"), scratch], cwd: scratch, name,
    no_parent: true, no_notify: true, labels: { "herdr.space": spaceId, "herdr.tab": tabId } });
  terminalId = made.address;
  await layout((value) => {
    value.spaces ||= [];
    let space = value.spaces.find((s: any) => s.id === spaceId);
    if (!space) { space = { id: spaceId, tabs: [] }; value.spaces.push(space); }
    space.name = "Terminal display check";
    space.folder = scratch;
    space.tabs = [{ id: tabId, name: "Output", root: { id: `p${randomUUID().replaceAll("-", "")}`, type: "block", content: { terminal: terminalId } } }];
  });
  assert.deepEqual(focus(desktop()), beforeFocus, "Creation moved desktop focus");
  await command("spinner");
  const initial = await core.call("terminal.get", { terminal: terminalId });
  const headless = [initial.cols, initial.rows];
  await size("headless before phone", headless);

  // Transparent protocol recorder: log metadata only, never terminal bytes.
  await writeFile(join(scratch, "hc-audit"), `#!/usr/bin/env python3\nimport os,sys,json,struct,select,subprocess,signal\nreal=${JSON.stringify(realHc)}\nroot=${JSON.stringify(scratch)}\nbreak_observe=${process.env.DISPLAY_BREAK_OBSERVER === "1" ? "True" : "False"}\n` + String.raw`
child=subprocess.Popen([real]+sys.argv[1:],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,bufsize=0)
log=open(os.path.join(root,'wire-'+str(os.getpid())+'.jsonl'),'a',buffering=1)
buf=b''
mode=None
def record(v): log.write(json.dumps(v)+'\n')
record({'phase':'started','wrapperPid':os.getpid(),'childPid':child.pid})
def rpc(payload):
 try:
  v=json.loads(payload)
  method=v.get('method');params=v.get('params',{})
  if method=='terminal.attach' and params.get('observe') and break_observe and params.get('history')==0 and params.get('cols')==13:
   params.update(observe=False,cols=13,rows=7)
   payload=json.dumps(v).encode()
  record({'method':method,**{k:params[k] for k in ['terminal','observe','cols','rows','history','lines'] if k in params}})
 except Exception: pass
 return payload
def stop(*args): raise SystemExit(0)
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
try:
 while True:
  ready,_,_=select.select([0,child.stdout],[],[],1)
  if child.poll() is not None: break
  for source in ready:
   if source==0:
    data=os.read(0,65536)
    if not data: raise SystemExit(0)
    buf+=data
    if mode is None and b'\n' in buf:
     line,buf=buf.split(b'\n',1)
     mode='framed' if json.loads(line).get('params',{}).get('framed') else 'plain'
     child.stdin.write(line+b'\n')
    if mode=='plain':
     child.stdin.write(buf);buf=b''
    elif mode=='framed':
     while len(buf)>=9:
      channel,kind,length=struct.unpack('<IBI',buf[:9])
      if len(buf)<9+length: break
      payload=buf[9:9+length];buf=buf[9+length:]
      if channel==0: payload=rpc(payload)
      else: record({'channel':channel,'kind':kind,'length':length})
      child.stdin.write(struct.pack('<IBI',channel,kind,len(payload))+payload)
   else:
    data=os.read(child.stdout.fileno(),65536)
    if not data: raise SystemExit(0)
    os.write(1,data)
finally:
 child.terminate()
 try: child.wait(timeout=3)
 except subprocess.TimeoutExpired: child.kill();child.wait()
 record({'phase':'stopped','wrapperPid':os.getpid(),'childPid':child.pid})
 log.close()
`, { mode: 0o700 });
  process.env.HERDR_PHONE_HC = join(scratch, "hc-audit");
  const store = new Store(join(scratch, "device"));
  const code = await store.pairing();
  const paired = await store.exchange(code, "Display check");
  app = start({ port: 0, origin, store });
  vite = await createServer({ root: resolve("web"), configFile: false, server: { host: "127.0.0.1", port, strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${app.server.port}`, ws: true } } }, logLevel: "error" });
  await vite.listen();
  browser = await webkit.launch();
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: false,
    serviceWorkers: "block", recordVideo: { dir: directory, size: { width: 390, height: 844 } } });
  await context.addInitScript((token: string) => {
    if (location.protocol === "http:" || location.protocol === "https:")
      localStorage.setItem("herdr-phone.device", token);
  }, paired.token);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(e.message));
  await page.goto(`${origin}/#terminal=${encodeURIComponent(terminalId!)}`);
  if (!baseline) await page.getByRole("button", { name: "Terminal view", exact: true }).tap();
  await page.locator(".terminal-viewport").waitFor();
  await page.locator(".xterm-accessibility-tree").getByText("You: show the checks", { exact: true }).waitFor({ state: "attached", timeout: 15000 });
  await size("phone observer only", headless);
  await page.evaluate(() => document.fonts.ready);
  const cells = await inspect(page, true);
  if (!baseline) assert(cells, "Candidate inspection seam is unavailable");
  const highlighted = cells?.rows.find((r: any) => r.text.includes("You: show"));
  const plain = cells?.rows.find((r: any) => r.text.includes("Terminal: checks"));
  check("highlighted and plain buffer backgrounds differ", !!highlighted && !!plain && highlighted.cells[0].bg === 0x24527d && highlighted.cells[0].bg !== plain.cells[0].bg,
    { highlighted: highlighted?.cells[0], plain: plain?.cells[0] });
  await page.screenshot({ path: join(directory, `terminal-colours-${label}-webkit.png`) });
  await choose(page, "read");
  await page.locator(".terminal-read").getByText("Stable line stays in place", { exact: true }).waitFor();
  await page.evaluate(() => {
    const read = document.querySelector(".terminal-read")!;
    const first = read.firstElementChild;
    const probe = { replaced: 0, mutations: 0 };
    new MutationObserver((records) => { probe.mutations += records.length; if (first !== read.firstElementChild || !first?.isConnected) probe.replaced++; })
      .observe(read, { childList: true, subtree: true, characterData: true });
    (window as any).displayProbe = probe;
  });
  await page.waitForTimeout(5000);
  const mutations = await page.evaluate(() => (window as any).displayProbe);
  check("busy Read changes without full replacement for 5 seconds", mutations.mutations > 0 && mutations.replaced === 0, mutations);
  await page.screenshot({ path: join(directory, `terminal-busy-${label}-webkit.png`) });

  // Print before subscribing: the page must fetch retained history, not merely
  // keep the 3000 lines as they arrive on an already-open observer.
  await page.goto("about:blank");
  await command("history");
  for (const view of ["mirror", "read"] as const) {
    await page.goto(`${origin}/#terminal=${encodeURIComponent(terminalId!)}`);
    if (!baseline) await page.getByRole("button", { name: "Terminal view", exact: true }).tap();
    await page.locator(".terminal-viewport").waitFor();
    if (!baseline) await eventually(async () => {
      const snapshot = await inspect(page);
      return snapshot?.observer && snapshot.rows.some((r: any) => /^LINE 3000 /.test(r.text));
    }, "Initial retained-history replay did not arrive");
    await choose(page, view);
    const initialHistory = await inspect(page);
    if (!baseline) {
      assert.equal(initialHistory.history, 500, "Initial load must request 500 rows");
      assert(initialHistory.rows.filter((r: any) => /^LINE /.test(r.text)).length < 1000, "Initial proof bypassed pagination");
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const snapshot = await inspect(page);
      if (snapshot?.rows.some((r: any) => /^LINE 0001 /.test(r.text))) break;
      await scrollTop(page);
      await page.waitForTimeout(350);
      if (snapshot?.historyStopped) break;
    }
    const snapshot = await inspect(page);
    const text = snapshot?.rows.map((r: any) => r.text) ?? await page.locator(view === "read" ? ".read-line" : ".xterm-accessibility-tree div").allTextContents();
    const ids = text.map((s: string) => /^LINE (\d{4}) /.exec(s)?.[1]).filter(Boolean).map(Number);
    check(`${view} all 3000 numbered lines in order without gaps or duplicates`, ids.length === 3000 && ids.every((n: number, i: number) => n === i + 1),
      { count: ids.length, first: ids[0], last: ids.at(-1), history: snapshot?.history, stopped: snapshot?.historyStopped });
    await scrollTop(page);
    await page.screenshot({ path: join(directory, `terminal-history-${view}-${label}-webkit.png`) });
    if (view === "mirror") await page.goto("about:blank");
  }
  await command("spinner");
  const oldWatch = (await inspect(page))?.watchId;
  desktopChannel = (await desktopCore.call("terminal.attach", { terminal: terminalId, observe: false, cols: 100, rows: 30, history: 0 })).channel;
  await size("synthetic desktop joins", [100, 30]);
  await command("spinner");
  await page.waitForTimeout(1200);
  await size("observer with desktop", [100, 30]);
  await recovered(page, [100, 30], oldWatch);
  const desktopWatch = (await inspect(page))?.watchId;
  desktopCore.process!.stdin.write(frame(desktopChannel, 2, Buffer.alloc(0)));
  desktopChannel = undefined;
  await size("desktop leaves while observer remains", headless);
  await command("spinner");
  await recovered(page, headless, desktopWatch);
  const video = page.video();
  await context.close(); context = undefined;
  if (video) await video.saveAs(join(directory, `terminal-display-${label}-webkit.webm`));
  await size("phone disconnect", headless);
  if (!baseline) {
    const { Observer } = await import("../server/observer");
    let received = false, failed = false;
    sizingObserver = new Observer({ terminalId: terminalId!, history: 0, cols: 13, rows: 7 },
      async () => { received = true; }, () => { failed = true; });
    await eventually(async () => received && !failed, "Mismatched-size observer did not receive output");
    await size("13x7 observer request alone", headless);
    desktopChannel = (await desktopCore.call("terminal.attach", { terminal: terminalId, observe: false, cols: 100, rows: 30, history: 0 })).channel;
    await size("13x7 observer while desktop joins", [100, 30]);
    desktopCore.process!.stdin.write(frame(desktopChannel, 2, Buffer.alloc(0)));
    desktopChannel = undefined;
    await size("13x7 observer after desktop leaves", headless);
    sizingObserver.close(); sizingObserver = undefined;
    await size("13x7 observer disconnect", headless);
  }
  check("no browser errors", pageErrors.length === 0, pageErrors);
  app.stop(); app = undefined;
  await recordersStopped();
  const records = await auditRecords();
  const attaches = records.filter((r) => r.method === "terminal.attach");
  check("production attachments are observe-only", attaches.length > 0 && attaches.every((r) => r.observe === true && r.terminal === terminalId), attaches);
  const channelFrames = records.filter((r) => r.channel);
  check("production channel frames are CREDIT or CLOSE only", channelFrames.some((r) => r.kind === 1) && channelFrames.every((r) => [1, 2].includes(r.kind)));
  const reads = records.filter((r) => r.method === "terminal.read");
  check("all plain reads use history zero", reads.length > 0 && reads.every((r) => r.lines === 0));
  report.channelFrames = records.filter((r) => r.channel).map((r) => ({ kind: r.kind, length: r.length }));
  const after = (await core.call("terminal.list", { all: true })).terminals;
  for (const prior of before) {
    const next = after.find((t: any) => t.address === prior.address);
    if (next && prior.state === "live") assert.deepEqual([next.cols, next.rows], [prior.cols, prior.rows], "Existing terminal size changed");
  }
  assert.deepEqual(focus(desktop()), beforeFocus, "Desktop focus changed");
} finally {
  const errors: unknown[] = [];
  const attempt = async (fn: () => unknown) => { try { await fn(); } catch (e) { errors.push(e); } };
  try {
    await attempt(() => context?.close());
    await attempt(() => browser?.close());
    await attempt(() => vite?.close());
    await attempt(() => app?.stop());
    await attempt(() => sizingObserver?.close());
    await attempt(() => recordersStopped());
    await attempt(() => desktopCore.close());
    if (terminalId) {
      await attempt(async () => {
        const own = await core.call("terminal.get", { terminal: terminalId });
        assert(own.name === name && own.cwd === scratch, "Cleanup ownership mismatch");
        await attempt(() => core.call("terminal.kill", { terminal: terminalId }));
        await attempt(() => core.call("terminal.rm", { terminal: terminalId }));
      });
      await attempt(() => layout((value) => { value.spaces = (value.spaces || []).filter((s: any) => s.id !== spaceId); }));
      await attempt(async () => {
        assert(!(await core.call("terminal.list", { all: true })).terminals.some((t: any) => t.address === terminalId), "Test terminal remains");
        assert(!(await core.call("doc.get", { name: "herdr-app" })).value.spaces.some((s: any) => s.id === spaceId), "Test space remains");
        assert.deepEqual(focus(desktop()), beforeFocus, "Cleanup moved desktop focus");
      });
    }
  } finally {
    await attempt(() => core.close());
    if (originalHc === undefined) delete process.env.HERDR_PHONE_HC; else process.env.HERDR_PHONE_HC = originalHc;
    await attempt(() => rm(scratch, { recursive: true, force: true }));
  }
  report.cleaned = errors.length === 0;
  await writeFile(join(directory, "proof.json"), JSON.stringify(report, null, 2) + "\n");
  if (errors.length) throw new AggregateError(errors, "Display proof cleanup failed");
}
console.log(JSON.stringify(report, null, 2));
assert(report.checks.every((c: any) => c.passed), "Display proof gates failed; see proof.json");
