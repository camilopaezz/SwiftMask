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
  invokePickOutputDir,
  invokeRunBenchmark,
  invokeSetEp,
} from "../lib/tauri";
import { isTheme } from "../lib/theme";
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
    // Prefetch for About; failures stay in console only — Settings no longer
    // shows App/ORT, and About fetches again if still missing.
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

  const updateStatusHint = (() => {
    switch (updateStatus) {
      case "checking":
        return "Checking for updates…";
      case "up-to-date":
        return "You're on the latest stable release.";
      case "available":
        return updateVersion
          ? `Update ${updateVersion} is ready to install (AppImage/NSIS package).`
          : "An update is ready to install (AppImage/NSIS package).";
      case "downloading":
        return updatePercent != null
          ? `Downloading update… ${updatePercent}%`
          : "Downloading update…";
      case "restarting":
        return "Installing and restarting…";
      case "error":
        return "Couldn't check for updates. Try again.";
      default:
        return "Stable channel only. In-app updates use AppImage (Linux) or NSIS (Windows); .deb/.rpm/MSI installs should update via those packages or reinstall.";
    }
  })();

  return (
    <div className="settings-panel">
      <div className="settings-field">
        <label htmlFor="settings-theme">Theme</label>
        <select
          id="settings-theme"
          className="settings-select"
          value={theme}
          onChange={(e) => {
            const value = e.target.value;
            if (isTheme(value)) setTheme(value);
          }}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
        <div className="settings-hint">Override the system appearance</div>
      </div>

      <div className="settings-field">
        <label htmlFor="settings-ep">Execution provider</label>
        <select
          id="settings-ep"
          className="settings-select"
          value={ep ?? ""}
          onChange={(e) => void handleEpChange(e.target.value)}
        >
          <option value="" disabled>
            Choose EP
          </option>
          {gpuInfo?.available_eps.map((epOption) => (
            <option key={epOption} value={epOption}>
              {epLabel(epOption)}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-field">
        <label htmlFor="settings-output-dir">Output directory</label>
        <button
          id="settings-output-dir"
          type="button"
          onClick={() => void handlePickOutputDir()}
          title={outputDir ?? "Same as input (default)"}
          style={{
            textAlign: "left",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {outputDir ?? "Choose output directory"}
        </button>
        {!outputDir && (
          <div className="settings-hint">Same as input (default)</div>
        )}
      </div>

      <div className="settings-field">
        <button
          type="button"
          onClick={() => void handleBenchmark()}
          disabled={loading}
        >
          {loading ? "Benchmarking…" : "Re-run benchmark"}
        </button>
      </div>

      <div className="settings-field">
        <button
          type="button"
          onClick={() => void handleCheckForUpdates()}
          disabled={!canCheckForUpdates(updateStatus)}
        >
          {updateStatus === "checking" ? "Checking…" : "Check for updates"}
        </button>
        {updateStatus === "available" && pendingUpdate && (
          <button
            type="button"
            className="settings-update-secondary"
            onClick={() => void handleInstallAndRestart()}
          >
            {updateVersion
              ? `Install ${updateVersion} and restart`
              : "Install and restart"}
          </button>
        )}
        {(updateStatus === "downloading" || updateStatus === "restarting") && (
          <button type="button" className="settings-update-secondary" disabled>
            {updateStatus === "restarting"
              ? "Restarting…"
              : updatePercent != null
                ? `Downloading… ${updatePercent}%`
                : "Downloading…"}
          </button>
        )}
        <div className="settings-hint">{updateStatusHint}</div>
      </div>

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
