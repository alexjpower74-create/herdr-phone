import { test, expect } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import { Store } from "./security";
import { Push, endpoint, subscription } from "./push";
import { start } from "./index";
export function sample(path = "sample") {
  const ec = createECDH("prime256v1"); ec.generateKeys();
  return { endpoint: `https://web.push.apple.com/${path}`, expirationTime: null, keys: { p256dh: ec.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}
test("subscription validation enforces providers, expiration and valid keys", () => {
  const s = sample();
  expect(subscription(s)).toEqual(s);
  for (const host of ["https://fcm.googleapis.com/a", "https://updates.push.services.mozilla.com/a", "https://web.push.apple.com:443/a"]) expect(endpoint(host)).toBeTruthy();
  for (const url of ["http://web.push.apple.com/a", "https://web.push.apple.com.evil.test/a", "https://localhost/a", "https://127.0.0.1/a", "https://web.push.apple.com:8443/a", "https://a@web.push.apple.com/a", "https://web.push.apple.com/a#b", "https://web.push.apple.com\\@evil.test/a"]) expect(() => endpoint(url)).toThrow();
  for (const bad of [{ ...s, expirationTime: 0 }, { ...s, expirationTime: "tomorrow" }, { ...s, keys: { ...s.keys, auth: "AA" } }, { ...s, keys: { ...s.keys, p256dh: Buffer.alloc(65,4).toString("base64url") } }]) expect(() => subscription(bad)).toThrow();
});
test("push endpoints authenticate, isolate ownership, persist keys and prune permanent failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "push-test-"));
  const store = new Store(dir);
  const first = await store.exchange(await store.pairing(), "Phone");
  const second = await store.exchange(await store.pairing(), "Tablet");
  let statusCode = 201;
  const requests: any[] = [];
  const app = start({ port: 0, origin: "https://phone.example", core: { call: async () => ({}) }, store,
    pushTransport: async r => { requests.push(r); return { statusCode }; } });
  const request = (path: string, method = "GET", data?: object, token = first.token, origin = "https://phone.example") => fetch(`http://127.0.0.1:${app.server.port}/api/push/${path}`, { method, headers: { Authorization: `Bearer ${token}`, origin, "content-type": "application/json" }, body: data && JSON.stringify(data) });
  try {
    expect((await request("key", "GET", undefined, "bad")).status).toBe(401);
    expect((await request("key", "GET", undefined, first.token, "https://evil.example")).status).toBe(401);
    const key = await (await request("key")).json();
    expect(key.publicKey).toHaveLength(87);
    expect(await (await request("key")).json()).toEqual(key);
    expect((await stat(join(dir,"vapid.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await request("test", "POST", {})).status).toBe(409);
    const s = sample();
    expect((await request("subscription", "POST", s)).status).toBe(201);
    expect((await request("subscription", "POST", s, second.token)).status).toBe(409);
    expect((await request("subscription", "DELETE", { endpoint: s.endpoint }, second.token)).status).toBe(204);
    expect(await (await request("subscription")).json()).toEqual({ enabled: true, endpoint: s.endpoint });
    expect((await request("test", "POST", {})).status).toBe(202);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers["Content-Encoding"]).toBe("aes128gcm");
    expect(requests[0].headers.Authorization).toStartWith("vapid ");
    expect(requests[0].body.length).toBeGreaterThan(100);
    expect(requests[0].body.toString()).not.toContain("Notifications are on");
    statusCode = 503;
    expect((await request("test", "POST", {})).status).toBe(502);
    expect((await store.subscription(first.device.id))?.endpoint).toBe(s.endpoint);
    statusCode = 410;
    expect((await request("test", "POST", {})).status).toBe(502);
    expect(await store.subscription(first.device.id)).toBeUndefined();
    await store.setSubscription(first.device.id, s);
    await store.revoke(first.device.id);
    expect((await store.read()).devices.some(d => d.subscription?.endpoint === s.endpoint)).toBe(false);
    await writeFile(join(dir,"vapid.json"), "{}");
    await expect(new Push(store,"https://phone.example").keys()).rejects.toMatchObject({ code: "push_keys_invalid" });
  } finally { app.stop(); await rm(dir, { recursive: true, force: true }); }
});
