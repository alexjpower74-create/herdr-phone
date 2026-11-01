import { test, expect, type Page } from "@playwright/test";
import { setup } from "./gesture-fixture";

async function touch(page: Page, type: string, points: { id: number; x: number; y: number }[]) {
  const impl = (page as any)._connection?.toImpl(page);
  const session = impl?.delegate?._pageProxySession;
  if (!session) throw new Error("Native WebKit touch dispatch is unavailable");
  await session.send("Input.dispatchTouchEvent", { type, touchPoints: points, modifiers: 0 });
}
async function start(page: Page) {
  const fixture = await setup(page);
  await expect(page.locator('.conversation [data-entry="reply-19"]')).toBeVisible();
  await page.getByRole('button', { name: 'Terminal view', exact: true }).tap();
  await page.evaluate(() => {
    (window as any).touchTrust = [];
    for (const name of ['touchstart', 'touchmove', 'touchend']) document.addEventListener(name, e => (window as any).touchTrust.push(e.isTrusted), { capture: true });
  });
  const box = await page.locator('.terminal-viewport').boundingBox();
  return { ...fixture, x: Math.round(box!.x + box!.width / 2), y: Math.round(box!.y + 30) };
}
async function drag(page: Page, x: number, y: number, dx = 0, dy = 100, cancel = false) {
  await touch(page, 'touchStart', [{ id: 1, x, y }]);
  for (let n = 1; n <= 5; n++) await touch(page, 'touchMove', [{ id: 1, x: x + dx * n / 5, y: y + dy * n / 5 }]);
  await touch(page, cancel ? 'touchCancel' : 'touchEnd', [{ id: 1, x: x + dx, y: y + dy }]);
}
test('deliberate top pull reveals earlier messages and returns to newest in Mirror and Read', async ({ page }) => {
  const { x, y, model } = await start(page);
  const watches = [...model.watches.values()];
  await page.locator('.terminal-input').fill('Keep this draft');
  await expect(page.getByText('Earlier messages are in Conversation ↑', { exact: true })).toBeVisible();
  for (const mode of ['mirror', 'read']) {
    if (mode === 'read') await page.getByRole('button', { name: 'Show readable text' }).tap();
    await touch(page, 'touchStart', [{ id: 1, x, y }]);
    await touch(page, 'touchMove', [{ id: 1, x, y: y + 20 }]);
    await expect(page.getByText('Earlier messages', { exact: true })).toBeVisible();
    await expect(page.locator('.terminal-viewport')).toBeVisible();
    await touch(page, 'touchMove', [{ id: 1, x, y: y + 110 }]);
    model.data.push({ id: `fresh-${mode}`, entries: [{ id: `fresh-${mode}`, role: 'assistant', text: `Newest ${mode} reply` }] } as any);
    await touch(page, 'touchEnd', [{ id: 1, x, y: y + 110 }]);
    const host = page.locator('.conversation');
    await expect(host.getByText(`Newest ${mode} reply`)).toBeVisible();
    await expect.poll(() => host.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(2);
    await page.mouse.move(x, y + 120); await page.mouse.wheel(0, -500);
    await expect.poll(() => host.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(100);
    await page.getByRole('button', { name: 'Terminal view', exact: true }).tap();
  }
  expect(await page.evaluate(() => (window as any).touchTrust)).toEqual(expect.arrayContaining([true]));
  expect(await page.evaluate(() => (window as any).touchTrust.every(Boolean))).toBe(true);
  await expect(page.locator('.terminal-input')).toHaveValue('Keep this draft');
  expect(model.calls).toEqual([]); expect([...model.watches.values()]).toEqual(watches);
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
