import { test, expect, type Page } from "@playwright/test";

// Browser push APIs are fakes: these checks do not measure provider or phone delivery.
async function setup(
  page: Page,
  options: {
    permission?: string;
    saved?: boolean;
    browser?: boolean;
    supported?: boolean;
    expired?: boolean;
  } = {},
) {
  const calls: { method: string; path: string; body: any }[] = [];
  let saved = options.saved ?? false;
  let fail = "";
  await page.addInitScript((options) => {
    localStorage.setItem("herdr-phone.device", "test-device-token");
    const fake = ((window as any).fakePush = {
      permission: options.permission ?? "default",
      subscription: options.browser ?? false,
      order: [] as string[],
      activations: [] as boolean[],
      expired: options.expired ?? false,
    });
    if (options.supported === false) {
      delete (window as any).PushManager;
      delete (window as any).Notification;
      return;
    }
    Object.defineProperty(window, "PushManager", {
      configurable: true,
      value: class {},
    });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: {
        get permission() {
          return fake.permission;
        },
        requestPermission() {
          fake.activations.push(navigator.userActivation.isActive);
          if (fake.permission !== "denied") fake.permission = "granted";
          return Promise.resolve(fake.permission);
        },
      },
    });
    const subscription = {
      endpoint: "https://web.push.apple.com/test-device",
      get expirationTime() {
        return fake.expired ? 1 : null;
      },
      toJSON() {
        return {
          endpoint: this.endpoint,
          expirationTime: null,
          keys: { p256dh: "mock-public-key", auth: "mock-auth" },
        };
      },
      async unsubscribe() {
        fake.order.push("unsubscribe");
        fake.subscription = false;
        fake.expired = false;
        return true;
      },
    };
    const registration = {
      pushManager: {
        async getSubscription() {
          return fake.subscription ? subscription : null;
        },
        async subscribe() {
          fake.subscription = true;
          return subscription;
        },
      },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        ready: Promise.resolve(registration),
        register: async () => registration,
      },
    });
  }, options);
  await page.routeWebSocket("**/api/ws", () => {});
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method();
    const body = request.postData() ? request.postDataJSON() : undefined;
    calls.push({ method, path, body });
    expect(request.headers().authorization).toBe("Bearer test-device-token");
    if (path === "/api/state")
      return route.fulfill({
        json: {
          version: 1,
          revision: 1,
          machines: [],
          spaces: [],
          programs: [],
        },
      });
    if (fail === path)
      return route.fulfill({
        status: 502,
        json: { error: { code: "push_failed", message: "Connection failed" } },
      });
    if (path.endsWith("/key"))
      return route.fulfill({ json: { publicKey: "AQID" } });
    if (path.endsWith("/test"))
      return route.fulfill({ status: 202, json: { ok: true } });
    if (path.endsWith("/subscription")) {
      if (method === "DELETE") {
        saved = false;
        await page.evaluate(() =>
          (window as any).fakePush.order.push("delete"),
        );
        return route.fulfill({ status: 204 });
      }
      if (method === "POST") saved = true;
      return route.fulfill({
        status: method === "POST" ? 201 : 200,
        json:
          method === "POST"
            ? { ok: true }
            : {
                enabled: saved,
                endpoint: saved
                  ? "https://web.push.apple.com/test-device"
                  : null,
              },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "•••" }).tap();
  if (options.supported !== false)
    await expect(
      page.getByRole("switch", { name: "Notifications" }),
    ).toBeEnabled({ timeout: 3000 });
  return {
    calls,
    setFail: (path: string) => {
      fail = path;
    },
    setSaved: (value: boolean) => {
      saved = value;
    },
  };
}
const toggle = (page: Page) =>
  page.getByRole("switch", { name: "Notifications" });
async function hit(page: Page) {
  expect(
    await toggle(page).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.height >= 44 &&
        [3, r.height / 2, r.height - 3].every((y) => {
          const target = document.elementFromPoint(r.x + r.width / 2, r.y + y);
          return target === el || (!!target && el.contains(target));
        })
      );
    }),
  ).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= 390),
  ).toBe(true);
}

test("enable from a real tap, test, reopen and server-first disable", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  await hit(page);
  await toggle(page).tap();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  expect(
    await page.evaluate(() => (window as any).fakePush.activations),
  ).toEqual([true]);
  const post = calls.find(
    (c) => c.path.endsWith("/subscription") && c.method === "POST",
  );
  expect(post?.body).toMatchObject({
    endpoint: "https://web.push.apple.com/test-device",
    keys: { auth: "mock-auth" },
  });
  await page.getByRole("button", { name: "Send test", exact: true }).tap();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Test accepted",
  );
  expect(calls.find((c) => c.path.endsWith("/test"))?.body).toEqual({});
  await page.getByRole("button", { name: "×", exact: true }).tap();
  await page.getByRole("button", { name: "•••" }).tap();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await hit(page);
  if (process.env.WEB_CAPTURE_DIR && test.info().project.name === "webkit") {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: `${process.env.WEB_CAPTURE_DIR}/notifications-webkit.png`,
    });
  }
  await toggle(page).tap();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Notifications are off",
  );
  expect(await page.evaluate(() => (window as any).fakePush.order)).toEqual([
    "delete",
    "unsubscribe",
  ]);
  expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({
    endpoint: "https://web.push.apple.com/test-device",
  });
});

test("registration failure stays off and supports an explicit retry", async ({
  page,
}) => {
  const control = await setup(page);
  control.setFail("/api/push/subscription");
  await toggle(page).tap();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Connection failed",
  );
  await expect(toggle(page)).toHaveAttribute("data-state", "unknown");
  await expect(page.getByRole("button", { name: "Send test" })).toBeDisabled();
  control.setFail("");
  await page.getByRole("button", { name: "Check again" }).tap();
  await toggle(page).tap();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
});

test("failed delete never unsubscribes the browser", async ({ page }) => {
  const control = await setup(page, {
    saved: true,
    browser: true,
    permission: "granted",
  });
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  control.setFail("/api/push/subscription");
  await toggle(page).tap();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Connection failed",
  );
  expect(await page.evaluate(() => (window as any).fakePush.order)).toEqual([]);
  await expect(toggle(page)).toHaveAttribute("data-state", "unknown");
});

test("denied permission never registers or claims enabled", async ({
  page,
}) => {
  const { calls } = await setup(page, { permission: "denied" });
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "blocked",
  );
  await toggle(page).tap();
  await expect(toggle(page)).toHaveAttribute("data-state", "unknown");
  expect(calls.some((c) => c.method === "POST")).toBe(false);
});

for (const options of [
  { saved: true },
  { browser: true, permission: "granted" },
  { saved: true, browser: true, permission: "denied" },
  { saved: true, browser: true, permission: "granted", expired: true },
]) {
  test(`mismatched or expired state stays off ${JSON.stringify(options)}`, async ({
    page,
  }) => {
    await setup(page, options);
    await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
    await expect(
      page.getByRole("button", { name: "Send test" }),
    ).toBeDisabled();
  });
}

test("offline and provider error clear enabled and can be checked again", async ({
  page,
  context,
}) => {
  const control = await setup(page, {
    saved: true,
    browser: true,
    permission: "granted",
  });
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await context.setOffline(true);
  await expect(toggle(page)).toHaveAttribute("data-state", "unknown");
  await context.setOffline(false);
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  control.setFail("/api/push/test");
  await page.getByRole("button", { name: "Send test" }).tap();
  await expect(toggle(page)).toHaveAttribute("data-state", "unknown");
  control.setFail("");
  await page.getByRole("button", { name: "Check again" }).tap();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
});

test("unsupported browser shows Home Screen guidance", async ({ page }) => {
  await setup(page, { supported: false });
  await expect(toggle(page)).toBeDisabled();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Add to Home Screen",
  );
});

test("revoked device returns to pairing without enabled settings", async ({
  page,
}) => {
  await setup(page, { saved: true, browser: true, permission: "granted" });
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await page.route("**/api/push/subscription", (route) =>
    route.fulfill({
      status: 401,
      json: {
        error: {
          code: "unauthorized",
          message: "Pair this phone to continue.",
        },
      },
    }),
  );
  await page.getByRole("button", { name: "Check again" }).tap();
  await expect(page.getByLabel("Pairing code")).toBeVisible();
  await expect(toggle(page)).toHaveCount(0);
});

test("stale server registration can be turned off without browser permission", async ({
  page,
}) => {
  const { calls } = await setup(page, { saved: true, permission: "denied" });
  await page
    .getByRole("button", { name: "Turn off notifications", exact: true })
    .tap();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Notifications are off",
  );
  expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  expect(
    await page.evaluate(() => (window as any).fakePush.activations),
  ).toEqual([]);
});

test("dismissal during permission never registers after settings closes", async ({
  page,
}) => {
  const { calls } = await setup(page);
  await page.evaluate(() => {
    (window as any).Notification.requestPermission = () =>
      new Promise((resolve) => {
        (window as any).releasePermission = () => resolve("granted");
      });
  });
  await toggle(page).tap();
  await page.getByRole("button", { name: "×", exact: true }).tap();
  await page.evaluate(() => (window as any).releasePermission());
  await page.getByRole("button", { name: "•••" }).tap();
  await expect(toggle(page)).toBeEnabled();
  expect(calls.some((c) => c.method === "POST")).toBe(false);
});

test("browser permission revoked while away clears enabled on recheck", async ({
  page,
}) => {
  await setup(page, { saved: true, browser: true, permission: "granted" });
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await page.evaluate(() => {
    (window as any).fakePush.permission = "denied";
  });
  await page.getByRole("button", { name: "Check again" }).tap();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "blocked",
  );
  await expect(
    page.getByRole("button", { name: "Turn off notifications", exact: true }),
  ).toBeEnabled();
});

test("expired send-test subscription409 clears enabled until rechecked", async ({
  page,
}) => {
  await setup(page, { saved: true, browser: true, permission: "granted" });
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await page.route("**/api/push/test", (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: {
          code: "subscription_required",
          message: "Enable notifications first.",
        },
      },
    }),
  );
  await page.getByRole("button", { name: "Send test", exact: true }).tap();
  await expect(toggle(page)).toHaveAttribute("data-state", "unknown");
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Enable notifications first",
  );
  await expect(
    page.getByRole("button", { name: "Send test", exact: true }),
  ).toBeDisabled();
});

test("failed initial inspection on reopened settings never claims enabled", async ({
  page,
}) => {
  const control = await setup(page, {
    saved: true,
    browser: true,
    permission: "granted",
  });
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "×", exact: true }).tap();
  control.setFail("/api/push/subscription");
  await page.getByRole("button", { name: "•••" }).tap();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "Connection failed",
  );
  await expect(toggle(page)).toHaveAttribute("data-state", "unknown");
  await expect(toggle(page)).toBeDisabled();
  control.setFail("");
  await page.getByRole("button", { name: "Check again" }).tap();
  await expect(toggle(page)).toHaveAttribute("aria-checked", "true");
});
