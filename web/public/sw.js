self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
// Authenticated requests and terminal content are never cached.
function safePath(value) {
  if (value === "/") return "/";
  if (typeof value !== "string" || !value.startsWith("/#terminal=")) return "/";
  const encoded = value.slice(12);
  try {
    const id = decodeURIComponent(encoded);
    if (id.length > 160 || !/^(?:[a-zA-Z0-9_.-]+\/)?t[0-9]+$/.test(id)) return "/";
    if (encodeURIComponent(id) !== encoded) return "/";
    return `/#terminal=${encodeURIComponent(id)}`;
  } catch { return "/"; }
}
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data.json() || {};
  } catch {}
  const url = safePath(payload?.url);
  event.waitUntil(
    self.registration.showNotification("Herdr", {
      body:
        (payload.body === "Notifications are on") ||
        typeof payload.body === "string" &&
        payload.body.length <= 240 &&
        /^[^\x00-\x1f\x7f]+ (?:needs you|finished)$/.test(payload.body)
          ? payload.body
          : "A terminal needs you",
      tag: typeof payload.tag === "string" ? payload.tag.slice(0, 240) : undefined,
      data: { url },
      icon: "/icon-192.png",
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(safePath(event.notification.data?.url), self.location.origin)
    .href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        for (const client of clients) {
          if ("navigate" in client && new URL(client.url || self.location.origin).origin === self.location.origin) {
            await client.navigate(url);
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
