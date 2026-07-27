# SwiftMask — product baseline

Cross-platform, local-first, GPU-accelerated background removal. MIT, no telemetry, no cloud.

This file is **why**, not a tour of the tree. Implementation lives in the code; git workflow in [`workflow.md`](workflow.md).

---

## Architectural decisions (locked)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| A1 | Desktop shell | **Tauri 2 + Rust** | Small binary, native EP access via `ort`, multi-platform, low RAM. |
| A2 | Inference embedding | **In-process `ort`** | No IPC serialization overhead; direct EP control. |
| A3 | GPU EP strategy | **DirectML (Win) + CUDA (Linux NVIDIA) + CPU fallback; CoreML later** | One Windows binary covers NVIDIA+AMD. Linux AMD → CPU (ROCm packaging cost too high for v1). |
| A4 | Model registry | **`u2netp`, `isnet-general-use`, `RMBG-1.4`, `RMBG-2.0`** | Turbo / Balanced / Balanced+ / Max Quality. BRIA models are CC BY-NC 4.0 (non-commercial). |
| A5 | Feature scope (v1) | **Single image: open/drop → process → PNG alpha** | No batch queue, post-edit, video, or manual mask editor. |
| A6 | Frontend | **React + TypeScript + Vite + Zustand** | Mature UI stack; events for long inference. |
| A7 | Release targets (v1) | **Windows x64 (NSIS + MSI) + Linux x64 (AppImage + deb + rpm)** | macOS deferred (no device to test). |
| A8 | Model delivery | **Lazy download from HuggingFace + appData cache** | Small installer; user only downloads modes they use. |
| A9 | GPU detection | **Auto-detect + silent benchmark + manual override** | iGPU (e.g. Vega) can be slower with DirectML than CPU. |
| A10 | Rust layout | **Single crate in `src-tauri/`** | Refactor to workspace only if it grows. |
| A11 | Progress / cancel | **Tauri events + shared cancel token** | Inference can run tens of seconds on CPU. |
| A12 | Export | **PNG with alpha only** | Covers most use; minimal postprocessing. |
| A13 | Testing | **Rust unit + inference smoke + Vitest + mocked Playwright** | Real Tauri WebDriver still open (see below). |
| A14 | Name & license | **`SwiftMask` + MIT** | Compatible with model licenses used. |
| A15 | Image pipeline | **`image` + `imageproc`** | Enough for mask I/O and light feathering. |
| A16 | Updates & telemetry | **Signed Tauri updater + zero telemetry** | Static `latest.json` on GitHub Releases; Ed25519 package sigs; no analytics. |
| A17 | Bundled benchmark model | **Embed `u2netp` via `include_bytes!`** | Offline first-run benchmark + offline Turbo. |
| A18 | Output filename | **`<stem>-nobg-<modelId>.png` + overwrite prompt** | Predictable; keeps inputs untouched. |
| A19 | Theme | **Follow system via `prefers-color-scheme`** | Minimal MVP cost. |

---

## Non-obvious constraints

Easy to get wrong if you only skim the code.

**Drag-drop is Tauri-native, not HTML5.** Tauri intercepts OS file drops; the HTML5 `drop` event does not fire for files in its webview (tauri#2768, #5555). `useTauriFileDrop` listens for `tauri://drag-drop` and gets **paths** so Rust can read via `std::fs` — image bytes never cross IPC. React dropzone libs do not work out of the box.

**One Linux binary, not two.** Built with the CUDA feature; on AMD the CUDA EP fails to load and ORT falls back to CPU. Keeps distribution simple. Core ORT is **statically linked** (`ort` `download-binaries`) — there is no separate `libonnxruntime.so` rpath problem. CUDA still needs host NVIDIA drivers/libs; missing stack → CPU.

**Models: Rust is source of truth.** Registry + SHA-256 live in `models.rs`; `bun run gen:models` codegen’s static metadata to `models.generated.ts`. Download state comes only from `list_models` at runtime. Pin HF revisions by commit SHA; document CC-BY-NC for BRIA in README and in-app.

**Postprocess:** current models emit a single-channel mask; min-max normalize to [0,255] (no second sigmoid — that produced near-uniform masks). Heavier models get a light Gaussian blur (radius 1.0) for edge feathering.

**Frontend domain ownership:** `currentImage.ts` owns drop acceptance, output path sync, process/overwrite (A18), event listeners, cancel/clear. Components stay thin over stores + domain calls.

**Errors:** wire shape is `{ code, message }` (`error.rs` / `parseAppError` / `errorCopy`). FE owns user-facing copy; technical `message` is for logs/support later. GPU OOM retries on CPU for that job only — does **not** change Settings EP.

**MSI versioning:** WiX ProductVersion is numeric only. SemVer pre-releases (e.g. `0.9.0-beta.1`) need `bundle.windows.wix.version` set to a numeric form (see `tauri.conf.json` / [`workflow.md`](workflow.md)).

---

## Out of scope for v1

macOS/CoreML, ROCm, batch queue, mask threshold controls, background replacement, video, tiling for >~4K images, manual mask editor.

---

## Open work (ship / 1.0)

Not re-documented elsewhere as a living backlog:

| Item | Notes |
|------|--------|
| Beta update channel | A16 stable-only today (`/releases/latest`); second endpoint + Settings preference later |
| Real desktop E2E | `e2e/tauri-webdriver.config.ts` is a stub; mocked Playwright only proves UI wiring |
| Local diagnostics | Rotating local log + “copy diagnostics” (no network) |
| Large-image guard | Fail clearly or warn before OOM/slow runs on huge inputs |
| First-run empty-state hint | Beyond the acceleration/benchmark spinner |
| `ort` 2.0 RC | Release-candidate dependency; revisit when stable |
| CSP | `null` in `tauri.conf.json` — low risk for local app; tighten later |

### Done (ship / 1.0 backlog)

| Item | Notes |
|------|--------|
| About / licenses panel | Settings → “About & licenses”; MIT app notice + model table from static registry; external links via `openUrl`. Optional later: `license_url` on the Rust model registry / codegen when the catalog grows (FE map is enough for now). |
