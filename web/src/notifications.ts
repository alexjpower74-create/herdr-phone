import { Client } from "./client";

type Saved = { enabled: boolean; endpoint: string | null };
const bounded = <T>(promise: Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Notifications could not be checked. Try again.")),
      12000,
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });

export function notificationSettings(
  dialog: HTMLDialogElement,
  client: Client,
) {
  const section = document.createElement("section");
  section.className = "notification-settings";
  const title = document.createElement("h3");
  title.textContent = "Notifications";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "settings-action notification-toggle";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-label", "Notifications");
  const disable = document.createElement("button");
  disable.textContent = "Turn off notifications";
  disable.className = "settings-action";
  const status = document.createElement("p");
  status.className = "muted";
  status.setAttribute("role", "status");
  const retry = document.createElement("button");
  retry.textContent = "Check again";
  retry.className = "settings-action";
  const test = document.createElement("button");
  test.textContent = "Send test";
  test.className = "settings-action";
  section.append(title, toggle, status, test, disable, retry);
  dialog.append(section);
  const supported =
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  const token = client.token;
  const alive = () =>
    dialog.open && dialog.isConnected && client.token === token;
  const ensureAlive = () => {
    if (!navigator.onLine)
      throw new Error("Offline. Reconnect, then check again.");
    if (!alive())
      throw new Error(
        "Settings closed. Check notification status when reopened.",
      );
  };
  let busy = false,
    enabled = false,
    known = false,
    saved: Saved | undefined;
  let registration: ServiceWorkerRegistration | undefined;
  const paint = (message: string) => {
    if (!alive()) return;
    toggle.setAttribute("aria-checked", String(enabled));
    toggle.dataset.state = known ? (enabled ? "on" : "off") : "unknown";
    toggle.textContent = known ? (enabled ? "On" : "Off") : "Check status";
    toggle.disabled = busy || !known || (!supported && !saved?.enabled);
    disable.hidden = !saved?.enabled;
    disable.disabled = busy;
    test.disabled = busy || !enabled;
    retry.disabled = busy;
    status.textContent = message;
  };
  const inspect = async () => {
    saved = await client.request<Saved>("/push/subscription");
    ensureAlive();
    let subscription: PushSubscription | null = null;
    if (supported) {
      registration = await bounded(navigator.serviceWorker.ready);
      subscription = await registration.pushManager.getSubscription();
      ensureAlive();
    }
    enabled = !!(
      supported &&
      Notification.permission === "granted" &&
      subscription &&
      (!subscription.expirationTime ||
        subscription.expirationTime > Date.now()) &&
      saved.enabled &&
      saved.endpoint === subscription.endpoint
    );
    known = true;
    if (!supported)
      return "On iPhone, use Share → Add to Home Screen, then open Herdr from its icon. Notifications require iOS 16.4 or later.";
    if (Notification.permission === "denied")
      return "Notifications are blocked. Allow Herdr in your device’s notification settings, then check again.";
    if (enabled) return "Get notified when a terminal needs you or finishes.";
    if (saved.enabled || subscription)
      return "Notifications need to be reconnected. Tap Off to reconnect this device.";
    return "Tap Off to turn notifications on. On iPhone, open Herdr from your Home Screen.";
  };
  const refresh = async () => {
    if (busy || !alive()) return;
    busy = true;
    known = false;
    enabled = false;
    paint("Checking notifications…");
    try {
      const message = await inspect();
      paint(message);
    } catch (error) {
      enabled = false;
      known = false;
      paint(`${(error as Error).message} Check your connection and try again.`);
    } finally {
      busy = false;
      paint(status.textContent!);
    }
  };
  const change = async (disabling: boolean) => {
    if (busy || !alive()) return;
    busy = true;
    enabled = false;
    known = false;
    paint(
      disabling ? "Turning notifications off…" : "Turning notifications on…",
    );
    try {
      if (disabling) {
        // Remove server delivery first; retain the browser subscription if deletion fails.
        await client.request(
          "/push/subscription",
          { endpoint: saved!.endpoint },
          "DELETE",
        );
        ensureAlive();
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription && !(await subscription.unsubscribe()))
          throw new Error(
            "Browser subscription could not be removed. Check again.",
          );
        ensureAlive();
        known = true;
        saved = { enabled: false, endpoint: null };
        paint("Notifications are off.");
      } else {
        // Keep this call before any await: permission must belong to this tap.
        const permission = await Notification.requestPermission();
        ensureAlive();
        if (permission !== "granted")
          throw new Error(
            "Notifications are blocked. Allow Herdr in your device’s notification settings, then check again.",
          );
        registration = await bounded(navigator.serviceWorker.ready);
        ensureAlive();
        let subscription = await registration.pushManager.getSubscription();
        ensureAlive();
        if (
          subscription?.expirationTime &&
          subscription.expirationTime <= Date.now()
        ) {
          if (!(await subscription.unsubscribe()))
            throw new Error(
              "Expired subscription could not be removed. Try again.",
            );
          ensureAlive();
          subscription = null;
        }
        if (!subscription) {
          const { publicKey } = await client.request<{ publicKey: string }>(
            "/push/key",
          );
          ensureAlive();
          const key = Uint8Array.from(
            atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")),
            (c) => c.charCodeAt(0),
          );
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: key,
          });
        }
        ensureAlive();
        await client.request("/push/subscription", subscription.toJSON());
        ensureAlive();
        paint(await inspect());
      }
    } catch (error) {
      enabled = false;
      known = false;
      paint(
        `${(error as Error).message} Notification status is unknown. Check again before retrying.`,
      );
    } finally {
      busy = false;
      paint(status.textContent!);
    }
  };
  toggle.onclick = () =>
    void change(enabled || (!supported && !!saved?.enabled));
  disable.onclick = () => void change(true);
  test.onclick = async () => {
    if (busy || !enabled) return;
    busy = true;
    paint("Sending test…");
    try {
      await client.request("/push/test", {});
      paint(
        "Test accepted. Check your notifications; delivery may take a moment.",
      );
    } catch (error) {
      enabled = false;
      known = false;
      paint(`${(error as Error).message} Check again before retrying.`);
    } finally {
      busy = false;
      paint(status.textContent!);
    }
  };
  retry.onclick = () => void refresh();
  const foreground = () => {
    if (!document.hidden) void refresh();
  };
  const offline = () => {
    enabled = false;
    known = false;
    paint("Offline. Reconnect, then check again.");
  };
  window.addEventListener("focus", foreground);
  window.addEventListener("online", foreground);
  window.addEventListener("offline", offline);
  document.addEventListener("visibilitychange", foreground);
  dialog.addEventListener(
    "close",
    () => {
      window.removeEventListener("focus", foreground);
      window.removeEventListener("online", foreground);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", foreground);
    },
    { once: true },
  );
  void refresh();
}
