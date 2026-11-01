# Herdr Phone

Your [Herdr](https://herdr.dev) agents on your phone, looking and working like the Herdr desktop app.

It's a web app you add to your iPhone's home screen. There's no App Store and no Apple developer account. A small bridge runs next to herdr-core on your computer and is reachable only over your own Tailscale network. It talks to herdr-core through `hc connect`, the same feed the desktop app uses, so remote machines that herdr-core already knows show up too.

**Status:** in development. See [PLAN.md](PLAN.md) for the spec and the build phases.

## Quick start

You need a Linux computer with a systemd user session, Git, Bun **1.4.4 or
newer**, Node.js **22.12 or newer** for the web build/tools, and `flock` from
util-linux. Herdr and herdr-core must already be running under the same user,
with `hc` available. Machines already connected to that core appear automatically;
only one bridge is needed.

Install Tailscale on the computer and phone, connect both to the same tailnet,
and enable MagicDNS and [HTTPS certificates](https://tailscale.com/docs/how-to/set-up-https-certificates).
Optional features need Python 3 for saved conversations and attachment storage,
ImageMagick with HEIF support for images, and Poppler's `pdfinfo` for PDFs.
Remote conversations and uploads also need Python 3 on the remote machine and
noninteractive SSH access from the bridge user.

1. **Clone, install both sets of dependencies, and build the web app.**

   ```sh
   mkdir -p "$HOME/Projects"
   git clone https://github.com/alexjpower74-create/herdr-phone.git "$HOME/Projects/herdr-phone"
   cd "$HOME/Projects/herdr-phone"
   bun install --frozen-lockfile
   (cd web && bun install --frozen-lockfile)
   bun run build
   ```

2. **Set the private browser origin.** Create the configuration directory:

   ```sh
   install -d -m 700 "$HOME/.config/herdr-phone"
   ```

   Save this as `~/.config/herdr-phone/environment`, replacing the hostname
   placeholder with this computer's full Tailscale DNS name. Include `:8443`
   and omit any trailing slash or path.

   ```ini
   HERDR_PHONE_ORIGIN=https://<full-tailnet-hostname>:8443
   HERDR_PHONE_LOCAL_NAME="This computer"
   ```

   ```sh
   chmod 600 "$HOME/.config/herdr-phone/environment"
   command -v bun
   command -v hc
   ```

3. **Create the user service.** Create `~/.config/systemd/user/` if needed and
   save the following as `~/.config/systemd/user/herdr-phone.service`.
   `%h` means your home directory. This example assumes Bun is in `~/.bun/bin`
   and `hc` is in `~/.local/bin` or a system bin directory; adjust `ExecStart`
   and `PATH` to match the paths printed above. Adjust `WorkingDirectory` and
   the entry-point path if you cloned elsewhere.

   ```ini
   [Unit]
   Description=Herdr Phone
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   WorkingDirectory=%h/Projects/herdr-phone
   EnvironmentFile=%h/.config/herdr-phone/environment
   Environment="PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin"
   ExecStart=%h/.bun/bin/bun %h/Projects/herdr-phone/bin/herdr-phone serve
   Restart=on-failure
   RestartSec=3
   UMask=0077

   [Install]
   WantedBy=default.target
   ```

4. **Start the bridge and publish it privately over HTTPS.**

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now herdr-phone.service
   tailscale serve --bg --https=8443 http://127.0.0.1:8790
   tailscale serve status
   ```

   Use `sudo` for the Tailscale command if your installation requires it.
   [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
   handles HTTPS in front of the loopback bridge. The URL it prints must match
   `HERDR_PHONE_ORIGIN` exactly. Port 8443 leaves an existing HTTPS service on
   port 443 alone. The computer and its user service must remain running.
   For startup errors, check `journalctl --user -u herdr-phone.service -n 50`;
   the loopback health endpoint is `http://127.0.0.1:8790/api/health`.

5. **Add the phone app and pair it.** With Tailscale connected on the iPhone,
   open the HTTPS URL in Safari, choose **Share → Add to Home Screen**, then
   launch Herdr from its new icon. From the repository on the computer, run:

   ```sh
   bun bin/herdr-phone pair
   ```

   This is `herdr-phone pair` when the repository's `bin/` directory is on
   your PATH. Enter the eight-character code in the phone app. It expires
   after ten minutes, works once, and is invalidated after five wrong attempts.
   Home should now show your spaces; tap one to open its first tab.

6. **Optionally enable saved conversations.** Save a private
   `~/.config/herdr-phone/transcripts.json` using the example below. Replace
   each placeholder directory with the JSONL logs and, for message-envelope
   records, the PID session index produced by your terminal program. Keep only
   the sources you actually use. The remote key must match its herdr-core
   machine alias; `ssh` is an existing alias in your SSH configuration.

   ```json
   {
     "machines": {
       "local": {
         "sources": [
           { "format": "messages", "root": "~/message-logs", "sessions": "~/session-index" },
           { "format": "responses", "root": "~/response-logs" }
         ]
       },
       "remote": {
         "ssh": "configured-ssh-alias",
         "sources": [{ "format": "responses", "root": "~/response-logs" }]
       }
     }
   }
   ```

   ```sh
   chmod 600 "$HOME/.config/herdr-phone/transcripts.json"
   ```

   Remove the `remote` entry for a local-only setup. See the
   [source formats and process matching](docs/API.md#conversation-history) for
   details. Until a matching source is configured, Conversation shows an
   unavailable message; **Terminal view** and the input controls still work.

## Bridge configuration

`bun bin/herdr-phone devices list` lists paired devices;
`bun bin/herdr-phone devices revoke <label-or-id>` removes access.
Restarting the bridge preserves device credentials. Device state is stored
privately under `~/.config/herdr-phone/`; only token hashes are retained.
The bridge listens only on `127.0.0.1:8790` by default and serves `web/dist`.

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

## Contributing

Pull requests against **main** are welcome. Fork the repository, make a focused
change on a branch, and describe the behavior and checks in your PR. Keep private
configuration, tokens, transcript files, machine names and screenshots of real
sessions out of commits.

Install both locked dependency sets as in Quick start. For local development,
port 8790 must be free: use the foreground bridge instead of the installed user
service. From the repository, run this in one shell:

```sh
HERDR_PHONE_ORIGIN=http://127.0.0.1:5176 bun bin/herdr-phone serve
```

In a second shell, run `bun run --cwd web dev` and open
`http://127.0.0.1:5176`. Vite proxies `/api` and WebSockets to the bridge on
8790. Pair the development browser with a fresh code. This loopback setup is
for development; the phone uses the HTTPS setup above.

Install the test browsers once, then run the relevant checks from the repository:

```sh
(cd web && bunx playwright install --with-deps chromium webkit)
bun test ./server
bun run --cwd web test:unit
bun run --cwd web test
bun run build
tools/check-no-personal-data
```

The browser suite runs Chromium and WebKit with mocked APIs on its own port
5177. Node.js is required by its server command; Python 3 runs the privacy
scanner. The server suite also exercises the optional image/PDF dependencies
listed above. `tools/check-no-personal-data --self-test` verifies the scanner
against planted private values.

Automated checks must not type into, resize or scroll existing terminals.
Opt-in `tools/test-*-integration.ts` scripts require
`HERDR_PHONE_INTEGRATION=1` and create disposable terminals in separate test
spaces. Review each script's prerequisites before running it and preserve its
cleanup and ownership checks.

## What it does (v1)

- **Home** is Herdr's Spaces sidebar, with spaces grouped by machine. A + next to each machine opens a new space there.
- **Tap a space** to open its first tab. The other tabs run across the top.
- **Each tab opens in Conversation.** Saved messages stay live, with your messages highlighted and older turns available by scrolling up. New replies follow at the bottom until you scroll away. **Terminal view** switches to the live terminal; **Conversation** brings you back.
- **Terminal view** starts in Mirror, keeping ANSI colours, fitting the phone width and supporting browser pinch zoom. Read wraps the text and follows new output until you scroll up. Both terminal views begin with about 500 retained history rows and load earlier rows at the top. The device remembers your Mirror/Read choice inside Terminal view; reopening a tab always starts in Conversation.
- **Compose and controls** work in either view. Compose locally, then tap Send or Enter to submit the message. The key bar provides Shift+Tab, Esc, the arrows, Enter and ^C without changing the desktop terminal size.
- **Attachments** use the paperclip for photos, camera images, PDFs and text files. Preview or remove selections locally; Send transfers them to the terminal's machine with your message.
- **Approval and menu buttons** preserve the choices and permission scope shown by recognized dialogs. Slash commands such as `/model` and `/effort` use the compose box; unknown menus remain usable with the key bar.
- **Pairing** uses a one-time code. Optional notifications tell you when a terminal needs you or finishes; tapping one opens its tab.

Drafts remain separate for each terminal while the page is open. Failed sends
keep the draft and are never replayed automatically. A blocked terminal shows
its current dialog before offering a separate “Send anyway” action. Closing
or reloading the page clears local drafts. The phone observes output without sending
resize or focus changes. Mirror and Read show history retained by the core.
**Conversation** opens saved messages from the current process's transcript,
including conversations kept privately by full-screen applications. Messages
load up to 50 turns at a time back to the beginning, with your messages highlighted
and tool calls collapsed to one line. The phone never scrolls the application
to retrieve them. Large transcripts load in bounded windows backwards from the
end, without a total-file size limit. Oversized records show a trimming notice;
older pages continue from where the previous window stopped. Missing history,
offline machines and reader errors have separate messages.

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
The [default view preview](docs/screens/conversation-default-webkit.png) shows
Conversation with live replies and the Terminal view button.
The [saved conversation preview](docs/screens/conversation-history-webkit.png)
shows the first message reached through paged history on a phone.
The [attachment preview](docs/screens/attachments-webkit.png) shows photo,
text and PDF selections before Send in the disposable-terminal upload check.
When the keyboard opens, the header and compose controls stay inside the
visible app area. Safe-area padding is applied once, while the terminal and
long menus scroll within the remaining space. The
[keyboard layout preview](docs/screens/keyboard-layout-webkit.png) shows that
area under an emulated 400px keyboard viewport; real phone verification follows.

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
