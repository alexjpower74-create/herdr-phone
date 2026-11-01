import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";

const terminal = { id: "t1", title: "Build", state: "live", status: "blocked", cols: 100, rows: 30 };
const state = { version: 1, revision: 1, machines: [{ id: "local", name: "Computer", online: true }], programs: [], spaces: [{ id: "work", machineId: "local", name: "Workbench", cwd: "", repo: null, branch: null, color: "#778899", tabs: [{ id: "build", name: "Build", terminals: [terminal] }, { id: "review", name: "Review", terminals: [{ ...terminal, id: "remote/t2" }] }] }] };
const turn = (n: number) => ({ id: `turn-${n}`, entries: [{ id: `user-${n}`, role: "user", text: `Request ${n}: Review this saved message.` }, { id: `reply-${n}`, role: "assistant", text: `Reply ${n}: The saved response remains readable.\n${"The next step is ready. ".repeat(6)}` }] });

async function setup(page: Page, preference: string | null = null, deepLink = false, blockedStorage = false) {
  const model = { data: Array.from({ length: 20 }, (_, i) => turn(i)), holdLatest: false, reads: [] as string[], calls: [] as { path: string; body: any }[], watches: new Map<WebSocketRoute, { terminalId: string; watchId: string }>() };
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
  await page.routeWebSocket("**/api/ws", ws => {
    ws.send(JSON.stringify({ type: "state", state }));
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "watch") model.watches.set(ws, { terminalId: frame.terminalId, watchId: frame.watchId });
      else if (frame.type === "unwatch") model.watches.delete(ws);
    });
  });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path.endsWith("/screen")) return route.fulfill({ json: screen(decodeURIComponent(path.split("/")[3])) });
    if (path.endsWith("/conversation")) {
      model.reads.push(path);
      if (model.holdLatest) return;
      return route.fulfill({ json: { available: true, session: path, revision: String(model.data.length), turns: model.data, nextCursor: null } });
    }
    if (route.request().method() === "POST") model.calls.push({ path, body: route.request().postDataJSON() });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(deepLink ? "/#terminal=remote%2Ft2" : "/");
  if (!deepLink) await page.getByRole("button", { name: "W Workbench", exact: true }).tap();
  return { model, publishPrompt: (next: any) => {
    prompt = next;
    for (const [ws, watch] of model.watches) ws.send(JSON.stringify({ type: "screen", ...watch, cols: 100, rows: 30, text: "Choose an option.", screenId: prompt.id, prompt }));
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
  const { model, publishPrompt } = await setup(page);
  await conversation(page);
  const host = page.locator(".conversation");
  model.data.push(turn(20));
  await expect(host.locator('[data-entry="reply-20"]')).toBeVisible({ timeout: 6000 });
  expect(await host.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
  const box = await host.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -600);
  await expect.poll(() => host.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(300);
  const prior = await host.evaluate(async el => {
    let previous = el.scrollTop, stable = 0;
    for (let frames = 0; frames < 120; frames++) {
      await new Promise(requestAnimationFrame);
      const current = el.scrollTop;
      stable = Math.abs(current - previous) < 0.5 ? stable + 1 : 0;
      if (stable >= 4) return current;
      previous = current;
    }
    throw new Error("Scroll did not settle");
  });
  model.data.push(turn(21));
  await expect(host.locator('[data-entry="reply-21"]')).toBeAttached({ timeout: 6000 });
  expect(Math.abs(await host.evaluate(el => el.scrollTop) - prior)).toBeLessThan(2);
  await page.getByRole("button", { name: "Yes, proceed", exact: true }).tap();
  await expect.poll(() => model.calls.length).toBe(1);
  expect(model.calls[0].body).toEqual({ promptId: "approval", optionId: "yes" });
  publishPrompt({ id: "menu", kind: "menu", options: [{ id: "quick", label: "Quick option", keys: ["enter"] }] });
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

test("Conversation follows layout changes but preserves native scroll-up before its event", async ({ page }) => {
  const { model, publishPrompt } = await setup(page);
  await conversation(page);
  await expect(page.getByRole("button", { name: "Yes, proceed", exact: true })).toBeVisible();
  await expect.poll(() => model.watches.size).toBe(1);
  const host = page.locator(".conversation");
  const gap = () => host.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(gap, { timeout: 1000 }).toBeLessThan(2);
  // Keep later polls pending: they must not rescue a missing resize handler.
  model.holdLatest = true;
  publishPrompt({ id: "many", kind: "menu", options: Array.from({ length: 10 }, (_, i) => ({ id: `choice-${i}`, label: `Setting ${i}: keep this choice for future sessions`, keys: ["enter"] })) });
  await expect(page.locator("#approvals button")).toHaveCount(10);
  await expect.poll(gap, { timeout: 1000 }).toBeLessThan(2);
  const height = await host.evaluate(el => el.scrollHeight);
  // A late font can grow the list without changing the panel's own dimensions.
  await host.evaluate(el => { el.style.fontSize = "16px"; });
  await expect.poll(() => host.evaluate(el => el.scrollHeight)).toBeGreaterThan(height);
  await expect.poll(gap, { timeout: 1000 }).toBeLessThan(2);
  await host.evaluate(el => el.addEventListener("scroll", event => event.stopImmediatePropagation(), { capture: true }));
  const box = await host.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -600);
  await expect.poll(gap).toBeGreaterThan(300);
  const prior = await host.evaluate(async el => {
    let previous = el.scrollTop, stable = 0;
    for (let frame = 0; frame < 120; frame++) {
      await new Promise(requestAnimationFrame);
      const current = el.scrollTop;
      stable = Math.abs(current - previous) < 0.5 ? stable + 1 : 0;
      if (stable >= 4) return current;
      previous = current;
    }
    throw new Error("Native scroll did not settle");
  });
  publishPrompt({ id: "small", kind: "menu", options: [{ id: "keep", label: "Keep current setting", keys: ["enter"] }] });
  await expect(page.getByRole("button", { name: "Keep current setting", exact: true })).toBeVisible();
  await expect(host.getByRole("button", { name: "Latest messages" })).toBeVisible();
  expect(Math.abs(await host.evaluate(el => el.scrollTop) - prior)).toBeLessThan(2);
});

test("unavailable preference storage still opens Conversation and permits terminal access", async ({ page }) => {
  await setup(page, "read", false, true);
  await conversation(page);
  await page.getByRole("button", { name: "Terminal view", exact: true }).tap();
  await expect(page.locator(".terminal-viewport")).toBeVisible();
});
