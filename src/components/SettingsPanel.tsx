import { ask } from "@tauri-apps/plugin-dialog";
import type { Update } from "@tauri-apps/plugin-updater";
import { type RefObject, useEffect, useState } from "react";
import { epLabel } from "../lib/epLabel";
import {
  formatUpdateCheckFailedCopy,
  formatUpdateInstallFailedCopy,
  formatUpToDateCopy,
} from "../lib/errorCopy";
import { showAppErrorNotice, showAppNotice } from "../lib/showAppErrorNotice";
import {
  invokeDetectGpu,
  invokeGetConfig,
  invokeGetRuntimeInfo,
  invokeClearOutputDir,
  invokePickOutputDir,
  invokeRunBenchmark,
  invokeSetEp,
} from "../lib/tauri";
import { isTheme, type Theme } from "../lib/theme";
import {
  canCheckForUpdates,
  checkForUpdate,
  classifyUpdaterError,
  installUpdateAndRelaunch,
} from "../lib/updater";
import { useSettingsStore } from "../stores/settingsStore";

export type SettingsPanelProps = {
  /**
   * Settings shell is open (fetch lifecycle). View visibility / inert is owned
   * by the modal-view wrapper in App so GPU/runtime are not re-fetched on
   * About → Settings return.
   */
  shellOpen: boolean;
  onOpenAbout: () => void;
  aboutEntryRef?: RefObject<HTMLButtonElement | null>;
};

type UpdateUiStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "error"
  | "restarting";

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function formatVram(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  const mib = bytes / 1024 ** 2;
  return `${mib.toFixed(0)} MiB`;
}

function formatSeconds(seconds: number): string {
  if (seconds < 0.001) return "<1ms";
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
  return `${seconds.toFixed(3)}s`;
}

export function SettingsPanel({
  shellOpen,
  onOpenAbout,
  aboutEntryRef,
}: SettingsPanelProps) {
  const {
    ep,
    outputDir,
    theme,
    gpuInfo,
    runtimeInfo,
    lastJobTimings,
    setEp: setEpInStore,
    setOutputDir,
    setTheme,
    setGpuInfo,
    setRuntimeInfo,
  } = useSettingsStore();
  const [loading, setLoading] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateUiStatus>("idle");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updatePercent, setUpdatePercent] = useState<number | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);

  useEffect(() => {
    if (!shellOpen) return;
    invokeDetectGpu()
      .then((info) => setGpuInfo(info))
      .catch((err: unknown) => {
        console.error("detect_gpu failed", err);
        showAppErrorNotice(err);
      });
    // Prefetch for About + version card; failures stay in console only when
    // Settings no longer depends on the value for layout.
    invokeGetRuntimeInfo()
      .then((info) => setRuntimeInfo(info))
      .catch((err: unknown) => {
        console.error("get_runtime_info failed", err);
      });
  }, [shellOpen, setGpuInfo, setRuntimeInfo]);

  // Drop the live Update resource when the panel unmounts / closes mid-check.
  useEffect(() => {
    return () => {
      void pendingUpdate?.close().catch(() => {
        /* ignore close races */
      });
    };
  }, [pendingUpdate]);

  const handleEpChange = async (value: string) => {
    try {
      await invokeSetEp(value);
      setEpInStore(value);
    } catch (err) {
      console.error("set_ep failed", err);
      showAppErrorNotice(err);
    }
  };

  const handlePickOutputDir = async () => {
    try {
      const picked = await invokePickOutputDir();
      if (picked) {
        setOutputDir(picked);
      }
    } catch (err) {
      console.error("pick_output_dir failed", err);
      showAppErrorNotice(err);
    }
  };

  const handleClearOutputDir = async () => {
    try {
      await invokeClearOutputDir();
      setOutputDir(null);
    } catch (err) {
      console.error("clear_output_dir failed", err);
      showAppErrorNotice(err);
    }
  };

  const handleBenchmark = async () => {
    setLoading(true);
    try {
      await invokeRunBenchmark();
      const config = await invokeGetConfig();
      setEpInStore(config.execution_provider);
    } catch (err) {
      console.error("benchmark failed", err);
      showAppErrorNotice(err);
    } finally {
      setLoading(false);
    }
  };

  const handleCheckForUpdates = async () => {
    if (!canCheckForUpdates(updateStatus)) return;
    setUpdateStatus("checking");
    setUpdatePercent(null);
    try {
      if (pendingUpdate) {
        await pendingUpdate.close().catch(() => undefined);
        setPendingUpdate(null);
      }
      const result = await checkForUpdate();
      if (result.status === "unavailable") {
        setUpdateStatus("error");
        showAppNotice(
          formatUpdateCheckFailedCopy(
            "Updates are only available in the desktop app.",
          ),
          "warning",
          "update_unavailable",
        );
        return;
      }
      if (result.status === "up-to-date") {
        setUpdateVersion(null);
        setPendingUpdate(null);
        setUpdateStatus("up-to-date");
        showAppNotice(formatUpToDateCopy(), "info", "update_up_to_date");
        return;
      }
      setPendingUpdate(result.update);
      setUpdateVersion(result.info.version);
      setUpdateStatus("available");
    } catch (err) {
      console.error("check for updates failed", err);
      setUpdateStatus("error");
      const { code, message } = classifyUpdaterError(err, "check");
      showAppErrorNotice(err, {
        severity: "error",
        copy: formatUpdateCheckFailedCopy(message),
        code,
      });
    }
  };

  const handleInstallAndRestart = async () => {
    if (
      !pendingUpdate ||
      updateStatus === "downloading" ||
      updateStatus === "restarting" ||
      updateStatus === "checking"
    ) {
      return;
    }
    const version = updateVersion ?? pendingUpdate.version;
    const confirmed = await ask(
      `Download and install SwiftMask ${version}? The app will restart when finished.`,
      { title: "Install update", kind: "info" },
    );
    if (!confirmed) return;

    setUpdateStatus("downloading");
    setUpdatePercent(null);
    try {
      await installUpdateAndRelaunch(pendingUpdate, (progress) => {
        if (progress.percent != null) setUpdatePercent(progress.percent);
        if (progress.phase === "finished") {
          setUpdateStatus("restarting");
        }
      });
      setUpdateStatus("restarting");
    } catch (err) {
      console.error("install update failed", err);
      // Keep the pending Update so the user can retry Install without re-checking.
      setUpdateStatus("available");
      setUpdatePercent(null);
      const { code, message } = classifyUpdaterError(err, "install");
      showAppErrorNotice(err, {
        severity: "error",
        copy: formatUpdateInstallFailedCopy(message),
        code,
      });
    }
  };

  const appVersion = runtimeInfo?.app_version;
  const epOptions = gpuInfo?.available_eps ?? [];

  const updatePill = (() => {
    switch (updateStatus) {
      case "checking":
        return { label: "Checking…", tone: "neutral" as const };
      case "up-to-date":
        return { label: "Current", tone: "ok" as const };
      case "available":
        return { label: "Ready", tone: "accent" as const };
      case "downloading":
        return {
          label: updatePercent != null ? `${updatePercent}%` : "Downloading…",
          tone: "accent" as const,
        };
      case "restarting":
        return { label: "Restarting…", tone: "accent" as const };
      case "error":
        return { label: "Failed", tone: "warn" as const };
      default:
        return { label: "Stable", tone: "neutral" as const };
    }
  })();

  const updateCardSubLines = (() => {
    switch (updateStatus) {
      case "checking":
        return ["Looking for a newer stable release…"];
      case "up-to-date":
        return [
          appVersion
            ? `You're on ${appVersion} · latest stable`
            : "You're on the latest stable release.",
        ];
      case "available":
        return [
          "Ready to install",
          ...(appVersion ? [`You're on ${appVersion}`] : []),
        ];
      case "downloading":
        return [
          updateVersion
            ? `Downloading ${updateVersion}…`
            : "Downloading update…",
        ];
      case "restarting":
        return ["Installing and restarting…"];
      case "error":
        return ["Couldn't check for updates. Try again."];
      default:
        return appVersion
          ? [`You're on ${appVersion} · stable channel`]
          : ["Stable channel"];
    }
  })();

  const showUpdateVersionBadge =
    (updateStatus === "available" ||
      updateStatus === "downloading" ||
      updateStatus === "restarting") &&
    Boolean(updateVersion);

  const checkLabel =
    updateStatus === "checking" ? "Checking…" : "Check for updates";

  return (
    <div className="settings-panel">
      <div className="settings-field">
        <div className="settings-field-label">Theme</div>
        <div className="settings-seg">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="settings-seg-btn"
              aria-pressed={theme === opt.value}
              onClick={() => {
                if (isTheme(opt.value)) setTheme(opt.value);
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-field">
        <div className="settings-field-label">Execution provider</div>
        <div className="settings-provider-block">
          <div className="settings-ep-chips">
            {epOptions.length === 0 ? (
              <span className="settings-provider-status">
                Detecting providers…
              </span>
            ) : (
              epOptions.map((epOption) => (
                <button
                  key={epOption}
                  type="button"
                  className="settings-ep-chip"
                  aria-pressed={ep === epOption}
                  onClick={() => void handleEpChange(epOption)}
                >
                  {epLabel(epOption)}
                </button>
              ))
            )}
          </div>
          <button
            type="button"
            className="settings-mini-bench"
            onClick={() => void handleBenchmark()}
            disabled={loading}
            title="Time each available EP and select the fastest"
          >
            <span className="settings-mini-bench-icon" aria-hidden="true">
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                focusable="false"
                aria-hidden="true"
              >
                <path d="M2.5 8a5.5 5.5 0 0 1 9.6-3.7M13.5 8a5.5 5.5 0 0 1-9.6 3.7" />
                <path d="M12.5 2.5v2.8H9.7M3.5 13.5v-2.8h2.8" />
              </svg>
            </span>
            {loading ? "Running…" : "Benchmark"}
          </button>
        </div>
        {loading ? (
          <div className="settings-provider-status">Benchmarking…</div>
        ) : null}
      </div>

      <div className="settings-field">
        <div className="settings-field-head">
          <div className="settings-field-label">Output directory</div>
          {outputDir ? (
            <button
              type="button"
              className="settings-path-reset"
              aria-label="Reset output directory to same as input"
              title="Use same folder as each input file"
              onClick={() => void handleClearOutputDir()}
            >
              Reset
            </button>
          ) : null}
        </div>
        <div className="settings-path-row">
          <div
            className="settings-path-value"
            title={outputDir ?? "Same as input (default)"}
          >
            <span>{outputDir ?? "Same as input"}</span>
          </div>
          <button
            type="button"
            aria-label={
              outputDir
                ? `Change output directory (current: ${outputDir})`
                : "Choose output directory"
            }
            onClick={() => void handlePickOutputDir()}
          >
            Browse…
          </button>
        </div>
      </div>

      {/* S2: sparse rules — prefs | system | about (footer keeps its own rule). */}
      <hr className="settings-rule" />

      <div className="settings-field">
        <div className="settings-update-card">
          <div className="settings-update-head">
            <div className="settings-update-copy">
              <div className="settings-update-title-row">
                <div className="settings-update-title">Updates</div>
                {showUpdateVersionBadge ? (
                  <span className="settings-update-ver-badge">
                    {updateVersion}
                  </span>
                ) : null}
              </div>
              <div className="settings-update-sub">
                {updateCardSubLines.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
            </div>
            <span className={`settings-status-pill tone-${updatePill.tone}`}>
              <span className="settings-status-dot" aria-hidden="true" />
              {updatePill.label}
            </span>
          </div>
          <div className="settings-update-actions">
            <button
              type="button"
              onClick={() => void handleCheckForUpdates()}
              disabled={!canCheckForUpdates(updateStatus)}
            >
              {checkLabel}
            </button>
            {updateStatus === "available" && pendingUpdate && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => void handleInstallAndRestart()}
              >
                Install and restart
              </button>
            )}
            {(updateStatus === "downloading" ||
              updateStatus === "restarting") && (
              <button type="button" disabled>
                {updateStatus === "restarting"
                  ? "Restarting…"
                  : updatePercent != null
                    ? `Downloading… ${updatePercent}%`
                    : "Downloading…"}
              </button>
            )}
          </div>
        </div>
      </div>

      {(gpuInfo || (lastJobTimings && lastJobTimings.stages.length > 0)) && (
        <hr className="settings-rule" />
      )}

      {gpuInfo && (
        <div className="settings-meta">
          <div>GPU: {gpuInfo.vendor}</div>
          <div>
            VRAM:{" "}
            {gpuInfo.vram_bytes != null
              ? formatVram(gpuInfo.vram_bytes)
              : "Unknown"}
          </div>
          <div>
            EPs:{" "}
            {gpuInfo.available_eps
              .map((epOption) => epLabel(epOption))
              .join(", ")}
          </div>
          <div>Opt: {gpuInfo.optimization}</div>
        </div>
      )}

      {lastJobTimings && lastJobTimings.stages.length > 0 && (
        <div className="settings-meta">
          <div>Last job</div>
          {lastJobTimings.stages.map((timing) => (
            <div key={timing.stage}>
              {timing.stage}: {formatSeconds(timing.seconds)}
            </div>
          ))}
          <div>total: {formatSeconds(lastJobTimings.total_seconds)}</div>
        </div>
      )}

      <div className="settings-footer">
        <button
          ref={aboutEntryRef}
          type="button"
          className="settings-about-link"
          onClick={onOpenAbout}
        >
          About &amp; licenses
        </button>
      </div>
    </div>
  );
}
