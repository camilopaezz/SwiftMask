# Changelog

All notable changes to SwiftMask are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Version numbers must stay in sync across `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` before tagging a release.

## [Unreleased]

## [1.1.1] - 2026-08-04

Finish notices polish and folder-watch reliability on the 1.1 batch line.

### Added

- Dual-surface finish notices for queue batches and single-image Process: always show AppNotice; OS desktop toast when the main window is unfocused or minimized
- AppNotice auto-dismiss: info after 5s, warning after 8s (paused while hovered); errors stay until dismissed
- Prefer GPU→CPU fallback wording over a plain success summary when a job fell back mid-run

### Fixed

- Folder watch: detect rename-into-place and harden settle so late-arriving files are not missed

## [1.1.0] - 2026-08-02

Batch processing and settings polish on top of the 1.0 stable line.

### Added

- **Batch queue** — multi-image drop and serial processing with per-row progress, fail-continue, cancel that leaves remaining items pending, retry/clear, and keyboard Process/Cancel in queue mode
- **Open folder** — load a folder of images into the queue; outputs write under `{folder}-nobg/` (created on Process, not on open); directory drop and `Ctrl+Shift+O`
- **Folder watch** (optional) — top-level notify watch with settle delay and junk filters; auto-enqueue/process new images after the first manual Process; cancel pauses auto-run until Process again
- **Overwrite policy for batch** — one-shot Yes/No/Cancel dialog (Overwrite all / Skip existing / Cancel); sticky mid-run policy; watch auto-run overwrites without re-prompting
- **Warm ORT session across queue jobs** — successful runs keep the cached session for serial throughput; drop on OOM (all keys), other errors (one key), EP invalidate, or 120s idle TTL
- Settings panel redesign: theme segmented control, EP chips + mini benchmark, output path Browse/Reset (`clear_output_dir`), updates status card with version badge and status pills
- Hybrid quality rail (Balanced / Balanced+ / High / Max) with detail panel; Turbo/`u2netp` remains benchmark-only and is not a user-facing mode

### Changed

- File source UI: compact file block with mini actions and Watch toggle; queue drawer with status/action icons and animated expand/collapse
- Quit/leave confirmations when the queue has pending or running work; EP locked while a batch run is active

### Fixed

- Queue FIFO ordering, path-key dedup (Windows separators/case), and finish-toast suppression on cancel
- E2E mocks and specs for queue finish/failed UX, High mode segments, and multi-drop path_is_dir

## [1.0.0] - 2026-07-31

First stable release. Non-prerelease tags enable the in-app auto-updater (`/releases/latest`).

### Added

- **High** quality mode (`birefnet-general-lite`, MIT) — mid/high tier between Balanced+ and Max Quality; BiRefNet postprocess uses sigmoid then min-max
- Signed auto-updater via static `latest.json` on GitHub Releases (Settings → Check for updates; quiet check after launch)
- About & licenses panel in Settings: app/ORT versions, MIT notice, model license table, GitHub links; external links open in the system browser (including the NC license modal)
- Release and CI publish extra installers: Linux `.deb` / `.rpm` and Windows `.msi` (alongside AppImage + NSIS)

### Changed

- **High** mode uses [studioludens/birefnet-lite-512](https://huggingface.co/studioludens/birefnet-lite-512) (512×512 ONNX, ~183 MB) instead of rembg’s 1024 BiRefNet-general-lite, to reduce peak VRAM / OOM on constrained GPUs; download URL is pinned to a Hugging Face commit; legacy `birefnet-general-lite.onnx` cache files are purged on model list/download

### Fixed

- Windows MSI bundling with SemVer pre-release versions (e.g. `0.9.0-beta.1`) by setting a numeric `bundle.windows.wix.version` (stable `1.0.0` uses the app version directly)

## [0.9.0-beta.1] - 2026-07-20

### Added

- User-facing README with download/install steps, screenshots, keyboard shortcuts, and troubleshooting
- Screenshots under `docs/screenshots/` for the main window, quality modes, and before/after results
- User-visible error handling: structured `{code, message}` wire format, friendly copy, sticky notices, and download retry
- Keyboard shortcuts for core workflows (`Ctrl+O` open, `Ctrl+Enter` process, `Esc` cancel)
- NC license acknowledgment modal before downloading non-commercial (CC BY-NC) models
- GPU OOM → automatic CPU inference fallback with user notice
- Backend download cancellation with single-flight download slot
- Custom scrollbar styles using theme tokens
- Dev → main release workflow and CI/CD gating for production PRs
- Redesigned UI shell: custom titlebar, left rail, animated modals/mode options
- Theme picker and rebranded color palette/logo

### Fixed

- Windows downloads: partial/stalled files, atomic finalize, progress freezes, verify race
- Windows GPU detection via DXCore (aligned with DirectML adapter selection)
- Windows ORT/DirectML session leaks and OOM recovery
- Cached ORT session released after each inference run

### Changed

- Prefer Balanced+ as default quality mode with safe Turbo fallback
- Fit image previews by aspect ratio
- Rename project from yabr to SwiftMask

## [0.1.0] - 2026-07-12

### Added

- Initial SwiftMask desktop app (Tauri 2 + React + local ONNX inference)
- Quality modes: Turbo (bundled), Balanced, Balanced+, Max Quality
- GPU benchmark, model downloads with SHA-256 verification, compare slider export

[Unreleased]: https://github.com/camilopaezz/SwiftMask/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/camilopaezz/SwiftMask/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/camilopaezz/SwiftMask/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/camilopaezz/SwiftMask/compare/v0.9.0-beta.1...v1.0.0
[0.9.0-beta.1]: https://github.com/camilopaezz/SwiftMask/compare/v0.1.0...v0.9.0-beta.1
[0.1.0]: https://github.com/camilopaezz/SwiftMask/releases/tag/v0.1.0
