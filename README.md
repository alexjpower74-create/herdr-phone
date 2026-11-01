# Herdr Phone

Your [Herdr](https://herdr.dev) agents on your phone, looking and working like the Herdr desktop app.

It's a web app you add to your iPhone's home screen. There's no App Store and no Apple developer account. A small bridge runs next to herdr-core on your computer and is reachable only over your own Tailscale network. It talks to herdr-core through `hc connect`, the same feed the desktop app uses, so remote machines that herdr-core already knows show up too.

**Status:** in development. See [PLAN.md](PLAN.md) for the spec and the build phases.

## Bridge setup

The bridge currently runs on Linux with Bun 1.4.4 or newer, herdr-core (`hc`)
and `flock` from util-linux. Remote machines already connected to the local
core appear automatically; they do not need a second bridge.

Run `bun server/index.ts` from the repository. It listens only on
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
| `HERDR_PHONE_CONFIG_DIR` | `~/.config/herdr-phone/` | Private device state |
| `HERDR_PHONE_STATIC_DIR` | `web/dist` | Built web app |
| `HERDR_PHONE_HC` | `hc` | Core client executable |
| `HERDR_PHONE_PROGRAMS` | Installed app configuration | Available terminal programs |

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

## What it does (v1)
- **Home** is Herdr's Spaces sidebar, with spaces grouped by machine. A + next to each machine opens a new space there.
- **Tap a space** to open its first tab. The other tabs run across the top.
- **Each tab shows readable terminal text.** The default Read view wraps the current screen, follows new output, and lets you scroll up. Mirror shows the original desktop grid with browser pinch zoom. Compose a message locally, then tap Send or Enter to submit it. The key bar provides Shift+Tab, Esc, the arrows, Enter and ^C without changing the desktop terminal size.
- **Approval and menu buttons** preserve the choices and permission scope shown by recognized dialogs. Slash commands such as `/model` and `/effort` use the compose box; unknown menus remain usable with the key bar.
- **Pairing** uses a one-time code. Lock-screen notifications are planned for the next phase.

Drafts remain separate for each terminal while the page is open. Failed sends
keep the draft and are never replayed automatically. A blocked terminal shows
its current dialog before offering a separate “Send anyway” action. Closing
or reloading the page clears local drafts. See the [readable terminal preview](docs/screens/terminal-readable-webkit.png) for the controls with neutral sample data.

## Security
A paired phone can read every terminal and type into it, so treat pairing like a login to your computer. Keep the bridge on a private network such as Tailscale, never the public internet, and revoke a lost device at once.

## License
MIT
