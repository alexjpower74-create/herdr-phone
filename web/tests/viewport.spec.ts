import { test, expect, type Page } from "@playwright/test";

test.use({ isMobile: true });
const terminal = { id: "t1", title: "Build", state: "live", status: "idle", cols: 100, rows: 30 };
const state = { version: 1, revision: 1, machines: [{ id: "local", name: "Computer", online: true }], programs: [], spaces: [{ id: "work", machineId: "local", name: "Workbench", cwd: "", repo: null, branch: null, color: "#778899", tabs: [{ id: "build", name: "Build", terminals: [terminal] }] }] };

async function setup(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("herdr-phone.device", "test-device-token");
    const viewport = new EventTarget();
    const metrics = { height: innerHeight, width: innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 };
    for (const key of Object.keys(metrics)) Object.defineProperty(viewport, key, { get: () => metrics[key as keyof typeof metrics] });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    (window as any).setViewport = (next: Partial<typeof metrics>, event = "resize") => {
      Object.assign(metrics, next);
      viewport.dispatchEvent(new Event(event));
    };
  });
  await page.routeWebSocket("**/api/ws", ws => {
    ws.send(JSON.stringify({ type: "state", state }));
    ws.onMessage(() => {});
  });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path.endsWith("/screen")) return route.fulfill({ json: { terminal, text: "Review the selected files.\nThe terminal remains live.", screenId: "screen", complete: true, prompt: null } });
    if (path.endsWith("/conversation")) return route.fulfill({ json: { available: true, session: "saved", revision: "1", nextCursor: null, turns: [{ id: "turn", entries: [{ id: "user", role: "user", text: "Review the selected files." }, { id: "reply", role: "assistant", text: "The saved conversation remains readable." }] }] } });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "W Workbench", exact: true }).tap();
  await expect(page.locator(".terminal-input")).toBeVisible();
  await page.locator(".terminal-input").tap();
  await page.keyboard.insertText("Keep this draft");
  await expect(page.locator(".terminal-input")).toHaveValue("Keep this draft");
}

async function viewport(page: Page, height: number, offsetTop: number, event = "resize", scale = 1) {
  await page.evaluate(({ height, offsetTop, event, scale }) => (window as any).setViewport({ height, offsetTop, scale }, event), { height, offsetTop, event, scale });
}
async function checkLayout(page: Page, height: number, top: number) {
  await expect.poll(async () => page.locator("#app").evaluate(el => Math.round(el.getBoundingClientRect().height))).toBe(height);
  await expect.poll(async () => page.locator("#app").evaluate(el => Math.round(el.getBoundingClientRect().top))).toBe(top);
  const result = await page.evaluate(() => {
    const header = document.querySelector("header")!, dock = document.querySelector(".input-dock")!;
    const h = header.getBoundingClientRect(), d = dock.getBoundingClientRect();
    const selectors = ["header button", ".tab", ".terminal-input", ".attach-files", ".compose-send", ...Array.from({ length: 6 }, (_, i) => `.keybar button:nth-child(${i + 1})`)];
    const hits = selectors.map(selector => {
      const el = document.querySelector(selector)!;
      const r = el.getBoundingClientRect();
      return [6, r.height / 2, r.height - 6].every(y => [6, r.width / 2, r.width - 6].every(x => {
        const target = document.elementFromPoint(r.left + x, r.top + y);
        return target === el || (target !== null && el.contains(target));
      }));
    });
    return { headerTop: h.top, dockBottom: d.bottom, hits, scrollY, overflow: document.documentElement.scrollHeight - innerHeight, horizontal: document.documentElement.scrollWidth - innerWidth };
  });
  expect(result.headerTop).toBe(top);
  expect(result.dockBottom).toBe(top + height);
  expect(result.hits.every(Boolean)).toBe(true);
  expect(result.scrollY).toBe(0);
  expect(result.overflow).toBeLessThanOrEqual(0);
  expect(result.horizontal).toBeLessThanOrEqual(0);
}

test("keyboard shrink and pan keep the header, keys and compose inside the visible viewport", async ({ page }) => {
  await setup(page);
  await viewport(page, 400, 44);
  await checkLayout(page, 400, 44);
  await viewport(page, 400, 70, "scroll");
  await checkLayout(page, 400, 70);
  if (process.env.VIEWPORT_SHOT) await page.screenshot({ path: process.env.VIEWPORT_SHOT.replace(".png", `-${test.info().project.name}.png`), clip: { x: 0, y: 70, width: 390, height: 400 } });
  await viewport(page, 844, 0);
  await checkLayout(page, 844, 0);
  await expect(page.locator(".terminal-input")).toHaveValue("Keep this draft");
});

test("pinch zoom does not resize or pan the shell and reset resumes keyboard tracking", async ({ page }) => {
  await setup(page);
  await viewport(page, 420, 20);
  await checkLayout(page, 420, 20);
  await viewport(page, 210, 80, "resize", 2);
  await checkLayout(page, 420, 20);
  await viewport(page, 440, 0);
  await checkLayout(page, 440, 0);
  const meta = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(meta).toContain("maximum-scale=10");
  expect(meta).toContain("interactive-widget=resizes-content");
});
