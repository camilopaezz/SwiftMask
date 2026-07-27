# Changelog

All notable changes to SwiftMask are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Version numbers must stay in sync across `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` before tagging a release.

## [Unreleased]

### Added

- About & licenses panel in Settings: app/ORT versions, MIT notice, model license table, GitHub links; external links open in the system browser (including the NC license modal)
- Release and CI publish extra installers: Linux `.deb` / `.rpm` and Windows `.msi` (alongside AppImage + NSIS)

### Fixed

- Windows MSI bundling with SemVer pre-release versions (e.g. `0.9.0-beta.1`) by setting a numeric `bundle.windows.wix.version`

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

[Unreleased]: https://github.com/camilopaezz/SwiftMask/compare/v0.9.0-beta.1...HEAD
[0.9.0-beta.1]: https://github.com/camilopaezz/SwiftMask/compare/v0.1.0...v0.9.0-beta.1
[0.1.0]: https://github.com/camilopaezz/SwiftMask/releases/tag/v0.1.0
