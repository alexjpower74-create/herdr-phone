import { test, expect, type Page, type Locator, type Route, type WebSocketRoute } from "@playwright/test";
import type { ConversationPage } from "../src/types";
const terminal = { id: "t1", title: "Build", state: "live", status: "idle", cols: 80, rows: 24 };
const state = { version: 1, revision: 1, machines: [{ id: "local", name: "This computer", online: true }], programs: [], spaces: [{ id: "work", machineId: "local", name: "Workbench", cwd: "", repo: "sample", branch: "main", color: "#22a99a", tabs: [{ id: "build", name: "Build", terminals: [terminal] }, { id: "review", name: "Review", terminals: [{ ...terminal, id: "t2" }] }] }] };
function turns(format: "messages" | "responses", count = 173): ConversationPage["turns"] {
  return Array.from({ length: count }, (_, i) => ({ id: `turn-${i}`, entries: [
    { id: `user-${i}`, role: "user", text: `Request ${i}: ${format === "messages" ? "Check the saved draft and report the result." : "Review the component and describe the next step."}` },
    { id: `tool-${i}`, role: "tool", text: "Read" },
    { id: `reply-${i}`, role: "assistant", text: `Reply ${i}: The review is complete. ${"A readable line of saved conversation. ".repeat(3)} ${i === 172 ? "<img src=x onerror=alert(1)>" + "z".repeat(600) : ""}` },
  ] }));
}
async function setup(page: Page, format: "messages" | "responses" = "messages", initial: { delayLatest?: boolean; unavailable?: boolean } = {}) {
  const model = { data: turns(format), session: format, status: 200, code: "unavailable", network: false, malformed: false, reason: "not_found" as ConversationPage["reason"], page: undefined as ConversationPage | undefined, unavailable: initial.unavailable ?? false, requests: [] as string[], pending: undefined as Route | undefined, delayOlder: false, delayLatest: initial.delayLatest ?? false, sockets: [] as WebSocketRoute[] };
  const result = (before?: string): ConversationPage => {
    const end = before ? Number(before) : model.data.length;
    const start = Math.max(0, end - 50);
    return { available: !model.unavailable, reason: model.unavailable ? model.reason : undefined, session: model.session, revision: String(model.data.length), turns: model.unavailable ? [] : model.data.slice(start, end), nextCursor: start ? String(start) : null };
  };
  await page.addInitScript(() => localStorage.setItem("herdr-phone.device", "test-device-token"));
  await page.routeWebSocket("**/api/ws", ws => {
    model.sockets.push(ws); ws.send(JSON.stringify({ type: "state", state }));
    ws.onMessage(() => {});
  });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/state") return route.fulfill({ json: state });
    if (url.pathname.endsWith("/screen")) return route.fulfill({ json: { terminal, text: "Ready", complete: true, screenId: "screen", prompt: null } });
    if (url.pathname.endsWith("/conversation")) {
      expect(route.request().headers().authorization).toBe("Bearer test-device-token");
      model.requests.push(url.pathname + url.search);
      const before = url.searchParams.get("before") ?? undefined;
      if ((before && model.delayOlder) || (!before && model.delayLatest)) { model.pending = route; return; }
      if (model.malformed) return route.fulfill({ body: "{broken", contentType: "application/json" });
      if (model.network) return route.abort("failed");
      if (model.status !== 200) return route.fulfill({ status: model.status, json: { error: { code: model.code, message: "private runtime information /private/transcript <img src=x>" } } });
      return route.fulfill({ json: model.page ?? result(before) });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "W Workbench sample · main" }).tap();
  await expect(page.getByRole("button", { name: "Terminal view", exact: true })).toBeVisible();
  await expect(page.locator(".conversation")).toBeVisible();
  return { model, result, open: async () => {
    const back = page.getByRole("button", { name: "Conversation", exact: true });
    if (await back.isVisible()) await back.tap();
    await hit(page.getByRole("button", { name: "Terminal view", exact: true }));
    await expect(page.locator(".conversation")).toBeVisible();
  } };
}
async function hit(control: Locator) {
  const area = await control.evaluate(el => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height, hits: [6, r.height / 2, r.height - 6].map(y => [6, r.width / 2, r.width - 6].every(x => { const target = document.elementFromPoint(r.left + x, r.top + y); return target === el || el.contains(target); })) };
  });
  console.log("hit", await control.getAttribute("class"), area);
  expect(area.height).toBeGreaterThanOrEqual(44);
  expect(area.hits).toEqual([true, true, true]);
}
async function wheel(page: Page, delta: number) {
  const box = await page.locator(".conversation").boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(300);
}

for (const format of ["messages", "responses"] as const) test(`${format}: 173 turns reach first message, retain anchor, safe text and controls`, async ({ page }) => {
  const { open, model } = await setup(page, format);
  await open();
  const host = page.locator(".conversation");
  await expect(host.locator('[data-turn="turn-172"]')).toBeVisible();
  expect(await page.locator(".terminal-viewport").isVisible()).toBe(false);
  expect(await host.locator("img").count()).toBe(0);
  expect(await host.locator(".conversation-user").first().evaluate(el => ({ font: parseFloat(getComputedStyle(el).fontSize), bg: getComputedStyle(el).backgroundColor }))).toMatchObject({ font: 14, bg: "rgb(41, 50, 68)" });
  await expect(host.locator(".conversation-tool").first()).toHaveAttribute("data-collapsed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (let i = 0; i < 100; i++) {
    if (await host.getByText("Beginning of conversation", { exact: true }).isVisible()) break;
    await wheel(page, -4500);
  }
  await expect(host.getByText("Beginning of conversation", { exact: true })).toBeVisible();
  await expect(host.locator('[data-turn="turn-0"]')).toBeVisible();
  expect(model.requests.filter(url => url.includes("before=")).length).toBe(3);
  expect(await host.locator("article").count()).toBe(173);
  await hit(host.getByRole("button", { name: "Latest messages" }));
  await host.getByRole("button", { name: "Latest messages" }).tap();
  await expect(host.locator('[data-turn="turn-172"]')).toBeVisible();
  await page.getByRole("button", { name: "Terminal view", exact: true }).tap();
  await expect(page.locator(".terminal-viewport")).toBeVisible();
  await expect(page.getByRole("button", { name: "Show readable text" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("herdr-phone.terminal-view"))).toBe("mirror");
});

test("poll updates current turn, appends uniquely, preserves nodes and reading position", async ({ page }) => {
  const { open, model } = await setup(page);
  await open();
  const host = page.locator(".conversation");
  await expect(host.locator('[data-entry="reply-172"]')).toBeVisible();
  await page.evaluate(() => (window as any).retained = document.querySelector('[data-turn="turn-170"]'));
  model.data[172].entries[2].text = "Current turn updated";
  model.data.push({ id: "turn-173", entries: [{ id: "user-173", role: "user", text: "Next request" }, { id: "reply-173", role: "assistant", text: "New reply" }] });
  await expect(host.getByText("Current turn updated", { exact: true })).toBeVisible();
  await expect(host.getByText("New reply", { exact: true })).toBeVisible();
  expect(await host.locator('[data-entry="reply-172"]').count()).toBe(1);
  expect(await page.evaluate(() => (window as any).retained === document.querySelector('[data-turn="turn-170"]'))).toBe(true);
  await wheel(page, -1000);
  const top = await host.evaluate(el => el.scrollTop);
  model.data[173].entries[1].text = "Updated new reply " + "text ".repeat(100);
  await expect(host.getByText(/^Updated new reply/)).toBeAttached();
  expect(Math.abs(await host.evaluate(el => el.scrollTop) - top)).toBeLessThan(3);
  await hit(host.getByRole("button", { name: "Latest messages" }));
  await host.getByRole("button", { name: "Latest messages" }).tap();
  await expect(host.getByText(/^Updated new reply/)).toBeVisible();
  if (process.env.CONVERSATION_SHOT) await page.screenshot({ path: process.env.CONVERSATION_SHOT });
});

test("unavailable, retry, errors and disconnect keep terminal controls usable", async ({ page }) => {
  const { open, model } = await setup(page, "messages", { unavailable: true });
  await open();
  await expect(page.getByText("No saved conversation was found for this terminal.")).toBeVisible();
  await hit(page.getByRole("button", { name: "Retry conversation" }));
  model.unavailable = false; model.status = 503;
  await page.getByRole("button", { name: "Retry conversation" }).tap();
  await expect(page.getByText("Could not load saved conversation. Please retry.")).toBeVisible();
  expect(await page.getByText("private runtime information").count()).toBe(0);
  model.status = 200;
  await page.getByRole("button", { name: "Retry conversation" }).tap();
  await expect(page.locator('[data-turn="turn-172"]')).toBeVisible();
  model.sockets[0].close();
  await expect(page.getByText("Conversation is offline. Reconnect and retry.")).toBeVisible();
  await page.getByRole("button", { name: "Terminal view", exact: true }).tap();
  const count = model.requests.length;
  await page.getByRole("button", { name: "Conversation", exact: true }).tap();
  await page.waitForTimeout(150);
  expect(model.requests.length).toBe(count);
  await expect(page.getByRole("button", { name: "esc", exact: true })).toBeVisible();
});

test("late older response cannot overwrite replacement session; reads serialize", async ({ page }) => {
  const { open, model, result } = await setup(page);
  await open();
  await expect(page.locator('[data-turn="turn-172"]')).toBeVisible();
  model.delayOlder = true;
  for (let i = 0; i < 20 && !model.pending; i++) await wheel(page, -5000);
  expect(model.pending).toBeTruthy();
  const old = model.pending!, oldPage = result("123"), count = model.requests.length;
  await page.waitForTimeout(2700);
  expect(model.requests.length).toBe(count);
  await page.getByRole("button", { name: "Terminal view", exact: true }).tap();
  model.session = "replacement"; model.data = [{ id: "replacement", entries: [{ id: "replacement-user", role: "user", text: "Replacement session" }] }];
  await page.getByRole("button", { name: "Conversation", exact: true }).tap();
  await expect(page.getByText("Replacement session", { exact: true })).toBeVisible();
  await old.fulfill({ json: oldPage }).catch(() => {});
  await expect(page.locator(".conversation article")).toHaveCount(1);
  await expect(page.locator('[data-turn="turn-73"]')).toHaveCount(0);
});

test("terminal switch cancels stale latest; no-overlap refresh resets page and cursor", async ({ page }) => {
  const { open, model, result } = await setup(page, "messages", { delayLatest: true });
  await open();
  await expect.poll(() => !!model.pending).toBe(true);
  const old = model.pending!, oldPage = result();
  model.delayLatest = false;
  model.data = turns("responses", 250);
  await page.getByRole("button", { name: "Review", exact: true }).tap();
  await open();
  await expect(page.locator('[data-turn="turn-249"]')).toBeVisible();
  await old.fulfill({ json: oldPage }).catch(() => {});
  await expect(page.locator('[data-turn="turn-172"]')).toHaveCount(0);
  model.data = turns("responses", 320);
  model.delayOlder = true;
  await expect(page.locator('[data-turn="turn-319"]')).toBeVisible({ timeout: 7000 });
  await expect(page.locator(".conversation article")).toHaveCount(50);
  for (let i = 0; i < 20 && !model.requests.some(url => url.includes("before=270")); i++) await wheel(page, -6000);
  expect(model.requests.some(url => url.includes("before=270"))).toBe(true);
  await hit(page.getByRole("button", { name: "Load older messages" }));
});

test("older prepend preserves visible anchor and Read preference survives Conversation", async ({ page }) => {
  const { open, model, result } = await setup(page);
  await page.getByRole("button", { name: "Terminal view", exact: true }).tap();
  await page.getByRole("button", { name: "Show readable text" }).tap();
  await open();
  await expect(page.locator('[data-turn="turn-172"]')).toBeVisible();
  model.delayOlder = true;
  for (let i = 0; i < 20 && !model.pending; i++) await wheel(page, -6000);
  expect(model.pending).toBeTruthy();
  const anchor = page.locator('[data-turn="turn-123"]');
  const before = (await anchor.boundingBox())!.y;
  await hit(page.getByRole("button", { name: "Load older messages" }));
  await model.pending!.fulfill({ json: result("123") });
  await expect(page.locator('[data-turn="turn-73"]')).toBeAttached();
  expect(Math.abs((await anchor.boundingBox())!.y - before)).toBeLessThan(3);
  await page.getByRole("button", { name: "Terminal view", exact: true }).tap();
  await expect(page.locator(".terminal-read")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("herdr-phone.terminal-view"))).toBe("read");
});

test("revoked authentication cancels a delayed page and returns pairing", async ({ page }) => {
  const { open, model } = await setup(page, "messages", { delayLatest: true });
  await open();
  await expect.poll(() => !!model.pending).toBe(true);
  await model.pending!.fulfill({ status: 401, json: { error: { code: "unauthorized", message: "Pair this phone to continue." } } });
  await expect(page.getByRole("heading", { name: "Your spaces, with you." })).toBeVisible();
  await expect(page.locator(".conversation")).toHaveCount(0);
});


test("bounded pages show trimming and keep empty continuation actionable", async ({ page }) => {
  const { model } = await setup(page, "messages", { delayLatest: true });
  await expect.poll(() => !!model.pending).toBe(true);
  model.delayLatest = false;
  model.page = { available: true, session: "bounded", revision: "1", turns: [], nextCursor: "older-window", warnings: ["long_output_trimmed", "scan_limited"] };
  await model.pending!.fulfill({ json: model.page });
  await expect(page.getByText("[long output trimmed]", { exact: true })).toBeVisible();
  await expect(page.getByText("Older messages remain beyond this read window.", { exact: true })).toBeVisible();
  await expect(page.getByText("No saved messages yet.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Beginning of conversation", { exact: true })).toHaveCount(0);
  const older = page.getByRole("button", { name: "Load older messages" });
  await hit(older);
  model.page = { ...model.page, turns: [{ id: "first", entries: [{ id: "first-user", role: "user", text: "First saved message" }] }], nextCursor: null, warnings: [] };
  await older.tap();
  await expect(page.getByText("First saved message", { exact: true })).toBeVisible();
  await expect(page.getByText("Beginning of conversation", { exact: true })).toBeVisible();
});

test("distinct unavailable reasons and reader errors recover without private details", async ({ page }) => {
  const { model } = await setup(page, "messages", { unavailable: true });
  const cases = [
    ["not_configured", "Saved conversation is not configured for this machine."],
    ["ambiguous", "More than one saved conversation matches this terminal."],
    ["offline", "The conversation machine is offline. Reconnect it and retry."],
    ["not_found", "No saved conversation was found for this terminal."],
  ] as const;
  for (const [reason, message] of cases) {
    model.reason = reason;
    await page.getByRole("button", { name: "Retry conversation" }).tap();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
  }
  model.unavailable = false; model.status = 503;
  for (const [code, message] of [
    ["conversation_too_large", "This conversation page is too large to display."],
    ["conversation_busy", "Conversation readers are busy. Please retry shortly."],
    ["conversation_timeout", "Loading saved conversation timed out. Please retry."],
    ["conversation_unavailable", "The saved conversation reader is unavailable. Please retry."],
    ["unknown", "Could not load saved conversation. Please retry."],
  ]) {
    model.code = code;
    await hit(page.getByRole("button", { name: "Retry conversation" }));
    await page.getByRole("button", { name: "Retry conversation" }).tap();
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await expect(page.locator(".conversation")).not.toContainText("private runtime information");
    await expect(page.locator(".conversation img")).toHaveCount(0);
  }
  model.malformed = true;
  await page.getByRole("button", { name: "Retry conversation" }).tap();
  await expect(page.getByText("Could not load saved conversation. Please retry.", { exact: true })).toBeVisible();
  model.malformed = false;
  model.network = true;
  await page.getByRole("button", { name: "Retry conversation" }).tap();
  await expect(page.getByText("Could not reach the bridge. Check your connection and retry.", { exact: true })).toBeVisible();
  model.network = false; model.status = 200;
  await page.getByRole("button", { name: "Retry conversation" }).tap();
  await expect(page.locator('[data-turn="turn-172"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry conversation" })).toBeHidden();
});


test("bounded turn fragments prepend older entries and reconcile latest overlap", async ({ page }) => {
  const { model } = await setup(page, "messages", { delayLatest: true });
  await expect.poll(() => !!model.pending).toBe(true);
  const entry = (id: string, text: string) => ({ id, role: "assistant" as const, text });
  model.delayLatest = false;
  model.page = { available: true, session: "fragments", revision: "1", turns: [{ id: "fragment", continuesPrevious: true, entries: [entry("b", "Newest B"), entry("c", "Newest C")] }], nextCursor: "older" };
  await model.pending!.fulfill({ json: model.page });
  await expect(page.getByText("Newest C", { exact: true })).toBeVisible();
  const older = page.getByRole("button", { name: "Load older messages" });
  await hit(older);
  model.page = { ...model.page, turns: [{ id: "fragment", entries: [entry("a", "Older A"), entry("b", "Stale B")] }], nextCursor: null };
  await older.tap();
  await expect(page.locator(".conversation [data-entry]")).toHaveText(["Older A", "Newest B", "Newest C"]);
  model.page = { ...model.page, revision: "2", turns: [{ id: "shifted-fragment", continuesPrevious: true, entries: [entry("c", "Updated C"), entry("d", "Latest D")] }], nextCursor: "new-window" };
  await expect(page.locator(".conversation [data-entry]")).toHaveText(["Older A", "Newest B", "Updated C", "Latest D"], { timeout: 7000 });
  await expect(page.locator(".conversation article")).toHaveCount(1);
  model.page = { ...model.page, revision: "3", turns: [{ id: "shifted-again", continuesPrevious: true, entries: [entry("c", "Updated C again"), entry("d", "Latest D")] }], nextCursor: "new-window" };
  await expect(page.locator('[data-entry="c"]')).toHaveText("Updated C again", { timeout: 7000 });
  await expect(page.locator(".conversation [data-entry]")).toHaveCount(4);
});
