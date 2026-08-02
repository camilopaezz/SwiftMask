# Batch processing (1.1) — product decisions

Locked product rules for the queue. Implementation lives in the code
(`queue.ts`, `queueRunner.ts`, `queueStore`, `folderWatch`, warm ORT session).

Classic **Select image → Process** stays the single-image path.

---

## Entry & enqueue

| Action | Result |
|--------|--------|
| Select image (Ctrl+O) | Single-image UI |
| Open folder… (Ctrl+Shift+O) | Top-level images only → queue (even if N=1) |
| Drop one+ image files | Queue; **append** if a queue exists |
| Drop **one** directory | Same as Open folder (**replace** session) |
| Drop folder + files, or 2+ folders | **Reject** + notice |
| Folder with 0 top-level images | Notice; **no recursion** |
| Enqueue count **> 200** | Soft confirm; watch arrivals skip confirm |
| Path already in queue (any status) | **Dedup: ignore** re-add; retry is explicit |

**Extensions:** `png`, `jpg`, `jpeg`, `webp`, `bmp`.

**Chrome:** Select image + Open folder on the rail; empty state emphasizes Select image.
Shortcuts: Ctrl+O image, Ctrl+Shift+O folder.

---

## When processing starts

| Source | Policy |
|--------|--------|
| Open folder / multi-drop | Enqueue only; user hits **Process** |
| Watch on, before first Process | New settled files **enqueue only** |
| Watch on, after first manual Process | New settled files **auto-process** when idle |
| Watch auto-run scope | **Watch arrivals only** — does not drain drop/folder pending that still need Process |
| Cancel mid-run | Pause watch auto-run until Process again |

---

## Queue UI

- Collapsible drawer under the preview; **⋯** only on the drawer bar (opens upward).
- Collapsed: counts, current item, error badge if failures, ⋯.
- Expanded first time in a session; then remember open/closed. Auto-expand on first failure; never auto-collapse on success.
- Done rows stay, move to bottom. Rows are text-only (no thumbnails).
- Click row pins preview; auto-follow running unless pinned.
- Progress: overall in Process area + per-row status/%.

---

## Processing

- Backend stays **single-flight**; FE serializes the queue.
- Process = **pending only**. Failures mark the row and **continue**. Cancel stops the current job; **pending remains**.
- FIFO. Mode/EP change only when not running (mode applies to pending).
- Model/license not ready → **block** Process (no silent Turbo / undownloaded mode).
- While running: allow append, pin, clear completed, expand drawer. **Block** mode/EP change and a second Process.
- Finish notice: “Finished: X succeeded, Y failed.” No auto-reveal folder. No OS notifications in 1.1.

---

## Outputs

| Source | Location |
|--------|----------|
| Open folder | Sibling **`{folderName}-nobg/`** (create on **Process** if missing; reuse if present) |
| Drop | `settings.outputDir` if set, else next to each input |
| Naming | `{stem}-nobg-{modelId}.png` |

| Overwrite | Policy |
|-----------|--------|
| Manual Process | One dialog: Overwrite all / Skip existing / Cancel |
| Watch auto-run | Always overwrite |

Folder sibling outputs stay outside the watched folder. Folder sessions reveal outputs via ⋯; multi-drop is per-row only.

---

## Watch (folder only)

- Opt-in, default **off**. Create-only, top-level, **500ms** size settle.
- Ignore: `.tmp`, `.temp`, `.crdownload`, `.part`, `.partial`, `~` suffix, `.ds_store`, `thumbs.db`, zero-byte after settle, dotfiles, non-images.
- Auto-run: idle until first successful Process this session; cancel pauses; clear all / close folder / stop watch → idle.
- Does not survive app restart.

---

## Clear / leave / quit

**⋯ menu:** Clear completed / failed / pending · Retry failed · Clear all… · Open outputs (folder) · Close folder.

| Action | Effect |
|--------|--------|
| Partial clears | Watch stays on if it was on |
| Clear all / Close folder | Stop watch → classic idle (confirm if live) |
| Open other folder | Replace session (confirm if live) |
| Select image with live queue | Confirm if live → single-image |
| Quit with running/pending | Confirm → cancel current → quit. **No** queue persistence |

---

## Non-goals (1.1)

Recursive scan/watch · parallel multi-GPU jobs · queue resume after quit ·
row thumbnails · OS notifications · HTML5 file drop · macOS.
