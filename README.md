# Herdr Phone

Your [Herdr](https://herdr.dev) agents on your phone, looking and working like the Herdr desktop app.

It's a web app you add to your iPhone's home screen. There's no App Store and no Apple developer account. A small bridge runs next to herdr-core on your computer and is reachable only over your own Tailscale network. It talks to herdr-core through `hc connect`, the same feed the desktop app uses, so remote machines that herdr-core already knows show up too.

**Status:** in development. See [PLAN.md](PLAN.md) for the spec and the build phases.

## What it does (v1)
- **Home** is Herdr's Spaces sidebar, with spaces grouped by machine. A + next to each machine opens a new space there.
- **Tap a space** to open its first tab. The other tabs run across the top.
- **Each tab is the live terminal.** Tap it to type, using a key bar with Shift+Tab, Esc, the arrows, Enter and ^C.
- **Yes and No buttons** appear when an agent asks for approval. Slash commands like `/model` and `/effort` work end to end.
- **Pairing** uses a one-time code. Lock-screen notifications fire when an agent needs you or finishes.

## Security
A paired phone can read every terminal and type into it, so treat pairing like a login to your computer. Keep the bridge on a private network such as Tailscale, never the public internet, and revoke a lost device at once.

## License
MIT
