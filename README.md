# Herdr Phone

Your [Herdr](https://herdr.dev) agents on your phone, looking and working like the Herdr desktop app.

It's a web app you add to your iPhone's home screen. There's no App Store and no Apple developer account. A small bridge runs next to herdr-core on your computer and is reachable only over your own Tailscale network. It talks to herdr-core through `hc connect`, the same feed the desktop app uses, so remote machines that herdr-core already knows show up too.

**Status:** in development. See [PLAN.md](PLAN.md) for the spec and the build phases.

## Bridge setup

The bridge currently runs on Linux with Bun 1.4.4 or newer, herdr-core (`hc`)
and `flock` from util-linux. Remote machines already connected to the local
core appear automatically; they do not need a second bridge.

Install the locked bridge dependencies with `bun install --frozen-lockfile`,
then run `bun server/index.ts` from the repository. It listens only on
`127.0.0.1:8790`. Set `HERDR_PHONE_ORIGIN` to the exact browser origin before
exposing it through a private HTTPS proxy. For Tailscale, port 8443 permits
running alongside an existing service on the default HTTPS port.

Pair a phone with `bun bin/herdr-phone pair`. The eight-character code expires
in ten minutes, works once, and is invalidated after five wrong attempts.
`bun bin/herdr-phone devices list` lists paired devices;
`bun bin/herdr-phone devices revoke <label-or-id>` removes access.
Restarting the bridge preserves device credentials. Device state is stored
privately under `~/.config/herdr-phone/`; only token hashes are retained.

| Setting | Default | Purpose |
|---|---|---|
| `HERDR_PHONE_PORT` | `8790` | Loopback listening port |
| `HERDR_PHONE_ORIGIN` | Loopback HTTP origin | Exact allowed browser origin |
| `HERDR_PHONE_LOCAL_NAME` | `This computer` | Local machine group display name |
| `HERDR_PHONE_CONFIG_DIR` | `~/.config/herdr-phone/` | Private device state |
| `HERDR_PHONE_STATIC_DIR` | `web/dist` | Built web app |
| `HERDR_PHONE_HC` | `hc` | Core client executable |
| `HERDR_PHONE_TRANSCRIPTS_CONFIG` | `~/.config/herdr-phone/transcripts.json` | Private conversation source configuration |
| `HERDR_PHONE_UPLOADS_DIR` | `~/.cache/herdr-phone/uploads` | Private local attachment storage |
| `HERDR_PHONE_PROGRAMS` | Installed app configuration | Available terminal programs |
| `HERDR_PHONE_VAPID_SUBJECT` | Configured HTTPS origin | HTTPS contact URL or mailto URI for push services |

The health check is `/api/health`. All terminal and layout APIs require a
paired device token. See [docs/API.md](docs/API.md) for the complete contract.
The bridge reads existing terminals without changing their size or scrolling
their history. Interactive verification must use disposable terminals.

## Development checks

Run `bun test server` for bridge checks and `tools/check-no-personal-data`
before publishing. The scanner's `--self-test` mode proves it rejects planted
private values, including values placed inside the scanner itself. Tests use
temporary private state and fake core processes; they do not type into existing
terminals. The browser source and its own checks live under `web/`.

The opt-in `tools/test-push-integration.ts` check requires
`HERDR_PHONE_INTEGRATION=1`. It creates one disposable terminal in a separate
test space, drives real status events and verifies encrypted delivery against
a local fake push endpoint. It checks silent reconnection, exact blocked/done
counts, signature validity and cleanup without changing desktop terminal sizes
or focus. It never contacts a public push provider.

## What it does (v1)
- **Home** is Herdr's Spaces sidebar, with spaces grouped by machine. A + next to each machine opens a new space there.
- **Tap a space** to open its first tab. The other tabs run across the top.
- **Each tab opens in Mirror.** The live terminal keeps its ANSI colours, fits the phone width and supports browser pinch zoom. Read is one header tap away: it wraps the text and follows new output until you scroll up. Both views begin with about 500 retained history rows and load earlier rows when you reach the top. Your last view choice is remembered on this device. Compose a message locally, then tap Send or Enter to submit it. The key bar provides Shift+Tab, Esc, the arrows, Enter and ^C without changing the desktop terminal size.
- **Approval and menu buttons** preserve the choices and permission scope shown by recognized dialogs. Slash commands such as `/model` and `/effort` use the compose box; unknown menus remain usable with the key bar.
- **Pairing** uses a one-time code. Optional notifications tell you when a terminal needs you or finishes; tapping one opens its tab.

Drafts remain separate for each terminal while the page is open. Failed sends
keep the draft and are never replayed automatically. A blocked terminal shows
its current dialog before offering a separate “Send anyway” action. Closing
or reloading the page clears local drafts. The phone observes output without sending
resize or focus changes. Mirror and Read show history retained by the core.
**Conversation** opens saved messages from the current process's transcript,
including conversations kept privately by full-screen applications. Messages
load 50 turns at a time back to the beginning, with your messages highlighted
and tool calls collapsed to one line. The phone never scrolls the application
to retrieve them.

Conversation sources are optional. Configure their private roots using the
[conversation API configuration](docs/API.md#conversation-history). Local reads
require Python 3; remote reads also require noninteractive SSH to the configured
machine. No additional bridge or reader is installed remotely. Missing or
ambiguous process-to-session matches show an unavailable state rather than
selecting another conversation from the same working directory.

Use the **paperclip** beside Send to choose photos, camera images, PDFs or text
files. Preview or remove selections before sending. Files stay on the phone
until Send; the bridge then stores them on the terminal's machine and submits
their paths with your message. Up to eight files are allowed, each at most
20 MiB. HEIC/HEIF images become JPEG with orientation preserved. Failed uploads
keep the draft and selected files, and send no partial message.

Attachment validation needs Python 3, ImageMagick and Poppler's `pdfinfo` on
the bridge; HEIC conversion also needs ImageMagick's HEIF support. Remote storage
uses the same private SSH mapping as Conversation. Generated files are private
(0600), never exposed as download URLs, and removed after seven days. See the
[attachment API](docs/API.md#file-attachments) for storage and capacity limits.

See the [colour preview](docs/screens/terminal-colours-after-webkit.png),
[history preview](docs/screens/terminal-history-after-webkit.png), and short
[before/after display recording](docs/screens/terminal-display-before-after.mp4),
all captured with neutral disposable-terminal output.
The [saved conversation preview](docs/screens/conversation-history-webkit.png)
shows the first message reached through paged history on a phone.
The [attachment preview](docs/screens/attachments-webkit.png) shows photo,
text and PDF selections before Send in the disposable-terminal upload check.

## Notifications

On iPhone, add Herdr to the Home Screen and open it from its icon. Open
Settings, tap the Notifications switch and allow notifications. Permission
is requested only from that tap. Use **Send test** to check delivery, and
turn the switch off to stop this device's notifications. A separate off
action remains available if browser permission or subscription state changes.
See the [Settings preview](docs/screens/notifications-webkit.png).

Messages contain only the space and tab names, followed by “needs you” or
“finished”. They never include terminal text, terminal titles or status
messages. Notifications follow live core events; opening the app or
reconnecting the bridge does not replay old notifications. Revoking a paired
device also removes its subscription.

The bridge keeps its VAPID keys and subscriptions in the private configuration
directory. Keys persist across restarts; do not delete them while devices are
subscribed. Push endpoints are restricted to the supported Apple, Google and
Mozilla services, with redirects disabled. Expired subscriptions are removed;
transient failures are not retried automatically. “Test accepted” means the
push service accepted the request, not that a phone has displayed it.

Automated checks cover the event, encryption and Settings flows. Physical
iPhone lock-screen delivery remains an acceptance check before release.

## Security
A paired phone can read every terminal and type into it, so treat pairing like a login to your computer. Keep the bridge on a private network such as Tailscale, never the public internet, and revoke a lost device at once.

## License
MIT
