import { spawn } from "node:child_process";
import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, hash } from "./security";
import { frame, Frames, Core } from "./core";
import { start, validateText, coreKeys } from "./index";
import { Snapshot } from "./state";
const temp = () => mkdtemp(join(tmpdir(), "phone-test-"));
test("framed decoder handles every split, coalesced frames and bounded length", () => {
  const a = frame(0, 0, Buffer.from('{"id":1}')),
    b = frame(7, 0, Buffer.from("next"));
  for (let i = 0; i < a.length; i++) {
    const f = new Frames();
    expect(f.feed(a.subarray(0, i))).toHaveLength(0);
    expect(
      f.feed(Buffer.concat([a.subarray(i), b])).map((v) => v.body.toString()),
    ).toEqual(['{"id":1}', "next"]);
  }
  const bad = Buffer.alloc(9);
  bad.writeUInt32LE(9000000, 5);
  expect(() => new Frames().feed(bad)).toThrow();
});
test("pair codes expire, burn after five failures, are single use and consumed concurrently", async () => {
  const dir = await temp();
  let now = 1000;
  const s = new Store(dir, () => now);
  try {
    const code = await s.pairing();
    const result = await Promise.allSettled([
      s.exchange(code, "Phone"),
      new Store(dir, () => now).exchange(code, "Other"),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const ok: any = result.find((r) => r.status === "fulfilled");
    const token = ok.value.token;
    expect(await s.auth(token)).toMatchObject({ label: ok.value.device.label });
    expect(await readFile(join(dir, "state.json"), "utf8")).not.toContain(
      token,
    );
    expect((await stat(join(dir, "state.json"))).mode & 0o777).toBe(0o600);
    await s.revoke(ok.value.device.id);
    await expect(s.auth(token)).rejects.toThrow();
    const expire = await s.pairing();
    now += 600001;
    await expect(s.exchange(expire, "Phone")).rejects.toThrow();
    const burn = await s.pairing();
    for (let i = 0; i < 5; i++)
      await expect(s.exchange("AAAAAAAA", "Phone")).rejects.toThrow();
    await expect(s.exchange(burn, "Phone")).rejects.toThrow();
    const replace = await s.pairing();
    await s.pairing();
    await expect(s.exchange(replace, "Phone")).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("corruption fails closed, duplicate labels require explicit id, throttle persists", async () => {
  const dir = await temp();
  const s = new Store(dir);
  try {
    for (let n = 0; n < 2; n++) await s.exchange(await s.pairing(), "Same");
    await expect(s.revoke("Same")).rejects.toThrow();
    expect(await s.list()).toHaveLength(2);
    for (let n = 0; n < 20; n++)
      try {
        await s.exchange("BAD", "Phone");
      } catch {}
    await expect(s.exchange(await s.pairing(), "Phone")).rejects.toMatchObject({
      status: 429,
    });
    await writeFile(join(dir, "state.json"), "{}");
    await expect(s.list()).rejects.toMatchObject({ status: 503 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
class Mock {
  calls: any[] = [];
  activeKeys = 0;
  maxActiveKeys = 0;
  completedKeys = 0;
  async call(method: string, p: any = {}) {
    this.calls.push({ method, p });
    if (method === "hello") return { generation: 1 };
    if (method === "machine.list")
      return {
        machines: [
          { name: "remote", state: "connected" },
          { name: "scratch", temporary: true, state: "connected" },
        ],
      };
    if (method === "terminal.list")
      return {
        terminals: [
          {
            address: "remote/t1",
            state: "live",
            cols: 80,
            rows: 24,
            labels: {},
            status: { state: "blocked" },
          },
        ],
      };
    if (method === "doc.get")
      return {
        value: {
          spaces: [
            {
              id: "s1",
              name: "Work",
              folder: "/work",
              tabs: [
                {
                  id: "tab",
                  name: "Tab",
                  root: { children: [{ content: { terminal: "t1" } }] },
                },
              ],
            },
          ],
        },
      };
    if (method === "terminal.get")
      return { address: p.terminal, state: "live", cols: 80, rows: 24 };
    if (method === "terminal.read") return { text: "screen", complete: true };
    if (method === "terminal.keys") {
      this.activeKeys++;
      this.maxActiveKeys = Math.max(this.maxActiveKeys, this.activeKeys);
      await Bun.sleep(15);
      this.activeKeys--;
      this.completedKeys++;
      return { turn: 1 };
    }
  }
}
test("normalization preserves qualified ids and cached offline spaces", async () => {
  const c = new Mock();
  const s = new Snapshot(c);
  let snap = await s.get();
  expect(snap.machines.map((m: any) => m.id)).toEqual(["local", "remote"]);
  expect(snap.spaces[1].tabs[0].terminals[0].id).toBe("remote/t1");
  c.call = async (m, p) =>
    m === "machine.list"
      ? { machines: [{ name: "remote", state: "unreachable" }] }
      : Mock.prototype.call.call(c, m, p);
  snap = await s.get(true);
  expect(snap.spaces[1].name).toBe("Work");
  expect(snap.machines[1].online).toBe(false);
  expect(snap.spaces[1].tabs[0].terminals[0].id).toBe("remote/t1");
});
test("local machine display name is configurable with a neutral fallback", async () => {
  const previous = process.env.HERDR_PHONE_LOCAL_NAME;
  try {
    process.env.HERDR_PHONE_LOCAL_NAME = " Workstation ";
    const configured = await new Snapshot(new Mock()).get();
    expect(configured.machines[0]).toEqual({
      id: "local", name: "Workstation", online: true,
    });
    delete process.env.HERDR_PHONE_LOCAL_NAME;
    expect((await new Snapshot(new Mock()).get()).machines[0].name).toBe("This computer");
    process.env.HERDR_PHONE_LOCAL_NAME = "   ";
    expect((await new Snapshot(new Mock()).get()).machines[0].name).toBe("This computer");
  } finally {
    if (previous === undefined) delete process.env.HERDR_PHONE_LOCAL_NAME;
    else process.env.HERDR_PHONE_LOCAL_NAME = previous;
  }
});
test("remote machine display names are capitalized without changing routing ids", async () => {
  const core = new Mock();
  const snapshot = await new Snapshot(core).get();
  expect(snapshot.machines[1]).toEqual({ id: "remote", name: "Remote", online: true });
  expect(snapshot.spaces[1].machineId).toBe("remote");
  expect(snapshot.spaces[1].tabs[0].terminals[0].id).toBe("remote/t1");
  expect(core.calls.some(({ method, p }) => method === "doc.get" && p.on === "remote")).toBe(true);
});
test("HTTP rejects absent/revoked tokens, wrong origins and URL credentials; input ack order and history zero", async () => {
  const dir = await temp(),
    store = new Store(dir),
    core = new Mock();
  const paired = await store.exchange(await store.pairing(), "Phone");
  const app = start({ port: 0, origin: "http://localhost", store, core });
  const base = `http://127.0.0.1:${app.server.port}`;
  const headers = {
    Authorization: `Bearer ${paired.token}`,
    "Content-Type": "application/json",
  };
  try {
    expect((await fetch(base + "/api/state")).status).toBe(401);
    expect((await fetch(base + "/api/state", { headers })).status).toBe(200);
    expect(
      (
        await fetch(base + "/api/state", {
          headers: { ...headers, Origin: "https://wrong.invalid" },
        })
      ).status,
    ).toBe(401);
    expect(
      (await fetch(base + "/api/state?token=" + paired.token, { headers }))
        .status,
    ).toBe(400);
    const screen = await fetch(base + "/api/terminals/remote%2Ft1/screen", {
      headers,
    });
    expect(screen.status).toBe(200);
    expect(core.calls.find((c) => c.method === "terminal.read").p).toEqual({
      terminal: "remote/t1",
      lines: 0,
    });
    await Promise.all(
      ["A", "B"].map((text) =>
        fetch(base + "/api/terminals/remote%2Ft1/keys", {
          method: "POST",
          headers,
          body: JSON.stringify({ keys: [text] }),
        }),
      ),
    );
    expect(core.maxActiveKeys).toBe(1);
    expect(core.completedKeys).toBe(2);
    expect(
      core.calls
        .filter((c) => c.method === "terminal.keys")
        .map((c) => c.p.keys),
    ).toEqual([["shift+a"], ["shift+b"]]);
    expect(
      (await fetch(base + "/api/device", { method: "DELETE", headers })).status,
    ).toBe(204);
    expect((await fetch(base + "/api/state", { headers })).status).toBe(401);
  } finally {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("literal text preserves punctuation and Unicode and rejects controls", () => {
  expect(validateText("A!🙂\n\t")).toBe("A!🙂\n\t");
  for (const text of ["", "\x01", "\ud800", "x".repeat(4097)])
    expect(() => validateText(text)).toThrow();
});
test("health honestly reports disconnected core", async () => {
  const app = start({
    port: 0,
    origin: "http://localhost",
    core: {
      call: async () => {
        throw Error("secret process detail");
      },
    },
  });
  try {
    const r = await fetch(`http://127.0.0.1:${app.server.port}/api/health`);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({
      ok: false,
      version: "1",
      core: "disconnected",
    });
  } finally {
    app.stop();
  }
});
test("WebSocket validates origin and credentials before upgrade; initial state, remote watch and CLI revocation", async () => {
  const dir = await temp(),
    store = new Store(dir),
    core = new Mock();
  const paired = await store.exchange(await store.pairing(), "Phone");
  const app = start({ port: 0, origin: "http://localhost", store, core });
  const base = `http://127.0.0.1:${app.server.port}`;
  const upgrade = {
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": Buffer.alloc(16).toString("base64"),
  };
  try {
    expect(
      (
        await fetch(base + "/api/ws", {
          headers: {
            ...upgrade,
            Origin: "http://localhost",
            "Sec-WebSocket-Protocol": "herdr-phone.v1",
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(base + "/api/ws", {
          headers: {
            ...upgrade,
            Origin: "https://wrong.invalid",
            "Sec-WebSocket-Protocol": `herdr-phone.v1, auth.${paired.token}`,
          },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(base + "/api/ws", {
          headers: {
            ...upgrade,
            "Sec-WebSocket-Protocol": `herdr-phone.v1, auth.${paired.token}`,
          },
        })
      ).status,
    ).toBe(401);
    const ws = new WebSocket(base.replace("http:", "ws:") + "/api/ws", {
      protocols: ["herdr-phone.v1", `auth.${paired.token}`],
      headers: { Origin: "http://localhost" },
    });
    const messages: any[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(Error("WS rejected"));
    });
    expect(ws.protocol).toBe("herdr-phone.v1");
    const wait = async (fn: () => boolean) => {
      for (let n = 0; n < 150; n++) {
        if (fn()) return;
        await Bun.sleep(20);
      }
      throw Error("Expected socket message");
    };
    await wait(() => messages.some((m) => m.type === "state"));
    ws.send(JSON.stringify({ type: "watch", terminalId: "remote/t1" }));
    await wait(() =>
      messages.some(
        (m) =>
          m.type === "screen" &&
          m.terminalId === "remote/t1" &&
          m.text === "screen",
      ),
    );
    const closed = new Promise<number>((resolve) => {
      ws.onclose = (e) => resolve(e.code);
    });
    await new Store(dir).revoke(paired.device.id);
    expect(await closed).toBe(4001);
  } finally {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("programs expose runnable entries only and repository metadata is real and cached", async () => {
  const dir = await temp(),
    file = join(dir, "programs.json");
  const before = process.env.HERDR_PHONE_PROGRAMS;
  await writeFile(
    file,
    JSON.stringify({
      programs: {
        shell: { name: "Shell", run: ["sh"] },
        missing: { name: "Missing" },
        empty: { name: "Empty", run: [] },
      },
    }),
  );
  process.env.HERDR_PHONE_PROGRAMS = file;
  try {
    const c = new Mock();
    const original = c.call.bind(c);
    let scans = 0;
    c.call = async (m, p) => {
      if (m === "machine.exec") {
        scans++;
        return {
          code: 0,
          stdout: Buffer.from("/work/project\nfeature\n").toString("base64"),
        };
      }
      return original(m, p);
    };
    const s = new Snapshot(c),
      snap = await s.get();
    expect(snap.programs).toEqual([{ id: "shell", name: "Shell", machineId: "local" }]);
    expect(snap.spaces[0]).toMatchObject({
      repo: "project",
      branch: "feature",
    });
    await s.get(true);
    expect(scans).toBe(2);
  } finally {
    if (before === undefined) delete process.env.HERDR_PHONE_PROGRAMS;
    else process.env.HERDR_PHONE_PROGRAMS = before;
    await rm(dir, { recursive: true, force: true });
  }
});
test("RPC disconnect rejects pending input without retry", async () => {
  const dir = await temp(),
    script = join(dir, "fake-core");
  const before = process.env.HERDR_PHONE_HC;
  await writeFile(
    script,
    `#!/usr/bin/env bun\nprocess.stdin.once('data',()=>{process.stdout.write(JSON.stringify({id:0,result:{framed:true,generation:1}})+'\\n');process.stdin.once('data',()=>process.exit(0));});\n`,
    { mode: 0o700 },
  );
  process.env.HERDR_PHONE_HC = script;
  const c = new Core();
  try {
    await expect(
      c.call("terminal.keys", { terminal: "t1", keys: ["a"] }),
    ).rejects.toThrow("Core disconnected");
    expect(c.pending.size).toBe(0);
  } finally {
    c.close();
    if (before === undefined) delete process.env.HERDR_PHONE_HC;
    else process.env.HERDR_PHONE_HC = before;
    await rm(dir, { recursive: true, force: true });
  }
});

test("null and array JSON bodies are rejected with 400", async () => {
  const dir = await temp(),
    store = new Store(dir);
  const paired = await store.exchange(await store.pairing(), "Phone");
  const app = start({
    port: 0,
    origin: "http://localhost",
    store,
    core: new Mock(),
  });
  try {
    for (const path of ["/api/pair", "/api/terminals/t1/keys"])
      for (const value of [null, []]) {
        const r = await fetch(`http://127.0.0.1:${app.server.port}` + path, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${paired.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(value),
        });
        expect(r.status).toBe(400);
      }
  } finally {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("atomic auth/list reads never rewrite state and corrupt state fails closed", async () => {
  const dir = await temp(),
    s = new Store(dir);
  try {
    const p = await s.exchange(await s.pairing(), "Phone");
    const path = join(dir, "state.json"),
      before = await stat(path);
    await s.auth(p.token);
    await s.list();
    const after = await stat(path);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    await writeFile(path, "null");
    await expect(s.auth(p.token)).rejects.toMatchObject({ status: 503 });
    await expect(s.list()).rejects.toMatchObject({ status: 503 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("kernel lock releases when owner crashes, files stay private and contention is bounded", async () => {
  const dir = await temp(),
    script = join(dir, "holder.ts");
  await writeFile(
    script,
    `import {Store} from ${JSON.stringify(import.meta.dir + "/security.ts")}; await new Store(process.argv[2]).transact(async()=>{console.log('locked');await Bun.sleep(60000);});`,
  );
  const child = spawn(process.execPath, [script, dir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "state.lock"))).mode & 0o777).toBe(0o600);
    const begin = Date.now();
    await expect(new Store(dir).pairing()).rejects.toMatchObject({
      code: "state_locked",
    });
    expect(Date.now() - begin).toBeLessThan(3000);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect((await new Store(dir).pairing()).length).toBe(8);
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}, 10000);
test("old connection teardown cannot reject a new generation and closed stdin is handled", async () => {
  const dir = await temp(),
    script = join(dir, "fake-core"),
    before = process.env.HERDR_PHONE_HC;
  await writeFile(
    script,
    `#!/usr/bin/env bun
let first=true;process.stdin.on('data',data=>{if(first){first=false;process.stdout.write(JSON.stringify({id:0,result:{framed:true,generation:1}})+'\\n');}else{const id=JSON.parse(data.subarray(9).toString()).id;setTimeout(()=>{const b=Buffer.from(JSON.stringify({id,result:{ok:true}}));const h=Buffer.alloc(9);h.writeUInt32LE(b.length,5);process.stdout.write(Buffer.concat([h,b]));},30);}});
`,
    { mode: 0o700 },
  );
  process.env.HERDR_PHONE_HC = script;
  const c = new Core();
  try {
    await c.connect();
    const old = c.process!;
    old.emit("exit", 0, null);
    await c.connect();
    const pending = c.call("hello");
    old.emit("exit", 0, null);
    old.stdin.emit(
      "error",
      Object.assign(new Error("pipe"), { code: "EPIPE" }),
    );
    expect(await pending).toEqual({ ok: true });
    expect(c.connected).toBe(true);
  } finally {
    c.close();
    if (before === undefined) delete process.env.HERDR_PHONE_HC;
    else process.env.HERDR_PHONE_HC = before;
    await rm(dir, { recursive: true, force: true });
  }
});

test("verified ASCII aliases preserve case and unsupported text is rejected before input", async () => {
  expect(coreKeys(["a", "B"])).toEqual(["a", "shift+b"]);
  expect(() => coreKeys(["a", "🙂"])).toThrow();
  for (const c of Array.from('!"#$%&()*+:<>?@^_{|}~'))
    expect(() => coreKeys([c])).toThrow();
  const dir = await temp(),
    store = new Store(dir),
    core = new Mock();
  const p = await store.exchange(await store.pairing(), "Phone");
  const app = start({ port: 0, origin: "http://localhost", core, store });
  try {
    const r = await fetch(
      `http://127.0.0.1:${app.server.port}/api/terminals/t1/keys`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${p.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: "start🙂" }),
      },
    );
    expect(r.status).toBe(400);
    expect(core.calls.filter((c) => c.method === "terminal.keys")).toHaveLength(
      0,
    );
  } finally {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
