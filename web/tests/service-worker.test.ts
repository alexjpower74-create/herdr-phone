import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it, expect, vi } from "vitest";
function worker() {
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
      matchAll: vi.fn().mockResolvedValue([{ navigate, focus }]),
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
