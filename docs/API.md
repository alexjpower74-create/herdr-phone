# Bridge API v1

The browser and bridge use one origin. The bridge listens on loopback port
8790; a private HTTPS proxy exposes it on port 8443. API responses are JSON
with `Cache-Control: no-store`. Static app files are public so an unpaired
phone can open the pairing screen. Terminal contents are never public.

## Authentication and errors

All `/api/*` routes except `GET /api/health` and `POST /api/pair` require
`Authorization: Bearer <device-token>`. Tokens contain at least 32 random
bytes, encoded with base64url. Only their SHA-256 hashes are persisted.
Revocation takes effect on the next request and closes existing sockets.
No token, pairing code or terminal contents may appear in request logs.

Browser requests must have the same origin as the configured external URL.
Requests without Origin (such as the local CLI) are permitted. No wildcard
CORS. WebSocket upgrades require an allowed Origin. Production configuration
uses `HERDR_PHONE_ORIGIN`; development permits its exact loopback origin.

Errors have the shape `{ "error": { "code": "unauthorized", "message":
"Pair this device to continue." } }`. Status codes: 400 invalid input,
401 absent/revoked token or rejected pairing, 404 missing resource,
409 conflicting state, 413 oversized input, 429 throttled, 503 core unavailable.
Do not return raw process arguments, environment variables or stack traces.

## Pairing and device management

`herdr-phone pair` creates and prints an eight-character, unambiguous uppercase
code, valid for ten minutes. Creating another invalidates the previous code.
The code is single use; five incorrect exchanges burn it. Comparison and
consumption are atomic, including concurrent requests. Invalid or expired
codes produce the same response. Rate-limit exchanges independently of the
code's attempt counter. Store the code hash, expiry and attempt count only.

`POST /api/pair`

Request: `{ "code": "<eight characters>", "label": "My phone" }`.
Trim and uppercase the code. Label is 1–64 characters after trimming.
Response 201: `{ "token": "<device-token>", "device": { "id": "<opaque-id>",
"label": "My phone", "createdAt": "<ISO date>" } }`.

`GET /api/device` returns `{ "device": { "id", "label", "createdAt" } }`.
`DELETE /api/device` revokes the calling device and returns 204.
CLI: `herdr-phone devices list`, `herdr-phone devices revoke <label-or-id>`.
Ambiguous labels must not revoke multiple devices silently.

State defaults to `~/.config/herdr-phone/`, override with
`HERDR_PHONE_CONFIG_DIR`. Directory mode is 0700; state/key files are 0600.
Use atomic replacement and a shared lock for CLI/server read-modify-write.
State corruption fails closed and must never silently reset paired devices.

## Health and the home screen

`GET /api/health` returns `{ "ok": true, "version": "1", "core": "connected" }`.
An unavailable core returns 503 with `core: "disconnected"`. No machine or
terminal details are disclosed here.

`GET /api/state` returns a complete normalized snapshot:

```ts
type State = {
  version: 1;
  revision: number;
  machines: Machine[];
  spaces: Space[];
  programs: Program[];
};
type Machine = {
  id: string; // "local", or the configured remote alias
  name: string; // "This computer" locally, configured alias remotely
  online: boolean;
};
type Space = {
  id: string; // local layout id, prefixed "machine/" when remote
  machineId: string;
  name: string;
  cwd: string;
  repo: string | null;
  branch: string | null;
  color: string; // CSS hex, validated before rendering
  tabs: Tab[];
};
type Tab = { id: string; name: string; terminals: Terminal[] };
type Terminal = {
  id: string; // core address, including remote prefix
  title: string;
  state: "live" | "finished";
  status: "idle" | "working" | "done" | "blocked" | "error" | "unknown";
  cols: number;
  rows: number;
};
type Program = { id: string; name: string };
```

Preserve document space/tab order, local machine first then remote aliases.
The bridge reads each core's `herdr-app` document through `doc.get`, and joins
its terminal ids with `terminal.list`/`events.subscribe`. Remote addresses
remain qualified throughout. Include empty spaces; exclude temporary machines.
Offline machines retain their last known spaces with `online: false`.
Missing repo/branch information is null, never fabricated. Cache metadata so
opening home is not blocked on repeated subprocess or repository scans.
Read program ids and display names from the installed app's `programs.json`;
never send launch arguments to the phone.

## Terminal display and input

`GET /api/terminals/:id/screen` returns `{ "terminal": Terminal, "text":
"<screen>", "complete": true }`. Encode the entire id with
`encodeURIComponent`, including its remote slash. Read with history zero;
never scroll a live application to obtain history.

`POST /api/terminals/:id/keys`, body `{ "keys": ["shift+tab"] }`, returns
`{ "ok": true }` after core acknowledgement. Supported bar names are
`shift+tab`, `esc`, `up`, `down`, `enter`, `ctrl+c`; individual printable
Unicode characters and `backspace`, `tab`, `left`, `right`, `delete`, `home`,
`end` are also accepted. Validate the array and bound each request.

`POST /api/terminals/:id/input`, body `{ "text": "hello" }`, types literal
text without implicit Enter, using the core's named-key API with one Unicode
character per key. Translate CR/LF, tab, escape, backspace and control-C
explicitly. Reject unknown control sequences. The bridge serializes input
per terminal. Clients await acknowledgements and never replay unacknowledged
input automatically after a disconnect. Keep one terminal's input associated
with that terminal when switching tabs. Request text is at most 4096 bytes.

`POST /api/terminals/:id/send`, body `{ "text": "hello" }`, is an optional
complete-message action using `terminal.send` (which includes Enter). It
must not force past a blocked state. Interactive typing uses `/input` and
`/keys`, so menus and explicit approval choices remain usable.

Installed-core limitation: the current named-key parser accepts a subset of
ASCII. Spaces use the `space` alias and uppercase letters use `shift+letter`.
It cannot preserve the shifted punctuation `!"#$%&()*+:<>?@^_{|}~` or non-ASCII
characters. Until a safe literal-text transport is available, `/input` and
printable `/keys` reject a request containing any unsupported character with
400 `unsupported_input`, before writing any part of it. The key bar is supported.
Arbitrary literal typing remains blocked; the intended literal-input contract
above is not yet fully implemented.

No resize endpoint exists. The client sets its own emulator to the desktop
cols/rows and scales the rendered terminal to the available width. Use
`terminal.attach` only with `observe: true`, and only after a disposable
terminal proves it leaves size unchanged. No DATA input, RESIZE or FOCUS
frames on observation channels. If that promise does not hold, use screen
reads and events instead. Testing never attaches to a user's running work.

## WebSocket

Connect to `/api/ws` using subprotocols `herdr-phone.v1` and
`auth.<device-token>`. The server selects only `herdr-phone.v1`; the credential
must never be put in the URL, echoed as a protocol or logged. Validate token
and Origin before upgrade. Close revoked devices with code 4001.

All messages are JSON. Server sends `{ "type": "state", "state": State }`
initially and after layout/status changes. A missed core event or reconnect
causes a fresh full snapshot, not partial state presented as current.

Client: `{ "type": "watch", "terminalId": "t1" }` subscribes to one
terminal, releasing any previous stream. `{ "type": "unwatch" }` releases it.
Server: `{ "type": "screen", "terminalId", "cols", "rows", "text" }`
is a complete plain-text replacement. When safe observer streams are available,
server instead sends `{ "type": "output", "terminalId", "cols", "rows",
"reset": true, "data": "<base64 ANSI bytes>" }` followed by messages with
`reset: false`. Reset the emulator before the first paint; use a streaming
UTF-8 decoder for split byte sequences. Never apply output for an old tab.
Terminal size changes update only the phone emulator.

`{ "type": "error", "code", "message", "terminalId"? }` reports recoverable
errors. `{ "type": "connection", "connected": false }` marks stale state
while the core reconnects. Bound frame sizes and socket buffers; disconnect
slow consumers rather than accumulating unlimited output. Reconnect with
bounded exponential backoff; refresh state and re-watch after reconnect.
Typing goes through acknowledged HTTP routes, not socket messages.

## Space creation (Phase 2)

`POST /api/spaces`: `{ "machineId": "local", "name": "Work", "cwd":
"<folder>", "programId": "<configured-id>" }`. Response 201:
`{ "spaceId": "<id>", "tabId": "<id>", "terminalId": "<address>" }`.

Validate machine, configured program, name and directory; do not accept shell
command strings. Use fresh layout ids and `terminal.run` with `herdr.space`
and `herdr.tab` labels, then an optimistic `doc.set` update with conflict
retry to name the space/tab. Preserve all existing layout fields. Do not
change desktop focus. Fail cleanly if the machine is offline. Roll back only
the newly created terminal on a failed creation; never touch other terminals.

## Push (Phase 3)

`GET /api/push/key` returns `{ "publicKey": "<base64url VAPID key>" }`.
`POST /api/push/subscription` accepts the browser's PushSubscription JSON and
returns 201 `{ "ok": true }`. `DELETE /api/push/subscription` with
`{ "endpoint": "<endpoint>" }` removes that device's subscription, 204.
Subscriptions belong to the authenticated device and are removed on revocation.
Validate HTTPS push endpoints against supported push services; reject local,
private and arbitrary destinations to prevent server-side request forgery.

Follow core status/turn events. Notify on entry into blocked and on a completed
turn, once per terminal/turn/type. Initial snapshots and reconnection must not
re-notify old states. Notification payload: `{ "title": "Herdr", "body":
"A terminal needs you", "tag": "<terminal/turn/kind>", "url":
"/#terminal=<encoded-id>" }`. Keep terminal contents out of lock-screen text.
Persist VAPID keys privately; discard expired subscriptions on 404/410.

## Verification boundary

Pairing expiry, reuse, five failures, concurrent exchange, revocation, origin
validation and authorization require tests with failing controls. Protocol
tests cover split/coalesced frames, disconnects and remote ids. Real-core
verification lists existing spaces read-only; input/observation tests use
only a disposable terminal. Never resize a desktop terminal in a test.
