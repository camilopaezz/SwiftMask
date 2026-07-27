---
name: run
description: Launch and drive the SwiftMask desktop app (Tauri/WebKit). Use when asked to run, start, open, or screenshot the app, or to confirm a UI change works end-to-end.
---

# Run SwiftMask

Tauri 2 + React desktop GUI. Drive it with Computer Use (Hyprland). Do **not** treat `bun run dev` alone as "running the app" — that is only the Vite frontend; the native shell is required for inference, dialogs, and EP selection.

## Launch (always scrub AppImage env)

Sessions hosted inside T3 Code (or any AppImage) inherit:

```text
APPDIR=/tmp/.mount_…
APPIMAGE=…/T3-Code.AppImage
```

Tauri treats those as "this process is an AppImage" and can resolve frontend assets against the **wrong** mount → **solid black WebView**. Portal screenshots then look "broken" when the window is simply blank. Always strip them before launch.

Default is **`bun run tauri dev`** (live Vite HMR + debug shell). Always scrub AppImage env; keep the extra WebKit DMA-BUF flag (the `tauri` script only sets compositing mode):

```bash
pkill -x swiftmask 2>/dev/null || true
# also kill a leftover Vite from a previous tauri dev if needed
pkill -f 'vite.*1420' 2>/dev/null || true

cd /home/camilo/code/SwiftMask
env -u APPDIR -u APPIMAGE -u APPIMAGE_SILENT_INSTALL \
  WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  bun run tauri dev \
  >/tmp/swiftmask-run.log 2>&1 &

# first compile can take a while; wait until the window exists
until hyprctl clients -j | jq -e '.[] | select(.class=="swiftmask")' >/dev/null 2>&1; do sleep 0.5; done
```

| Launch | When |
|--------|------|
| `bun run tauri dev` (default) | Normal UI work / computer-use with HMR |
| `src-tauri/target/debug/swiftmask` | Dev shell without Vite (only if already built and you don't need frontend reload) |
| `src-tauri/target/release/swiftmask` | Fast smoke when you don't need HMR and release is current |

`package.json` already sets `WEBKIT_DISABLE_COMPOSITING_MODE=1` on the `tauri` script; still scrub `APPDIR`/`APPIMAGE` yourself.

**Done when:** `hyprctl clients -j` shows `class=="swiftmask"` and a `grim` crop of that window shows the sidebar (logo, quality modes, Select image) — not a solid black frame.

## See the UI (Hyprland)

WebKitGTK exposes **0 AT-SPI nodes** here, so do not rely on accessibility selectors.

1. Geometry: `hyprctl clients -j | jq '.[] | select(.class=="swiftmask")'`
2. Screenshot: `grim -g "x,y wxh" /tmp/swiftmask.png` then **Read** the PNG
3. Clicks: absolute desktop coordinates (window `at` + in-window offset). Prefer absolute over `relative: true` if the first hit misses
4. Portal / `get_app_state` screenshots: OK **after** a clean launch; if black, assume env pollution or WebKit layer issue and use `grim` instead

Native dialogs (**Open File**, overwrite confirm) are **separate** Hyprland clients (`title` differs). List windows before every click after opening a dialog.

## Smoke path (process one image)

1. Launch as above; confirm CUDA/CPU chip and quality list paint
2. Select **Turbo** (bundled `u2netp`, no download) unless the change under test needs another mode
3. **Select image** → pick a fixture, e.g. `e2e/fixtures/sample.png` or any file under `~/Pictures`
4. **Process** → if "already exists. Overwrite?" appears, click **Yes**
5. **Done** when status is Done, before/after slider is visible, and (when auto-save is on) `*-nobg-u2netp.png` sits next to the source

## Gotchas

- **Never launch without unsetting `APPDIR`/`APPIMAGE`** from an AppImage-hosted agent session
- Black portal crop ≠ broken portal: full-desktop portal often still shows T3 Code while SwiftMask itself is blank
- `ydotool` socket may be missing; uinput absolute pointer still works on this machine
- First launch of non-Turbo modes may download models (~170 MB); prefer Turbo for quick smoke
