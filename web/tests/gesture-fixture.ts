import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";

const terminal = { id: "t1", title: "Build", state: "live", status: "blocked", cols: 100, rows: 30 };
const state = { version: 1, revision: 1, machines: [{ id: "local", name: "Computer", online: true }], programs: [], spaces: [{ id: "work", machineId: "local", name: "Workbench", cwd: "", repo: null, branch: null, color: "#778899", tabs: [{ id: "build", name: "Build", terminals: [terminal] }, { id: "review", name: "Review", terminals: [{ ...terminal, id: "remote/t2" }] }] }] };
const turn = (n: number) => ({ id: `turn-${n}`, entries: [{ id: `user-${n}`, role: "user", text: `Request ${n}: Review this saved message.` }, { id: `reply-${n}`, role: "assistant", text: `Reply ${n}: The saved response remains readable.\n${"The next step is ready. ".repeat(6)}` }] });

export async function setup(page: Page, preference: string | null = null, deepLink = false, blockedStorage = false) {
  const model = { data: Array.from({ length: 20 }, (_, i) => turn(i)), holdLatest: false, reads: [] as string[], calls: [] as { path: string; body: any }[], sockets: [] as WebSocketRoute[], watchCalls: [] as unknown[], screenText: "The live terminal is ready.", watches: new Map<WebSocketRoute, { terminalId: string; watchId: string }>() };
  let prompt: any = { id: "approval", kind: "approval", options: [{ id: "yes", label: "Yes, proceed", keys: ["enter"] }, { id: "no", label: "No, cancel", keys: ["down", "enter"] }] };
  await page.addInitScript(({ preference, blockedStorage }) => {
    localStorage.setItem("herdr-phone.device", "test-device-token");
    if (preference && !localStorage.getItem("fixture.initialized")) localStorage.setItem("herdr-phone.terminal-view", preference);
    localStorage.setItem("fixture.initialized", "1");
    if (blockedStorage) {
      const read = Storage.prototype.getItem, write = Storage.prototype.setItem;
      Storage.prototype.getItem = function(key) { if (key.includes("terminal-view") || key.includes("conversation-default")) throw new Error("Storage unavailable"); return read.call(this, key); };
      Storage.prototype.setItem = function(key, value) { if (key.includes("terminal-view") || key.includes("conversation-default")) throw new Error("Storage unavailable"); return write.call(this, key, value); };
    }
  }, { preference, blockedStorage });
  const screen = (id = "t1") => ({ type: "screen", terminal: { ...terminal, id }, text: model.screenText, complete: true, screenId: prompt?.id || "screen", prompt });
  await page.routeWebSocket("**/api/ws", ws => {
    model.sockets.push(ws);
    ws.send(JSON.stringify({ type: "state", state }));
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      model.watchCalls.push(frame);
      if (frame.type === "watch") model.watches.set(ws, { terminalId: frame.terminalId, watchId: frame.watchId });
      else if (frame.type === "unwatch") model.watches.delete(ws);
    });
  });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path.endsWith("/screen")) return route.fulfill({ json: screen(decodeURIComponent(path.split("/")[3])) });
    if (path.endsWith("/conversation")) {
      model.reads.push(path);
      if (model.holdLatest) return;
      return route.fulfill({ json: { available: true, session: path, revision: String(model.data.length), turns: model.data, nextCursor: null } });
    }
    if (route.request().method() === "POST") model.calls.push({ path, body: route.request().postDataJSON() });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(deepLink ? "/#terminal=remote%2Ft2" : "/");
  if (!deepLink) await page.getByRole("button", { name: "W Workbench", exact: true }).tap();
  return { model, publishScreen: (text: string) => {
    model.screenText = text;
    for (const [ws, watch] of model.watches) ws.send(JSON.stringify({ type: "screen", ...watch, cols: 100, rows: 30, text, screenId: "long", prompt }));
  }, publishPrompt: (next: any) => {
    prompt = next;
    for (const [ws, watch] of model.watches) ws.send(JSON.stringify({ type: "screen", ...watch, cols: 100, rows: 30, text: "Choose an option.", screenId: prompt.id, prompt }));
  } };
}
