import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";

test.use({ isMobile: false });
const terminal = { id: "t1", title: "Build", state: "live", status: "working", cols: 80, rows: 24 };
const state = { version: 1, revision: 1,
  machines: [{ id: "local", name: "This computer", online: true }], programs: [],
  spaces: [{ id: "sample", machineId: "local", name: "Sample", cwd: "", repo: null, branch: null,
    color: "#22a99a", tabs: [{ id: "build", name: "Build", terminals: [terminal] }] }] };
const inspect = (page: Page, cells = false) => page.evaluate(async (includeCells) =>
  (await import(/* @vite-ignore */ "/src/main.ts") as any).inspectTerminal(includeCells), cells);
async function setup(page: Page) {
  let socket: WebSocketRoute;
  const watches: { watchId: string; history: number }[] = [];
  const writes: string[] = [];
  await page.addInitScript(() => localStorage.setItem("herdr-phone.device", "test-device-token"));
  await page.routeWebSocket("**/api/ws", ws => {
    socket = ws;
    ws.onMessage(raw => {
      const request = JSON.parse(String(raw));
      if (request.type === "watch") watches.push(request);
    });
    ws.send(JSON.stringify({ type: "state", state }));
  });
  await page.route("**/api/**", route => {
    if (route.request().method() !== "GET") writes.push(route.request().url());
    return route.fulfill({ json: route.request().url().endsWith("/state") ? state :
      { terminal, text: "Plain fallback", screenId: "plain", prompt: null, complete: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "S Sample", exact: true }).tap();
  await expect.poll(() => watches.length).toBe(1);
  const output = (text: string | Buffer, seq = 0, watch = watches.at(-1)!) =>
    socket!.send(JSON.stringify({ type: "output", terminalId: "t1", watchId: watch.watchId, history: watch.history,
      cols: 80, rows: 24, reset: seq === 0, seq, data: Buffer.from(text).toString("base64") }));
  const screen = (text: string, watch = watches.at(-1)!) =>
    socket!.send(JSON.stringify({ type: "screen", terminalId: "t1", watchId: watch.watchId, history: watch.history,
      cols: 80, rows: 24, text, screenId: text, prompt: null }));
  return { watches, writes, output, screen, close() { socket!.close({ code: 1012, reason: "Geometry changed" }); },
    unavailable() { socket!.send(JSON.stringify({ type: "error", code: "observer_unavailable", terminalId: "t1", watchId: watches.at(-1)!.watchId, message: "Unavailable" })); } };
}
function history(first: number, last: number) {
  return Array.from({ length: last - first + 1 }, (_, i) => `Retained row ${first + i}`).join("\r\n");
}

test("ANSI colours, streaming UTF-8 and sequence guards survive plain screen races", async ({ page }) => {
  const mock = await setup(page);
  mock.output("\x1b[41mHighlighted\x1b[0m plain\r\n");
  await expect.poll(async () => (await inspect(page))?.observer).toBe(true);
  const initial = await inspect(page, true);
  expect(initial.rows[0].cells[0].bgMode).not.toBe(0);
  expect(initial.rows[0].cells[0].bg).not.toBe(initial.rows[0].cells[12].bg);
  const bytes = Buffer.from("café 🙂");
  mock.output(bytes.subarray(0, bytes.length - 2), 1);
  mock.output(bytes.subarray(bytes.length - 2), 2);
  mock.output("DUPLICATE", 2);
  mock.screen("Plain cannot overwrite colours");
  mock.output("STALE", 3, { watchId: "old-watch", history: 500 });
  await expect.poll(async () => (await inspect(page)).rows.map((r: any) => r.text).join("\n")).toContain("café 🙂");
  const after = await inspect(page);
  expect(after.resets).toBe(initial.resets);
  expect(after.rows.map((r: any) => r.text).join("\n")).not.toMatch(/DUPLICATE|STALE|Plain cannot/);
  await page.getByRole("button", { name: "Show readable text" }).tap();
  await expect(page.locator(".terminal-read")).toContainText("café 🙂");
  expect(mock.writes).toEqual([]);
});

test("Mirror wheel reveals retained rows, pages atomically and ignores the replaced watch", async ({ page }) => {
  const mock = await setup(page);
  mock.output(history(500, 1023));
  await expect.poll(async () => (await inspect(page))?.observer).toBe(true);
  const viewport = page.locator(".terminal-viewport");
  await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(500);
  const bounds = await viewport.boundingBox();
  await page.mouse.move(bounds!.x + 100, bounds!.y + 80);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await inspect(page)).viewportY).toBeLessThan((await inspect(page)).baseY);
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => mock.watches.length).toBe(2);
  expect(mock.watches[1].history).toBe(1000);
  expect(mock.watches[1].watchId).not.toBe(mock.watches[0].watchId);
  const anchor = (await inspect(page)).rows[0].text;
  // Keep the old display intact until its visible anchor arrives in the replay.
  mock.output(history(0, 250));
  await page.waitForTimeout(100);
  expect((await inspect(page)).rows[0].text).toBe(anchor);
  mock.output("\r\n" + history(251, 1023), 1);
  await expect.poll(async () => (await inspect(page)).historyBusy).toBe(false);
  const after = await inspect(page);
  expect(after.rows.filter((r: any) => r.text === "Retained row 500")).toHaveLength(1);
  expect(after.rows[after.viewportY].text).toBe(anchor);
  mock.output("OBSOLETE", 1, mock.watches[0]);
  mock.screen("Poll race");
  await page.waitForTimeout(100);
  expect((await inspect(page)).rows.map((r: any) => r.text).join("\n")).not.toMatch(/OBSOLETE|Poll race/);
  expect(mock.writes).toEqual([]);
});

test("Read exposes large history with a bounded DOM and restores the paging anchor", async ({ page }) => {
  const mock = await setup(page);
  mock.output(history(500, 1023));
  await expect.poll(async () => (await inspect(page))?.observer).toBe(true);
  await page.getByRole("button", { name: "Show readable text" }).tap();
  await expect(page.locator(".terminal-read")).toContainText("Retained row 1023");
  expect(await page.locator(".read-line").count()).toBe(524);
  const viewport = page.locator(".terminal-viewport");
  const bounds = await viewport.boundingBox();
  await page.mouse.move(bounds!.x + 100, bounds!.y + 80);
  for (let i = 0; i < 40 && mock.watches.length < 2; i++) {
    await page.mouse.wheel(0, -2000);
    await page.waitForTimeout(50);
  }
  await expect.poll(() => mock.watches.length).toBe(2);
  await expect(page.locator(".terminal-read")).toContainText("Retained row 500");
  const prior = await page.locator(".read-line").filter({ hasText: /^Retained row 500$/ }).evaluate(el => el.getBoundingClientRect().top - document.querySelector(".terminal-viewport")!.getBoundingClientRect().top);
  mock.output(history(0, 1023));
  await expect.poll(async () => (await inspect(page)).historyBusy).toBe(false);
  const anchor = page.locator(".read-line").filter({ hasText: /^Retained row 500$/ });
  await expect(anchor).toBeVisible();
  const delta = await anchor.evaluate(el => el.getBoundingClientRect().top -
    document.querySelector(".terminal-viewport")!.getBoundingClientRect().top);
  expect(Math.abs(delta - prior)).toBeLessThan(3);
  expect(await page.locator(".read-line").count()).toBeLessThan(300);
  for (let i = 0; i < 40 && mock.watches.length < 3; i++) {
    await page.mouse.wheel(0, -2000);
    await page.waitForTimeout(50);
  }
  await expect.poll(() => mock.watches.length).toBe(3);
  expect(mock.watches[2].history).toBe(1500);
  mock.output(history(-500, 1023));
  await expect.poll(async () => (await inspect(page)).historyBusy).toBe(false);
  await expect(page.locator(".read-line").filter({ hasText: /^Retained row 0$/ })).toBeVisible();
  expect(await page.locator(".read-line").count()).toBeLessThan(300);
});

test("reconnect starts a fresh watch and decoder while retaining the draft", async ({ page }) => {
  const mock = await setup(page);
  mock.output("Old buffer");
  await expect.poll(async () => (await inspect(page))?.observer).toBe(true);
  await page.getByLabel("Type to terminal").fill("Retain this draft");
  mock.close();
  await expect.poll(() => mock.watches.length).toBe(2);
  expect(mock.watches[1].watchId).not.toBe(mock.watches[0].watchId);
  expect(mock.watches[1].history).toBe(500);
  mock.output("Fresh buffer");
  await expect.poll(async () => (await inspect(page)).rows[0].text).toBe("Fresh buffer");
  await expect(page.getByLabel("Type to terminal")).toHaveValue("Retain this draft");
  expect((await inspect(page)).resets).toBe(2);
});

test("plain fallback is labelled and exact-width bottom rows do not scroll the screen", async ({ page }) => {
  const mock = await setup(page);
  mock.unavailable();
  const text = Array.from({ length: 24 }, (_, i) => String(i).padEnd(80, "x")).join("\n");
  mock.screen(text);
  await expect(page.locator("#terminal-info")).toContainText("Plain screen");
  await expect.poll(async () => (await inspect(page)).rows[0].text).toBe("0".padEnd(80, "x"));
  const data = await inspect(page);
  expect(data.baseY).toBe(0);
  expect(data.rows[23].text).toBe("23".padEnd(80, "x"));
  expect(data.resets).toBe(0);
});

test("history recomputes a moved anchor after later replay chunks drain", async ({ page }) => {
  const mock = await setup(page);
  mock.output(history(500, 1023));
  await expect.poll(async () => (await inspect(page))?.observer).toBe(true);
  const viewport = page.locator(".terminal-viewport");
  const bounds = await viewport.boundingBox();
  await page.mouse.move(bounds!.x + 100, bounds!.y + 80);
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => mock.watches.length).toBe(2);
  await page.evaluate(() => {
    const original = window.requestAnimationFrame.bind(window);
    const held: (() => void)[] = [];
    window.requestAnimationFrame = callback => original(time => {
      if (document.querySelector(".observer-staging")) held.push(() => callback(time));
      else callback(time);
    });
    (window as any).releaseReplayPaints = () => {
      window.requestAnimationFrame = original;
      for (const callback of held.splice(0)) callback();
    };
  });
  try {
    // A provisional screen contains the anchor at row zero, before the fuller
    // replay replaces it. Hold painting so both chunks precede the atomic swap.
    mock.output("Retained row 500");
    await expect.poll(() => page.locator(".observer-staging").count()).toBe(1);
    await page.waitForTimeout(100);
    mock.output("\x1b[H\x1b[2J" + history(0, 1023), 1);
    await page.waitForTimeout(100);
    await page.evaluate(() => (window as any).releaseReplayPaints());
    await expect.poll(async () => (await inspect(page)).historyBusy).toBe(false);
    const data = await inspect(page);
    expect(data.viewportY).toBe(500);
    expect(data.rows[data.viewportY].text).toBe("Retained row 500");
  } finally {
    await page.evaluate(() => (window as any).releaseReplayPaints?.());
  }
});

test("continuous 200Hz output permits initial observation and anchored history swaps", async ({ page }) => {
  const mock = await setup(page);
  async function busyReplay(text: string, ready: () => Promise<boolean>) {
    mock.output(text);
    let seq = 1;
    const timer = setInterval(() => mock.output("\r\x1b[2KBusy " + seq, seq++), 5);
    try {
      await expect.poll(ready, { timeout: 1200, intervals: [16] }).toBe(true);
      expect(seq).toBeGreaterThan(3);
      const before = seq;
      await page.waitForTimeout(100);
      expect(seq).toBeGreaterThan(before + 5);
    } finally { clearInterval(timer); }
  }
  await busyReplay("\x1b[41m" + history(500, 1023) + "\x1b[0m",
    async () => Boolean((await inspect(page))?.observer));
  const viewport = page.locator(".terminal-viewport");
  const bounds = await viewport.boundingBox();
  await page.mouse.move(bounds!.x + 100, bounds!.y + 80);
  await page.mouse.wheel(0, -100000);
  await expect.poll(() => mock.watches.length).toBe(2);
  await busyReplay(history(0, 1023), async () => !(await inspect(page)).historyBusy);
  const data = await inspect(page);
  expect(data.rows[data.viewportY].text).toBe("Retained row 500");
  expect(data.resets).toBe(2);
  expect(mock.writes).toEqual([]);
});
