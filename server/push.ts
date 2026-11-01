import webpush from "web-push";
import { createECDH, randomBytes } from "node:crypto";
import { readFile, open, rename, chmod } from "node:fs/promises";
import { join } from "node:path";
import { Store, Failure, invalid, type Subscription } from "./security";

import {
  bytes,
  publicPoint,
  endpoint as validateEndpoint,
  subscription as validateSubscription,
} from "./push-subscription";
export function endpoint(value: unknown) {
  try {
    return validateEndpoint(value);
  } catch {
    throw invalid();
  }
}
export function subscription(value: unknown, now = Date.now()) {
  try {
    return validateSubscription(value, now);
  } catch {
    throw invalid();
  }
}
export type PushRequest = {
  endpoint: string;
  method: string;
  headers: Record<string, string | number>;
  body: Buffer;
  timeout?: number;
};
export type PushTransport = (
  request: PushRequest,
) => Promise<{ statusCode: number }>;
export const pushTransport: PushTransport = async (details) => {
  const response = await fetch(details.endpoint, {
    method: details.method,
    headers: details.headers as Record<string, string>,
    body: details.body,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  await response.body?.cancel();
  return { statusCode: response.status };
};
type Keys = { publicKey: string; privateKey: string };
export class Push {
  stopped = false;
  constructor(
    public store: Store,
    public origin: string,
    public transport: PushTransport = pushTransport,
  ) {}
  async keys(): Promise<Keys> {
    return this.store.transact(async () => {
      const path = join(this.store.dir, "vapid.json");
      try {
        const keys = JSON.parse(await readFile(path, "utf8"));
        const pub = publicPoint(keys.publicKey),
          priv = bytes(keys.privateKey, 32);
        const ec = createECDH("prime256v1");
        ec.setPrivateKey(priv);
        if (!pub.equals(ec.getPublicKey())) throw invalid();
        await chmod(path, 0o600);
        return { publicKey: keys.publicKey, privateKey: keys.privateKey };
      } catch (e: any) {
        if (e.code !== "ENOENT")
          throw new Failure(
            503,
            "push_keys_invalid",
            "Notification keys require repair.",
          );
      }
      const keys = webpush.generateVAPIDKeys();
      const tmp = join(
        this.store.dir,
        `vapid.${randomBytes(8).toString("hex")}.tmp`,
      );
      const file = await open(tmp, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(keys));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(tmp, path);
      return keys;
    });
  }
  subject() {
    const value = process.env.HERDR_PHONE_VAPID_SUBJECT || this.origin;
    try {
      const u = new URL(value);
      if (
        (u.protocol === "https:" &&
          u.hostname &&
          !u.username &&
          !u.password &&
          !u.hash) ||
        (u.protocol === "mailto:" && /^[^\s@]+@[^\s@]+$/.test(u.pathname))
      )
        return value;
    } catch {}
    throw new Failure(
      503,
      "push_subject_invalid",
      "Configure an HTTPS notification contact.",
    );
  }
  async current(id: string) {
    const s = await this.store.subscription(id);
    if (!s) return undefined;
    if (s.expirationTime !== null && s.expirationTime <= this.store.now()) {
      await this.store.removeSubscription(id, s.endpoint, s);
      return undefined;
    }
    try {
      return subscription(s, this.store.now());
    } catch {
      throw new Failure(503, "state_invalid", "Device state requires repair.");
    }
  }
  async send(id: string, payload: object) {
    const s = await this.current(id);
    if (!s)
      throw new Failure(
        409,
        "subscription_required",
        "Enable notifications first.",
      );
    const keys = await this.keys();
    // Recheck ownership after key IO; revocation and registration share the state lock.
    const current = await this.current(id);
    if (!current || JSON.stringify(current) !== JSON.stringify(s))
      throw new Failure(
        409,
        "subscription_required",
        "Enable notifications first.",
      );
    let status: number;
    try {
      const request = webpush.generateRequestDetails(
        s,
        JSON.stringify(payload),
        {
          TTL: 60,
          contentEncoding: "aes128gcm",
          timeout: 5000,
          vapidDetails: { subject: this.subject(), ...keys },
        },
      );
      if (this.stopped)
        throw new Failure(
          503,
          "push_stopped",
          "Notification delivery stopped.",
        );
      status = (await this.transport(request)).statusCode;
    } catch (e) {
      if (e instanceof Failure) throw e;
      throw new Failure(
        502,
        "push_failed",
        "Notification service did not accept the request.",
      );
    }
    if (status === 404 || status === 410) {
      await this.store.removeSubscription(id, s.endpoint, s);
      throw new Failure(
        409,
        "subscription_required",
        "Enable notifications first.",
      );
    }
    if (status < 200 || status >= 300 || !Number.isInteger(status))
      throw new Failure(
        502,
        "push_failed",
        "Notification service did not accept the request.",
      );
  }
  async broadcast(payload: object) {
    const devices = await this.store.read();
    // A failure is isolated to its device and is never retried automatically.
    for (const d of devices.devices)
      if (!this.stopped && d.subscription)
        await this.send(d.id, payload).catch(() => {});
  }
}
