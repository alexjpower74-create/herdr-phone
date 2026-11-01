import { Client } from "./client";

type Saved = { enabled: boolean; endpoint: string | null };
const bounded = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Notifications could not be checked. Try again.")), 12000);
  promise.then(resolve, reject).finally(() => clearTimeout(timer));
});

export function notificationSettings(dialog: HTMLDialogElement, client: Client) {
  const section = document.createElement("section");
  section.className = "notification-settings";
  const title = document.createElement("h3");
  title.textContent = "Notifications";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "settings-action notification-toggle";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-label", "Notifications");
  const status = document.createElement("p");
  status.className = "muted";
  status.setAttribute("role", "status");
  const retry = document.createElement("button");
  retry.textContent = "Check again";
  retry.className = "settings-action";
  const test = document.createElement("button");
  test.textContent = "Send test";
  test.className = "settings-action";
  section.append(title, toggle, status, test, retry);
  dialog.append(section);
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  let busy = false, enabled = false, saved: Saved | undefined;
  let registration: ServiceWorkerRegistration | undefined;
  const paint = (message: string) => {
    toggle.setAttribute("aria-checked", String(enabled));
    toggle.textContent = enabled ? "On" : "Off";
    toggle.disabled = busy || (!supported && !saved?.enabled);
    test.disabled = busy || !enabled;
    retry.disabled = busy;
    status.textContent = message;
  };
  const inspect = async () => {
    saved = await client.request<Saved>("/push/subscription");
    let subscription: PushSubscription | null = null;
    if (supported) {
      registration = await bounded(navigator.serviceWorker.ready);
      subscription = await registration.pushManager.getSubscription();
    }
    enabled = !!(supported && Notification.permission === "granted" && subscription &&
      (!subscription.expirationTime || subscription.expirationTime > Date.now()) &&
      saved.enabled && saved.endpoint === subscription.endpoint);
    if (!supported) return "On iPhone, use Share → Add to Home Screen, then open Herdr from its icon. Notifications require iOS 16.4 or later.";
    if (Notification.permission === "denied") return "Notifications are blocked. Allow Herdr in your device’s notification settings, then check again.";
    if (enabled) return "Get notified when a terminal needs you or finishes.";
    if (saved.enabled || subscription) return "Notifications need to be reconnected. Tap Off to reconnect this device.";
    return "Tap Off to turn notifications on. On iPhone, open Herdr from your Home Screen.";
  };
  const refresh = async () => {
    if (busy || !dialog.isConnected) return;
    busy = true;
    enabled = false;
    paint("Checking notifications…");
    try { const message = await inspect(); paint(message); }
    catch (error) { enabled = false; paint(`${(error as Error).message} Check your connection and try again.`); }
    finally { busy = false; paint(status.textContent!); }
  };
  toggle.onclick = async () => {
    if (busy) return;
    const disabling = enabled || (!supported && !!saved?.enabled);
    busy = true;
    enabled = false;
    paint(disabling ? "Turning notifications off…" : "Turning notifications on…");
    try {
      if (disabling) {
        // Remove server delivery first; retain the browser subscription if deletion fails.
        await client.request("/push/subscription", { endpoint: saved!.endpoint }, "DELETE");
        const subscription = await registration?.pushManager.getSubscription();
        if (subscription && !(await subscription.unsubscribe())) throw new Error("Browser subscription could not be removed. Check again.");
        saved = { enabled: false, endpoint: null };
        paint("Notifications are off.");
      } else {
        // Keep this call before any await: permission must belong to this tap.
        const permission = await Notification.requestPermission();
        if (permission !== "granted") throw new Error("Notifications are blocked. Allow Herdr in your device’s notification settings, then check again.");
        registration = await bounded(navigator.serviceWorker.ready);
        let subscription = await registration.pushManager.getSubscription();
        if (subscription?.expirationTime && subscription.expirationTime <= Date.now()) {
          if (!(await subscription.unsubscribe())) throw new Error("Expired subscription could not be removed. Try again.");
          subscription = null;
        }
        if (!subscription) {
          const { publicKey } = await client.request<{ publicKey: string }>("/push/key");
          const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
          subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        }
        await client.request("/push/subscription", subscription.toJSON());
        paint(await inspect());
      }
    } catch (error) {
      enabled = false;
      paint(`${(error as Error).message} Check again or tap Off to retry.`);
    } finally { busy = false; paint(status.textContent!); }
  };
  test.onclick = async () => {
    if (busy || !enabled) return;
    busy = true;
    paint("Sending test…");
    try {
      await client.request("/push/test", {});
      paint("Test accepted. Check your notifications; delivery may take a moment.");
    } catch (error) {
      enabled = false;
      paint(`${(error as Error).message} Check again before retrying.`);
    } finally { busy = false; paint(status.textContent!); }
  };
  retry.onclick = () => void refresh();
  const foreground = () => { if (!document.hidden) void refresh(); };
  const offline = () => { enabled = false; paint("Offline. Reconnect, then check again."); };
  window.addEventListener("focus", foreground);
  window.addEventListener("online", foreground);
  window.addEventListener("offline", offline);
  document.addEventListener("visibilitychange", foreground);
  dialog.addEventListener("close", () => {
    window.removeEventListener("focus", foreground);
    window.removeEventListener("online", foreground);
    window.removeEventListener("offline", offline);
    document.removeEventListener("visibilitychange", foreground);
  }, { once: true });
  void refresh();
}
