import { test, expect, type Page } from "@playwright/test";
import { setup } from "./gesture-fixture";

async function touch(page: Page, type: string, points: { id: number; x: number; y: number }[]) {
  const impl = (page as any)._connection?.toImpl(page);
  const session = impl?.delegate?._pageProxySession;
  if (!session) throw new Error("Native WebKit touch dispatch is unavailable");
  await session.send("Input.dispatchTouchEvent", { type, touchPoints: points, modifiers: 0 });
}
async function wheel(page: Page, x: number, y: number, deltaY: number) {
  const session = (page as any)._connection?.toImpl(page)?.delegate?._pageProxySession;
  if (!session) throw new Error("Native WebKit wheel dispatch is unavailable");
  await session.send("Input.dispatchWheelEvent", { x, y, deltaX: 0, deltaY, modifiers: 0 });
}
async function start(page: Page) {
  const fixture = await setup(page);
  await expect(page.locator('.conversation [data-entry="reply-19"]')).toBeVisible();
  await page.getByRole('button', { name: 'Terminal view', exact: true }).tap();
  await page.evaluate(() => {
    (window as any).touchTrust = [];
    (window as any).touchMoves = [];
    document.addEventListener("touchmove", e => (window as any).touchMoves.push(e.defaultPrevented));
    for (const name of ['touchstart', 'touchmove', 'touchend']) document.addEventListener(name, e => (window as any).touchTrust.push({ type: e.type, trusted: e.isTrusted }), { capture: true });
  });
  const box = await page.locator('.terminal-viewport').boundingBox();
  expect(await page.locator('.terminal-viewport').evaluate(el => {
    const r = el.getBoundingClientRect();
    return [r.top + 4, r.top + r.height / 2, r.bottom - 4].every(y => {
      const hit = document.elementFromPoint(r.left + r.width / 2, y);
      return hit === el || el.contains(hit);
    });
  })).toBe(true);
  const x = Math.round(box!.x + box!.width / 2), y = Math.round(box!.y + 30);
  expect(await page.locator('.terminal-viewport').evaluate((el, { x, y }) => { const hit = document.elementFromPoint(x, y); return hit === el || el.contains(hit); }, { x, y })).toBe(true);
  return { ...fixture, x, y };
}
async function drag(page: Page, x: number, y: number, dx = 0, dy = 100, cancel = false) {
  await touch(page, 'touchStart', [{ id: 1, x, y }]);
  for (let n = 1; n <= 5; n++) await touch(page, 'touchMove', [{ id: 1, x: x + dx * n / 5, y: y + dy * n / 5 }]);
  await touch(page, cancel ? 'touchCancel' : 'touchEnd', [{ id: 1, x: x + dx, y: y + dy }]);
}
test('deliberate top pull reveals earlier messages and returns to newest in Mirror and Read', async ({ page }) => {
  const { x, y, model, publishScreen } = await start(page);
  const watches = model.watchCalls.length;
  await page.locator('.terminal-input').fill('Keep this draft');
  await page.locator('input[type=file]').setInputFiles({ name: 'sample.txt', mimeType: 'text/plain', buffer: Buffer.from('A saved attachment') });
  await page.locator('.terminal-input').blur();
  await expect(page.getByText('Earlier messages are in Conversation ↑', { exact: true })).toBeVisible();
  for (const mode of ['mirror', 'read']) {
    if (mode === 'read') await page.getByRole('button', { name: 'Show readable text' }).tap();
    await touch(page, 'touchStart', [{ id: 1, x, y }]);
    await touch(page, 'touchMove', [{ id: 1, x, y: y + 20 }]);
    await expect(page.getByText('Earlier messages', { exact: true })).toBeVisible();
    publishScreen(`Screen update during ${mode} pull`);
    await expect(page.locator('.terminal-history-hint')).toHaveText('Earlier messages');
    await expect(page.locator('.terminal-viewport')).toBeVisible();
    if (process.env.GESTURE_SHOTS) await page.screenshot({ path: `${process.env.GESTURE_SHOTS}/pull-${mode}.png` });
    await touch(page, 'touchMove', [{ id: 1, x, y: y + 110 }]);
    model.data.push({ id: `fresh-${mode}`, entries: [{ id: `fresh-${mode}`, role: 'assistant', text: `Newest ${mode} reply` }] } as any);
    await touch(page, 'touchEnd', [{ id: 1, x, y: y + 110 }]);
    const host = page.locator('.conversation');
    await expect(host.getByText(`Newest ${mode} reply`)).toBeVisible();
    if (process.env.GESTURE_SHOTS) await page.screenshot({ path: `${process.env.GESTURE_SHOTS}/newest-${mode}.png` });
    await expect.poll(() => host.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
    await wheel(page, x, y + 120, -500);
    await expect.poll(() => host.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(100);
    await page.getByRole('button', { name: 'Terminal view', exact: true }).tap();
  }
  expect(await page.evaluate(() => (window as any).touchTrust.every((e: any) => e.trusted))).toBe(true);
  const counts = await page.evaluate(() => (window as any).touchTrust.reduce((counts: any, e: any) => { counts[e.type] = (counts[e.type] || 0) + 1; return counts; }, {}));
  expect(counts).toMatchObject({ touchstart: 4, touchmove: 4, touchend: 4 });
  await expect(page.locator('.terminal-input')).toHaveValue('Keep this draft');
  await expect(page.getByText('sample.txt', { exact: true })).toBeVisible();
  await expect(page.locator('.terminal-input')).not.toBeFocused();
  expect(await page.evaluate(() => (window as any).touchMoves.some(Boolean))).toBe(true);
  await expect(page.locator('.keybar button')).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'Yes, proceed', exact: true })).toBeVisible();
  expect(model.calls).toEqual([]); expect(model.watchCalls.length).toBe(watches);
});
for (const [name, dx, dy, cancel] of [['short', 0, 25, false], ['horizontal', 100, 20, false], ['upward', 0, -25, false], ['cancelled', 0, 100, true]] as const) test(`${name} gesture stays in Terminal`, async ({ page }) => {
  const { x, y } = await start(page); await drag(page, x, y, dx, dy, cancel);
  await expect(page.locator('.terminal-viewport')).toBeVisible();
  await expect(page.locator('.conversation')).toBeHidden();
});
test('multi-touch cancels pull until all fingers lift', async ({ page }) => {
  const { x, y } = await start(page);
  await touch(page, 'touchStart', [{ id: 1, x, y }]);
  await touch(page, 'touchMove', [{ id: 1, x, y: y + 20 }]);
  await touch(page, 'touchStart', [{ id: 1, x, y: y + 20 }, { id: 2, x: x + 30, y }]);
  await touch(page, 'touchMove', [{ id: 1, x, y: y + 120 }, { id: 2, x: x + 30, y: y + 100 }]);
  await touch(page, 'touchEnd', [{ id: 1, x, y: y + 120 }, { id: 2, x: x + 30, y: y + 100 }]);
  await expect(page.locator('.terminal-viewport')).toBeVisible();
});

test('a pull that retreats below threshold does not hand off', async ({ page }) => {
  const { x, y } = await start(page);
  await touch(page, 'touchStart', [{ id: 1, x, y }]);
  await touch(page, 'touchMove', [{ id: 1, x, y: y + 100 }]);
  await touch(page, 'touchMove', [{ id: 1, x, y: y + 3 }]);
  await touch(page, 'touchEnd', [{ id: 1, x, y: y + 3 }]);
  await expect(page.locator('.terminal-viewport')).toBeVisible();
});

test('zoom metrics reject a single finger pull without preventing native movement', async ({ page }) => {
  const { x, y } = await start(page);
  await page.evaluate(() => Object.defineProperty(window.visualViewport!, 'scale', { configurable: true, value: 2 }));
  await drag(page, x, y);
  await expect(page.locator('.terminal-viewport')).toBeVisible();
  expect(await page.evaluate(() => (window as any).touchMoves)).toEqual([false, false, false, false, false]);
  expect(await page.locator('.terminal-viewport').evaluate(el => getComputedStyle(el).touchAction)).toContain('pinch-zoom');
});

test('touch beginning in scrollback cannot hand off after reaching the top', async ({ page }) => {
  const { x, y, publishScreen } = await start(page);
  publishScreen('Retained terminal line\n'.repeat(100));
  // Real wheel positions the scrollable Read view; native WebKit touch panning
  // is not implemented on this host, so no platform scrolling claim is made.
  await page.getByRole('button', { name: 'Show readable text' }).tap();
  await expect(page.locator('.terminal-read')).toContainText('Retained terminal line', { timeout: 6000 });
  await wheel(page, x, y + 100, 500);
  await expect.poll(() => page.locator('.terminal-viewport').evaluate(el => el.scrollTop)).toBeGreaterThan(50);
  await touch(page, 'touchStart', [{ id: 1, x, y }]);
  await wheel(page, x, y + 100, -10000);
  await expect.poll(() => page.locator('.terminal-viewport').evaluate(el => el.scrollTop)).toBeLessThan(1);
  await touch(page, 'touchMove', [{ id: 1, x, y: y + 100 }]);
  await touch(page, 'touchEnd', [{ id: 1, x, y: y + 100 }]);
  await expect(page.locator('.terminal-viewport')).toBeVisible();
  expect(await page.evaluate(() => (window as any).touchMoves.every((v: boolean) => !v))).toBe(true);
});

for (const change of ['view', 'terminal', 'disconnect', 'hidden']) test(`${change} change cancels held pull`, async ({ page }) => {
  const { x, y, model } = await start(page);
  if (change === 'view') await page.getByRole('button', { name: 'Show readable text' }).focus();
  if (change === 'terminal') await page.getByRole('button', { name: 'Review', exact: true }).focus();
  await touch(page, 'touchStart', [{ id: 1, x, y }]);
  await touch(page, 'touchMove', [{ id: 1, x, y: y + 100 }]);
  if (change === 'view') await page.keyboard.press('Enter');
  if (change === 'terminal') {
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Terminal view', exact: true }).focus();
    await page.keyboard.press('Enter');
  }
  if (change === 'disconnect') {
    for (const ws of model.sockets) ws.close();
    await expect(page.getByText(/Connection lost/)).toBeVisible();
  }
  if (change === 'hidden') await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });
  await touch(page, 'touchEnd', [{ id: 1, x, y: y + 100 }]);
  await expect(page.locator('.terminal-viewport')).toBeVisible();
});
