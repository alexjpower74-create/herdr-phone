import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/jetbrains-mono/400.css";
import "./style.css";
import { terminalFontReady, remeasureTerminalFont } from "./terminal-font";
import { draft, selectFiles, preview, removeFile, clearDraft, releasePreviews, forgetDrafts, type SelectedFile } from "./attachments";
import { Conversation } from "./conversation";
import { ApiError, Client } from "./client";
import { readableLines, type ReadLine } from "./readable";
import { ReadWindow } from "./read-window";
import { ObserverDisplay, bufferText, terminalOptions, type BufferAnchor } from "./observer";
import { notificationSettings } from "./notifications";
import type { State, Space, Tab, TerminalInfo, Frame, Prompt } from "./types";
const root = document.querySelector<HTMLDivElement>("#app")!;
const client = new Client();
let state: State | undefined,
  space: Space | undefined,
  tab: Tab | undefined,
  active: TerminalInfo | undefined;
let emulator: Terminal | undefined,
  resize: ResizeObserver | undefined,
  connected = false;
let currentText = "",
  currentPrompt: Prompt | null = null,
  usedPrompt = "",
  screenGeneration = 0;
let conversation: Conversation | undefined;
let conversationOpen = false;
let terminalEpoch = 0;
let appEpoch = 0;
let paintFrame = 0;
let mirrorSource: string | undefined;
let fallbackFullPatches = 0, fallbackRowPatches = 0;
let readLines: ReadLine[] = [];
const readWindow = new ReadWindow();
let historyBudget = 500, historyBusy = false, historyStopped = false;
let observerLabel = "Plain screen · connecting colour and history…";
let mirrorFollowing = true, mirrorPosition = 0;
const observation = new ObserverDisplay(
  () => emulator,
  (next, host, anchor, index = 0) => {
    const old = emulator;
    const oldLength = old?.buffer.active.length ?? 0;
    old?.element?.parentElement?.remove();
    old?.dispose();
    emulator = next;
    host.className = "terminal-canvas";
    host.hidden = terminalView === "read";
    observerLabel = next.buffer.active.type === "alternate"
      ? "Live colours · alternate screen has no retained history" : "Live colours · retained history";
    historyStopped = next.buffer.active.type === "alternate" ||
      (historyBusy && next.buffer.active.length <= oldLength) || historyBudget >= 100000;
    historyBusy = false;
    if (historyStopped && next.buffer.active.type !== "alternate")
      observerLabel += " · history limit reached";
    currentText = bufferText(next);
    readSource = undefined;
    scaleTerminal();
    if (anchor) {
      if (anchor.view === "mirror") {
        mirrorFollowing = false;
        mirrorPosition = index * mirrorRowHeight() + anchor.offset;
        const viewport = root.querySelector<HTMLElement>(".terminal-viewport");
        if (viewport && terminalView === "mirror") viewport.scrollTop = mirrorPosition;
      } else {
        followingNewest = false;
        paintReadable(false);
        if (readLines.length > 1000) {
          const lineIndex = readLines.findIndex(line => line.kind === "text" && line.text === anchor.text);
          readPosition = readWindow.offset(lineIndex) - anchor.offset;
          paintReadable(false, true);
        }
        const rows = [...root.querySelectorAll<HTMLElement>(".read-line")];
        const row = rows.find(row => row.textContent === anchor.text);
        const viewport = root.querySelector<HTMLElement>(".terminal-viewport");
        if (row && viewport) viewport.scrollTop = row.offsetTop - anchor.offset;
        else notice("History loaded, but the readable position could not be restored.");
        readPosition = viewport?.scrollTop ?? 0;
      }
    } else if (mirrorFollowing) scrollMirrorNewest();
    scheduleObserverPaint();
  },
  () => scheduleObserverPaint(),
  message => { historyBusy = false; observerLabel = message; updateTerminalInfo(); },
);
client.onWatch = (id, history) => {
  if (!active) return;
  observation.watch(id, history, pendingAnchor);
  pendingAnchor = undefined;
};
let pendingAnchor: BufferAnchor | undefined;
function scheduleObserverPaint() {
  if (paintFrame) return;
  paintFrame = requestAnimationFrame(() => {
    paintFrame = 0;
    if (!emulator || !observation.active) return;
    currentText = bufferText(emulator);
    active && (active.cols = emulator.cols, active.rows = emulator.rows);
    paintReadable();
    scaleTerminal();
    if (mirrorFollowing) scrollMirrorNewest();
    updateTerminalInfo();
  });
}
type TerminalView = "read" | "mirror";
const VIEW_KEY = "herdr-phone.terminal-view";
function preferredTerminalView(): TerminalView {
  try {
    return localStorage.getItem(VIEW_KEY) === "read" ? "read" : "mirror";
  } catch {
    return "mirror";
  }
}
let terminalView: TerminalView = preferredTerminalView(),
  followingNewest = true,
  readPosition = 0,
  readSource: string | undefined;
const pending = new Set<string>();
let submissionEpoch = 0;
const submissions = new Map<string, AbortController>();
type Submission = {
  id: string;
  text: string;
  revision: number;
  files: SelectedFile[];
  uploads: string[];
  epoch: number;
  controller: AbortController;
};
function cancelSubmissions() {
  submissionEpoch++;
  for (const controller of submissions.values()) controller.abort();
  submissions.clear();
}
function validSubmission(saved: Submission) {
  return connected && active?.id === saved.id && saved.epoch === submissionEpoch && !saved.controller.signal.aborted;
}
function renderAttachments() {
  const host = root.querySelector<HTMLElement>(".attachments");
  if (!host || !active) return;
  host.replaceChildren();
  const id = active.id;
  for (const selected of draft(id).files) {
    const chip = element("div", "attachment");
    const url = preview(selected);
    if (url) {
      const image = element("img", "attachment-preview");
      image.src = url;
      image.alt = "";
      image.onerror = () => { image.remove(); };
      chip.append(image);
    }
    chip.append(element("span", "attachment-name", selected.file.name));
    const remove = button("×", () => {
      removeFile(draft(id), selected.key);
      renderAttachments();
      updateCompose();
    }, "attachment-remove");
    remove.disabled = pending.has(id);
    remove.setAttribute("aria-label", `Remove ${selected.file.name}`);
    chip.append(remove);
    host.append(chip);
  }
}
function updateCompose() {
  const input = root.querySelector<HTMLTextAreaElement>(".terminal-input");
  const submit = root.querySelector<HTMLButtonElement>(".compose-send");
  if (active && input && submit) {
    input.value = draft(active.id).text;
    submit.disabled = pending.has(active.id) || !connected || (!input.value && !draft(active.id).files.length);
    submit.textContent = pending.has(active.id) ? "Sending…" : "Send";
    const attach = root.querySelector<HTMLButtonElement>(".attach-files");
    if (attach) attach.disabled = pending.has(active.id);
    root.querySelectorAll<HTMLButtonElement>(".attachment-remove").forEach(remove => { remove.disabled = pending.has(active!.id); });
  }
}
const folded = new Set<string>();
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
) {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}
function button(label: string, action: () => void, className = "") {
  const el = element("button", className, label);
  el.type = "button";
  el.onclick = action;
  return el;
}
function notice(message: string) {
  let el = document.querySelector<HTMLElement>("#notice");
  if (!el) {
    el = element("div", "notice");
    el.id = "notice";
    el.role = "status";
    root.append(el);
  }
  el.textContent = message;
}
function disposeTerminal() {
  cancelSubmissions();
  releasePreviews();
  terminalEpoch++;
  conversation?.dispose();
  conversation = undefined;
  conversationOpen = false;
  screenGeneration++;
  observation.dispose();
  cancelAnimationFrame(paintFrame);
  paintFrame = 0;
  mirrorSource = undefined;
  readWindow.clear();
  resize?.disconnect();
  emulator?.dispose();
  emulator = undefined;
  active = undefined;
  client.watch(null);
}
function header(title: string, back = false) {
  const head = element("header");
  if (back)
    head.append(
      button(
        "‹",
        () => {
          history.replaceState(null, "", location.pathname);
          home();
        },
        "icon back",
      ),
    );
  else {
    const mark = element("img", "brand-mark");
    mark.src = "/brand.png";
    mark.alt = "";
    head.append(mark);
  }
  head.append(element("h1", "", title));
  head.append(button("•••", settings, "icon"));
  return head;
}
function pairing(message = "") {
  root.querySelectorAll("dialog").forEach((dialog) => dialog.close());
  appEpoch++;
  disposeTerminal();
  root.replaceChildren();
  root.append(header("Herdr"));
  const main = element("main", "pairing");
  const mark = element("img", "pair-symbol");
  mark.src = "/brand.png";
  mark.alt = "";
  main.append(
    mark,
    element("h2", "", "Your spaces, with you."),
    element(
      "p",
      "muted",
      "Enter the pairing code from your bridge to connect this phone.",
    ),
  );
  const form = element("form");
  const label = element("label", "", "Pairing code");
  const code = element("input");
  code.name = "code";
  code.autocomplete = "one-time-code";
  code.maxLength = 8;
  code.pattern = "[A-Za-z0-9]{8}";
  code.required = true;
  code.placeholder = "XXXXXXXX";
  code.className = "code";
  label.append(code);
  const deviceLabel = element("label", "", "Device name");
  const device = element("input");
  device.name = "device";
  device.value = "My phone";
  device.required = true;
  device.maxLength = 64;
  device.autocomplete = "off";
  deviceLabel.append(device);
  const submit = element("button", "primary", "Connect");
  submit.type = "submit";
  const error = element("p", "form-error", message);
  error.role = "alert";
  form.append(label, deviceLabel, submit, error);
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    try {
      await client.pair(code.value, device.value);
      await start();
    } catch (e) {
      error.textContent = (e as Error).message;
      submit.disabled = false;
    }
  };
  main.append(form);
  root.append(main);
}
function connectionText() {
  return connected ? "Connected" : "Reconnecting…";
}
function home() {
  if (root.querySelector("dialog[open]")) return;
  disposeTerminal();
  space = undefined;
  tab = undefined;
  root.replaceChildren(header("Herdr"));
  const main = element("main", "spaces");
  const title = element("div", "section-heading");
  title.append(
    element("h2", "", "Spaces"),
    button("+", () => newSpace(), "icon"),
  );
  main.append(title);
  if (!state) {
    main.append(element("p", "empty", "Loading spaces…"));
    root.append(main);
    return;
  }
  for (const machine of state.machines) {
    const group = element("section", "machine");
    const heading = element("div", "machine-heading");
    const fold = button(
      "",
      () => {
        folded.has(machine.id)
          ? folded.delete(machine.id)
          : folded.add(machine.id);
        home();
      },
      "machine-fold",
    );
    fold.setAttribute("aria-expanded", String(!folded.has(machine.id)));
    fold.append(
      element("span", "machine-icon", machine.id === "local" ? "▱" : "▤"),
      element("span", "machine-name", machine.name),
    );
    const dot = element("span", `dot ${machine.online ? "online" : ""}`);
    dot.title = machine.online ? "Online" : "Offline";
    fold.append(
      dot,
      element("span", "chevron", folded.has(machine.id) ? "›" : "⌄"),
    );
    heading.append(
      fold,
      button("+", () => newSpace(machine.id), "icon machine-add"),
    );
    heading.lastElementChild!.setAttribute(
      "aria-label",
      `New space on ${machine.name}`,
    );
    (heading.lastElementChild as HTMLButtonElement).disabled = !machine.online;
    group.append(heading);
    if (!folded.has(machine.id))
      for (const item of state.spaces.filter(
        (s) => s.machineId === machine.id,
      )) {
        const row = button("", () => openSpace(item), "space-row");
        const tile = element(
          "span",
          "tile",
          Array.from(item.name)[0]?.toUpperCase() ?? "?",
        );
        tile.style.background = /^#[\da-f]{6}$/i.test(item.color)
          ? item.color
          : "#637184";
        const info = element("span", "space-info");
        info.append(element("span", "space-name", item.name));
        const detail = [item.repo, item.branch].filter(Boolean).join(" · ");
        if (detail) info.append(element("span", "space-detail", detail));
        row.append(tile, info, element("span", "row-chevron", "›"));
        row.disabled = !machine.online;
        group.append(row);
      }
    main.append(group);
  }
  if (!state.spaces.length)
    main.append(element("p", "empty", "No spaces yet. Tap + to start one."));
  root.append(main);
  const foot = element("footer", "home-footer");
  foot.append(
    element("span", `dot ${connected ? "online" : ""}`),
    element("span", "", connectionText()),
  );
  root.append(foot);
}
function openSpace(next: Space, desired?: string) {
  space = next;
  tab =
    next.tabs.find((t) => t.terminals.some((x) => x.id === desired)) ??
    next.tabs[0];
  showTerminal(desired);
}
async function showTerminal(desired?: string) {
  const savedSpace = space,
    savedTab = tab;
  disposeTerminal();
  space = savedSpace;
  tab = savedTab;
  if (!space) return home();
  root.replaceChildren(header(space.name, true));
  const tabs = element("nav", "tabs");
  tabs.setAttribute("aria-label", "Tabs");
  for (const item of space.tabs) {
    const b = button(
      item.name,
      () => {
        tab = item;
        showTerminal();
      },
      `tab ${item.id === tab?.id ? "selected" : ""}`,
    );
    b.setAttribute("aria-current", String(item.id === tab?.id));
    tabs.append(b);
  }
  const tabHeader = element("div", "tab-header");
  const viewToggle = button(
    "Mirror",
    () => {
      if (conversationOpen) toggleConversation(false);
      setTerminalView(terminalView === "read" ? "mirror" : "read", true);
    },
    "view-toggle",
  );
  const conversationToggle = button("Conversation", () => toggleConversation(!conversationOpen), "conversation-toggle");
  conversationToggle.setAttribute("aria-pressed", "false");
  tabHeader.append(tabs, viewToggle, conversationToggle);
  root.append(tabHeader);
  const terminals = tab?.terminals ?? [];
  active = terminals.find((t) => t.id === desired) ?? terminals[0];
  if (terminals.length > 1) {
    const panes = element("nav", "panes");
    panes.setAttribute("aria-label", "Terminals");
    for (const terminal of terminals)
      panes.append(
        button(
          terminal.title,
          () => showTerminal(terminal.id),
          terminal.id === active?.id ? "selected" : "",
        ),
      );
    root.append(panes);
  }
  if (!active) {
    viewToggle.hidden = true;
    conversationToggle.hidden = true;
    root.append(element("p", "empty", "This tab has no running terminal."));
    return;
  }
  followingNewest = true;
  mirrorFollowing = true;
  mirrorPosition = 0;
  historyBudget = 500;
  historyBusy = historyStopped = false;
  pendingAnchor = undefined;
  observerLabel = active.state === "finished" ? "Plain screen · finished terminal, no colour or history stream" :
    "Plain screen · connecting colour and history…";
  readPosition = 0;
  readSource = undefined;
  currentText = "";
  history.replaceState(null, "", `#terminal=${encodeURIComponent(active.id)}`);
  const info = element("div", "terminal-info");
  info.id = "terminal-info";
  root.append(info);
  updateTerminalInfo();
  const viewport = element("main", "terminal-viewport");
  viewport.setAttribute("aria-label", "Terminal screen");
  const canvas = element("div", "terminal-canvas");
  const read = element("div", "terminal-read");
  read.setAttribute("aria-label", "Readable terminal text");
  viewport.append(canvas, read);
  viewport.addEventListener("scroll", () => {
    captureReadPosition(viewport);
    if (terminalView === "read" && readLines.length > 1000) paintReadable(false, true);
    if (terminalView === "mirror") syncMirrorScroll(viewport);
    if (viewport.scrollTop < 2) requestHistory();
  }, {
    passive: true,
  });
  root.append(viewport);
  conversation = new Conversation(client, active.id, connected);
  root.append(conversation.host);
  const approvals = element("div", "approvals");
  approvals.id = "approvals";
  root.append(approvals);
  const dock = element("div", "input-dock");
  const keys = element("div", "keybar");
  for (const [label, key] of [
    ["⇧ Tab", "shift+tab"],
    ["Esc", "esc"],
    ["↑", "up"],
    ["↓", "down"],
    ["Enter", "enter"],
    ["^C", "ctrl+c"],
  ]) {
    const b = button(label, () => keyAction(key));
    b.setAttribute("aria-label", key);
    b.onpointerdown = (e) => {
      e.preventDefault();
      keyAction(key);
    };
    b.onclick = (e) => {
      if (e.detail === 0) keyAction(key);
    };
    keys.append(b);
  }
  const input = element("textarea", "terminal-input");
  input.rows = 1;
  input.setAttribute("aria-label", "Type to terminal");
  input.placeholder = "Type to terminal…";
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.spellcheck = false;
  const idForDraft = active.id;
  input.value = draft(idForDraft).text;
  input.placeholder = "Compose a message…";
  input.addEventListener("input", () => {
    const saved = draft(idForDraft);
    saved.text = input.value;
    saved.revision++;
    updateCompose();
  });
  input.onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submitDraft(idForDraft);
    }
  };
  const compose = element("div", "compose");
  const submit = button(
    "Send",
    () => void submitDraft(idForDraft),
    "primary compose-send",
  );
  const picker = element("input", "attachment-picker");
  picker.type = "file";
  picker.accept = "image/*,application/pdf,text/*";
  picker.multiple = true;
  picker.hidden = true;
  const attach = button("📎", () => picker.click(), "attach-files");
  attach.setAttribute("aria-label", "Attach files");
  picker.onchange = () => {
    const error = selectFiles(draft(idForDraft), [...(picker.files ?? [])]);
    picker.value = "";
    if (error) notice(error);
    renderAttachments();
    updateCompose();
  };
  const attachments = element("div", "attachments");
  attachments.setAttribute("aria-label", "Selected files");
  compose.append(input, attach, submit);
  dock.append(keys, attachments, picker, compose);
  root.append(dock);
  renderAttachments();
  updateCompose();
  const id = active.id, generation = screenGeneration, lifetime = terminalEpoch;
  await terminalFontReady(terminalOptions, () => {
    if (active?.id === id && lifetime === terminalEpoch) refreshTerminalFont();
  });
  if (active?.id !== id || generation !== screenGeneration) return;
  emulator = new Terminal({ ...terminalOptions, cols: active.cols, rows: active.rows });
  emulator.open(canvas);
  viewport.onclick = () => input.focus();
  resize = new ResizeObserver(() => {
    scaleTerminal();
    if (terminalView === "read") {
      captureReadPosition(viewport);
      if (followingNewest) {
        viewport.scrollTop = viewport.scrollHeight;
        readPosition = viewport.scrollTop;
      }
    }
  });
  resize.observe(viewport);

  setTerminalView(terminalView);
  updateCompose();
  currentText = "";
  currentPrompt = null;
  usedPrompt = "";
  client.watch(id);
  client
    .screen(id)
    .then((screen) => {
      if (active?.id !== id || generation !== screenGeneration) return;
      active = screen.terminal;
      paint(
        screen.text,
        screen.terminal.cols,
        screen.terminal.rows,
        screen.prompt,
      );
    })
    .catch((e) => notice((e as Error).message));
}
function toggleConversation(open: boolean) {
  conversationOpen = open;
  const viewport = root.querySelector<HTMLElement>(".terminal-viewport");
  if (viewport) viewport.hidden = open;
  root.querySelector(".conversation-toggle")?.setAttribute("aria-pressed", String(open));
  conversation?.show(open);
  if (!open) { setTerminalView(terminalView); scaleTerminal(); }
}
function setTerminalView(view: TerminalView, remember = false) {
  const viewport = root.querySelector<HTMLElement>(".terminal-viewport"),
    canvas = root.querySelector<HTMLElement>(".terminal-canvas"),
    read = root.querySelector<HTMLElement>(".terminal-read"),
    toggle = root.querySelector<HTMLButtonElement>(".view-toggle");
  if (!viewport || !canvas || !read || !toggle || !active) return;
  terminalView = view;
  if (remember) {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // The choice still applies for this session if storage is unavailable.
    }
  }
  viewport.dataset.view = view;
  canvas.hidden = view === "read";
  read.hidden = view === "mirror";
  toggle.textContent = view === "read" ? "Mirror" : "Read";
  toggle.setAttribute(
    "aria-label",
    view === "read" ? "Show desktop mirror" : "Show readable text",
  );
  toggle.setAttribute("aria-pressed", String(view === "mirror"));
  if (view === "read") {
    // Restore the Read position, not the unrelated Mirror scroll offset.
    paintReadable(false);
    viewport.scrollTop = followingNewest ? viewport.scrollHeight : readPosition;
    readPosition = viewport.scrollTop;
  } else {
    viewport.scrollTop = mirrorFollowing ? viewport.scrollHeight : mirrorPosition;
    if (emulator) remeasureTerminalFont(emulator);
    scaleTerminal();
    if (mirrorFollowing) scrollMirrorNewest();
    else syncMirrorScroll(viewport);
  }
}
function captureReadPosition(viewport: HTMLElement) {
  if (terminalView !== "read") return;
  const position = viewport.scrollTop;
  const remaining = viewport.scrollHeight - position - viewport.clientHeight;
  if (remaining < 1) followingNewest = true;
  else if (position < readPosition - 1) followingNewest = false;
  else if (position > readPosition + 1 && remaining < 32)
    followingNewest = true;
  readPosition = position;
}
function paintReadable(capturePosition = true, scrollOnly = false) {
  const read = root.querySelector<HTMLElement>(".terminal-read"),
    viewport = root.querySelector<HTMLElement>(".terminal-viewport");
  if (
    !read ||
    !viewport ||
    terminalView !== "read" ||
    (readSource === currentText && !scrollOnly)
  )
    return;
  if (readSource !== currentText) readLines = readableLines(currentText);
  readSource = currentText;
  // Native scrolling can advance before its scroll event is delivered. Read
  // the live position immediately before replacing content, not from its last
  // callback or before building the next frame.
  if (capturePosition) captureReadPosition(viewport);
  const position = readPosition;
  readWindow.render(read, readLines, followingNewest ? Number.MAX_SAFE_INTEGER : position, viewport.clientHeight);
  const nextTop = followingNewest ? viewport.scrollHeight : position;
  if (!scrollOnly || Math.abs(viewport.scrollTop - nextTop) > 1) viewport.scrollTop = nextTop;
  readPosition = viewport.scrollTop;
}
function updateTerminalInfo() {
  const info = document.querySelector("#terminal-info");
  if (info && active)
    info.textContent = `${active.title} · ${active.cols} × ${active.rows} · ${connected ? active.status : "reconnecting"} · ${observerLabel}`;
}
function scaleTerminal() {
  if (terminalView !== "mirror") return;
  const canvas = document.querySelector<HTMLElement>(".terminal-canvas"),
    viewport = document.querySelector<HTMLElement>(".terminal-viewport");
  if (!canvas || !viewport || !emulator) return;
  const natural =
    emulator.element?.querySelector<HTMLElement>(".xterm-screen")
      ?.offsetWidth ?? 0;
  if (natural) {
    const scale = Math.min(1, (viewport.clientWidth - 24) / natural);
    canvas.style.transform = `scale(${scale})`;
    canvas.style.width = `${natural}px`;
    canvas.style.height = `${emulator.element?.offsetHeight ?? 0}px`;
    viewport.style.setProperty(
      "--terminal-height",
      `${observation.active ? emulator.buffer.active.length * mirrorRowHeight() : (emulator.element?.offsetHeight ?? 0) * scale}px`,
    );
  }
}
function refreshTerminalFont() {
  if (!emulator) return;
  const viewport = root.querySelector<HTMLElement>(".terminal-viewport");
  const previousRowHeight = mirrorRowHeight();
  // Native scrolling can lead its event. Capture the live row position and
  // follow state before font metrics change the fitted row height.
  const rowPosition = (viewport?.scrollTop ?? 0) / (previousRowHeight || 1);
  const follow = !!viewport && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 32;
  remeasureTerminalFont(emulator);
  observation.remeasureFont();
  if (terminalView === "mirror" && viewport && !viewport.hidden) {
    scaleTerminal();
    mirrorFollowing = follow;
    if (follow) scrollMirrorNewest();
    else {
      mirrorPosition = rowPosition * mirrorRowHeight();
      viewport.scrollTop = mirrorPosition;
      syncMirrorScroll(viewport);
    }
  }
}
document.fonts.addEventListener("loadingdone", refreshTerminalFont);
function dimensions(cols: number, rows: number) {
  if (!emulator || !active) return;
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > 1000 ||
    rows > 500
  )
    return;
  if (emulator.cols !== cols || emulator.rows !== rows) mirrorSource = undefined;
  active.cols = cols;
  active.rows = rows;
  if (emulator.cols !== cols || emulator.rows !== rows)
    emulator.resize(cols, rows);
  updateTerminalInfo();
}
function paint(
  text: string,
  cols: number,
  rows: number,
  prompt: Prompt | null = null,
) {
  currentPrompt = prompt;
  if (observation.active) { renderChoices(); return; }
  dimensions(cols, rows);
  if (!emulator) return;
  currentText = text;
  renderChoices();
  if (paintFrame) return;
  paintFrame = requestAnimationFrame(() => {
    paintFrame = 0;
    paintReadable();
    if (!emulator || observation.active || mirrorSource === currentText) return;
    const target = emulator;
    const previous = mirrorSource?.split("\n") ?? [];
    const plain = currentText.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
    const lines = plain.split("\n");
    let patch = "\x1b[?7l";
    let changedRows = 0;
    for (let i = 0; i < Math.min(target.rows, Math.max(lines.length, previous.length)); i++)
      if (previous[i] !== lines[i]) {
        changedRows++;
        patch += `\x1b[${i + 1};1H\x1b[2K${lines[i] ?? ""}`;
      }
    fallbackRowPatches += changedRows;
    if (changedRows >= target.rows) fallbackFullPatches++;
    mirrorSource = plain;
    if (patch.length > 5) target.write(patch, () => {
      if (emulator === target) scaleTerminal();
    });
  });
}

function renderChoices() {
  const area = document.querySelector<HTMLElement>("#approvals");
  if (!area) return;
  if (
    !connected ||
    !active ||
    !currentPrompt ||
    currentPrompt.id === usedPrompt
  ) {
    area.replaceChildren();
    delete area.dataset.prompt;
    return;
  }
  const id = active.id;
  const prompt = currentPrompt;
  const identity = JSON.stringify([id, prompt.id]);
  if (area.dataset.prompt === identity) return;
  area.replaceChildren();
  area.dataset.prompt = identity;
  for (const choice of prompt.options) {
    area.append(
      button(
        choice.label,
        async () => {
          if (
            !connected ||
            currentPrompt?.id !== prompt.id ||
            usedPrompt === prompt.id
          )
            return;
          usedPrompt = prompt.id;
          renderChoices();
          try {
            await client.action(id, "prompt", {
              promptId: prompt.id,
              optionId: choice.id,
            });
          } catch (error) {
            notice(
              `${(error as Error).message} Choice was not replayed; refresh the dialog before choosing again.`,
            );
            if (active?.id === id) await refreshScreen(id);
          }
        },
        "approval",
      ),
    );
  }
}
async function refreshScreen(id: string) {
  const generation = screenGeneration;
  try {
    const screen = await client.screen(id);
    if (active?.id !== id || generation !== screenGeneration) return;
    active = screen.terminal;
    paint(
      screen.text,
      screen.terminal.cols,
      screen.terminal.rows,
      screen.prompt,
    );
    return screen;
  } catch (error) {
    notice((error as Error).message);
  }
}
function keyAction(key: string) {
  if (!active || !connected)
    return notice("Connection unavailable. Input was not sent.");
  if (key === "enter" && (draft(active.id).text || draft(active.id).files.length))
    return void submitDraft(active.id);
  const id = active.id;
  void client
    .action(id, "keys", { keys: [key] })
    .catch((error) =>
      notice(
        `${(error as Error).message} Input was not replayed. Earlier delivery may be unknown; check the terminal before continuing.`,
      ),
    );
}
async function submitDraft(id: string, forceScreenId?: string, captured?: Submission) {
  if (pending.has(id)) return;
  if (!connected || active?.id !== id)
    return notice("Connection unavailable. Draft and files retained; nothing was replayed.");
  const saved = draft(id);
  const submission = captured ?? {
    id, text: saved.text, revision: saved.revision, files: [...saved.files], uploads: [],
    epoch: submissionEpoch, controller: new AbortController(),
  };
  if ((!submission.text && !submission.files.length) || !validSubmission(submission)) return;
  pending.add(id);
  submissions.set(id, submission.controller);
  updateCompose();
  let dispatched = false;
  try {
    // Capture once: later edits and removals belong to the next message.
    if (!captured) for (const selected of submission.files) {
      if (!validSubmission(submission)) throw new Error("Sending was cancelled.");
      const result = await client.upload(id, selected.file, submission.controller.signal);
      if (!validSubmission(submission)) throw new Error("Sending was cancelled.");
      submission.uploads.push(result.upload.id);
    }
    if (!validSubmission(submission)) throw new Error("Sending was cancelled.");
    dispatched = true;
    await client.action(id, "send", {
      text: submission.text,
      ...(submission.uploads.length ? { uploads: submission.uploads } : {}),
      ...(forceScreenId ? { force: true, screenId: forceScreenId } : {}),
    }, submission.controller.signal);
    if (!validSubmission(submission)) throw new Error("Delivery outcome is unknown after disconnection.");
    if (saved.revision === submission.revision) clearDraft(saved);
  } catch (error) {
    if (!client.token) return;
    const reason = validSubmission(submission) ? (error as Error).message : "Pending input was cancelled.";
    const retained = submission.files.length ? "Draft and files retained." : "Draft retained.";
    notice(dispatched
      ? `${reason} ${retained} Delivery may be unknown; check the terminal before sending again.`
      : `${reason} Nothing was sent. ${retained}`);
    if (error instanceof ApiError && error.code === "terminal_blocked" && !forceScreenId && validSubmission(submission)) {
      const screen = await refreshScreen(id);
      if (screen && validSubmission(submission)) {
        const dialog = modal("Terminal is waiting for a choice");
        dialog.append(element("pre", "blocked-screen", screen.text));
        dialog.append(element("p", "muted", "Sending this message and its selected files may answer the current dialog."));
        dialog.append(button("Send anyway", async () => {
          dialog.close();
          if (!validSubmission(submission)) return;
          const fresh = await refreshScreen(id);
          if (!fresh || !validSubmission(submission)) return;
          if (fresh.screenId !== screen.screenId) {
            notice("The dialog changed. Draft and files retained; review the current dialog before sending again.");
            return;
          }
          void submitDraft(id, fresh.screenId, submission);
        }, "primary"));
      }
    }
  } finally {
    if (submissions.get(id) === submission.controller) submissions.delete(id);
    pending.delete(id);
    renderAttachments();
    updateCompose();
  }
}

function frame(message: Frame) {
  if (message.type === "state") {
    state = message.state;
    const requested = new URLSearchParams(location.hash.slice(1)).get(
      "terminal",
    );
    if (space) {
      const updated = state.spaces.find((s) => s.id === space!.id);
      if (!updated) return home();
      space = updated;
      tab = updated.tabs.find((t) => t.id === tab?.id);
      const terminal = tab?.terminals.find((t) => t.id === active?.id);
      if (!terminal) return showTerminal();
      active = terminal;
      updateTerminalInfo();
      renderChoices();
    } else if (requested) {
      const found = state.spaces.find((s) =>
        s.tabs.some((t) => t.terminals.some((x) => x.id === requested)),
      );
      if (found) openSpace(found, requested);
      else home();
    } else home();
  }
  if (message.type === "connection") {
    const changed = connected !== message.connected;
    connected = message.connected;
    if (!connected) {
      cancelSubmissions();
      client.cancelPending();
      if (active)
        notice(
          "Connection lost. Pending input was cancelled. Delivery may be unknown; drafts retained. Check the terminal before continuing.",
        );
    }
    updateTerminalInfo();
    updateCompose();
    renderChoices();
    if (changed && !space) home();
  }
  if (message.type === "screen" && message.terminalId === active?.id) {
    screenGeneration++;
    paint(message.text, message.cols, message.rows, message.prompt);
  }
  if (
    message.type === "output" &&
    message.terminalId === active?.id &&
    emulator
  ) {
    screenGeneration++;
    observation.output(message);
  }
  if (message.type === "error") {
    if (message.watchId && message.watchId !== observation.watchId) return;
    if (message.terminalId && message.terminalId !== active?.id) return;
    if (message.code === "observer_unavailable") observation.unavailable();
    else notice(message.message);
  }
}
function modal(title: string) {
  const dialog = element("dialog");
  const head = element("div", "dialog-heading");
  head.append(
    element("h2", "", title),
    button("×", () => dialog.close(), "icon"),
  );
  dialog.append(head);
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (!space && client.token) home();
  });
  root.append(dialog);
  dialog.showModal();
  return dialog;
}
function newSpace(
  machineId = state?.machines.find((m) => m.online)?.id ?? "local",
) {
  if (!state) return;
  const dialog = modal("New space");
  const form = element("form");
  const machine = element("select");
  machine.setAttribute("aria-label", "Machine");
  for (const m of state.machines) {
    const option = element("option", "", m.name);
    option.value = m.id;
    option.disabled = !m.online;
    option.selected = m.id === machineId;
    machine.append(option);
  }
  const name = element("input");
  name.placeholder = "Space name";
  name.setAttribute("aria-label", "Space name");
  name.required = true;
  name.maxLength = 100;
  name.value = "New space";
  const cwd = element("input");
  cwd.placeholder = "Working directory";
  cwd.setAttribute("aria-label", "Working directory");
  cwd.required = true;
  cwd.autocapitalize = "off";
  cwd.spellcheck = false;
  const defaultDirectory = () => {
    cwd.value =
      (space?.machineId === machine.value ? space.cwd : undefined) ||
      state?.spaces.find((item) => item.machineId === machine.value && item.cwd)
        ?.cwd ||
      "";
  };
  defaultDirectory();

  const program = element("select");
  program.setAttribute("aria-label", "Program");
  const submit = element("button", "primary", "Create space");
  submit.type = "submit";
  const updatePrograms = () => {
    program.replaceChildren();
    for (const p of state!.programs.filter(
      (item) => item.machineId === machine.value,
    )) {
      const option = element("option", "", p.name);
      option.value = p.id;
      program.append(option);
    }
    submit.disabled = !program.options.length;
  };
  updatePrograms();
  machine.onchange = () => {
    defaultDirectory();
    updatePrograms();
  };
  const error = element("p", "form-error");
  error.role = "alert";
  form.append(machine, name, cwd, program, submit, error);
  dialog.append(form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      const result = await client.request<{
        spaceId: string;
        terminalId: string;
      }>("/spaces", {
        machineId: machine.value,
        name: name.value,
        cwd: cwd.value,
        programId: program.value,
      });
      dialog.close();
      state = await client.state();
      const found = state.spaces.find((s) => s.id === result.spaceId);
      if (found) openSpace(found, result.terminalId);
      else home();
    } catch (e) {
      error.textContent = (e as Error).message;
      submit.disabled = false;
    }
  };
}
function settings() {
  const dialog = modal("Settings");
  if (client.token) notificationSettings(dialog, client);
  dialog.append(
    button(
      "Disconnect this phone",
      async () => {
        try {
          await client.request("/device", undefined, "DELETE");
          forgetDrafts();
          client.forget();
          dialog.close();
          pairing();
        } catch (e) {
          notice((e as Error).message);
        }
      },
      "settings-action",
    ),
  );
}
async function start() {
  const epoch = ++appEpoch;
  home();
  try {
    const snapshot = await client.state();
    if (epoch !== appEpoch) return;
    state = snapshot;
    client.onFrame = frame;
    client.onConnection = (value) => {
      const changed = connected !== value;
      connected = value;
      if (!value) cancelSubmissions();
      conversation?.connection(value);
      if (!value && active)
        notice(
          "Connection lost. Pending input was cancelled. Delivery may be unknown; drafts retained. Check the terminal before continuing.",
        );
      if (changed && !space) home();
      else updateTerminalInfo();
      updateCompose();
      renderChoices();
    };
    client.connect();
    frame({ type: "state", state });
  } catch (e) {
    if (epoch !== appEpoch) return;
    if (client.token) {
      home();
      notice((e as Error).message);
      const retry = button("Retry connection", () => void start(), "retry");
      root.append(retry);
    }
  }
}
client.onUnauthorized = () => {
  cancelSubmissions();
  forgetDrafts();
  client.forget();
  state = undefined;
  pairing("Pair this phone to continue.");
};
window.addEventListener("pagehide", () => { cancelSubmissions(); releasePreviews(); });
window.addEventListener("pageshow", renderAttachments);
window.addEventListener("hashchange", () => {
  if (!state) return;
  const requested = new URLSearchParams(location.hash.slice(1)).get("terminal");
  const found = state.spaces.find((s) =>
    s.tabs.some((t) => t.terminals.some((x) => x.id === requested)),
  );
  if (found && requested) openSpace(found, requested);
  else frame({ type: "state", state });
});
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(() => {});
if (client.token) void start();
else pairing();

function mirrorRowHeight() {
  const screen = emulator?.element?.querySelector<HTMLElement>(".xterm-screen");
  const viewport = root.querySelector<HTMLElement>(".terminal-viewport");
  if (!screen || !viewport || !emulator) return 1;
  const scale = Math.min(1, (viewport.clientWidth - 24) / screen.offsetWidth);
  return screen.offsetHeight / emulator.rows * scale;
}
function syncMirrorScroll(viewport: HTMLElement) {
  if (!emulator || !observation.active) return;
  const remaining = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
  if (viewport.scrollTop < mirrorPosition - 1) mirrorFollowing = false;
  else if (remaining < 2) mirrorFollowing = true;
  mirrorPosition = viewport.scrollTop;
  const line = Math.min(emulator.buffer.active.baseY, Math.floor((mirrorPosition + 0.5) / mirrorRowHeight()));
  emulator.scrollToLine(line);
  const canvas = emulator.element?.parentElement;
  if (canvas) canvas.style.top = `${line * mirrorRowHeight()}px`;
}
function scrollMirrorNewest() {
  if (terminalView !== "mirror") return;
  const viewport = root.querySelector<HTMLElement>(".terminal-viewport");
  if (!viewport) return;
  viewport.scrollTop = viewport.scrollHeight;
  syncMirrorScroll(viewport);
}
function requestHistory() {
  if (!active || !observation.active || historyBusy || historyStopped || !emulator) return;
  const viewport = root.querySelector<HTMLElement>(".terminal-viewport");
  if (!viewport) return;
  let anchor: BufferAnchor | undefined;
  if (terminalView === "mirror") {
    const index = Math.min(emulator.buffer.active.baseY, Math.floor((viewport.scrollTop + 0.5) / mirrorRowHeight()));
    const text = emulator.buffer.active.getLine(index)?.translateToString(true) ?? "";
    anchor = { text, index, offset: viewport.scrollTop - index * mirrorRowHeight(), view: "mirror" };
    mirrorFollowing = false;
  } else {
    const top = viewport.getBoundingClientRect().top;
    const row = [...root.querySelectorAll<HTMLElement>(".read-line")].find(row => row.getBoundingClientRect().bottom > top);
    if (!row) return;
    const text = row.textContent ?? "";
    const index = currentText.split("\n").findIndex(line => line.trimEnd() === text);
    anchor = { text, index, offset: row.getBoundingClientRect().top - top, view: "read" };
    followingNewest = false;
  }
  pendingAnchor = anchor;
  historyBusy = true;
  historyBudget = Math.min(100000, historyBudget + 500);
  observerLabel = "Loading earlier history…";
  updateTerminalInfo();
  client.watch(active.id, historyBudget);
}

// Browser integration imports this module under Vite. Production exposes no
// inspection object, terminal reference, or input operation.
export const inspectTerminal = import.meta.env.DEV ? (includeCells = true) => {
  if (!emulator || !active) return null;
  const buffer = emulator.buffer.active;
  const rows = Array.from({ length: buffer.length }, (_, i) => {
    const line = buffer.getLine(i);
    return {
      text: line?.translateToString(true) ?? "",
      cells: includeCells ? Array.from({ length: line?.length ?? 0 }, (_, j) => {
        const cell = line!.getCell(j)!;
        return { text: cell.getChars(), bg: cell.getBgColor(), bgMode: cell.getBgColorMode(), fg: cell.getFgColor(), fgMode: cell.getFgColorMode() };
      }) : [],
    };
  });
  return { terminalId: active.id, size: { cols: emulator.cols, rows: emulator.rows }, type: buffer.type, baseY: buffer.baseY, viewportY: buffer.viewportY,
    rows, resets: observation.resets, fullPatches: fallbackFullPatches, rowPatches: fallbackRowPatches, watchId: observation.watchId,
    history: historyBudget, historyBusy, historyStopped, observer: observation.active, followingNewest, readPosition, mirrorPosition, rowHeight: mirrorRowHeight() };
} : undefined;
