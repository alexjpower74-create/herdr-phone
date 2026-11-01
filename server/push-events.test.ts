import { test, expect } from "bun:test";
import { PushEvents, notification } from "./push-events";
const terminal = (address = "t1", state = "working", turn = 3) => ({
  address,
  status: { state },
  turn,
});
const snapshot = (seq: number, terminals = [terminal()]) => ({
  id: 2,
  result: { seq, terminals },
});
const event = (seq: number, type: string, data: any, id = "t1") => ({
  method: "event",
  params: { seq, type, terminal: id, data },
});
const status = (seq: number, state: string, id = "t1") =>
  event(seq, "status", { status: { state } }, id);
const turn = (seq: number, n: number, state: string, id = "t1") =>
  event(seq, "turn", { turn: n, state }, id);

test("ordered core status then explicit turn produce one notification per terminal/turn/kind", () => {
  const machine = new PushEvents();
  expect(machine.consume(snapshot(10))).toEqual([]);
  expect(machine.consume(status(11, "blocked"))).toEqual([]);
  expect(machine.consume(turn(12, 4, "blocked"))).toEqual([
    { terminal: "t1", turn: 4, kind: "blocked" },
  ]);
  for (const e of [
    turn(12, 4, "blocked"),
    status(11, "done"),
    status(13, "blocked"),
    status(14, "working"),
    status(15, "blocked"),
    turn(16, 4, "blocked"),
  ])
    expect(machine.consume(e)).toEqual([]);
  expect(machine.consume(status(17, "done"))).toEqual([
    { terminal: "t1", turn: 4, kind: "done" },
  ]);
  expect(machine.consume(turn(18, 4, "done"))).toEqual([]);
  expect(machine.consume(status(19, "working"))).toEqual([]);
  expect(machine.consume(status(20, "done"))).toEqual([]);
  expect(machine.consume(turn(21, 5, "done"))).toEqual([
    { terminal: "t1", turn: 5, kind: "done" },
  ]);
  expect(machine.consume(turn(22, 4, "blocked"))).toEqual([]);
});

test("initial missed reconnect and remote-created baselines are silent and keep dedupe", () => {
  const machine = new PushEvents();
  expect(
    machine.consume(
      snapshot(10, [
        terminal("t1", "blocked", 4),
        terminal("remote/t1", "done", 8),
      ]),
    ),
  ).toEqual([]);
  expect(machine.consume(status(11, "blocked"))).toEqual([]);
  expect(machine.consume(status(12, "done", "remote/t1"))).toEqual([]);
  machine.disconnect();
  expect(machine.consume(turn(13, 5, "done"))).toEqual([]);
  expect(
    machine.consume(
      snapshot(20, [
        terminal("t1", "working", 4),
        terminal("remote/t1", "working", 8),
      ]),
    ),
  ).toEqual([]);
  expect(machine.consume(status(21, "blocked"))).toEqual([]);
  expect(machine.consume(turn(22, 4, "blocked"))).toEqual([]);
  expect(machine.consume(status(23, "done", "remote/t1"))).toEqual([]);
  expect(machine.consume(turn(24, 9, "done", "remote/t1"))).toEqual([
    { terminal: "remote/t1", turn: 9, kind: "done" },
  ]);
  expect(
    machine.consume({
      method: "missed",
      params: { seq: 30, terminals: [terminal("t1", "done", 6)] },
    }),
  ).toEqual([]);
  expect(machine.consume(turn(29, 7, "blocked"))).toEqual([]);
  expect(machine.consume(status(31, "done"))).toEqual([]);
  expect(
    machine.consume(
      event(32, "created", terminal("remote/t2", "blocked", 7), "remote/t2"),
    ),
  ).toEqual([]);
  expect(machine.consume(status(33, "blocked", "remote/t2"))).toEqual([]);
});

test("retained state is one ledger per current terminal plus bounded absent tombstones", () => {
  const machine = new PushEvents();
  machine.consume(snapshot(0));
  for (let n = 1; n <= 1200; n++) {
    machine.consume(
      event(n * 2, "created", terminal(`t${n + 1}`, "blocked", 1), `t${n + 1}`),
    );
    machine.consume(event(n * 2 + 1, "removed", {}, `t${n + 1}`));
  }
  expect(machine.terminals.size).toBe(1025);
  expect(machine.terminals.has("t1")).toBe(true);
  expect(machine.consume(turn(3000, 4, "blocked"))).toHaveLength(1);
});

test("payload names come only from layout, are bounded and private contents never leak", () => {
  const n = { terminal: "remote/t1", turn: 4, kind: "blocked" as const };
  const s = {
    spaces: [
      {
        id: "space1",
        machineId: "remote",
        name: "Work\u001b\n",
        tabs: [
          {
            id: "tab1",
            name: "Work",
            terminals: [
              { id: "remote/t1", title: "SECRET SCREEN", status: "PRIVATE" },
            ],
          },
        ],
      },
    ],
  };
  const layouts = new Map([["remote", { spaces: s.spaces }]]);
  const normalized = {
    spaces: s.spaces.map((space) => ({
      ...space,
      id: `remote/${space.id}`,
      tabs: space.tabs.map((tab) => ({ ...tab, id: `remote/${tab.id}` })),
    })),
  };
  expect(notification(n, normalized, layouts)).toEqual({
    title: "Herdr",
    body: "Work needs you",
    tag: "remote/t1/4/blocked",
    url: "/#terminal=remote%2Ft1",
  });
  expect(notification(n, {}, layouts).body).toBe("A terminal needs you");
  s.spaces[0].name = "W".repeat(1000);
  s.spaces[0].tabs[0].name = "T".repeat(1000);
  expect(notification(n, normalized, layouts).body.length).toBeLessThanOrEqual(
    240,
  );
  expect(
    notification({ ...n, kind: "done" }, normalized, layouts).body,
  ).toEndWith(" finished");
});

test("EventFeed preserves ordered snapshot, live and missed payloads while invalidating clients", async () => {
  const { EventFeed } = await import("./core");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "event-feed-"));
  const path = join(dir, "feed");
  const messages = [
    snapshot(10),
    status(11, "blocked"),
    {
      method: "missed",
      params: { seq: 20, terminals: [terminal("remote/t1", "done", 8)] },
    },
  ];
  await writeFile(
    path,
    `#!/usr/bin/env bun\nlet buffer=""; process.stdin.on("data",chunk=>{ buffer+=chunk; let nl; while((nl=buffer.indexOf("\\n"))>=0){const m=JSON.parse(buffer.slice(0,nl));buffer=buffer.slice(nl+1);if(m.id===1)console.log(JSON.stringify({id:1,result:{generation:1}}));else if(m.id===2){const data=${JSON.stringify(messages)}.map(m=>JSON.stringify(m)+"\\n").join("");process.stdout.write(data.slice(0,13));setTimeout(()=>process.stdout.write(data.slice(13)),10);}}});`,
    { mode: 0o700 },
  );
  const old = process.env.HERDR_PHONE_HC;
  process.env.HERDR_PHONE_HC = path;
  let feed: InstanceType<typeof EventFeed> | undefined;
  let invalidations = 0;
  const received: any[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Feed timed out")), 2000);
      feed = new EventFeed(
        () => {
          invalidations++;
          if (invalidations === 3) {
            clearTimeout(timer);
            resolve();
          }
        },
        () => {},
        (m) => received.push(m),
      );
    });
    expect(received).toEqual(messages);
    expect(invalidations).toBe(3);
  } finally {
    feed?.close();
    if (old === undefined) delete process.env.HERDR_PHONE_HC;
    else process.env.HERDR_PHONE_HC = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test("address reuse with a new creation timestamp resets identity without replaying baselines", () => {
  const m = new PushEvents();
  m.consume(snapshot(10, [{ ...terminal("t1", "done", 99), created_ms: 100 }]));
  m.disconnect();
  m.consume(
    snapshot(0, [{ ...terminal("t1", "working", 0), created_ms: 200 }]),
  );
  expect(m.consume(status(1, "blocked"))).toEqual([]);
  expect(m.consume(turn(2, 1, "blocked"))).toEqual([
    { terminal: "t1", turn: 1, kind: "blocked" },
  ]);
});

test("normalized folder and generated tab display names are excluded from lock-screen payloads", async () => {
  const { Snapshot } = await import("./state");
  const layout = {
    spaces: [
      {
        id: "s1",
        folder: "/workspace/private-project",
        tabs: [{ id: "tab1", root: { content: { terminal: "t1" } } }],
      },
    ],
  };
  const state = new Snapshot({
    call: async (method) => {
      if (method === "terminal.list")
        return {
          terminals: [
            {
              ...terminal(),
              state: "live",
              cols: 80,
              rows: 24,
              cwd: "/workspace/private-project",
            },
          ],
        };
      if (method === "machine.list") return { machines: [] };
      if (method === "doc.get") return { value: layout };
      return {};
    },
  });
  state.programs = async () => [];
  state.colors = async () => ({});
  const normalized = await state.get();
  expect(normalized.spaces[0].name).toBe("private-project");
  expect(normalized.spaces[0].tabs[0].name).toBe("Tab 1");
  expect(
    notification(
      { terminal: "t1", turn: 4, kind: "blocked" },
      normalized,
      state.layouts,
    ).body,
  ).toBe("A terminal needs you");
});
