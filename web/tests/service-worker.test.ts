import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it, expect, vi } from "vitest";
function worker(empty = false) {
  const listeners = new Map<string, (event: any) => void>();
  const showNotification = vi.fn().mockResolvedValue(undefined),
    navigate = vi.fn().mockResolvedValue(undefined),
    focus = vi.fn(),
    openWindow = vi.fn();
  const self = {
    addEventListener: (type: string, fn: (event: any) => void) =>
      listeners.set(type, fn),
    skipWaiting: vi.fn(),
    registration: { showNotification },
    location: { origin: "https://phone.example" },
    clients: {
      claim: vi.fn(),
      matchAll: vi.fn().mockResolvedValue(empty ? [] : [{ navigate, focus }]),
      openWindow,
    },
  };
  runInNewContext(
    readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"),
    { self, URL },
  );
  return { listeners, showNotification, navigate, focus, openWindow };
}
describe("notification privacy and navigation", () => {
  it("does not cache authenticated API or terminal content", () => {
    const w = worker();
    expect(w.listeners.has("fetch")).toBe(false);
  });
  it("keeps terminal content and external URLs out of notifications", async () => {
    const w = worker();
    let done: Promise<unknown> | undefined;
    w.listeners.get("push")!({
      data: {
        json: () => ({
          body: "private terminal output",
          url: "https://elsewhere.example/",
          tag: "turn-1",
        }),
      },
      waitUntil: (p: Promise<unknown>) => (done = p),
    });
    await done;
    expect(w.showNotification).toHaveBeenCalledWith(
      "Herdr",
      expect.objectContaining({
        body: "A terminal needs you",
        data: { url: "/" },
      }),
    );
  });
  it.each([
    "Workbench / Build needs you",
    "Workbench finished",
    "A terminal finished",
  ])("preserves layout notification wording: %s", async (body) => {
    const w = worker();
    let done: Promise<unknown> | undefined;
    w.listeners.get("push")!({
      data: { json: () => ({ body, url: "/#terminal=t1" }) },
      waitUntil: (p: Promise<unknown>) => (done = p),
    });
    await done;
    expect(w.showNotification).toHaveBeenCalledWith(
      "Herdr",
      expect.objectContaining({ body }),
    );
  });
  it("opens the encoded terminal deep link in an existing window", async () => {
    const w = worker();
    let done: Promise<unknown> | undefined;
    const close = vi.fn();
    w.listeners.get("notificationclick")!({
      notification: { close, data: { url: "/#terminal=remote%2Ft3" } },
      waitUntil: (p: Promise<unknown>) => (done = p),
    });
    await done;
    expect(close).toHaveBeenCalled();
    expect(w.navigate).toHaveBeenCalledWith(
      "https://phone.example/#terminal=remote%2Ft3",
    );
    expect(w.focus).toHaveBeenCalled();
    expect(w.openWindow).not.toHaveBeenCalled();
  });
});

async function pushBody(body: unknown, url = "/") {
  const w = worker();
  let done: Promise<unknown> | undefined;
  w.listeners.get("push")!({
    data: { json: () => ({ body, url }) },
    waitUntil: (p: Promise<unknown>) => (done = p),
  });
  await done;
  return w;
}
it("preserves the exact fixed test notification body", async () => {
  const w = await pushBody("Notifications are on");
  expect(w.showNotification).toHaveBeenCalledWith(
    "Herdr",
    expect.objectContaining({
      body: "Notifications are on",
      data: { url: "/" },
    }),
  );
});
it.each([
  "secret\nWorkbench finished",
  "x".repeat(241) + " finished",
  "Notifications are on secret",
  "secret\x7f finished",
])("rejects private or unbounded wording %s", async (body) => {
  const w = await pushBody(body);
  expect(w.showNotification).toHaveBeenCalledWith(
    "Herdr",
    expect.objectContaining({ body: "A terminal needs you" }),
  );
});
it.each([
  "https://elsewhere.example/#terminal=t1",
  "//elsewhere.example/",
  "javascript:alert(1)",
  "/#terminal=t1&secret=value",
  "/#terminal=%",
  "/#terminal=../t1",
  "/#terminal=remote%252Ft3",
  "/#terminal=t1#bad",
  "/#terminal=t1%0A",
  "/private",
])("validates hostile stored click data %s", async (url) => {
  const w = worker();
  let done: Promise<unknown> | undefined;
  w.listeners.get("notificationclick")!({
    notification: { close: () => {}, data: { url } },
    waitUntil: (p: Promise<unknown>) => (done = p),
  });
  await done;
  expect(w.navigate).toHaveBeenCalledWith("https://phone.example/");
});
it.each(["remote%2Ft3", "remote%2Ft2w", "t3a"])(
  "opens a terminal when no window exists: %s",
  async (encoded) => {
    const w = worker(true);
    let done: Promise<unknown> | undefined;
    w.listeners.get("notificationclick")!({
      notification: { close: () => {}, data: { url: `/#terminal=${encoded}` } },
      waitUntil: (p: Promise<unknown>) => (done = p),
    });
    await done;
    expect(w.openWindow).toHaveBeenCalledWith(
      `https://phone.example/#terminal=${encoded}`,
    );
  },
);
