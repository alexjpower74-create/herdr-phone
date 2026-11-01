import {
  test,
  expect,
  type Locator,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";

test.use({ isMobile: true });

const terminal = {
  id: "t1",
  title: "Build",
  state: "live",
  status: "blocked",
  cols: 200,
  rows: 120,
};
const state = {
  version: 1,
  revision: 1,
  machines: [{ id: "local", name: "This computer", online: true }],
  programs: [],
  spaces: [
    {
      id: "work",
      machineId: "local",
      name: "Workbench",
      cwd: "",
      repo: "sample",
      branch: "main",
      color: "#22a99a",
      tabs: [{ id: "build", name: "Build", terminals: [terminal] }],
    },
  ],
};
const prompt = {
  id: "approval",
  kind: "approval",
  options: [
    { id: "yes", label: "Yes, proceed", keys: ["enter"] },
    { id: "no", label: "No, cancel", keys: ["down", "enter"] },
  ],
};
const wideScreen = [
  ...Array.from({ length: 55 }, (_, i) =>
    `Earlier output ${i + 1}: checking project files.`.padEnd(200),
  ),
  ...Array(8).fill(" ".repeat(200)),
  "┌" + "─".repeat(198) + "┐",
  "Update complete",
  "The message is ready, including punctuation and Unicode: café 🙂.",
  "  File names, option labels and command output remain readable.",
  "─".repeat(200),
  "A long unbroken path wraps inside the phone:",
  "artifacts/" + "x".repeat(190),
  "╌".repeat(200),
  "Ready to continue",
  "The checks passed. Review the command below before choosing an option.",
  "",
  "  $ printf ready",
  "",
  "› 1. Yes, proceed",
  "  2. No, cancel",
  "",
  "Newest update: waiting for your choice.",
  ...Array(35).fill(" ".repeat(200)),
].join("\n");

async function setup(page: Page) {
  let text = wideScreen;
  const sockets: WebSocketRoute[] = [];
  const writes: { path: string; body: unknown }[] = [];
  await page.addInitScript(() =>
    localStorage.setItem("herdr-phone.device", "test-device-token"),
  );
  const frame = () =>
    JSON.stringify({
      type: "screen",
      terminalId: "t1",
      cols: 200,
      rows: 120,
      text,
      screenId: "screen",
      prompt,
    });
  await page.routeWebSocket("**/api/ws", (ws) => {
    sockets.push(ws);
    ws.onMessage((raw) => {
      if (JSON.parse(String(raw)).type === "watch") ws.send(frame());
    });
    ws.send(JSON.stringify({ type: "state", state }));
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST")
      writes.push({ path, body: request.postDataJSON() });
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path.endsWith("/screen"))
      return route.fulfill({
        json: { terminal, text, complete: true, screenId: "screen", prompt },
      });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "W Workbench sample · main" }).tap();
  await page
    .getByRole("button", { name: "Yes, proceed", exact: true })
    .waitFor();
  await page.evaluate(() => document.fonts.ready);
  return {
    writes,
    update(next: string) {
      text = next;
      for (const socket of sockets) socket.send(frame());
    },
  };
}

test("200-column screen is readable by default without horizontal page scroll", async ({
  page,
}) => {
  await setup(page);
  const effectiveFont = await page.evaluate(() => {
    const read = document.querySelector<HTMLElement>(".terminal-read");
    if (read)
      return (
        (parseFloat(getComputedStyle(read).fontSize) *
          read.getBoundingClientRect().width) /
        read.offsetWidth
      );
    const canvas = document.querySelector<HTMLElement>(".terminal-canvas")!;
    const rows = canvas.querySelector<HTMLElement>(".xterm-rows")!;
    return (
      (parseFloat(getComputedStyle(rows).fontSize) *
        canvas.getBoundingClientRect().width) /
      canvas.offsetWidth
    );
  });
  console.log(
    `Rendered font: ${effectiveFont.toFixed(2)}px at 390px / 200 columns`,
  );
  expect(effectiveFont).toBeGreaterThanOrEqual(12);
  const read = page.locator(".terminal-read");
  await expect(read).toBeVisible();
  await expect(read).toContainText("Newest update: waiting for your choice.");
  expect(
    await read.evaluate((el) => getComputedStyle(el).fontFamily),
  ).toContain("JetBrains Mono");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  expect(await read.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  const lines = await read.locator(".read-line").allTextContents();
  expect(lines.every((line) => line === line.trimEnd())).toBe(true);
  expect(lines.join("\n")).not.toMatch(/\n{3}/);
  expect(await read.locator(".read-rule").count()).toBe(3);
  expect(
    await read
      .locator(".read-rule")
      .evaluateAll((els) =>
        els.every((el) => el.getBoundingClientRect().width <= 366),
      ),
  ).toBe(true);
  const viewport = page.locator(".terminal-viewport");
  await expect
    .poll(() =>
      viewport.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeLessThan(3);
  const newest = read
    .locator(".read-line")
    .filter({ hasText: "Newest update:" });
  expect(
    await newest.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.x + r.width / 2,
        r.y + r.height / 2,
      );
      return hit === el || (hit !== null && el.contains(hit));
    }),
  ).toBe(true);
  if (process.env.WEB_CAPTURE_DIR)
    await page.screenshot({
      path: `${process.env.WEB_CAPTURE_DIR}/terminal-readable-${test.info().project.name}.png`,
    });
});

test.describe("screen scrolling", () => {
  // Mobile WebKit does not expose wheel input; use its desktop engine at the same phone viewport.
  test.use({ isMobile: false });
  async function settledPosition(viewport: Locator) {
    return viewport.evaluate(
      (el) =>
        new Promise<number>((resolve, reject) => {
          let previous = el.scrollTop;
          let stableFrames = 0;
          let frame = 0;
          const timeout = setTimeout(() => {
            cancelAnimationFrame(frame);
            reject(new Error("Terminal scrolling did not settle"));
          }, 5000);
          const sample = () => {
            const current = el.scrollTop;
            stableFrames =
              Math.abs(current - previous) < 0.1 ? stableFrames + 1 : 0;
            previous = current;
            if (stableFrames >= 6) {
              clearTimeout(timeout);
              resolve(current);
            } else frame = requestAnimationFrame(sample);
          };
          frame = requestAnimationFrame(sample);
        }),
    );
  }
  test("read view follows newest output until the person scrolls up", async ({
    page,
  }) => {
    const mock = await setup(page);
    const viewport = page.locator(".terminal-viewport");
    const read = page.locator(".terminal-read");
    await expect(read).toBeVisible();
    await expect
      .poll(() =>
        viewport.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThan(3);
    const bounds = await viewport.boundingBox();
    await page.mouse.move(
      bounds!.x + bounds!.width / 2,
      bounds!.y + bounds!.height / 2,
    );
    // Even a small upward movement pauses following; being near the bottom
    // must not override the person's direction on the next output frame.
    await page.mouse.wheel(0, -16);
    await expect
      .poll(() =>
        viewport.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeGreaterThan(5);
    const small = await settledPosition(viewport);
    expect(
      await viewport.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    ).toBeLessThan(32);
    mock.update(wideScreen.trimEnd() + "\nSmall-scroll update.");
    await expect(read).toContainText("Small-scroll update.");
    expect(Math.abs((await settledPosition(viewport)) - small)).toBeLessThan(3);
    await page.mouse.wheel(0, 10000);
    await expect
      .poll(() =>
        viewport.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThan(3);
    await settledPosition(viewport);
    await page.mouse.wheel(0, -700);
    await expect
      .poll(() =>
        viewport.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeGreaterThan(200);
    const prior = await settledPosition(viewport);
    mock.update(wideScreen);
    mock.update(wideScreen.trimEnd() + "\nAnother new line.");
    await expect(read).toContainText("Another new line.");
    expect(Math.abs((await settledPosition(viewport)) - prior)).toBeLessThan(3);
    await page.mouse.wheel(0, 10000);
    await expect
      .poll(() =>
        viewport.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThan(3);
    await settledPosition(viewport);
    mock.update(wideScreen.trimEnd() + "\nNewest arrival.");
    await expect(read).toContainText("Newest arrival.");
    await expect
      .poll(() =>
        viewport.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThan(3);
    await settledPosition(viewport);

    // Composited scrolling can advance before its scroll callback runs. Hold
    // that callback while real wheel input moves the viewport, then deliver an
    // output frame. Observe the position immediately after paint, before later
    // wheel frames could hide a momentary jump back to the bottom.
    await viewport.evaluate((el) => {
      const probe = { callbacksHeld: 0, paintedTop: null as number | null };
      const hold = (event: Event) => {
        if (event.target !== el) return;
        probe.callbacksHeld++;
        event.stopImmediatePropagation();
      };
      const read = el.querySelector(".terminal-read")!;
      const observer = new MutationObserver(() => {
        if (
          probe.paintedTop === null &&
          read.textContent?.includes("Output during scrolling.")
        )
          probe.paintedTop = el.scrollTop;
      });
      observer.observe(read, { childList: true });
      document.addEventListener("scroll", hold, true);
      (window as any).scrollProbe = probe;
      (window as any).releaseScrollProbe = () => {
        observer.disconnect();
        document.removeEventListener("scroll", hold, true);
      };
    });
    try {
      await page.mouse.wheel(0, -700);
      await expect
        .poll(() =>
          viewport.evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
          ),
        )
        .toBeGreaterThan(200);
      const during = await viewport.evaluate((el) => el.scrollTop);
      mock.update(wideScreen.trimEnd() + "\nOutput during scrolling.");
      await expect
        .poll(() => page.evaluate(() => (window as any).scrollProbe.paintedTop))
        .not.toBeNull();
      const probe = await page.evaluate(() => (window as any).scrollProbe);
      expect(probe.callbacksHeld).toBeGreaterThan(0);
      expect(probe.paintedTop).toBeLessThanOrEqual(during + 3);
      await settledPosition(viewport);
      expect(
        await viewport.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      ).toBeGreaterThan(200);
    } finally {
      await page.evaluate(() => (window as any).releaseScrollProbe());
    }
    const paused = await settledPosition(viewport);
    await page
      .getByRole("button", { name: "Show desktop mirror", exact: true })
      .tap();
    mock.update(wideScreen.trimEnd() + "\nUpdate while mirroring.");
    await expect(page.locator(".xterm-rows")).toContainText(
      "Update while mirroring.",
    );
    await page
      .getByRole("button", { name: "Show readable text", exact: true })
      .tap();
    await expect(read).toContainText("Update while mirroring.");
    expect(Math.abs((await settledPosition(viewport)) - paused)).toBeLessThan(
      3,
    );
  });
});

test("mirror toggle preserves the desktop grid and permits browser pinch zoom", async ({
  page,
}) => {
  const { writes } = await setup(page);
  const toggle = page.getByRole("button", {
    name: "Show desktop mirror",
    exact: true,
  });
  expect(
    await toggle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return [4, r.height / 2, r.height - 4].every((y) => {
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + y);
        return hit === el || (hit !== null && el.contains(hit));
      });
    }),
  ).toBe(true);
  await toggle.tap();
  await expect(page.locator(".terminal-canvas")).toBeVisible();
  await expect(page.locator(".terminal-read")).toBeHidden();
  await expect(page.locator(".terminal-info")).toContainText("200 × 120");
  await expect(page.locator(".xterm-accessibility-tree")).toContainText(
    "Earlier output 1:",
  );
  // The read-only mirror must not intercept the browser's native touch gestures.
  expect(
    await page.locator(".terminal-viewport").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.x + 30, r.y + 30) === el;
    }),
  ).toBe(true);
  expect(
    await page
      .locator(".terminal-viewport")
      .evaluate((el) => getComputedStyle(el).touchAction),
  ).toMatch(/pinch-zoom|^manipulation$/);
  const meta = await page
    .locator('meta[name="viewport"]')
    .getAttribute("content");
  expect(meta).not.toMatch(
    /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:,|$)/,
  );
  expect(meta).toContain("maximum-scale=10");
  const control = await page
    .getByRole("button", { name: "enter", exact: true })
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      const x = Math.round(r.x + 8),
        y = Math.round(r.y + 8);
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        hit: hit === el || (hit !== null && el.contains(hit)),
        color: getComputedStyle(el)
          .backgroundColor.match(/\d+/g)!
          .slice(0, 3)
          .map(Number),
      };
    });
  expect(control.hit).toBe(true);
  const mirrorCapture = await page.screenshot(
    process.env.WEB_CAPTURE_DIR
      ? {
          path: `${process.env.WEB_CAPTURE_DIR}/terminal-mirror-${test.info().project.name}.png`,
        }
      : {},
  );
  // Hit testing alone misses a composited terminal layer painting over the dock.
  const painted = await page.evaluate(
    async ({ png, x, y }) => {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = reject;
        image.src = `data:image/png;base64,${png}`;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
    },
    { png: mirrorCapture.toString("base64"), x: control.x, y: control.y },
  );
  expect(painted).toEqual(control.color);
  await page
    .getByRole("button", { name: "Show readable text", exact: true })
    .tap();
  await expect(page.locator(".terminal-read")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Yes, proceed", exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(0);
  await page.getByRole("button", { name: "Yes, proceed", exact: true }).tap();
  await expect
    .poll(() => writes)
    .toEqual([
      {
        path: "/api/terminals/t1/prompt",
        body: { promptId: "approval", optionId: "yes" },
      },
    ]);
});
