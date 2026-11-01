import { test, expect, type Page, type Route, type WebSocketRoute } from "@playwright/test";
const png = { name: "sample.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=", "base64") };
const text = { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("A saved note. café 🙂\n") };
const terminal = { id: "t1", title: "Build", state: "live", status: "idle", cols: 80, rows: 24 };
const state = { version: 1, revision: 1, machines: [{ id: "local", name: "This computer", online: true }], programs: [], spaces: [{ id: "sample", machineId: "local", name: "Sample", cwd: "", repo: null, branch: null, color: "#22a99a", tabs: [{ id: "build", name: "Build", terminals: [terminal] }, { id: "review", name: "Review", terminals: [{ ...terminal, id: "remote/t2" }] }] }] };
async function setup(page: Page) {
  const model = { uploads: [] as { name: string; bytes: Buffer; auth: string | undefined; path: string; type: string }[], sends: [] as { path: string; body: any }[], steps: [] as string[], hold: false, uploadStatus: 201, failAt: 1, blocked: false, screenId: "dialog", pending: undefined as Route | undefined, holdSend: false, pendingSend: undefined as Route | undefined, sockets: [] as WebSocketRoute[] };
  await page.addInitScript(() => {
    localStorage.setItem("herdr-phone.device", "test-device-token");
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    (window as any).urls = { created: [], revoked: [] };
    URL.createObjectURL = value => { const url = create(value); (window as any).urls.created.push(url); return url; };
    URL.revokeObjectURL = value => { (window as any).urls.revoked.push(value); revoke(value); };
  });
  await page.routeWebSocket("**/api/ws", ws => { model.sockets.push(ws); ws.send(JSON.stringify({ type: "state", state })); ws.onMessage(() => {}); });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/state") return route.fulfill({ json: state });
    if (url.pathname.endsWith("/screen")) return route.fulfill({ json: { terminal: { ...terminal, id: decodeURIComponent(url.pathname.split("/")[3]) }, text: "Review the current choice", screenId: model.screenId, complete: true, prompt: null } });
    if (url.pathname.endsWith("/uploads")) {
      const body = await new Request(url, { method: "POST", headers: { "Content-Type": request.headers()["content-type"] }, body: request.postDataBuffer()! }).formData();
      expect([...body.keys()]).toEqual(["file"]);
      const file = body.get("file") as File;
      model.uploads.push({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()), type: request.headers()["content-type"], auth: request.headers().authorization, path: url.pathname });
      model.steps.push(`upload-${model.uploads.length}`);
      if (model.hold) { model.pending = route; return; }
      if (model.uploadStatus !== 201 && model.uploads.length >= model.failAt) return route.fulfill({ status: model.uploadStatus, json: { error: { code: "unsupported_file", message: "This file type is not supported." } } });
      return route.fulfill({ status: 201, json: { upload: { id: `upload-${model.uploads.length}`, name: file.name, type: file.type, size: file.size, converted: false } } });
    }
    if (url.pathname.endsWith("/send")) {
      const body = request.postDataJSON(); model.sends.push({ path: url.pathname, body }); model.steps.push("send");
      if (model.holdSend) { model.pendingSend = route; return; }
      if (model.blocked && !body.force) return route.fulfill({ status: 409, json: { error: { code: "terminal_blocked", message: "Terminal is waiting for a choice." } } });
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "S Sample", exact: true }).tap();
  await expect(page.getByRole("button", { name: "Show readable text" })).toBeVisible();
  return model;
}
async function choose(page: Page, files = [png, text]) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach files", exact: true }).tap();
  const picker = await chooser;
  expect(picker.isMultiple()).toBe(true);
  await picker.setFiles(files);
}
const send = (page: Page) => page.locator(".compose-send");
async function hit(page: Page, selector: string) {
  const result = await page.locator(selector).first().evaluate(el => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height, hits: [6, r.height / 2, r.height - 6].every(y => [6, r.width / 2, r.width - 6].every(x => { const target = document.elementFromPoint(r.left + x, r.top + y); return target === el || el.contains(target); })) };
  });
  expect(result.width).toBeGreaterThanOrEqual(44); expect(result.height).toBeGreaterThanOrEqual(44); expect(result.hits).toBe(true);
}
const replyUpload = (route: Route, id = "ready-1") => route.fulfill({ status: 201, json: { upload: { id, name: "sample.png", type: "image/png", size: png.buffer.length, converted: false } } });

test("picker selection remains local, previews and removable chips fit phone", async ({ page }) => {
  const model = await setup(page);
  await hit(page, ".attach-files");
  await expect(page.locator(".attachment-picker")).toHaveAttribute("accept", "image/*,application/pdf,text/*");
  expect(await page.locator(".attachment-picker").getAttribute("capture")).toBeNull();
  await choose(page);
  await expect(page.locator(".attachment")).toHaveCount(2);
  await expect(page.locator(".attachment-preview")).toBeVisible();
  expect(await page.locator(".attachment-preview").evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true);
  expect(model.uploads).toHaveLength(0); expect(model.sends).toHaveLength(0);
  await hit(page, ".attachment-remove");
  if (process.env.ATTACHMENT_SHOT) await page.screenshot({ path: process.env.ATTACHMENT_SHOT.replace(".png", `-${test.info().project.name}.png`) });
  await page.getByRole("button", { name: "Remove sample.png", exact: true }).tap();
  await expect(page.locator(".attachment")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).urls.revoked.length)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("file-only Enter uploads exact bytes sequentially then sends IDs once", async ({ page }) => {
  const model = await setup(page);
  await expect(page.locator(".terminal-canvas .xterm-rows")).toContainText("Review the current choice");
  // WebKit's request interception omits multipart file payloads. Bypass interception
  // for this proof and compare bytes actually received by the loopback HTTP fixture.
  await page.unroute("**/api/**");
  await page.request.delete("/__test/uploads");
  await page.route("**/api/terminals/*/send", async route => {
    model.sends.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ json: { ok: true } });
  });
  await choose(page);
  await page.getByRole("button", { name: "enter", exact: true }).tap();
  await expect.poll(() => model.sends.length).toBe(1);
  const { uploads } = await (await page.request.get("/__test/uploads")).json();
  expect(uploads.map((file: any) => file.name)).toEqual([png.name, text.name]);
  expect(Buffer.from(uploads[0].bytes, "base64").equals(png.buffer)).toBe(true);
  expect(Buffer.from(uploads[1].bytes, "base64").equals(text.buffer)).toBe(true);
  expect(uploads.every((file: any) => file.auth === "Bearer test-device-token" && file.type.startsWith("multipart/form-data; boundary="))).toBe(true);
  expect(model.sends[0].body).toEqual({ text: "", uploads: ["upload-1", "upload-2"] });
  await expect(page.locator(".attachment")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).urls.revoked.length)).toBe(1);
});

test("captures text and selection, locks removal during uploads and preserves later text", async ({ page }) => {
  const model = await setup(page); model.hold = true;
  await choose(page);
  await page.getByLabel("Type to terminal").fill("Original café 🙂\nmessage");
  await send(page).tap();
  await expect.poll(() => model.uploads.length).toBe(1);
  await expect(page.getByRole("button", { name: "Remove sample.png" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Attach files" })).toBeDisabled();
  await page.getByLabel("Type to terminal").fill("My next message");
  model.hold = false; await replyUpload(model.pending!);
  await expect.poll(() => model.sends.length).toBe(1);
  expect(model.sends[0].body).toEqual({ text: "Original café 🙂\nmessage", uploads: ["ready-1", "upload-2"] });
  await expect(page.getByLabel("Type to terminal")).toHaveValue("My next message");
  await expect(page.locator(".attachment")).toHaveCount(2);
});

for (const status of [413, 415, 429]) test(`upload ${status} keeps selection and text with zero message sends`, async ({ page }) => {
  const model = await setup(page); model.uploadStatus = status;
  await choose(page); await page.getByLabel("Type to terminal").fill("Keep this draft");
  await send(page).tap();
  await expect(page.getByText(/This file type is not supported. Nothing was sent/)).toBeVisible();
  expect(model.sends).toHaveLength(0);
  await expect(page.locator(".attachment")).toHaveCount(2);
  await expect(page.getByLabel("Type to terminal")).toHaveValue("Keep this draft");
  await expect(page.getByRole("button", { name: "Remove sample.png" })).toBeEnabled();
});

test("local size and count limits reject without uploading, HEIC shows filename", async ({ page }) => {
  const model = await setup(page);
  await choose(page, Array.from({ length: 9 }, (_, i) => ({ ...text, name: `note-${i}.txt` })));
  await expect(page.getByText("Choose up to eight files per message.")).toBeVisible();
  await expect(page.locator(".attachment")).toHaveCount(0);
  await choose(page, [{ ...text, buffer: Buffer.alloc(20 * 1024 * 1024 + 1) }]);
  await expect(page.getByText("Each file must be 20 MiB or smaller.")).toBeVisible();
  await expect(page.locator(".attachment")).toHaveCount(0);
  await choose(page, [{ name: "camera.heic", mimeType: "image/heic", buffer: Buffer.from("sample") }]);
  await expect(page.locator(".attachment-name")).toHaveText("camera.heic");
  await expect(page.locator(".attachment-preview")).toHaveCount(0);
  expect(model.uploads).toHaveLength(0);
});

for (const interrupt of ["disconnect", "auth", "tab"] as const) test(`${interrupt} during upload cancels continuation and never sends partial message`, async ({ page }) => {
  const model = await setup(page); model.hold = true;
  await choose(page); await page.getByLabel("Type to terminal").fill("Original draft"); await send(page).tap();
  await expect.poll(() => !!model.pending).toBe(true);
  if (interrupt === "disconnect") model.sockets[0].close({ code: 1012 });
  if (interrupt === "auth") await model.pending!.fulfill({ status: 401, json: { error: { code: "unauthorized", message: "Pair this phone to continue." } } });
  if (interrupt === "tab") await page.getByRole("button", { name: "Review", exact: true }).tap();
  if (interrupt !== "auth") await replyUpload(model.pending!).catch(() => {});
  await expect.poll(() => model.sends.length).toBe(0);
  await page.waitForTimeout(200);
  expect(model.uploads.length).toBe(1); expect(model.sends.length).toBe(0);
  if (interrupt === "auth") {
    await expect(page.getByRole("heading", { name: "Your spaces, with you." })).toBeVisible();
    expect(await page.evaluate(() => (window as any).urls.revoked.length)).toBe(1);
  } else if (interrupt === "tab") {
    await expect(page.locator(".attachment")).toHaveCount(0);
    await choose(page, [text]);
    await page.getByRole("button", { name: "Build", exact: true }).tap();
    await expect(page.locator(".attachment")).toHaveCount(2);
    await expect(page.getByLabel("Type to terminal")).toHaveValue("Original draft");
  } else await expect(page.locator(".attachment")).toHaveCount(2);
});

test("blocked message reuses uploaded IDs only after separate fresh-screen force", async ({ page }) => {
  const model = await setup(page); model.blocked = true;
  await choose(page); await page.getByLabel("Type to terminal").fill("Captured message"); await send(page).tap();
  await expect(page.getByRole("button", { name: "Send anyway", exact: true })).toBeVisible();
  expect(model.sends).toHaveLength(1); expect(model.sends[0].body.force).toBeUndefined();
  await page.getByRole("button", { name: "Send anyway", exact: true }).tap();
  await expect.poll(() => model.sends.length).toBe(2);
  expect(model.uploads).toHaveLength(2);
  expect(model.sends[1].body).toEqual({ text: "Captured message", uploads: ["upload-1", "upload-2"], force: true, screenId: "dialog" });
  await expect(page.locator(".attachment")).toHaveCount(0);
});

test("changed blocked screen retains ready selection without forcing", async ({ page }) => {
  const model = await setup(page); model.blocked = true;
  await choose(page); await send(page).tap();
  await expect(page.getByRole("button", { name: "Send anyway" })).toBeVisible();
  model.screenId = "changed-dialog";
  await page.getByRole("button", { name: "Send anyway" }).tap();
  await expect(page.getByText(/The dialog changed. Draft and files retained/)).toBeVisible();
  expect(model.sends).toHaveLength(1); await expect(page.locator(".attachment")).toHaveCount(2);
});

test("ambiguous send failure retains files and draft with no automatic replay", async ({ page }) => {
  const model = await setup(page); model.holdSend = true;
  await choose(page); await page.getByLabel("Type to terminal").fill("Retain after unknown outcome"); await send(page).tap();
  await expect.poll(() => !!model.pendingSend).toBe(true);
  model.sockets[0].close({ code: 1012 });
  await model.pendingSend!.abort().catch(() => {});
  await expect(page.getByText(/Delivery may be unknown/).first()).toBeVisible();
  await expect(page.getByLabel("Type to terminal")).toHaveValue("Retain after unknown outcome");
  await expect(page.locator(".attachment")).toHaveCount(2);
  await page.waitForTimeout(300); expect(model.sends).toHaveLength(1);
});

test("qualified terminal route, per-terminal selection and logout revoke previews", async ({ page }) => {
  const model = await setup(page);
  await choose(page, [png]);
  await page.getByRole("button", { name: "Review", exact: true }).tap();
  expect(await page.evaluate(() => (window as any).urls.revoked.length)).toBe(1);
  await choose(page, [text]); await send(page).tap();
  await expect.poll(() => model.sends.length).toBe(1);
  expect(model.uploads[0].path).toBe("/api/terminals/remote%2Ft2/uploads");
  expect(model.sends[0].path).toBe("/api/terminals/remote%2Ft2/send");
  await page.getByRole("button", { name: "Build", exact: true }).tap();
  await expect(page.locator(".attachment-preview")).toBeVisible();
  await page.getByRole("button", { name: "•••", exact: true }).tap();
  await page.getByRole("button", { name: "Disconnect this phone", exact: true }).tap();
  await expect(page.getByRole("heading", { name: "Your spaces, with you." })).toBeVisible();
  const urls = await page.evaluate(() => (window as any).urls);
  expect(new Set(urls.created)).toEqual(new Set(urls.revoked));
});

test("a later upload failure never sends the successfully uploaded subset", async ({ page }) => {
  const model = await setup(page); model.uploadStatus = 415; model.failAt = 2;
  await choose(page); await page.getByLabel("Type to terminal").fill("Keep the complete selection"); await send(page).tap();
  await expect(page.getByText(/This file type is not supported. Nothing was sent/)).toBeVisible();
  expect(model.uploads).toHaveLength(2); expect(model.sends).toHaveLength(0);
  await expect(page.locator(".attachment")).toHaveCount(2);
  await expect(page.getByLabel("Type to terminal")).toHaveValue("Keep the complete selection");
});
