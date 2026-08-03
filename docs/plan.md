# SwiftMask — product baseline

Cross-platform, local-first, GPU-accelerated background removal. MIT, no telemetry, no cloud.

**Why** only — not a tree tour. Code is the implementation; git/release flow is [`workflow.md`](workflow.md).

---

## Architectural decisions (locked)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| A1 | Desktop shell | **Tauri 2 + Rust** | Small binary, native EP access via `ort`, multi-platform, low RAM. |
| A2 | Inference embedding | **In-process `ort`** | No IPC serialization overhead; direct EP control. |
| A3 | GPU EP strategy | **DirectML (Win) + CUDA (Linux NVIDIA) + CPU fallback; CoreML later** | One Windows binary covers NVIDIA+AMD. Linux AMD → CPU (ROCm packaging cost too high for v1). |
| A4 | Model registry | **`u2netp`, `isnet-general-use`, `RMBG-1.4`, `birefnet-general-lite`, `RMBG-2.0`** | UI: Balanced / Balanced+ / High / Max. `u2netp` is benchmark-only (hidden). BRIA models CC BY-NC 4.0; High MIT. |
| A5 | Feature scope | **Single image + batch queue** | Multi-drop / open folder / optional folder watch. No post-edit, video, or manual mask editor. |
| A6 | Frontend | **React + TypeScript + Vite + Zustand** | Mature UI stack; events for long inference. |
| A7 | Release targets | **Windows x64 (NSIS + MSI) + Linux x64 (AppImage + deb + rpm)** | macOS deferred (no device to test). |
| A8 | Model delivery | **Lazy download + appData cache** | Small installer; user only downloads modes they use. |
| A9 | GPU detection | **Auto-detect + silent benchmark + manual override** | iGPU can be slower with DirectML than CPU. |
| A10 | Rust layout | **Single crate in `src-tauri/`** | Workspace only if it grows. |
| A11 | Progress / cancel | **Tauri events + shared cancel token** | Inference can run tens of seconds on CPU. |
| A12 | Export | **PNG with alpha only** | Covers most use; minimal postprocessing. |
| A13 | Testing | **Rust unit + inference smoke + Vitest + mocked Playwright** | Real Tauri WebDriver still open. |
| A14 | Name & license | **`SwiftMask` + MIT** | Compatible with model licenses used. |
| A15 | Image pipeline | **`image` crate** | Decode/encode + custom mask normalize/resize/feather in `pipeline.rs`. |
| A16 | Updates & telemetry | **Signed Tauri updater + zero telemetry** | Static `latest.json` on GitHub Releases; Ed25519 package sigs. |
| A17 | Bundled benchmark model | **Embed `u2netp` via `include_bytes!`** | Offline EP benchmark only — not a UI quality mode. |
| A18 | Output filename | **`<stem>-nobg-<modelId>.png` + overwrite prompt** | Predictable; inputs untouched. |
| A19 | Theme | **Follow system via `prefers-color-scheme`** | Minimal cost. |

---

## Non-obvious constraints

Easy to get wrong if you only skim the code.

**Drag-drop is Tauri-native, not HTML5.** Tauri intercepts OS file drops; the HTML5 `drop` event does not fire for files in its webview (tauri#2768, #5555). `useTauriFileDrop` listens for `tauri://drag-drop` and gets **paths** so Rust reads via `std::fs` — image bytes never cross IPC.

**One Linux binary, not two.** Built with the CUDA feature; on AMD the CUDA EP fails to load and ORT falls back to CPU. Core ORT is **statically linked** (`ort` `download-binaries`). CUDA still needs host NVIDIA drivers; missing stack → CPU.

**Models: Rust is source of truth.** Registry + SHA-256 in `models.rs`; `bun run gen:models` codegen’s static metadata to `models.generated.ts`. Download state only from `list_models`. Pin HF revisions by commit SHA.

**Postprocess:** most models min-max normalize to [0,255] (no second sigmoid — that washed U2Net/ISNet/RMBG). **High (`birefnet-general-lite`)** is sigmoid then min-max (BiRefNet logits). Heavier models get light Gaussian edge feathering (radius 1.0).

**Errors:** wire shape `{ code, message }`. FE owns user-facing copy. GPU OOM retries on CPU for **that job only** — does not change Settings EP.

**MSI versioning:** WiX ProductVersion is numeric only. SemVer pre-releases need `bundle.windows.wix.version` (see [`workflow.md`](workflow.md)).

---

## Out of scope

macOS/CoreML, ROCm, mask threshold controls, background replacement, video, tiling for >~4K images, manual mask editor, recursive folder scan/watch, queue persistence across quit.

---

## Open work

| Item | Notes |
|------|--------|
| Beta update channel | A16 stable-only today (`/releases/latest`) |
| Real desktop E2E | `e2e/tauri-webdriver.config.ts` is a stub |
| Local diagnostics | Rotating local log + “copy diagnostics” (no network) |
| Large-image guard | Fail/warn before OOM on huge inputs |
| `ort` 2.0 stable | Still on RC; revisit when stable |
| CSP | `null` in `tauri.conf.json` — tighten later |
