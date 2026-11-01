import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "./index";
import { Store } from "./security";
import { createSpace } from "./spaces";

async function harness(action: (context: any) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "bridge-action-"));
  const store = new Store(dir);
  const device = await store.exchange(await store.pairing(), "Test");
  let blocked = true;
  let text = "Current dialog";
  const calls: any[] = [];
  const core = {
    async call(method: string, params: any) {
      calls.push({ method, params });
      if (method === "terminal.get")
        return {
          address: params.terminal,
          state: "live",
          status: { state: blocked ? "blocked" : "idle" },
          turn: 1,
          cols: 80,
          rows: 24,
        };
      if (method === "terminal.read") return { text, complete: true };
      if (method === "terminal.send" && blocked && !params.force)
        throw { kind: "blocked" };
      return {};
    },
  };
  const app = start({ port: 0, core, store });
  const request = (suffix: string, body?: any) =>
    fetch(`http://127.0.0.1:${app.server.port}/api/terminals/t1/${suffix}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${device.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    await action({
      request,
      calls,
      change: (next: string, state = true) => {
        text = next;
        blocked = state;
      },
    });
  } finally {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
}
test("ordinary sends never force; deliberate force binds current blocked screen", async () => {
  await harness(async ({ request, calls, change }: any) => {
    expect((await request("input", { text: "old" })).status).toBe(404);
    const blocked = await request("send", { text: "Hello!🙂" });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("terminal_blocked");
    expect(calls.at(-1).params).toMatchObject({
      force: false,
      text: "Hello!🙂",
    });
    const screen = await (await request("screen")).json();
    expect(
      (
        await request("send", {
          text: "Hello!🙂",
          force: true,
          screenId: screen.screenId,
        })
      ).status,
    ).toBe(200);
    const count = calls.filter((c: any) => c.method === "terminal.send").length;
    change("Replacement dialog");
    expect(
      (
        await request("send", {
          text: "No",
          force: true,
          screenId: screen.screenId,
        })
      ).status,
    ).toBe(409);
    const next = await (await request("screen")).json();
    change("Replacement dialog", false);
    expect(
      (
        await request("send", {
          text: "No",
          force: true,
          screenId: next.screenId,
        })
      ).status,
    ).toBe(409);
    expect(calls.filter((c: any) => c.method === "terminal.send")).toHaveLength(
      count,
    );
    change("Ready", false);
    expect((await request("send", { text: "Literal!🙂\n\t" })).status).toBe(
      200,
    );
    expect(calls.at(-1).params.text).toBe("Literal!🙂\n\t");
  });
});
test("invalid literal text and named keys fail before core dispatch", async () => {
  await harness(async ({ request, calls }: any) => {
    for (const text of ["", "\0", "\u0085", "\ud800", "x".repeat(4097)])
      expect((await request("send", { text })).status).toBe(
        text.length > 4096 ? 413 : 400,
      );
    for (const keys of [["up", "!"], ["🙂"], ["space"], []])
      expect((await request("keys", { keys })).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(
      (
        await request("keys", {
          keys: ["shift+tab", "esc", "up", "down", "enter", "ctrl+c", "A", "2"],
        })
      ).status,
    ).toBe(200);
    expect(calls[0].params.keys).toEqual([
      "shift+tab",
      "esc",
      "up",
      "down",
      "enter",
      "ctrl+c",
      "shift+a",
      "2",
    ]);
  });
});
test("space creation retries conflicts, preserves fields/focus and rolls back only its terminal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "space-action-"));
  const path = join(dir, "programs.json");
  await writeFile(
    path,
    JSON.stringify({
      programs: { shell: { name: "Shell", run: ["/bin/cat"] } },
    }),
  );
  const old = process.env.HERDR_PHONE_PROGRAMS;
  process.env.HERDR_PHONE_PROGRAMS = path;
  let conflict = true;
  let fail = false;
  const calls: any[] = [];
  const original = {
    focus: "existing",
    custom: { preserved: true },
    spaces: [{ id: "existing", name: "Original", tabs: [] }],
  };
  let saved: any;
  const core = {
    async call(method: string, params: any) {
      calls.push({ method, params });
      if (method === "machine.list")
        return { machines: [{ name: "remote", state: "connected" }] };
      if (method === "file.read") return { text: await Bun.file(path).text() };
      if (method === "machine.exec")
        return { code: 0, stdout: Buffer.from("/work\n").toString("base64") };
      if (method === "terminal.run")
        return { address: params.on ? "remote/t9" : "t9" };
      if (method === "doc.get")
        return { value: original, version: conflict ? 1 : 2 };
      if (method === "doc.set") {
        if (fail) throw { kind: "unavailable" };
        if (conflict) {
          conflict = false;
          throw { kind: "version_conflict" };
        }
        saved = params.value;
      }
      return {};
    },
  };
  try {
    for (const machineId of ["local", "remote"]) {
      conflict = true;
      const result = await createSpace(core, {
        machineId,
        programId: "shell",
        name: "New",
        cwd: "/work",
      });
      expect(result.terminalId).toBe(
        machineId === "local" ? "t9" : "remote/t9",
      );
      expect(saved.focus).toBe("existing");
      expect(saved.custom).toEqual(original.custom);
      expect(saved.spaces[0]).toEqual(original.spaces[0]);
      expect(saved.spaces[1].name).toBe("New");
      expect(original.spaces).toHaveLength(1);
    }
    fail = true;
    await expect(
      createSpace(core, {
        machineId: "remote",
        programId: "shell",
        name: "Fail",
        cwd: "/work",
      }),
    ).rejects.toBeDefined();
    expect(
      calls
        .filter(
          (c) => c.method === "terminal.kill" || c.method === "terminal.rm",
        )
        .map((c) => c.params.terminal),
    ).toEqual(["remote/t9", "remote/t9"]);
    const runs = calls.filter((c) => c.method === "terminal.run").length;
    await expect(
      createSpace(core, {
        machineId: "local",
        programId: "arbitrary",
        name: "Bad",
        cwd: "/work",
      }),
    ).rejects.toBeDefined();
    expect(calls.filter((c) => c.method === "terminal.run")).toHaveLength(runs);
  } finally {
    if (old === undefined) delete process.env.HERDR_PHONE_PROGRAMS;
    else process.env.HERDR_PHONE_PROGRAMS = old;
    await rm(dir, { recursive: true, force: true });
  }
});
test("metadata follows live foreground cwd and shared qualified color names", async () => {
  const { Snapshot } = await import("./state");
  const dir = await mkdtemp(join(tmpdir(), "space-metadata-"));
  const file = join(dir, "shared.json");
  await writeFile(
    file,
    JSON.stringify({
      space: { colors: { s1: "ansi6", "remote/s1": "ansi3" } },
    }),
  );
  const old = process.env.HERDR_PHONE_SHARED;
  process.env.HERDR_PHONE_SHARED = file;
  const calls: any[] = [];
  const core = {
    async call(method: string, params: any = {}) {
      calls.push({ method, params });
      if (method === "terminal.list")
        return {
          terminals: ["t1", "remote/t1"].map((address) => ({
            address,
            state: "live",
            cwd: "/old",
            foreground: { cwd: "/worktrees/feature" },
          })),
        };
      if (method === "machine.list")
        return { machines: [{ name: "remote", state: "connected" }] };
      if (method === "doc.get")
        return {
          value: {
            spaces: [
              {
                id: "s1",
                folder: "/fallback",
                tabs: [{ id: "tab", root: { content: { terminal: "t1" } } }],
              },
            ],
          },
        };
      if (method === "machine.exec")
        return {
          code: 0,
          stdout: Buffer.from("/repos/parent/.git\nfeature\n").toString(
            "base64",
          ),
        };
      throw Error("Missing config");
    },
  };
  try {
    const snapshot = new Snapshot(core);
    const state = await snapshot.get();
    expect(
      state.spaces.map((s: any) => [s.cwd, s.repo, s.branch, s.color]),
    ).toEqual([
      ["/worktrees/feature", "parent", "feature", "#22a99a"],
      ["/worktrees/feature", "parent", "feature", "#e3814f"],
    ]);
    expect(
      calls
        .filter((c) => c.method === "machine.exec")
        .every(
          (c) =>
            c.params.cwd === "/worktrees/feature" &&
            c.params.argv.includes("--git-common-dir"),
        ),
    ).toBe(true);
    await snapshot.get(true);
    expect(calls.filter((c) => c.method === "machine.exec")).toHaveLength(2);
  } finally {
    if (old === undefined) delete process.env.HERDR_PHONE_SHARED;
    else process.env.HERDR_PHONE_SHARED = old;
    await rm(dir, { recursive: true, force: true });
  }
});
test("prompt actions reread inside queue and reject stale or client-invented choices", async () => {
  const approval = await Bun.file(
    new URL("fixtures/approval-a.txt", import.meta.url),
  ).text();
  await harness(async ({ request, calls, change }: any) => {
    change(approval);
    const screen = await (await request("screen")).json();
    expect(screen.prompt.kind).toBe("approval");
    const action = {
      promptId: screen.prompt.id,
      optionId: screen.prompt.options[1].id,
    };
    expect((await request("prompt", action)).status).toBe(200);
    expect(calls.at(-1).params.keys).toEqual(["down", "enter"]);
    const count = calls.filter((c: any) => c.method === "terminal.keys").length;
    expect(
      (
        await request("prompt", {
          ...action,
          optionId: "invented",
          keys: ["enter"],
        })
      ).status,
    ).toBe(409);
    change("Dismissed");
    expect((await request("prompt", action)).status).toBe(409);
    expect(calls.filter((c: any) => c.method === "terminal.keys")).toHaveLength(
      count,
    );
  });
});
