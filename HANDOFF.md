# Finplay Mac handoff

Use this when starting a **new agent on a Mac** that can build and run the desktop app and verify the player / home / trailer bugs. Linux agents cannot exercise the macOS libmpv embed / Spaces fullscreen path.

**Repo:** `kings431/finplay` · **branch:** `main` · **baseline tag:** `v0.3.13` (`d4b0680`)

---

## Paste this into the new Mac agent

```
You are continuing Finplay work on macOS. Read HANDOFF.md first, then run
./scripts/mac-setup.sh and npm run desktop. Do not publish or tag unless asked.
Verify every item in the "Test checklist" in HANDOFF.md against a real Jellyfin
server the user provides (or ask for server URL + login). Fix failures you can
reproduce; keep diffs focused. Prefer running the app over guessing from code.
```

---

## What this app is

Desktop Jellyfin client (Tauri 2 + React 19). Video plays through **libmpv** on macOS (child NSWindow over Finplay in windowed mode; **handoff** to a standalone `--fs` / Spaces window for fullscreen). OSD chrome lives in `src-tauri/player/finplay.lua`.

Critical paths:

| Area | Files |
|------|--------|
| Start / stop / IPC / fullscreen handoff | `src-tauri/src/mpv.rs` |
| macOS embed / focus / attach | `src-tauri/src/libmpv.rs` |
| OSD + key bindings | `src-tauri/player/finplay.lua` |
| Web → mpv key forwarding + finish/cache | `src/playback.tsx`, `src/cache.ts` |
| Playing page UI | `src/pages/Playing.tsx` |
| Home hero | `src/pages/Home.tsx`, `src/styles.css` |
| Trailers | `src-tauri/src/trailer.rs`, `src/trailer.ts`, `src/pages/Detail.tsx` |
| Settings (`Open fullscreen`) | `src/pages/Settings.tsx`, `src/settings.ts` |

---

## Mac bootstrap

```bash
git clone https://github.com/kings431/finplay.git   # or pull main
cd finplay
git checkout main && git pull
./scripts/mac-setup.sh          # brew mpv + bundle libmpv, npm ci, build check
npm run desktop                 # Tauri + Vite; needs a display session
```

Requirements: macOS 14+, Xcode CLT, Homebrew, Node 22+, Rust (stable via rustup).

`./scripts/mac-setup.sh --run` setup + launches the app.

Dev notes:

- Bundled player: `src-tauri/libmpv/libmpv.2.dylib` (created by the setup script; **do not commit** the dylib tree).
- Without that folder, windowed embed fails / falls back poorly — always run setup once.
- Optional: `brew install yt-dlp` so trailers prefer mpv; without it, trailers open the **embedded YouTube** window.
- Signing / notarization is not required for local `tauri dev`.
- **Do not** push tags or release alone unless the user asks. Version bump: `npm run release:version -- x.y.z` then commit + `git tag vX.Y.Z` + push tag (triggers `.github/workflows/release.yml`).

---

## Recent fixes (what we think is done)

Shipped through **0.3.10–0.3.13** (verify on Mac — most work was done from Linux):

1. **OSD dying after speed change** — `toast` was called before define; Lua error killed chrome (`e0c93db`). Handlers wrapped in `pcall` (`96f6d03`).
2. **Space / arrows while webview focused** — forward pause/seek/volume over IPC from `PlaybackProvider` for the whole session (`1df67f6`, hardened in `d4b0680`).
3. **Continue Watching stale** — `finish()` invalidates `home:` / item caches; `useCached` notifies mounted hooks (`1df67f6`).
4. **macOS fullscreen** — cannot Spaces-fullscreen a borderless child; hand off to standalone libmpv `--fs`, ESC should hand **back** to embed (`688dcaf`, `d4b0680`).
5. **Sticky fullscreen when setting is off** — stale session kept `handoff` true; drop dead sessions on play / close (`d4b0680`).
6. **Trailers** — YouTube embed window instead of full youtube.com UI (`d4b0680`).
7. **Home hero** — prev/next buttons + horizontal trackpad swipe (`d4b0680`).

---

## Test checklist (do these in the running app)

Ask the user for Jellyfin URL + credentials if not already signed in. Use a movie **and** an episode when possible.

### A. Settings / start mode
- [ ] Settings → **Open fullscreen** is **off**. Quit playback fully. Play a title.
- [ ] Expect: video **inside** Finplay (no second fullscreen Space on start).
- [ ] Turn **Open fullscreen** **on**, play again → starts in native fullscreen / Space.
- [ ] Turn it **off** again, play a third time → must **not** stick to fullscreen.

### B. Keyboard (windowed / in-UI player)
Focus Finplay (or the player). With video playing:
- [ ] `Space` — pause / resume
- [ ] `←` / `→` — seek ~10s
- [ ] `↑` / `↓` — volume toast
- [ ] `[` / `]` — speed nudge + toast; after changing speed, Space/arrows still work
- [ ] `F` — enter fullscreen handoff
- [ ] `A` / `S` / `C` — audio / subs / chapters menus
- [ ] `Backspace` or OSD Back — stop and report progress

### C. Fullscreen handoff (the hard Mac path)
- [ ] From windowed play, press `F` or the OSD fullscreen control.
- [ ] Expect: **one** native fullscreen / new Space player (not a crashed AppKit child).
- [ ] In that fullscreen window: `Space` / arrows still work (player owns keys here).
- [ ] `Esc` — leave fullscreen and return to the **in-app** embed (Finplay + video together). **Must not** leave a second orphaned mpv window beside Finplay.
- [ ] After return: Space/arrows still work in embed.

### D. Continue Watching
- [ ] Play something for ~30s+, stop / close.
- [ ] Go Home **without** restarting the app.
- [ ] Expect: title appears / updates in **Continue watching** with progress (no hard refresh).

### E. Trailers
- [ ] Open a movie with a Remote Trailer → Trailer button.
- [ ] Expect: dedicated trailer window with **embedded** YouTube player (not full YouTube chrome), **or** mpv if `yt-dlp` is installed.
- [ ] Close trailer; main app still fine.

### F. Home hero
- [ ] Hover hero → ‹ › buttons; click advances slides.
- [ ] Two-finger **horizontal** swipe on trackpad advances slides.
- [ ] Dots / auto-advance still behave; Play / More info still work.

### G. Regression smoke
- [ ] Double-click video (or OSD) for fullscreen toggle if applicable.
- [ ] Skip intro / Up next if the title has segments.
- [ ] No crash when rapidly toggling fullscreen twice.

---

## If something fails — where to look first

| Symptom | Likely cause / place |
|---------|----------------------|
| Always starts fullscreen with setting off | Stale `Session` / `handoff` in `mpv.rs` `player_play` |
| Esc leaves two windows | `escape` / `switch_mode` in `mpv.rs`; embed reattach in `libmpv.rs` |
| Keys dead only in windowed embed | `playback.tsx` IPC forwarder; `player_focus` / `libmpv::focus_player` |
| Keys die after speed menu | `finplay.lua` `set_speed` / `toast` / `pcall` on bindings |
| Continue Watching stale | `finish()` + `invalidate` in `playback.tsx`; `cache.ts` listeners |
| Trailer = full YouTube site | `trailer.rs` should use `youtube-nocookie.com/embed/...` |
| No video / blank embed | Missing `src-tauri/libmpv` — re-run `./scripts/mac-setup.sh` |
| Crash on fullscreen | Never call Spaces FS on borderless child; must hand off |

---

## Release habit (only if user asks)

```bash
npm run release:version -- 0.3.14   # bump everywhere
# commit message that describes the fix
git tag v0.3.14
git push origin main && git push origin v0.3.14
```

Never invent or print signing keys / updater tokens.

---

## Prior agent context

Earlier work (Linux private worker) could not run the Mac player. Fixes through `v0.3.13` were shipped for CI Mac builds and for this Mac agent to validate. Prefer **reproducing in `npm run desktop`** over trusting commit messages.
