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
4. **Each tab opens in Conversation,** showing saved messages paged 50 turns at a time back to the beginning, with user messages highlighted and tool calls collapsed to one line. Replies update while open, following the newest until the person scrolls up. It reads the matching process's transcript on either machine without touching the terminal. The header's **Terminal view** button opens the live ANSI-coloured desktop Mirror fitted to the phone width with browser pinch zoom; that same button becomes **Conversation** to return. Read stays inside Terminal view: readable, soft-wrapped text. Both terminal views expose retained core scrollback, starting with about 500 history rows and loading older rows at the top without scrolling or resizing the desktop. A guarded device preference remembers Mirror/Read inside Terminal view; each session still opens in Conversation, including after migrating an old preference. Compose, approval/menu choices and the key bar work from either view. Text stays on the phone until Send or Enter submits the whole message, including punctuation and Unicode. A blocked dialog requires a separate explicit confirmation before sending anyway. With the keyboard open, the app follows the visible viewport so the header stays at the top and the compose controls remain directly above the keyboard, without document scrolling.
5. **Key bar** above the keyboard:
   - **Shift+Tab**, to cycle modes
   - **Esc**
   - **up and down arrows**
   - **Enter**
   - **^C**
6. **Yes and No buttons.** When an agent asks to approve something, its choices become big tappable buttons.
7. **Slash commands work end to end.** You type /model, /effort or /mcp, and their menus show in the terminal. You move through them with the arrow and Enter buttons, or tap an option.
8. **Pairing by code, and lock-screen notifications** when an agent needs you or finishes.
9. **File attachments.** A paperclip beside Send accepts photos, camera images,
   PDFs and text files. Preview or remove selections locally; Send stores them
   privately on the terminal's machine and includes their paths with the message.
   Each file is limited to 20 MiB, HEIC images become JPEG, and stored files expire
   after seven days. Upload or send failure retains the draft for deliberate retry.

## Later (not v1)
- Rich conversation formatting and searchable saved sessions.
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

## Conversation work

The API contract precedes implementation. The bridge slice owns `server/` and
its transcript fixtures, the web slice owns `web/`, and integration owns root
configuration, `tools/`, documentation and private machine configuration. Each
slice reviews the other's first working commit. Verification uses a committed
QA worktree, both supported transcript schemas, explicit failure controls, and
real WebKit scrolling from the newest page to the first message at 390×844.
Disposable processes and helper tabs occupy a separate test space and are closed
when finished. Production files and panes remain untouched.

Large transcripts use bounded reads backwards from the end, with no total-file
size limit. Older pages continue from opaque byte offsets. Per-record and per-page
bounds produce visible trimming notices instead of hiding an entire conversation.
The latest page of a generated 300 MiB transcript must load in under 300 ms on
the verification host, and paging must reach its first message. Error messages
distinguish absent history, offline machines and reader failures. The same path
is verified read-only on an existing large transcript, without terminal input.
