# Herdr Phone: plan

Your Herdr agents on your iPhone, looking and working like the Herdr app. It's a web app added to your home screen, with no App Store and no Apple account. Decided 2026-10-31.

## Why we're building it
- Collie works but doesn't feel like the Herdr app. It also can't rename agents or jump to one.
- The other phone apps either only see the old terminal herdr, or are native, which needs a paid Apple account.
- herdr-core already gives us everything through `hc connect`, the same feed the desktop app uses: terminals, live events, the spaces-and-tabs layout, and the Mac through the PC's own link.

## How it works
```
iPhone (home-screen app) --HTTPS over Tailscale--> bridge on the PC --hc connect--> herdr-core (PC + Mac)
```
- **Bridge.** A small Bun server on the PC, published with `tailscale serve`, so it only opens on your devices. It talks to herdr-core, and the Mac comes through the PC's own Herdr link (no second install, no crew).
- **Pairing, like Collie.** `herdr-phone pair` prints an 8-character code that lasts 10 minutes and works once. You type it into the app, and the app keeps a device token (the bridge stores only its hash). Revoke with `herdr-phone devices revoke iPhone`. Every request needs the token.
- **Notifications.** Web Push, already proven on your phone. The bridge follows `events.subscribe` and pings you when an agent is blocked waiting on you or finishes a turn. Tap the notification to open that agent.

## What it does (v1): his spec, 2026-10-31
Keep it simple but effective. Reference: the Herdr app's Spaces sidebar. A
public-safe [home preview](docs/screens/home-webkit.png) uses neutral sample spaces.
1. **Home is the Herdr Spaces sidebar.** It has the "Spaces" header, then groups for "This computer" and "mac", each with its online dot. Every space has its coloured letter tile, its name, and a subtitle with the repo and branch. Herdr's own colours, fonts and spacing.
2. **The + buttons work.** The + next to a machine opens a new space on that machine. The + at the top opens a new space too.
3. **Tap a space and its first tab opens,** with the other tabs across the top. Tap a tab to switch.
4. **The tab is the live terminal,** and tapping it brings up a compose box. Text stays on the phone until Send or Enter submits the whole message, including punctuation and Unicode. A blocked dialog requires a separate explicit confirmation before sending anyway.
5. **Key bar** above the keyboard:
   - **Shift+Tab**, to cycle modes
   - **Esc**
   - **up and down arrows**
   - **Enter**
   - **^C**
6. **Yes and No buttons.** When an agent asks to approve something, its choices become big tappable buttons.
7. **Slash commands work end to end.** You type /model, /effort or /mcp, and their menus show in the terminal. You move through them with the arrow and Enter buttons, or tap an option.
8. **Pairing by code, and lock-screen notifications** when an agent needs you or finishes.

## Later (not v1)
- A chat view: an agent's conversation as messages instead of the terminal.
- Rename an agent, and jump to it on the desktop.
- Your Herdr mods on the phone, a files and changes view, and an iPad layout.

## Build plan
| Phase | What | Done when |
|---|---|---|
| 0. Look | Settled: the Herdr Spaces sidebar. | Done 2026-10-31. |
| 1. Bridge | Talks to `hc connect`, lists agents on both machines, pairing, tokens, `tailscale serve`. | It lists your real agents on the PC and Mac. |
| 2. Core screens | Home (spec 1–2), space with tabs and the live terminal (3–4), key bar (5), Yes/No buttons (6), slash menus (7). | You talk to an agent from the phone, approve something, and change /model. |
| 3. Push | Lock-screen notifications. | A blocked agent pings your phone and you answer it in two taps. |
| 4. Polish + swap | Herdr look pass and real-phone QA, then Collie is removed. | You say it feels like Herdr. |

## How it's checked
- Each phase is reviewed as it lands.
- Playwright with Safari's engine (WebKit) at iPhone size, real taps and swipes, and screenshots.
- The final check is on a real iPhone.

## Rules
- It runs at a new address next to Collie until you OK the swap, so nothing you have now breaks.
- Only your paired devices can see or touch an agent. A paired phone is like a login to your PC, so revoke a lost phone at once.
- Nothing is shown to you as done until it works on your phone.

## Implementation boundaries

The browser and bridge contract is [docs/API.md](docs/API.md). Slice work is
isolated on branches and merged only after a cross-review of the first working
commit and focused verification.

| Slice | Owned paths | Development port |
|---|---|---|
| Bridge | `server/`, `bin/`, `docs/API.md` | 8791 |
| Web | `web/` | 5176; browser tests 5177 |
| Integration | Root configuration, `tools/`, CI, documentation and merges | 8790; verification 8792 |

Phase 1 requires a token-authenticated request listing actual spaces from the
local and remote core. Authentication, pairing expiry, failed attempts,
single-use consumption and revocation are tested independently. Terminal input
and observation checks use disposable terminals exclusively. No test resizes
existing desktop terminals, modifies active work or changes desktop focus.

Published fixtures and screenshots use neutral sample data. Local evidence,
machine configuration and credentials stay outside the tracked tree. One final
whole-suite run follows the phase reviews; intermediate runs target changed
behaviour only.
