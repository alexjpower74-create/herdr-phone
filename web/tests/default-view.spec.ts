import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";

const terminal = { id: "t1", title: "Build", state: "live", status: "blocked", cols: 100, rows: 30 };
const state = { version: 1, revision: 1, machines: [{ id: "local", name: "Computer", online: true }], programs: [], spaces: [{ id: "work", machineId: "local", name: "Workbench", cwd: "", repo: null, branch: null, color: "#778899", tabs: [{ id: "build", name: "Build", terminals: [terminal] }, { id: "review", name: "Review", terminals: [{ ...terminal, id: "remote/t2" }] }] }] };
const turn = (n: number) => ({ id: `turn-${n}`, entries: [{ id: `user-${n}`, role: "user", text: `Request ${n}: Review this saved message.` }, { id: `reply-${n}`, role: "assistant", text: `Reply ${n}: The saved response remains readable.\n${"The next step is ready. ".repeat(6)}` }] });

async function setup(page: Page, preference: string | null = null, deepLink = false, blockedStorage = false) {
  const model = { data: Array.from({ length: 20 }, (_, i) => turn(i)), reads: [] as string[], calls: [] as { path: string; body: any }[], sockets: [] as WebSocketRoute[] };
  let prompt: any = { id: "approval", kind: "approval", options: [{ id: "yes", label: "Yes, proceed", keys: ["enter"] }, { id: "no", label: "No, cancel", keys: ["down", "enter"] }] };
  await page.addInitScript(({ preference, blockedStorage }) => {
    localStorage.setItem("herdr-phone.device", "test-device-token");
    if (preference && !localStorage.getItem("fixture.initialized")) localStorage.setItem("herdr-phone.terminal-view", preference);
    localStorage.setItem("fixture.initialized", "1");
    if (blockedStorage) {
      const read = Storage.prototype.getItem, write = Storage.prototype.setItem;
      Storage.prototype.getItem = function(key) { if (key.includes("terminal-view") || key.includes("conversation-default")) throw new Error("Storage unavailable"); return read.call(this, key); };
      Storage.prototype.setItem = function(key, value) { if (key.includes("terminal-view") || key.includes("conversation-default")) throw new Error("Storage unavailable"); return write.call(this, key, value); };
    }
  }, { preference, blockedStorage });
  const screen = (id = "t1") => ({ type: "screen", terminal: { ...terminal, id }, text: "The live terminal is ready.", complete: true, screenId: prompt?.id || "screen", prompt });
  await page.routeWebSocket("**/api/ws", ws => { model.sockets.push(ws); ws.send(JSON.stringify({ type: "state", state })); ws.onMessage(() => {}); });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path.endsWith("/screen")) return route.fulfill({ json: screen(decodeURIComponent(path.split("/")[3])) });
    if (path.endsWith("/conversation")) {
      model.reads.push(path);
      return route.fulfill({ json: { available: true, session: path, revision: String(model.data.length), turns: model.data, nextCursor: null } });
    }
    if (route.request().method() === "POST") model.calls.push({ path, body: route.request().postDataJSON() });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(deepLink ? "/#terminal=remote%2Ft2" : "/");
  if (!deepLink) await page.getByRole("button", { name: "W Workbench", exact: true }).tap();
  return { model, publishMenu: () => {
    prompt = { id: "menu", kind: "menu", options: [{ id: "quick", label: "Quick option", keys: ["enter"] }] };
    for (const ws of model.sockets) ws.send(JSON.stringify(screen()));
  } };
}
async function conversation(page: Page) {
  await expect(page.locator(".conversation")).toBeVisible();
  await expect(page.locator(".terminal-viewport")).toBeHidden();
  await expect(page.getByRole("button", { name: "Terminal view", exact: true })).toBeVisible();
  await expect(page.locator(".view-toggle")).toBeHidden();
  await expect(page.locator('.conversation [data-entry="reply-19"]')).toBeVisible();
}

for (const preference of [null, "mirror", "read"]) test(`session opens Conversation with ${preference || "fresh"} preference and toggles both ways`, async ({ page }) => {
  await setup(page, preference);
  await conversation(page);
  await page.getByRole("button", { name: "Terminal view", exact: true }).tap();
  await expect(page.locator(".terminal-viewport")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show readable text" })).toBeVisible();
  await page.getByRole("button", { name: "Show readable text" }).tap();
  await expect(page.locator(".terminal-read")).toBeVisible();
  await page.getByRole("button", { name: "Conversation", exact: true }).tap();
  await conversation(page);
  await page.reload();
  await conversation(page);
  await page.getByRole("button", { name: "Terminal view", exact: true }).tap();
  await expect(page.locator(".terminal-read")).toBeVisible();
});

test("remote deep link and tab changes open saved messages without a discovery tap", async ({ page }) => {
  const { model } = await setup(page, "read", true);
  await conversation(page);
  expect(model.reads.at(-1)).toContain("remote%2Ft2/conversation");
  await page.getByRole("button", { name: "Terminal view", exact: true }).tap();
  await page.getByRole("button", { name: "Build", exact: true }).tap();
  await conversation(page);
  expect(model.reads.at(-1)).toBe("/api/terminals/t1/conversation");
});

test("default Conversation follows live replies, preserves scroll-up and supports prompt/menu/keys", async ({ page }) => {
  const { model, publishMenu } = await setup(page);
  await conversation(page);
  const host = page.locator(".conversation");
  model.data.push(turn(20));
  await expect(host.locator('[data-entry="reply-20"]')).toBeVisible({ timeout: 6000 });
  expect(await host.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
  const box = await host.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(350);
  const prior = await host.evaluate(el => el.scrollTop);
  expect(await host.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(300);
  model.data.push(turn(21));
  await expect(host.locator('[data-entry="reply-21"]')).toBeAttached({ timeout: 6000 });
  expect(Math.abs(await host.evaluate(el => el.scrollTop) - prior)).toBeLessThan(2);
  await page.getByRole("button", { name: "Yes, proceed", exact: true }).tap();
  await expect.poll(() => model.calls.length).toBe(1);
  expect(model.calls[0].body).toEqual({ promptId: "approval", optionId: "yes" });
  publishMenu();
  await page.getByRole("button", { name: "Quick option", exact: true }).tap();
  await expect.poll(() => model.calls.length).toBe(2);
  expect(model.calls[1].body).toEqual({ promptId: "menu", optionId: "quick" });
  await page.getByRole("button", { name: "shift+tab", exact: true }).tap();
  await expect.poll(() => model.calls.length).toBe(3);
  expect(model.calls[2].body).toEqual({ keys: ["shift+tab"] });
  await expect(host).toBeVisible();
  if (process.env.DEFAULT_VIEW_SHOT) {
    await host.getByRole("button", { name: "Latest messages" }).tap();
    await page.screenshot({ path: process.env.DEFAULT_VIEW_SHOT.replace(".png", `-${test.info().project.name}.png`) });
  }
});

test("unavailable preference storage still opens Conversation and permits terminal access", async ({ page }) => {
  await setup(page, "read", false, true);
  await conversation(page);
  await page.getByRole("button", { name: "Terminal view", exact: true }).tap();
  await expect(page.locator(".terminal-viewport")).toBeVisible();
});
