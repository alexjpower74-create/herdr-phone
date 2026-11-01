import { test, expect, type Page } from "@playwright/test";
const terminal = { id: "t1", title: "Build", state: "live", status: "idle", cols: 56, rows: 37 };
const state = { version: 1, revision: 1, machines: [{ id: "local", name: "This computer", online: true }], programs: [], spaces: [{ id: "sample", machineId: "local", name: "Sample", cwd: "", repo: null, branch: null, color: "#22a99a", tabs: [{ id: "build", name: "Build", terminals: [terminal] }] }] };
async function setup(page: Page, stream: boolean, history = false) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = 0, abort = false;
  const requests: string[] = [];
  await page.route(/jetbrains-mono-latin-400-normal.*\.woff2?$/, async route => { held++; await gate; if (abort) await route.abort(); else await route.continue(); });
  await page.addInitScript(() => localStorage.setItem("herdr-phone.device", "test-device-token"));
  await page.routeWebSocket("**/api/ws", ws => {
    ws.send(JSON.stringify({ type: "state", state }));
    ws.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (stream && request.type === "watch") ws.send(JSON.stringify({ type: "output", terminalId: "t1", watchId: request.watchId, history: request.history, cols: 56, rows: 37, reset: true, seq: 0, data: Buffer.from("WWWWiiiiMMMM Readable terminal\r\nSaved output remains in place" + (history ? Array.from({ length: 173 }, (_, i) => `\r\nRetained row ${i}`).join("") : "")).toString("base64") }));
    });
  });
  await page.route("**/api/**", route => {
    requests.push(route.request().method() + " " + new URL(route.request().url()).pathname);
    if (route.request().url().endsWith("/conversation")) return route.fulfill({ json: { available: false, reason: "not_found", session: null, revision: "0", turns: [], nextCursor: null } });
    return route.fulfill({ json: route.request().url().endsWith("/state") ? state : { terminal, text: "WWWWiiiiMMMM Readable terminal\nSaved output remains in place", screenId: "screen", prompt: null, complete: true } });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "S Sample", exact: true }).tap();
  await page.getByRole("button", { name: "Terminal view", exact: true }).tap();
  return { release, fail: () => { abort = true; release(); }, requests, held: () => held };
}
async function metrics(page: Page) {
  return page.locator(".terminal-canvas:not(.observer-staging) .xterm-screen").evaluate(el => {
    const rows = el.querySelector<HTMLElement>(".xterm-rows")!;
    const style = getComputedStyle(rows);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    context.font = `${style.fontSize} ${style.fontFamily}`;
    return { cell: (el as HTMLElement).offsetWidth / 56, glyph: context.measureText("W").width,
      spacing: parseFloat(style.letterSpacing) || 0, text: rows.textContent, width: el.getBoundingClientRect().width };
  });
}
for (const stream of [false, true]) test(`held font measures first ${stream ? "stream" : "fallback"} terminal only after readiness`, async ({ page }) => {
  const mock = await setup(page, stream);
  await expect.poll(mock.held).toBeGreaterThan(0);
  await page.waitForTimeout(150);
  // A premature open caches fallback cell and glyph widths, causing the first-open spacing bug.
  const premature = await page.locator(".xterm").count();
  await expect(page.getByRole("button", { name: "esc", exact: true })).toBeVisible();
  mock.release();
  await expect(page.locator(".terminal-canvas:not(.observer-staging) .xterm-rows")).toContainText("Readable terminal");
  await page.evaluate(() => document.fonts.ready);
  const first = await metrics(page);
  console.log("font metrics", { stream, first });
  expect(Math.abs(first.cell - first.glyph)).toBeLessThan(0.04);
  expect(Math.abs(first.spacing)).toBeLessThan(0.04);
  expect(premature).toBe(0);
  expect(first.width).toBeLessThanOrEqual(366);
  if (process.env.FONT_SHOT) await page.screenshot({ path: process.env.FONT_SHOT.replace(".png", stream ? "-stream.png" : "-fallback.png") });
  await page.getByRole("button", { name: "‹", exact: true }).tap();
  await page.getByRole("button", { name: "S Sample", exact: true }).tap();
  await page.getByRole("button", { name: "Terminal view", exact: true }).tap();
  await expect(page.locator(".terminal-canvas:not(.observer-staging) .xterm-rows")).toContainText("Readable terminal");
  const reopened = await metrics(page);
  expect(Math.abs(first.cell - reopened.cell)).toBeLessThan(0.02);
  expect(mock.requests.every(request => request.startsWith("GET "))).toBe(true);
});

test("leaving a terminal while fonts wait cancels its eventual open", async ({ page }) => {
  const mock = await setup(page, true);
  await expect.poll(mock.held).toBeGreaterThan(0);
  await page.getByRole("button", { name: "‹", exact: true }).tap();
  mock.release();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("heading", { name: "Spaces", exact: true })).toBeVisible();
  await expect(page.locator(".xterm")).toHaveCount(0);
});

test("stalled font permits fallback and a late load remeasures without input", async ({ page }) => {
  const mock = await setup(page, true);
  await expect.poll(mock.held).toBeGreaterThan(0);
  // The request remains held: readiness must be bounded rather than waiting forever.
  await expect(page.locator(".terminal-canvas:not(.observer-staging) .xterm-rows")).toContainText("Readable terminal", { timeout: 4000 });
  const before = await metrics(page);
  mock.release();
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(async () => Math.abs((await metrics(page)).cell - (await metrics(page)).glyph)).toBeLessThan(0.04);
  const after = await metrics(page);
  console.log("late font metrics", { before, after });
  expect(Math.abs(after.cell - before.cell)).toBeGreaterThan(1);
  expect(after.width).toBeLessThanOrEqual(366);
  expect(after.text).toBe(before.text);
  expect(mock.requests.every(request => request.startsWith("GET "))).toBe(true);
});

test("late font preserves the live scrolled row even before its scroll callback", async ({ page }) => {
  const mock = await setup(page, true, true);
  await expect.poll(mock.held).toBeGreaterThan(0);
  const viewport = page.locator(".terminal-viewport");
  await expect(page.locator(".terminal-canvas:not(.observer-staging) .xterm-rows")).toContainText("Retained row", { timeout: 4000 });
  await page.evaluate(() => {
    document.addEventListener("scroll", event => {
      if ((event.target as HTMLElement)?.classList?.contains("terminal-viewport")) event.stopImmediatePropagation();
    }, true);
  });
  const bounds = await viewport.boundingBox();
  await page.mouse.move(bounds!.x + 100, bounds!.y + 80);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(300);
  const position = () => viewport.evaluate(el => {
    const screen = el.querySelector<HTMLElement>(".terminal-canvas:not(.observer-staging) .xterm-screen")!;
    const scale = screen.getBoundingClientRect().width / screen.offsetWidth;
    const rowHeight = screen.offsetHeight / 37 * scale;
    return { row: el.scrollTop / rowHeight, remaining: el.scrollHeight - el.clientHeight - el.scrollTop };
  });
  const before = await position();
  expect(before.remaining).toBeGreaterThan(100);
  mock.release();
  await page.evaluate(() => document.fonts.ready);
  await expect.poll(async () => Math.abs((await metrics(page)).cell - (await metrics(page)).glyph)).toBeLessThan(0.04);
  const after = await position();
  console.log("late font row anchor", { before, after });
  expect(Math.abs(after.row - before.row)).toBeLessThan(0.5);
  expect(mock.requests.every(request => request.startsWith("GET "))).toBe(true);
});

test("failed font requests keep fallback usable without an unhandled rejection", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const mock = await setup(page, true);
  await expect.poll(mock.held).toBeGreaterThan(0);
  mock.fail();
  await expect(page.locator(".terminal-canvas:not(.observer-staging) .xterm-rows")).toContainText("Readable terminal");
  await expect(page.getByRole("button", { name: "Show readable text" })).toBeVisible();
  expect(errors).toEqual([]);
  expect(mock.requests.every(request => request.startsWith("GET "))).toBe(true);
});

test("font arriving during Conversation is measured again when Mirror returns", async ({ page }) => {
  const mock = await setup(page, true);
  await expect.poll(mock.held).toBeGreaterThan(0);
  await expect(page.locator(".terminal-canvas:not(.observer-staging) .xterm-rows")).toContainText("Readable terminal", { timeout: 4000 });
  await page.getByRole("button", { name: "Conversation", exact: true }).tap();
  await expect(page.locator(".conversation")).toBeVisible();
  mock.release();
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: "Terminal view", exact: true }).tap();
  await expect(page.locator(".terminal-canvas:not(.observer-staging) .xterm-rows")).toContainText("Readable terminal");
  const after = await metrics(page);
  expect(Math.abs(after.cell - after.glyph)).toBeLessThan(0.04);
  expect(after.width).toBeGreaterThan(300);
  expect(after.width).toBeLessThanOrEqual(366);
});
