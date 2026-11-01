import { ECDH } from "node:crypto";
import type { Subscription } from "./security";

const providers = new Set([
  "web.push.apple.com",
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
]);
export function bytes(value: unknown, length: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Invalid subscription");
  const b = Buffer.from(value, "base64url");
  if (b.length !== length || b.toString("base64url") !== value)
    throw new Error("Invalid subscription");
  return b;
}
export function publicPoint(value: unknown) {
  const b = bytes(value, 65);
  if (b[0] !== 4) throw new Error("Invalid subscription");
  try {
    ECDH.convertKey(b, "prime256v1");
  } catch {
    throw new Error("Invalid subscription");
  }
  return b;
}
export function endpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || /[\s\\]/.test(value))
    throw new Error("Invalid subscription");
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error("Invalid subscription");
  }
  if (
    /^https:\/\/[^/]*@/i.test(value) ||
    value.includes("#") ||
    u.protocol !== "https:" ||
    !providers.has(u.hostname) ||
    u.port ||
    u.username ||
    u.password ||
    u.hash
  )
    throw new Error("Invalid subscription");
  return u.href;
}
export function subscription(value: any, now = Date.now()): Subscription {
  if (!value || typeof value !== "object" || !value.keys)
    throw new Error("Invalid subscription");
  const url = endpoint(value.endpoint);
  const expirationTime = value.expirationTime ?? null;
  if (
    expirationTime !== null &&
    (typeof expirationTime !== "number" ||
      !Number.isSafeInteger(expirationTime) ||
      expirationTime <= now)
  )
    throw new Error("Invalid subscription");
  publicPoint(value.keys.p256dh);
  bytes(value.keys.auth, 16);
  return {
    endpoint: url,
    expirationTime,
    keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
  };
}
