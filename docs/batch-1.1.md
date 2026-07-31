# SwiftMask Batch Processing — 1.1 Spec

**Status:** Product decisions locked (grilling 2026-07-30). Ready for phased implementation.  
**Branch:** `t3code/batch-ingestion` (do **not** merge into 1.0 release track).  
**Audience:** Orchestrating agent + implementers. This file is the source of truth for batch 1.1.

---

## 0. Relationship to 1.0

| Track | Scope |
|-------|--------|
| **1.0** | Single image only (`docs/plan.md` A5). Current release testing. |
| **1.1** | This document. Batch queue, open folder, optional folder watch. |

- Do not change 1.0 behavior for classic **Select image → Process**.
- Update `docs/plan.md` only when 1.1 is intentional product scope (add “Batch 1.1” section; do not rewrite A5 history as if batch was always in v1).
- Phase commits on this branch are checkpoints; each must leave the app usable.

---

## 1. Product summary

**One queue, two input methods** (same worklist, same cancel/retry/output rules after enqueue):

1. **Open folder** (+ optional **watch** for new top-level images)
2. **Drag & drop images** into a queue

Classic **Select image** (Ctrl+O / file picker single) stays the **single-image** UI and processing path.

### Mental model

```
Select image  →  single-image shell (unchanged)
Drop images   →  queue UI (append if already in queue)
Open folder / drop one directory  →  queue UI (replace session)
Watch (folder only, opt-in)  →  append + auto-run new files
```

---

## 2. Locked decisions (complete)

### 2.1 Entry points & enqueue

| Action | Result |
|--------|--------|
| Select image (Ctrl+O) | Classic single-image UI |
| Open folder… (Ctrl+Shift+O) | Scan **top-level images only** → queue UI even if N=1 |
| Drop one+ image files | Queue UI; **append** if queue exists |
| Drop **one** directory | Same as Open folder (**replace** session) |
| Drop folder + files, or 2+ folders | **Reject** + toast |
| Folder with 0 top-level images | Toast: no images (subfolders not scanned); **no recursion** |
| Enqueue count **> 200** | Soft confirm “Enqueue N images?”; watch arrivals skip confirm |
| Path already in queue (any status) | **Dedup: ignore** re-add. Retry is an explicit row action |
| Folder drop during early checkpoints | Until CP4: toast “Open folder comes later” |

**Image extensions (existing):** `png`, `jpg`, `jpeg`, `webp`, `bmp`.

**UI chrome (entry):**
- Left rail: **Select image** + **Open folder…** (two buttons; primary styling on Select image).
- Dropping a **directory** = Open folder.
- Canvas empty copy: **“Drop images or a folder to start a queue”** (plus Select image / Open folder hints).
- Shortcuts: Ctrl+O image, Ctrl+Shift+O folder.

### 2.2 When processing starts

| Source | Start policy |
|--------|----------------|
| Open folder / multi-drop | Enqueue only; user hits **Process** |
| Watch (on) | New settled files **auto-enqueue + auto-process** when worker idle |

### 2.3 Queue UI layout (Option B — collapsible)

- **Left rail:** brand → folder/source block (path + Watch when folder) → Mode → Process footer.
- **Main:** preview canvas + **collapsible queue drawer under preview**.
- **Collapsed bar:** counts (`done/total`), current item, **error badge** if failures > 0, one **⋯** menu.
- **Expanded:** full list; **one** ⋯ only in list header (never two ⋯ visible at once).
- **Enter queue UI:** drawer **expanded** first time this session; then **remember** open/closed.
- **Auto-expand** on first failure; **do not** auto-collapse on success.
- **Done items:** stay in list, move to **bottom**, success checkmark.
- **Rows:** text only (no thumbnails in 1.1).
- **Click row:** pin preview; **auto-follow running** unless user pinned another row.
- Progress: **overall** in Process area (`12/40 · name · stage`) **+ per-row** status/%.

### 2.4 Processing rules

- Backend remains **single-flight** (one job at a time). Queue serializes above it.
- **Process** runs **pending only**.
- **Retry failed:** separate (per-row + bulk when failures exist).
- **Do not** re-run successes unless user explicitly retries a done row.
- **Failure:** mark row failed with message; **continue** the run.
- **Cancel:** stop current job; **leave remaining pending** (Process resumes them).
- **Order:** FIFO (folder listing order for initial open, then append).
- **Model/license not ready:** **block** Process (download/license modal); no silent Turbo fallback.
- **While running (interactive):** allow drop-append, select/pin, clear completed, expand drawer. **Block:** mode change, EP change, second Process.
- **Mode change:** only when not running; applies to pending only.
- **Finish:** in-app notice “Finished: X succeeded, Y failed.” OS notifications later (out of 1.1). No auto-reveal folder.

### 2.5 Outputs

| Source | Output location |
|--------|-----------------|
| Open folder | Sibling **`{folderName}-nobg/`** (create if missing; **reuse** if exists) |
| Drop (one or many) | Current single-image rules: `settings.outputDir` if set, else **next to each input** |
| Naming (always) | `{stem}-nobg-{modelId}.png` (same as A18) |

| Overwrite | Policy |
|-----------|--------|
| Manual Process | If any outputs exist: **one** dialog — Overwrite all / Skip existing / Cancel |
| Watch auto-run | **Always overwrite** (no dialog) |

- Folder sibling outputs avoid re-ingest under watch (outputs never land inside watched folder).
- **Open outputs:** folder session → reveal `{folder}-nobg/`; multi-drop → **per-row only**.

### 2.6 Watch (folder only)

- **Opt-in**, default **off**. Toggle only when a folder source is active.
- **Create only** (no reprocess on modify).
- **Top-level only** (no recursive watch).
- **Settle:** file size stable **500ms** before enqueue.
- **Ignore:** `.tmp`, `.temp`, `.crdownload`, `.part`, `.partial`, `~` suffix, `.ds_store`, `thumbs.db`, zero-byte after settle, **dotfiles**, non-image extensions.
- Watch does **not** survive app restart.
- Quit while watch idle (no pending/running): free quit.

### 2.7 Clear / leave / quit

**⋯ menu (single):**
- Clear completed  
- Clear failed  
- Clear pending  
- Clear all… (confirm if pending/running)  
- Close folder (when folder source)

| Action | Effect |
|--------|--------|
| Clear completed / failed / pending | Partial; **watch stays on** if it was on |
| Clear all | Stop watch; confirm if live → empty → **classic idle** |
| Close folder | Same as Clear all for folder sessions (stop watch + clear → idle) |
| Open other folder / drop folder | **Replace** session; confirm if pending/running |
| Select image with live queue | Confirm if pending/running; leave queue → single-image |
| Quit with running/pending | Confirm → cancel current → quit (wait for cancel). **No** queue persistence / resume |

### 2.8 Row actions

| Action | When |
|--------|------|
| Click | Pin preview |
| Remove | Pending / failed / done (not running; running → Cancel first, or Remove on active = cancel that job) |
| Retry | Failed (optional: done → re-queue pending, overwrite that output) |
| Show in folder | Done → reveal **output** file |

### 2.9 Backend / session

- **FE owns the queue** (Zustand + domain module).
- **Serial invokes** of existing (or lightly extended) `remove_image_background` per item.
- **ORT session keep-alive** across queue images until idle timeout / EP change / quit (perf requirement).
- **No** multi-image “batch run” Rust command that owns the whole loop in v1.1 (keeps mid-run append simple).
- Progress events remain job-scoped (`id` on payloads); each queue item gets a UUID job id when processed.
- Invalidate warm session on EP change; do not change EP mid-run from UI.

### 2.10 Keyboard

| Shortcut | Action |
|----------|--------|
| Ctrl+O | Select image (leave queue with confirm if live) |
| Ctrl+Shift+O | Open folder |
| Ctrl+Enter | Process pending |
| Escape | Cancel current job (pending stays) |
| Delete / Backspace | Remove selected row if not running |
| ↑ / ↓ | Move selection when drawer expanded |
| — | No dedicated drawer toggle shortcut |

### 2.11 Platforms

Same as 1.0: **Windows x64 + Linux x64**. Watch implementation must work on both (e.g. `notify` crate). macOS still out of scope.

---

## 3. Implementation phases (checkpoints)

Each phase = **one commitable vertical slice** + **computer-use e2e acceptance** (not code-review theater).  
Do not start phase N+1 until phase N acceptance passes.

### Phase matrix

| CP | Name | User-visible outcome | Depends on |
|----|------|----------------------|------------|
| **1** | Queue skeleton | Drop images → queue UI; list/manage; no batch process | — |
| **2** | Serial run (cold session) | Process drains pending; cancel/fail/overwrite | CP1 |
| **3** | Warm session | Same UX; model stays loaded across items | CP2 |
| **4** | Open folder + sibling out | Open folder / drop dir; `{folder}-nobg/` | CP2 (CP3 optional parallel) |
| **5** | Watch | Opt-in watch; settle; auto-run | CP4 |

---

### CP1 — Queue skeleton only

**Goal:** Prove multi-item state + layout B without touching inference batching.

**In scope**
- Multi-drop / multi-file path accept → **queue UI** (including N=1 from drop).
- Collapsible drawer under preview; rows all **pending**.
- Select row → pin preview of **original** (`convertFileSrc` / existing asset path).
- Remove row; ⋯ **Clear all** only (minimal menu).
- Dedup on append; soft confirm if >200.
- Reject non-images; reject mixed folder+files.
- Folder drop / Open folder: **toast** “Open folder comes in a later step” (no half-impl).
- Rail: source summary (“N images”) + Mode (visible) + **Process disabled** with short hint (“Batch process next”).
- Classic **Select image + Process** fully working (single-image path unchanged).
- Canvas empty copy updated for queue entry.

**Out of scope**
- Batch Process / cancel / fail / overwrite dialogs for many files  
- Warm session  
- Open folder / watch / sibling `-nobg`  
- Retry, Clear completed/failed, error badge, progress %, done-at-bottom ordering  

**Likely touch points**
- `src/stores/imageStore.ts` — grow beyond single `current` (queue list + selection + UI mode)
- `src/lib/currentImage.ts` — `acceptDrop` multi-enqueue; gate classic vs queue
- `src/lib/useTauriFileDrop.ts` — already multi-path; wire all images
- `src/components/FileBlock.tsx`, `PreviewCanvas.tsx`, `App.tsx`, `App.css`
- New: queue drawer component(s), queue domain helpers

**Acceptance (computer-use e2e)**
1. Launch app; empty state shows drop-to-queue copy.
2. Drop multiple images → queue UI; drawer lists all; all pending.
3. Expand/collapse drawer; selection pins preview of original.
4. Drop more images → append; duplicate path ignored.
5. Remove one row; Clear all → back toward idle / empty.
6. Drop non-image / mixed folder+files → rejected with toast.
7. **Select image** still opens classic single-image flow; **Process** still works for that path.
8. In queue UI, Process control is disabled (or clearly non-batch).

**Commit message suggestion:** `feat(batch): queue skeleton UI for multi-drop (1.1 CP1)`

---

### CP2 — Serial run (cold session OK)

**Goal:** Drain the queue with real inference; correctness over perf.

**In scope**
- Process = pending only; serial FE invokes of `remove_image_background`.
- Per-item job UUID; progress events update row + overall footer.
- Cancel current; pending remains.
- Fail → mark row, continue.
- Overwrite: one dialog at Process start (Overwrite all / Skip existing / Cancel).
- Done rows → bottom with ✓; failed with message.
- Retry failed (per-row + bulk).
- ⋯ full menu: Clear completed / failed / pending / Clear all (confirm if live).
- Interactive while running (append, pin, clear completed); block mode/EP/second Process.
- Finish notice with counts.
- Preview auto-follow running unless pinned.
- Auto-expand drawer on first failure.
- Delete key removes selected non-running; ↑/↓ selection when expanded.
- Session still **cold** (load per image) is acceptable.

**Out of scope**
- Warm session (CP3)  
- Open folder / watch (CP4–5)  

**Likely touch points**
- `src/lib/currentImage.ts` (or new `queueRunner.ts`) — run loop, cancel, overwrite batch
- `src/lib/overwrite.ts` — multi-file variant
- `src/lib/path.ts` — reuse `deriveOutputPath`
- `src-tauri` — only if needed for job id / busy UX; prefer no warm session yet
- Process footer / ImagePanel adaptations for queue

**Acceptance (computer-use e2e)**
1. Drop 3+ images; Process; all complete to sibling/next-to-input outputs with correct names.
2. Cancel mid-run; current stops; others stay pending; Process resumes.
3. Force a failure (bad file if possible) → row failed; others continue; finish notice counts failures.
4. Overwrite path: run twice → one dialog, Overwrite all / Skip work.
5. Retry failed works; Clear completed leaves pending/failed as designed.
6. Drop additional image while running → appends as pending; processed after.
7. Mode/EP controls disabled or non-destructive while running.
8. Classic single-image path still works.

**Commit message suggestion:** `feat(batch): serial queue processing (1.1 CP2)`

---

### CP3 — Warm ORT session

**Goal:** Perf — keep model loaded across queue items.

**In scope**
- Backend session keep-alive across serial jobs (idle timeout + invalidate on EP/mode-affecting changes).
- No UX change required beyond faster back-to-back items.
- Align with comment/pattern in `src-tauri/src/inference.rs` (keep session across images).

**Out of scope**
- Rust-owned multi-image batch command that blocks mid-run append  

**Likely touch points**
- `src-tauri/src/inference.rs`, `processing.rs`, `job.rs`, `commands.rs`
- Ensure FE still serial-invokes; no Busy races when keep-alive holds resources

**Acceptance**
1. Process a queue of ≥5 images; logs/timings or observable gap shows no full session reload each time (or documented metric).
2. Change EP after run → next run uses new EP cleanly.
3. Cancel + re-Process still works.
4. No regressions vs CP2 e2e.

**Commit message suggestion:** `perf(batch): keep ORT session warm across queue jobs (1.1 CP3)`

---

### CP4 — Open folder + sibling output

**Goal:** Folder as first-class batch source.

**In scope**
- Open folder… button + Ctrl+Shift+O + drop **one** directory.
- Top-level image scan only; empty → toast; >200 → confirm.
- Queue source = folder; rail shows path; outputs → **`{folderName}-nobg/`** (reuse if exists).
- Replace session when opening/dropping another folder (confirm if live).
- Open outputs → reveal sibling folder.
- Watch toggle **visible but disabled or hidden** until CP5 (prefer visible disabled with “Coming next” only if it doesn’t confuse — else hide until CP5).
- Clear all / Close folder → idle (Close folder can equal Clear all for folder source).

**Out of scope**
- Watch behavior (CP5)  
- Recursive scan  

**Likely touch points**
- New Tauri command: list top-level images in directory (or FE+dialog + Rust read_dir)
- `FileBlock` / rail folder block
- Output path derivation for folder sessions
- Drop handler: directory vs files vs reject mixed

**Acceptance (computer-use e2e)**
1. Open folder with several images → queue filled; Process → files in `{name}-nobg/`.
2. Re-open same folder after outputs exist → overwrite dialog behavior correct.
3. Drop a directory → same as Open folder.
4. Drop folder + file → rejected.
5. Open second folder with pending work → confirm; replace.
6. Open outputs reveals sibling folder.
7. Multi-drop still uses non-sibling output rules.

**Commit message suggestion:** `feat(batch): open folder with sibling -nobg output (1.1 CP4)`

---

### CP5 — Folder watch

**Goal:** Opt-in hands-off pipeline on the open folder.

**In scope**
- Watch toggle default **off**; create-only; top-level; 500ms size settle; ignore list (see §2.6).
- New files → append (dedup) + auto-process when idle; always overwrite outputs.
- Clear all / Close folder / quit: stop watch.
- Partial clears do not stop watch.
- No watch across restart.

**Likely touch points**
- Rust `notify` (or equivalent) + FE events for “file ready”
- Settle/debounce logic; ignore filters
- Auto-run hook into queue runner from CP2

**Acceptance (computer-use e2e)**
1. Open folder, enable Watch, Process initial set (or empty folder).
2. Copy a new image into folder → appears in queue after settle → processes without manual Process.
3. Copy `.crdownload` / partial / hidden → ignored.
4. Disable watch → new files not enqueued.
5. Clear all → watch off, idle.
6. Quit with only watch idle → no blocking dialog.

**Commit message suggestion:** `feat(batch): optional folder watch with settle and auto-run (1.1 CP5)`

---

## 4. Architecture notes for implementers

### Current constraints (do not fight)

- **Single-flight** backend: `ProcessingState.try_acquire` → `Busy` on concurrent jobs. Queue must serialize.
- **Drag-drop is Tauri-native** (`tauri://drag-drop`), not HTML5 — see `docs/plan.md`.
- Domain ownership: prefer extending `currentImage.ts` or a sibling `queue*.ts` domain module; keep components thin.
- Output naming is FE-owned (`src/lib/path.ts`).
- Errors: `{ code, message }` + FE copy maps.

### Suggested state shape (illustrative)

```ts
type QueueItemStatus = "pending" | "processing" | "done" | "failed";

type QueueItem = {
  id: string;           // stable row id
  inputPath: string;
  outputPath: string;   // derived when enqueued or at process time
  status: QueueItemStatus;
  progress?: number;
  stage?: string;
  error?: string;
  jobId?: string;       // inference job id while/after run
};

type QueueSource =
  | { kind: "drop" }
  | { kind: "folder"; path: string; watch: boolean };

// UI mode: "single" | "queue"
// single: existing ImageItem current
// queue: items[], selectedId, pinned, source, drawerOpen, running
```

### IPC additions (by phase)

| Phase | Possible commands / events |
|-------|----------------------------|
| CP1 | None or minimal (`path_is_dir` if needed for drop classification) |
| CP2 | Existing `remove_image_background`, `cancel_inference`, `path_exists` |
| CP3 | Session keep-alive internals; maybe no new FE API |
| CP4 | `list_folder_images(path) -> string[]`, `ensure_dir`, reveal folder |
| CP5 | `watch_folder_start/stop`, events `folder://ready` with path |

Exact API names are implementer choice; behavior is not.

### Explicit non-goals (1.1)

- Recursive folder scan/watch  
- Parallel multi-GPU jobs  
- Queue persistence / resume after quit  
- Thumbnails in queue rows  
- OS notifications (later)  
- Background replacement / mask editor / video  
- HTML5 drop  
- Shipping on 1.0 release branch  

---

## 5. Orchestration playbook (for the agent running the project)

### How to run the work

1. **Read this file** + `docs/plan.md` non-obvious constraints + current `imageStore` / `currentImage` / `job.rs`.
2. **Implement only the current CP** scope table (In / Out). Refuse scope creep mid-CP.
3. **Commit** on `t3code/batch-ingestion` with suggested message style when CP acceptance passes.
4. **Acceptance = computer-use e2e** on the real Tauri app (`/run` skill or project run docs), not only unit tests. Mocked Playwright may supplement but does not replace CP acceptance.
5. After each CP, **demo to user** (screenshots or live) before starting the next.
6. Prefer **small domain modules + Zustand** matching existing style; match `App.css` tokens (paprika/carbon/floral).
7. If a decision is missing, **stop and ask** — do not invent product behavior outside this doc.

### Suggested agent split (optional)

| Role | Responsibility |
|------|----------------|
| Implementer | Code for one CP |
| E2E driver | Computer-use script against acceptance checklist |
| Spec guardian | Diff PR against this doc’s In/Out; reject extras |

Do **not** use “code review style” agents as the primary gate; **e2e computer use** is the gate.

### Definition of done for 1.1

All CP1–CP5 acceptance lists pass on Linux (and Windows before release). Classic single-image 1.0 flows unchanged. This doc’s decisions match shipped behavior. Plan.md gains a short Batch 1.1 pointer.

---

## 6. Reference mocks (design exploration)

HTML mocks used during grilling (may expire; local copies on branch):

| File | Topic |
|------|--------|
| `tmp-batch-open-folder-mock.html` | Open folder entry (A/B/C) — chose **C** |
| `tmp-batch-queue-layout-mock.html` | Queue layout — chose **B collapsible** |
| `tmp-batch-queue-clear-mock.html` | Clear/⋯ menu — chose **A** single ⋯ |

These are **not** production UI; implement in React + `App.css` patterns.

---

## 7. Decision log (short)

| Topic | Decision |
|-------|----------|
| Queue model | One queue, two inputs |
| Folder scan | Images, top-level only |
| Watch | Opt-in, default off, create-only, folder only |
| Outputs folder | Sibling `{folder}-nobg/`; drop uses existing rules |
| Naming | `{stem}-nobg-{modelId}.png` |
| Start | Manual Process; watch auto-runs |
| UI mode | Drop/folder → queue; Select image → single |
| Layout | Collapsible drawer under preview |
| Fail/cancel | Continue on fail; cancel keeps pending |
| Session | FE queue + warm keep-alive |
| Overwrite | One dialog manual; always overwrite on watch |
| Dedup | Any status, ignore re-add |
| Ship | 1.1 phases CP1–CP5; not 1.0 |
| First CP | Skeleton only (no batch process) |
| Validation | Computer-use e2e per CP |

---

*End of spec. Implement CP1 next unless the user orders otherwise.*
