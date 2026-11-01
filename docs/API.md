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
type Program = { id: string; name: string; machineId: string };
```

Preserve document space/tab order, local machine first then remote aliases.
The bridge reads each core's `herdr-app` document through `doc.get`, and joins
its terminal ids with `terminal.list`/`events.subscribe`. Remote addresses
remain qualified throughout. Include empty spaces; exclude temporary machines.
Offline machines retain their last known spaces with `online: false`.
Resolve the subtitle from the first live terminal's current directory (fall
back to the saved space folder). For linked worktrees, use the shared Git
directory to identify the parent repository and the worktree's current branch.
Map the desktop's stored color name through its avatar palette; a valid
explicit hex color remains valid. Missing repo/branch information is null,
never fabricated. Cache metadata so
opening home is not blocked on repeated subprocess or repository scans.
Read program ids and display names from the installed app's `programs.json`;
never send launch arguments to the phone. Program ids are scoped to `machineId`;
show only the selected machine’s programs in the creation form. Remote config
is read through the current core and cached for at most 30 seconds.

## Terminal display and input

`GET /api/terminals/:id/screen` returns `{ "terminal": Terminal, "text":
"<screen>", "complete": true, "screenId": "<digest>", "prompt": Prompt | null }`.
The digest binds the terminal, current screen and reported status/turn.
Encode the entire id with
`encodeURIComponent`, including its remote slash. Read with history zero;
never scroll a live application to obtain history.

`POST /api/terminals/:id/keys`, body `{ "keys": ["shift+tab"] }`, returns
`{ "ok": true }` after core acknowledgement. Supported bar names are
`shift+tab`, `esc`, `up`, `down`, `enter`, `ctrl+c`; `backspace`, `tab`,
`left`, `right`, `delete`, `home`, `end`, ASCII letters and digits are also
accepted for menu navigation. Uppercase letters map to shifted letter keys.
Validate and bound the entire request before sending any keys. Arbitrary
literal text does not use this endpoint.

`POST /api/terminals/:id/send`, body `{ "text": "hello" }`, submits a complete
message through `terminal.send`, which pastes the literal text then presses
Enter. Spaces, punctuation, Unicode and multiline text are preserved. Reject
empty input, invalid Unicode, NUL and unexpected control characters; allow
line breaks and tabs. The UTF-8 text limit is 4096 bytes.

The phone keeps each terminal's draft locally until the person presses Send
or Enter. The key-bar Enter submits a nonempty draft; with an empty draft it
sends the named Enter key to the terminal. Composition never sends individual
keystrokes. Commands such as `/model`, `/effort` and `/mcp` use the same send
path, then their menus use the key bar or detected menu options. The former
`/input` route is removed and returns 404.

The bridge serializes send, keys and prompt actions per terminal. Clients
await acknowledgements, prevent duplicate submission, keep a pending send
associated with its original terminal, and never automatically replay an
unacknowledged request. Preserve the draft on failure and explain an unknown
delivery outcome after disconnection; clear it only when acknowledged and
only if the person has not since edited it.

Default sends always omit `force` or set it false. A blocked terminal returns
409 `terminal_blocked`. The phone keeps the draft and offers an explicit
confirmation showing the current dialog. Only a separate deliberate
"Send anyway" action submits `{ "text", "force": true, "screenId" }`.
Immediately before dispatch, the bridge verifies the terminal is still blocked
and the screen digest still matches; otherwise return 409 `stale_prompt`.
Never turn a rejected ordinary send into a forced retry automatically.

## Prompt detection and choices

The bridge detects prompts from the current history-zero screen and reported
status. The client renders the supplied choices and does not parse terminal
text. Home state does not read every terminal screen to discover prompts.

```ts
type Prompt = {
  id: string; // screen-bound digest; changes with the active dialog
  kind: "approval" | "menu";
  options: { id: string; label: string; keys: string[] }[];
};
```

Approval detection requires a currently blocked terminal and a recognized
active approval block at the end of the screen. Menu detection requires a
recognized active command menu, including its heading, selection marker and
active end-of-screen structure. Some installed menus omit navigation instructions. Unknown, truncated, historical or ambiguous text yields null;
the key bar remains available. Preserve the actual option labels, including
the scope of any remembered permission; never reduce them to a misleading Yes.
Tests use sanitized real screen structures from both supported terminal UIs,
plus ordinary numbered output and dismissed/stale prompts as negative cases.
Private originals and provenance stay outside the published tree.

`POST /api/terminals/:id/prompt`, body `{ "promptId", "optionId" }`, rereads
the current screen/status inside that terminal's input queue, detects it again,
and sends only the keys for that current option. Return `{ "ok": true }` on
acknowledgement; 409 `stale_prompt` if it changed or disappeared. Do not accept
client-supplied replacement labels or keys on this route. No prompt is acted
on without a deliberate tap.

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
Server: `{ "type": "screen", "terminalId", "cols", "rows", "text", "screenId", "prompt" }`
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
`GET /api/push/subscription` returns `{ "enabled": true, "endpoint": "<endpoint>" }`
for this device, or `{ "enabled": false, "endpoint": null }`.
`POST /api/push/subscription` accepts the browser's PushSubscription JSON and
returns 201 `{ "ok": true }`. `DELETE /api/push/subscription` with
`{ "endpoint": "<endpoint>" }` removes that device's subscription, 204.
Each device has at most one active subscription; registering replaces its old
one. The same endpoint cannot belong to two devices (`409 subscription_conflict`).
Deletion is idempotent and cannot remove another device's subscription.
Subscriptions belong to the authenticated device and are removed atomically on
revocation. Validate the expiration time, a valid uncompressed P-256 `p256dh`
public key, and a 16-byte `auth` secret. Store subscription credentials privately.

Only HTTPS endpoints on these exact hosts are accepted: `web.push.apple.com`,
`fcm.googleapis.com`, and `updates.push.services.mozilla.com`. Only the default
HTTPS port is allowed; user information and fragments are forbidden. Reject
local, private and arbitrary destinations, including deceptive host suffixes.
Never follow redirects. No HTTP request or environment setting can widen this
allowlist. Tests may inject a transport without changing production validation.

`POST /api/push/test` with `{}` sends only to this device's active subscription.
It returns 202 `{ "ok": true }` when the push service accepts the request; this
is not confirmation of delivery to a phone. No subscription, or an expired one,
returns `409 subscription_required`; a failed provider request returns
`502 push_failed`. The test payload has title `Herdr`, body `Notifications are on`,
a fresh tag and URL `/`. The Settings toggle requests permission directly from
a user gesture, registers this device on enable, and deletes its subscription
before unsubscribing the browser on disable. A permission denial, network failure,
or failed registration must not be displayed as enabled.

Follow `events.subscribe` status/turn events, including qualified remote ids.
Notify on entry into blocked and on a completed turn, once per terminal/turn/kind.
The core's turn counter identifies the turn. Initial snapshots, missed-event
resnapshots and reconnection establish a silent baseline and must not re-notify
old states. Ignore duplicate/out-of-order event sequence numbers. Live events
must be consumed in order; periodic HTTP/WS snapshots never trigger delivery.
Do not retry ambiguous provider failures automatically or replay notification
history when a device subscribes. Notification payload: `{ "title": "Herdr", "body":
"<space / tab> needs you", "tag": "<terminal/turn/kind>", "url":
"/#terminal=<encoded-id>" }`. For a finished turn, use "<space / tab> finished".
Names come from the layout, never terminal contents or terminal titles. Avoid
duplicating identical space/tab names; fall back to "A terminal" if unnamed.
Strip control characters from layout names and bound the whole body to 240
characters. Keep terminal contents, status messages and terminal titles out of
lock-screen text. Notification taps navigate to the encoded terminal id on this
origin only. The service worker validates the deep link before navigating.

Persist the VAPID key pair in the private configuration directory (0700), in a
0600 file, without regenerating it on restart or corrupt state. Use
`HERDR_PHONE_VAPID_SUBJECT` for an HTTPS contact URL or mailto URI; otherwise use
the configured HTTPS origin. Never expose the private key through the API or
logs. Discard expired subscriptions on 404/410, but retain them for transient
provider errors. Apply a bounded request timeout and a short notification TTL.

## Verification boundary

Pairing expiry, reuse, five failures, concurrent exchange, revocation, origin
validation and authorization require tests with failing controls. Protocol
tests cover split/coalesced frames, disconnects and remote ids. Real-core
verification lists existing spaces read-only; input/observation tests use
only a disposable terminal. Never resize a desktop terminal in a test.
