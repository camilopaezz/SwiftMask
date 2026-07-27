# Git workflow

How we branch, integrate, and release SwiftMask.

## Branches

| Branch | Role |
|--------|------|
| `main` | Production. Tagged releases only. Full CI on PRs targeting `main` (not on ordinary pushes). |
| `dev` | Integration. Feature PRs merge here. **No CI** — you validate locally. |
| `feature/*` | Short-lived work branches. Cut from `dev`, PR back to `dev`. |

`origin/HEAD` points at `main`. Treat `dev` as the daily integration line.

## Day-to-day (feature → dev)

1. Branch from `dev`:
   ```bash
   git checkout dev && git pull
   git checkout -b feature/my-change
   ```
2. Implement, run checks locally:
   ```bash
   bun run lint && bun run test && bun run build
   # optional: bun run test:e2e
   ```
3. Push and open a **PR into `dev`**.
4. **CI does not run** on PRs to `dev` — review and smoke-test manually.
5. Merge to `dev` when satisfied.

Repeat until `dev` has enough for a release.

## Release (dev → main)

1. On `dev`, prepare a release PR into `main`:
   - Bump version in **all three** files: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`
   - MSI/WiX only accepts a numeric ProductVersion (`major.minor.patch[.build]`). SemVer pre-releases like `0.9.0-beta.1` fail unless `bundle.windows.wix.version` is set to something numeric (e.g. `0.9.0.1`). For stable releases you can drop the override.
   - Move `[Unreleased]` items in `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` section
2. Open **PR `dev` → `main`**. **Full CI runs** (lint, unit tests, `gen:models:check`, Rust tests, Tauri bundles on Linux + Windows, mocked Playwright E2E).
3. Merge when green and reviewed. Merging does not re-run CI — the PR run is the gate.
4. Tag on `main` (version must match the bump):
   ```bash
   git checkout main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```
5. **Release workflow** (`.github/workflows/release.yml`) builds **signed** installers and publishes a [GitHub Release](https://docs.github.com/en/repositories/releasing-projects-on-github) with assets:
   - Linux: AppImage, `.deb`, `.rpm`, AppImage `.sig`
   - Windows: NSIS setup `.exe`, `.msi`, NSIS `.sig` (MSI `.sig` may also be present)
   - `latest.json` — static manifest for the in-app updater

To re-run a failed publish without retagging, use **Actions → Release → Run workflow** with the existing tag.

## Signed auto-updater

In-app updates use [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/) against a static endpoint:

`https://github.com/camilopaezz/SwiftMask/releases/latest/download/latest.json`

| Topic | Detail |
|-------|--------|
| Channel | **Stable only.** GitHub `/releases/latest` ignores prereleases (`0.9.0-beta.*` etc.). Until the first **non-prerelease** tag after this lands, `check()` finds nothing — expected; betas still ship installers for manual download. |
| Update packages | `linux-x86_64` → AppImage; `windows-x86_64` → **NSIS** setup.exe. MSI / deb / rpm stay on the release for first install / package managers but are **not** listed in `latest.json`. |
| UX | Silent check a few seconds after launch (log-only on failure) + **Settings → Check for updates**. User confirms before download/install; then install + relaunch. No telemetry. |
| Signing | Ed25519 updater package signatures (not Authenticode/SmartScreen). Public key is in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. |

### One-time key setup (operator)

```bash
# Generate once; never commit the private key
bunx tauri signer generate -w ~/.tauri/swiftmask.key --ci
# Optional password: omit --ci and enter one, or pass -p '…'
```

1. Put the **public** key contents into `tauri.conf.json` → `plugins.updater.pubkey` (already set for this project).
2. Add GitHub Actions secrets on the repo:
   - `TAURI_SIGNING_PRIVATE_KEY` — full private key file contents
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — only if the key was generated with a password
3. Both **`ci.yml`** (PR → `main`) and **`release.yml`** require these secrets so builds always prove signing works.

Losing the private key breaks continuous signed updates for existing installs — treat it like a production signing key.

Forks and external PRs that cannot read repo secrets will fail the signed Tauri build step on PR → `main`; maintainers re-run CI after secrets are available, or review without relying on fork CI green.

### Local builds (contributors)

`bundle.createUpdaterArtifacts` is **on** in `tauri.conf.json`, so a full `tauri build` needs the same signing env vars as CI:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/swiftmask.key)"
# only if the key has a password:
# export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='…'

bunx tauri build --bundles appimage   # Linux example
# bunx tauri build --bundles nsis     # Windows
```

- **Dev / day-to-day UI work:** `bun run tauri dev` does **not** need the private key.
- **Unsigned local smoke of an installer:** not supported while `createUpdaterArtifacts` is true — either export the key above, or temporarily set `"createUpdaterArtifacts": false` in a private branch (never commit that for release).
- **Production key:** do not hand the real private key to random contributors; maintainers build signed artifacts in CI/release.

### `latest.json` shape (generated in `release.yml`)

```json
{
  "version": "<semver without v>",
  "notes": "<changelog excerpt>",
  "pub_date": "<RFC3339>",
  "platforms": {
    "linux-x86_64": {
      "url": "https://github.com/…/releases/download/vVERSION/swiftmask-linux.AppImage",
      "signature": "<contents of .AppImage.sig>"
    },
    "windows-x86_64": {
      "url": "https://github.com/…/releases/download/vVERSION/swiftmask-windows-setup.exe",
      "signature": "<contents of .exe.sig>"
    }
  }
}
```

Prerelease tags still attach `latest.json` (useful later for a beta endpoint); clients currently only hit `/releases/latest`.

## CI summary

| Event | Workflow | What runs |
|-------|----------|-----------|
| PR → `dev` | — | Nothing (manual QA) |
| Push to `dev` | — | Nothing |
| PR → `main` | `ci.yml` | Lint, unit tests, `gen:models:check`, `cargo test`, signed Tauri build (Linux + Windows), mocked Playwright E2E |
| Push to `main` | — | Nothing (CI already ran on the PR) |
| Push semver tag `vX.Y.Z` (optional `-prerelease`) on `main` | `release.yml` | Version check, signed build, `latest.json`, GitHub Release upload |
| Manual dispatch with existing tag | `release.yml` | Re-publish a failed release without retagging |

## First-time setup

If `dev` is not on the remote yet:

```bash
git checkout dev
git push -u origin dev
```

Set GitHub default comparison branch for PRs to `dev` if you want (Settings → General → Default branch stays `main`).

## Example: NC license feature

```bash
# already on feature/nc-license-modal
git push -u origin feature/nc-license-modal
# open PR: feature/nc-license-modal → dev (no CI)
# manual check → merge

# later, release batch:
# open PR: dev → main with version 0.2.0 + CHANGELOG
# merge → tag v0.2.0 → release workflow publishes installers
```