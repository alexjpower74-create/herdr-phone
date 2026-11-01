import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
const fixture = {
  version: 1,
  revision: 1,
  machines: [
    { id: "local", name: "This computer", online: true },
    { id: "remote", name: "remote", online: true },
  ],
  spaces: [
    {
      id: "work",
      machineId: "local",
      name: "Workbench",
      cwd: "/workspace/sample",
      repo: "sample",
      branch: "main",
      color: "#199f91",
      tabs: [
        {
          id: "one",
          name: "Build",
          terminals: [
            {
              id: "t1",
              title: "Build",
              state: "live",
              status: "blocked",
              cols: 100,
              rows: 30,
            },
          ],
        },
        {
          id: "two",
          name: "Check",
          terminals: [
            {
              id: "t2",
              title: "Check",
              state: "live",
              status: "working",
              cols: 80,
              rows: 24,
            },
          ],
        },
      ],
    },
    {
      id: "remote/work",
      machineId: "remote",
      name: "Remote work",
      cwd: "",
      repo: null,
      branch: null,
      color: "#5685df",
      tabs: [
        {
          id: "remote/one",
          name: "Shell",
          terminals: [
            {
              id: "remote/t3",
              title: "Shell",
              state: "live",
              status: "idle",
              cols: 120,
              rows: 32,
            },
          ],
        },
      ],
    },
  ],
  programs: [
    { id: "shell", name: "Shell", machineId: "local" },
    { id: "shell", name: "Remote shell", machineId: "remote" },
  ],
};
async function capture(page: Page, name: string) {
  if (process.env.WEB_CAPTURE_DIR) {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: `${process.env.WEB_CAPTURE_DIR}/${name}-${test.info().project.name}.png`,
    });
  }
}
const suppliedPrompt = {
  id: "dialog-1",
  kind: "approval",
  options: [
    { id: "yes", label: "Yes", keys: ["1", "enter"] },
    { id: "no", label: "No", keys: ["2", "enter"] },
  ],
};
const prompt =
  "Allow this operation?\n› 1. Yes\n  2. No\nPress Enter to confirm";
type Call = { path: string; body: any; auth: string | undefined };
async function setup(page: Page, paired = true, path = "/") {
  const calls: Call[] = [];
  const sockets: WebSocketRoute[] = [];
  let typed = "",
    menu = false,
    selection = 0;
  await page.addInitScript((p) => {
    if (p) localStorage.setItem("herdr-phone.device", "test-device-token");
  }, paired);
  await page.routeWebSocket("**/api/ws", (ws) => {
    sockets.push(ws);
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === "watch")
        ws.send(
          JSON.stringify({
            type: "screen",
            terminalId: msg.terminalId,
            cols: 100,
            rows: 30,
            text: msg.terminalId === "t1" ? prompt : "Ready for input",
            screenId: "screen-1",
            prompt: msg.terminalId === "t1" ? suppliedPrompt : null,
          }),
        );
    });
    ws.send(JSON.stringify({ type: "state", state: fixture }));
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let body;
    try {
      body = request.postDataJSON();
    } catch {}
    calls.push({ path, body, auth: request.headers()["authorization"] });
    if (path === "/api/pair")
      return route.fulfill({
        status: 201,
        json: { token: "test-device-token" },
      });
    if (path === "/api/state") return route.fulfill({ json: fixture });
    if (path.endsWith("/screen")) {
      const id = decodeURIComponent(path.split("/")[3]);
      const terminal = fixture.spaces
        .flatMap((s) => s.tabs.flatMap((t) => t.terminals))
        .find((t) => t.id === id);
      return route.fulfill({
        json: {
          terminal,
          text: id === "t1" ? prompt : "Ready for input",
          complete: true,
          screenId: "screen-1",
          prompt: id === "t1" ? suppliedPrompt : null,
        },
      });
    }
    if (path === "/api/device") return route.fulfill({ status: 204 });
    if (path === "/api/terminals/t1/send") typed = body.text;
    if (
      path === "/api/terminals/t1/keys" ||
      path === "/api/terminals/t1/send"
    ) {
      let screen: string | undefined;
      if (menu && body.keys?.includes("down")) {
        selection = 1;
        screen = "Select model\n  Balanced\n› Quick\nUse ↑/↓ and Enter";
      } else if (menu && body.keys?.includes("enter")) {
        menu = false;
        screen = `Model: ${selection ? "Quick" : "Balanced"}`;
      } else if (
        ["/model", "/effort", "/mcp"].includes(typed) &&
        path.endsWith("/send")
      ) {
        menu = true;
        screen = "Select model\n› Balanced\n  Quick\nUse ↑/↓ and Enter";
      }
      if (screen)
        for (const socket of sockets)
          socket.send(
            JSON.stringify({
              type: "screen",
              terminalId: "t1",
              cols: 100,
              rows: 30,
              text: screen,
              screenId: "menu-screen",
              prompt: null,
            }),
          );
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(path);
  return { calls, sockets };
}
async function open(page: Page) {
  await page.getByRole("button", { name: "W Workbench sample · main" }).tap();
  await expect(
    page.getByRole("button", { name: "Yes", exact: true }),
  ).toBeVisible();
}
test("pairing, ordered groups, no overflow and usable hit targets", async ({
  page,
}) => {
  const { calls } = await setup(page, false);
  await capture(page, "pairing");
  await page.getByLabel("Pairing code").fill("ABCDEFGH");
  await page.getByRole("button", { name: "Connect", exact: true }).tap();
  await expect(page.getByRole("heading", { name: "Spaces" })).toBeVisible();
  await expect(page.getByText("This computer", { exact: true })).toBeVisible();
  await expect(page.getByText("remote", { exact: true })).toBeVisible();
  await capture(page, "home");
  expect(calls.find((c) => c.path === "/api/pair")?.body).toEqual({
    code: "ABCDEFGH",
    label: "My phone",
  });
  expect(calls.find((c) => c.path === "/api/state")?.auth).toBe(
    "Bearer test-device-token",
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= 390),
  ).toBe(true);
  const row = page.getByRole("button", { name: "W Workbench sample · main" });
  expect(
    await row.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [
        r.height,
        ...[4, r.height / 2, r.height - 4].map((y) => {
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + y);
          return hit === el || el.contains(hit);
        }),
      ];
    }),
  ).toEqual([52, true, true, true]);
});
test("approval and slash menu controls send exact acknowledged keys", async ({
  page,
}) => {
  const { calls } = await setup(page);
  let taps = 0;
  await page.exposeFunction("recordTap", () => taps++);
  await page.evaluate(() =>
    document.addEventListener("pointerdown", () => (window as any).recordTap()),
  );
  await open(page);
  await capture(page, "terminal");
  await page.getByRole("button", { name: "Yes", exact: true }).tap();
  await expect
    .poll(() =>
      calls.filter((c) => c.path.endsWith("/prompt")).map((c) => c.body),
    )
    .toContainEqual({ promptId: "dialog-1", optionId: "yes" });
  await expect(
    page.getByRole("button", { name: "Yes", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Type to terminal").tap();
  await page.getByLabel("Type to terminal").fill("/model");
  await page.getByRole("button", { name: "enter", exact: true }).tap();
  await page.getByRole("button", { name: "down", exact: true }).tap();
  await page.getByRole("button", { name: "enter", exact: true }).tap();
  await expect
    .poll(() =>
      calls
        .filter(
          (c) =>
            c.path.endsWith("/send") ||
            c.path.endsWith("/keys") ||
            c.path.endsWith("/prompt"),
        )
        .map((c) => c.body),
    )
    .toEqual([
      { promptId: "dialog-1", optionId: "yes" },
      { text: "/model" },
      { keys: ["down"] },
      { keys: ["enter"] },
    ]);
  await expect(page.locator(".xterm-accessibility-tree")).toContainText(
    "Model: Quick",
  );
  await expect.poll(() => taps).toBe(6);
  expect(taps).toBeLessThanOrEqual(6);
  test.info().annotations.push({
    type: "tap count",
    description: `${taps} taps to open, approve and choose a model in the mock flow`,
  });
  expect(
    calls.some((c) => c.path.includes("resize") || c.path.includes("attach")),
  ).toBe(false);
});
test("remote terminal stays qualified and old-tab screens are ignored", async ({
  page,
}) => {
  const { calls, sockets } = await setup(page);
  await page.getByRole("button", { name: "R Remote work" }).tap();
  await page.getByLabel("Type to terminal").fill("hello");
  await page.getByRole("button", { name: "Send", exact: true }).tap();
  await expect
    .poll(() => calls.some((c) => c.path === "/api/terminals/remote%2Ft3/send"))
    .toBe(true);
  sockets[0].send(
    JSON.stringify({
      type: "screen",
      terminalId: "t1",
      cols: 50,
      rows: 10,
      text: prompt,
    }),
  );
  await expect(
    page.getByRole("button", { name: "Yes", exact: true }),
  ).toHaveCount(0);
  sockets[0].send(
    JSON.stringify({ type: "error", code: "probe", message: "Frame boundary" }),
  );
  await expect(page.getByRole("status")).toHaveText("Frame boundary");
  await expect(page.locator("#terminal-info")).toContainText("100 × 30");
  expect(new URL(page.url()).hash).toBe("#terminal=remote%2Ft3");
});
test("pending input retains its terminal and failures cancel queued input", async ({
  page,
}) => {
  const { calls } = await setup(page);
  let release!: () => void;
  const blocked = new Promise<void>((r) => (release = r));
  let received = false;
  await page.route("**/api/terminals/t1/send", async (route) => {
    calls.push({
      path: "/api/terminals/t1/send",
      body: route.request().postDataJSON(),
      auth: undefined,
    });
    received = true;
    await blocked;
    await route.fulfill({
      status: 503,
      json: { error: { message: "Disconnected" } },
    });
  });
  await open(page);
  await page.getByLabel("Type to terminal").fill("first");
  await page.getByRole("button", { name: "Send", exact: true }).tap();
  await expect.poll(() => received).toBe(true);
  await page.getByRole("button", { name: "down", exact: true }).tap();
  await page.getByRole("button", { name: "Check", exact: true }).tap();
  await page.getByLabel("Type to terminal").fill("second");
  await page.getByRole("button", { name: "Send", exact: true }).tap();
  release();
  await expect(page.getByRole("status")).toContainText("not replayed");
  await expect
    .poll(() =>
      calls.some(
        (c) => c.path === "/api/terminals/t2/send" && c.body.text === "second",
      ),
    )
    .toBe(true);
  expect(calls.filter((c) => c.path === "/api/terminals/t1/keys")).toHaveLength(
    0,
  );
});
test("stale historical approval text cannot create a button", async ({
  page,
}) => {
  const { sockets } = await setup(page);
  await open(page);
  sockets[0].send(
    JSON.stringify({
      type: "screen",
      terminalId: "t1",
      cols: 100,
      rows: 30,
      text: prompt + "\nFinished.\n$ ",
      screenId: "history",
      prompt: null,
    }),
  );
  await expect(
    page.getByRole("button", { name: "Yes", exact: true }),
  ).toHaveCount(0);
});
test("new space machine selector and device revocation", async ({ page }) => {
  const { sockets } = await setup(page);
  await page.getByRole("button", { name: "New space on remote" }).tap();
  sockets[0].send(JSON.stringify({ type: "connection", connected: true }));
  sockets[0].send(JSON.stringify({ type: "state", state: fixture }));
  await expect(page.getByLabel("Machine", { exact: true })).toHaveValue(
    "remote",
  );
  await page.getByRole("button", { name: "×", exact: true }).tap();
  await page.getByRole("button", { name: "•••" }).tap();
  await page.getByRole("button", { name: "Disconnect this phone" }).tap();
  await expect(
    page.getByRole("heading", { name: "Your spaces, with you." }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("herdr-phone.device")),
  ).toBeNull();
});

test("core disconnect cancels unsent input without replay", async ({
  page,
}) => {
  const { calls, sockets } = await setup(page);
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let received = false;
  await page.route("**/api/terminals/t1/send", async (route) => {
    received = true;
    await hold;
    await route.fulfill({ json: { ok: true } });
  });
  await open(page);
  await page.getByLabel("Type to terminal").fill("first");
  await page.getByRole("button", { name: "Send", exact: true }).tap();
  await expect.poll(() => received).toBe(true);
  await page.getByRole("button", { name: "down", exact: true }).tap();
  sockets[0].send(JSON.stringify({ type: "connection", connected: false }));
  await expect(page.getByRole("status")).toContainText(
    "Pending input was cancelled",
  );
  release();
  sockets[0].send(JSON.stringify({ type: "connection", connected: true }));
  await page.getByRole("button", { name: "Check", exact: true }).tap();
  await page.getByLabel("Type to terminal").fill("ready");
  await page.getByRole("button", { name: "Send", exact: true }).tap();
  await expect
    .poll(() => calls.some((c) => c.path === "/api/terminals/t2/send"))
    .toBe(true);
  expect(calls.filter((c) => c.path === "/api/terminals/t1/keys")).toHaveLength(
    0,
  );
});
test("plain snapshots cannot execute terminal control sequences", async ({
  page,
}) => {
  const { sockets } = await setup(page);
  await open(page);
  sockets[0].send(
    JSON.stringify({
      type: "screen",
      terminalId: "t1",
      cols: 100,
      rows: 30,
      text: "BEFORE\x1b[2JAFTER",
    }),
  );
  await expect(page.locator(".xterm-accessibility-tree")).toContainText(
    "BEFORE[2JAFTER",
  );
});

test("500 character compose preserves literal text and sends only on deliberate submission", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await open(page);
  const input = page.getByLabel("Type to terminal");
  const text = Array.from(
    'Hello 🙂 café! "quoted" $value <tag> \\ / + = ?\n\t'.repeat(20),
  )
    .slice(0, 500)
    .join("");
  expect(Array.from(text)).toHaveLength(500);
  await input.tap();
  await page.keyboard.insertText(text);
  await expect(input).toHaveValue(text);
  expect(calls.some((call) => /\/(send|input|keys)$/.test(call.path))).toBe(
    false,
  );
  await page.getByRole("button", { name: "Send", exact: true }).tap();
  await expect(input).toHaveValue("");
  expect(
    calls
      .filter((call) => call.path.endsWith("/send"))
      .map((call) => call.body),
  ).toEqual([{ text }]);
  expect(calls.some((call) => call.path.endsWith("/input"))).toBe(false);
});

test("pending send prevents duplicates and retains edits and independent tab drafts", async ({
  page,
}) => {
  const { calls } = await setup(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const sends: any[] = [];
  await page.route("**/api/terminals/t1/send", async (route) => {
    sends.push(route.request().postDataJSON());
    await held;
    await route.fulfill({ json: { ok: true } });
  });
  await open(page);
  const input = page.getByLabel("Type to terminal");
  await input.fill("submitted");
  await input.press("Enter");
  await expect.poll(() => sends.length).toBe(1);
  await input.press("Enter");
  await page.getByRole("button", { name: "enter", exact: true }).tap();
  await input.fill("newer draft");
  await page.getByRole("button", { name: "Check", exact: true }).tap();
  await expect(input).toHaveValue("");
  await input.fill("second terminal draft");
  release();
  await page.getByRole("button", { name: "Build", exact: true }).tap();
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await expect(input).toHaveValue("newer draft");
  expect(sends).toEqual([{ text: "submitted" }]);
  await page.getByRole("button", { name: "Check", exact: true }).tap();
  await expect(input).toHaveValue("second terminal draft");
  expect(calls.filter((call) => call.path.endsWith("/send"))).toEqual([]);
});

test("disconnect leaves uncertain draft intact and reconnect never replays", async ({
  page,
}) => {
  const { calls, sockets } = await setup(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let received = 0;
  await page.route("**/api/terminals/t1/send", async (route) => {
    received++;
    await held;
    await route.fulfill({ json: { ok: true } });
  });
  await open(page);
  const input = page.getByLabel("Type to terminal");
  await input.fill("uncertain");
  await input.press("Enter");
  await expect.poll(() => received).toBe(1);
  await page.getByRole("button", { name: "down", exact: true }).tap();
  sockets[0].send(JSON.stringify({ type: "connection", connected: false }));
  await expect(page.getByRole("status")).toContainText(
    "Pending input was cancelled",
  );
  release();
  await expect(page.getByRole("status")).toContainText("unknown");
  sockets[0].send(JSON.stringify({ type: "connection", connected: true }));
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await expect(input).toHaveValue("uncertain");
  expect(received).toBe(1);
  expect(calls.some((call) => call.path.endsWith("/keys"))).toBe(false);
});

test("blocked sends require separate deliberate force and fresh matching screen", async ({
  page,
}) => {
  await setup(page);
  const sends: any[] = [];
  await page.route("**/api/terminals/t1/send", async (route) => {
    const body = route.request().postDataJSON();
    sends.push(body);
    await route.fulfill(
      body.force
        ? { json: { ok: true } }
        : {
            status: 409,
            json: {
              error: {
                code: "terminal_blocked",
                message: "Waiting for a choice",
              },
            },
          },
    );
  });
  await open(page);
  await page.getByLabel("Type to terminal").fill("message");
  await page.getByRole("button", { name: "Send", exact: true }).tap();
  await expect(page.getByRole("dialog")).toContainText("Allow this operation?");
  await expect(page.getByLabel("Type to terminal")).toHaveValue("message");
  expect(sends).toEqual([{ text: "message" }]);
  await page.getByRole("button", { name: "Send anyway", exact: true }).tap();
  await expect(page.getByLabel("Type to terminal")).toHaveValue("");
  expect(sends).toEqual([
    { text: "message" },
    { text: "message", force: true, screenId: "screen-1" },
  ]);
});

test("changed force confirmation stops before dispatch and server stale denial retains draft", async ({
  page,
}) => {
  await setup(page);
  const sends: any[] = [];
  let screenId = "screen-1";
  await page.route("**/api/terminals/t1/screen", async (route) =>
    route.fulfill({
      json: {
        terminal: fixture.spaces[0].tabs[0].terminals[0],
        text: prompt,
        complete: true,
        screenId,
        prompt: suppliedPrompt,
      },
    }),
  );
  await page.route("**/api/terminals/t1/send", async (route) => {
    const body = route.request().postDataJSON();
    sends.push(body);
    await route.fulfill({
      status: 409,
      json: {
        error: {
          code: body.force ? "stale_prompt" : "terminal_blocked",
          message: body.force ? "The dialog changed" : "Waiting for a choice",
        },
      },
    });
  });
  await open(page);
  const input = page.getByLabel("Type to terminal");
  await input.fill("keep this");
  await input.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  screenId = "screen-2";
  await page.getByRole("button", { name: "Send anyway" }).tap();
  await expect(page.getByRole("status")).toContainText(
    "review the current dialog",
  );
  expect(sends).toHaveLength(1);
  await expect(input).toHaveValue("keep this");
  await input.press("Enter");
  await page.getByRole("button", { name: "Send anyway" }).tap();
  await expect(page.getByRole("status")).toContainText("Draft retained");
  await expect.poll(() => sends.length).toBe(3);
  expect(sends[2]).toEqual({
    text: "keep this",
    force: true,
    screenId: "screen-2",
  });
  await expect(input).toHaveValue("keep this");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("scoped prompt labels are preserved and stale choices remain visibly rejected", async ({
  page,
}) => {
  const { sockets } = await setup(page);
  const actions: any[] = [];
  await page.route("**/api/terminals/t1/prompt", async (route) => {
    actions.push(route.request().postDataJSON());
    await route.fulfill({
      status: 409,
      json: {
        error: { code: "stale_prompt", message: "This choice is stale" },
      },
    });
  });
  await open(page);
  sockets[0].send(
    JSON.stringify({
      type: "screen",
      terminalId: "t1",
      cols: 100,
      rows: 30,
      text: "Choose permission",
      screenId: "scoped-screen",
      prompt: {
        id: "scoped",
        kind: "approval",
        options: [
          {
            id: "session",
            label: "Allow for this session",
            keys: ["2", "enter"],
          },
        ],
      },
    }),
  );
  await page
    .getByRole("button", { name: "Allow for this session", exact: true })
    .tap();
  await expect(page.getByRole("status")).toContainText("This choice is stale");
  expect(actions).toEqual([{ promptId: "scoped", optionId: "session" }]);
  expect(actions[0].keys).toBeUndefined();
});

test("all named keybar keys and slash commands use their documented routes", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await open(page);
  for (const key of ["shift+tab", "esc", "up", "down", "enter", "ctrl+c"]) {
    const control = page.getByRole("button", { name: key, exact: true });
    expect(
      await control.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.height >= 44 &&
          [3, rect.height / 2, rect.height - 3].every((y) => {
            const hit = document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + y,
            );
            return hit === element || (hit !== null && element.contains(hit));
          })
        );
      }),
    ).toBe(true);
    await control.tap();
  }
  await expect
    .poll(() => calls.filter((call) => call.path.endsWith("/keys")).length)
    .toBe(6);
  expect(
    calls
      .filter((call) => call.path.endsWith("/keys"))
      .map((call) => call.body.keys),
  ).toEqual([["shift+tab"], ["esc"], ["up"], ["down"], ["enter"], ["ctrl+c"]]);
  for (const command of ["/effort", "/mcp"]) {
    await page.getByLabel("Type to terminal").fill(command);
    await page.getByLabel("Type to terminal").press("Enter");
    await expect(page.getByLabel("Type to terminal")).toHaveValue("");
    await expect(page.locator(".xterm-accessibility-tree")).toContainText(
      "Select model",
    );
  }
  expect(
    calls
      .filter((call) => call.path.endsWith("/send"))
      .map((call) => call.body),
  ).toEqual([{ text: "/effort" }, { text: "/mcp" }]);
});

test("space creation uses machine programs and defaults then opens its first tab", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await page.getByRole("button", { name: "New space on remote" }).tap();
  await expect(page.getByLabel("Program", { exact: true })).toHaveText(
    "Remote shell",
  );
  await page.getByLabel("Machine", { exact: true }).selectOption("local");
  await expect(page.getByLabel("Working directory")).toHaveValue(
    "/workspace/sample",
  );
  await expect(page.getByLabel("Program", { exact: true })).toHaveText("Shell");
  await page.getByLabel("Space name").fill("Created");
  await page.getByLabel("Working directory").fill("/workspace/edited");
  const created = structuredClone(fixture);
  created.spaces[0].id = "created";
  created.spaces[0].name = "Created";
  await page.route("**/api/spaces", (route) => {
    calls.push({
      path: "/api/spaces",
      body: route.request().postDataJSON(),
      auth: undefined,
    });
    return route.fulfill({
      status: 201,
      json: { spaceId: "created", tabId: "one", terminalId: "t1" },
    });
  });
  await page.route("**/api/state", (route) => route.fulfill({ json: created }));
  await page.getByRole("button", { name: "Create space", exact: true }).tap();
  await expect(
    page.getByRole("heading", { name: "Created", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Build", exact: true }),
  ).toHaveAttribute("aria-current", "true");
  expect(calls.find((call) => call.path === "/api/spaces")?.body).toEqual({
    machineId: "local",
    name: "Created",
    cwd: "/workspace/edited",
    programId: "shell",
  });
});

test("bridge menu choices use prompt ids without parsing text", async ({
  page,
}) => {
  const { calls, sockets } = await setup(page);
  await open(page);
  sockets[0].send(
    JSON.stringify({
      type: "screen",
      terminalId: "t1",
      cols: 100,
      rows: 30,
      text: "Select setting\n› Balanced\n  Quick\nUse arrows and Enter",
      screenId: "menu-1",
      prompt: {
        id: "menu-1",
        kind: "menu",
        options: [{ id: "quick", label: "Quick", keys: ["down", "enter"] }],
      },
    }),
  );
  await page.getByRole("button", { name: "Quick", exact: true }).tap();
  await expect
    .poll(() => calls.filter((call) => call.path.endsWith("/prompt")).length)
    .toBe(1);
  expect(calls.find((call) => call.path.endsWith("/prompt"))?.body).toEqual({
    promptId: "menu-1",
    optionId: "quick",
  });
});

test("socket reconnect after failed request preserves draft without resubmission", async ({
  page,
}) => {
  const { sockets } = await setup(page);
  let sends = 0;
  await page.route("**/api/terminals/t1/send", async (route) => {
    sends++;
    sockets[0].close({ code: 1011, reason: "Disconnected" });
    await route.abort("failed");
  });
  await open(page);
  const input = page.getByLabel("Type to terminal");
  await input.fill("retain on reconnect");
  await input.press("Enter");
  await expect(page.getByRole("status")).toContainText("Draft retained");
  await expect.poll(() => sockets.length).toBe(2);
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await expect(input).toHaveValue("retain on reconnect");
  expect(sends).toBe(1);
});

test("ten long menu options scroll within choices while keybar and compose remain usable", async ({
  page,
}) => {
  const { calls, sockets } = await setup(page);
  await open(page);
  const labels = [
    "Default (recommended) — Best for everyday, complex tasks (set as default)",
    "Model Two — For complex work and everyday tasks (set as default)",
    "Model Three — For your toughest challenges (set as default)",
    "Model Four — Most efficient for simpler tasks (set as default)",
    "Model Five — Fastest for quick answers (set as default)",
    "Model Six — Fastest for quick answers (set as default)",
    "Model Seven — Efficient for routine tasks (set as default)",
    "Model Eight — Best for everyday, complex tasks (set as default)",
    "Model Nine — Most capable for your hardest and longest-running tasks (set as default)",
    "Model Ten — Best for everyday, complex tasks (set as default)",
  ];
  const controls = page.locator(
    ".keybar button, .terminal-input, .compose-send",
  );
  const hitControls = async () => {
    expect(
      await controls.evaluateAll((elements) =>
        elements.every((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.top >= 0 &&
            rect.bottom <= innerHeight &&
            rect.height >= 44 &&
            [3, rect.height / 2, rect.height - 3].every((y) => {
              const hit = document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + y,
              );
              return hit === element || (hit !== null && element.contains(hit));
            })
          );
        }),
      ),
    ).toBe(true);
  };
  let repeatedFrame = "";
  const repeats = setInterval(() => {
    if (repeatedFrame) sockets[0].send(repeatedFrame);
  }, 100);
  try {
    for (let selected = 0; selected < labels.length; selected++) {
      const promptId = `large-menu-${selected}`;
      repeatedFrame = JSON.stringify({
        type: "screen",
        terminalId: "t1",
        cols: 100,
        rows: 30,
        text: "Select setting. Enter sets the default for new sessions.",
        screenId: promptId,
        prompt: {
          id: promptId,
          kind: "menu",
          options: labels.map((label, index) => ({
            id: `option-${index}`,
            label,
            keys: Array(index).fill("down").concat("enter"),
          })),
        },
      });
      sockets[0].send(repeatedFrame);
      const area = page.locator("#approvals");
      const option = page.getByRole("button", {
        name: labels[selected],
        exact: true,
      });
      await expect(option).toBeVisible();
      const originalOption = await option.elementHandle();
      expect(
        await area.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      ).toBe(true);
      await hitControls();
      const bounds = await area.boundingBox();
      expect(bounds).not.toBeNull();
      await page.mouse.move(
        bounds!.x + bounds!.width / 2,
        bounds!.y + bounds!.height / 2,
      );
      // Drive the scroll container with real input; no scrollIntoView/scrollTop assignment.
      await page.mouse.wheel(0, -2000);
      const reachable = () =>
        option.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const parent = element.parentElement!.getBoundingClientRect();
          const y = rect.y + rect.height / 2;
          const hit = document.elementFromPoint(rect.x + rect.width / 2, y);
          return (
            y > parent.top &&
            y < parent.bottom &&
            (hit === element || (hit !== null && element.contains(hit)))
          );
        });
      for (let step = 0; step < 12 && !(await reachable()); step++) {
        await page.mouse.wheel(0, 80);
        await page.waitForTimeout(40);
      }
      // Repeated identical bridge snapshots must not reset the user's scroll position.
      await page.waitForTimeout(220);
      expect(
        await originalOption!.evaluate((element) => element.isConnected),
      ).toBe(true);
      expect(await reachable()).toBe(true);
      await hitControls();
      if (selected === 0 || selected === labels.length - 1)
        await capture(page, `large-menu-${selected}`);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= 390),
      ).toBe(true);
      await option.tap();
      await expect
        .poll(
          () => calls.filter((call) => call.path.endsWith("/prompt")).length,
        )
        .toBe(selected + 1);
      expect(
        calls.filter((call) => call.path.endsWith("/prompt"))[selected].body,
      ).toEqual({
        promptId,
        optionId: `option-${selected}`,
      });
      await page.waitForTimeout(220);
      await expect(area.getByRole("button")).toHaveCount(0);
    }
  } finally {
    clearInterval(repeats);
  }
  expect(calls.filter((call) => call.path.endsWith("/prompt"))).toHaveLength(
    10,
  );
});

test("prompt choices disappear on disconnect and consumed prompts stay hidden", async ({
  page,
}) => {
  const { sockets } = await setup(page);
  await open(page);
  sockets[0].send(JSON.stringify({ type: "connection", connected: false }));
  await expect(page.locator("#approvals button")).toHaveCount(0);
  sockets[0].send(JSON.stringify({ type: "connection", connected: true }));
  await page.getByRole("button", { name: "Yes", exact: true }).tap();
  sockets[0].send(
    JSON.stringify({
      type: "screen",
      terminalId: "t1",
      cols: 100,
      rows: 30,
      text: prompt,
      screenId: "screen-1",
      prompt: suppliedPrompt,
    }),
  );
  sockets[0].send(
    JSON.stringify({
      type: "error",
      code: "probe",
      message: "Repeated prompt processed",
    }),
  );
  await expect(page.getByRole("status")).toHaveText(
    "Repeated prompt processed",
  );
  await expect(page.locator("#approvals button")).toHaveCount(0);
});

test("notification deep link opens remote terminal at empty startup", async ({
  page,
}) => {
  await setup(page, true, "/#terminal=remote%2Ft3");
  await expect(
    page.getByRole("heading", { name: "Remote work", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Shell", exact: true }),
  ).toHaveAttribute("aria-current", "true");
});

test("notification deep link switches from an already open local terminal", async ({
  page,
}) => {
  await setup(page);
  await open(page);
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.href = "/#terminal=remote%2Ft3";
    link.textContent = "Mock notification target";
    link.style.cssText =
      "position:fixed;top:70px;left:20px;z-index:1000;background:black;padding:14px";
    document.body.append(link);
  });
  await page.getByRole("link", { name: "Mock notification target" }).tap();
  await expect(
    page.getByRole("heading", { name: "Remote work", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Shell", exact: true }),
  ).toHaveAttribute("aria-current", "true");
});
