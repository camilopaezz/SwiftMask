import { ask } from "@tauri-apps/plugin-dialog";
import type { Update } from "@tauri-apps/plugin-updater";
import { type RefObject, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { epLabel } from "../lib/epLabel";
import {
  formatUpdateCheckFailedCopy,
  formatUpdateInstallFailedCopy,
  formatUpToDateCopy,
} from "../lib/errorCopy";
import { isQueueRunActive } from "../lib/queueRunner";
import { showAppErrorNotice, showAppNotice } from "../lib/showAppErrorNotice";
import {
  invokeClearOutputDir,
  invokeDetectGpu,
  invokeGetConfig,
  invokeGetRuntimeInfo,
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
import { useQueueStore } from "../stores/queueStore";
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

const THEME_OPTIONS: { value: Theme; labelKey: string }[] = [
  { value: "system", labelKey: "settings.themeSystem" },
  { value: "light", labelKey: "settings.themeLight" },
  { value: "dark", labelKey: "settings.themeDark" },
];

const STAGE_KEYS: Record<string, string> = {
  decoding: "stages.decoding",
  preprocessing: "stages.preprocessing",
  inferring: "stages.inferring",
  "inferring-cpu": "stages.inferringCpu",
  postprocessing: "stages.postprocessing",
  encoding: "stages.encoding",
  Processing: "stages.processing",
};

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
  const { t } = useTranslation();
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
  const queueRunning = useQueueStore((s) => s.running);
  const epLocked = queueRunning || isQueueRunActive();
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
    if (epLocked) return;
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
    if (epLocked) return;
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
          formatUpdateCheckFailedCopy(t("errors.updateUnavailable.body")),
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
    const confirmed = await ask(t("settings.installConfirm", { version }), {
      title: t("settings.installTitle"),
      kind: "info",
    });
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
        return { label: t("settings.pillChecking"), tone: "neutral" as const };
      case "up-to-date":
        return { label: t("settings.pillCurrent"), tone: "ok" as const };
      case "available":
        return { label: t("settings.pillReady"), tone: "accent" as const };
      case "downloading":
        return {
          label:
            updatePercent != null
              ? `${updatePercent}%`
              : t("settings.pillDownloading"),
          tone: "accent" as const,
        };
      case "restarting":
        return {
          label: t("settings.pillRestarting"),
          tone: "accent" as const,
        };
      case "error":
        return { label: t("settings.pillFailed"), tone: "warn" as const };
      default:
        return { label: t("settings.pillStable"), tone: "neutral" as const };
    }
  })();

  const updateCardSubLines = (() => {
    switch (updateStatus) {
      case "checking":
        return [t("settings.subLooking")];
      case "up-to-date":
        return [
          appVersion
            ? t("settings.subOnVersionLatest", { version: appVersion })
            : t("settings.subLatestStable"),
        ];
      case "available":
        return [
          t("settings.subReadyToInstall"),
          ...(appVersion
            ? [t("settings.subYoureOn", { version: appVersion })]
            : []),
        ];
      case "downloading":
        return [
          updateVersion
            ? t("settings.subDownloadingVersion", { version: updateVersion })
            : t("settings.subDownloadingUpdate"),
        ];
      case "restarting":
        return [t("settings.subInstallingRestarting")];
      case "error":
        return [t("settings.subCheckFailed")];
      default:
        return appVersion
          ? [t("settings.subOnVersionChannel", { version: appVersion })]
          : [t("settings.subStableChannel")];
    }
  })();

  const showUpdateVersionBadge =
    (updateStatus === "available" ||
      updateStatus === "downloading" ||
      updateStatus === "restarting") &&
    Boolean(updateVersion);

  const checkLabel =
    updateStatus === "checking"
      ? t("settings.checking")
      : t("settings.checkForUpdates");

  const stageLabel = (stage: string) => {
    const key = STAGE_KEYS[stage];
    return key ? t(key) : stage;
  };

  return (
    <div className="settings-panel">
      <div className="settings-field">
        <div className="settings-field-label">{t("settings.theme")}</div>
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
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-field">
        <div className="settings-field-label">
          {t("settings.executionProvider")}
        </div>
        <div className="settings-provider-block">
          <div className="settings-ep-chips">
            {epOptions.length === 0 ? (
              <span className="settings-provider-status">
                {t("settings.detectingProviders")}
              </span>
            ) : (
              epOptions.map((epOption) => (
                <button
                  key={epOption}
                  type="button"
                  className="settings-ep-chip"
                  aria-pressed={ep === epOption}
                  disabled={epLocked}
                  title={epLocked ? t("settings.epLockedTitle") : undefined}
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
            disabled={loading || epLocked}
            title={
              epLocked
                ? t("settings.benchmarkLockedTitle")
                : t("settings.benchmarkTitle")
            }
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
            {loading ? t("settings.benchmarkRunning") : t("settings.benchmark")}
          </button>
        </div>
        {loading ? (
          <div className="settings-provider-status">
            {t("settings.benchmarking")}
          </div>
        ) : epLocked ? (
          <div className="settings-provider-status">
            {t("settings.lockedWhileQueue")}
          </div>
        ) : null}
      </div>

      <div className="settings-field">
        <div className="settings-field-head">
          <div className="settings-field-label">
            {t("settings.outputDirectory")}
          </div>
          {outputDir ? (
            <button
              type="button"
              className="settings-path-reset"
              aria-label={t("settings.resetOutputDirAria")}
              title={t("settings.resetOutputDirTitle")}
              onClick={() => void handleClearOutputDir()}
            >
              {t("common.reset")}
            </button>
          ) : null}
        </div>
        <div className="settings-path-row">
          <div
            className="settings-path-value"
            title={outputDir ?? t("settings.sameAsInputDefault")}
          >
            <span>{outputDir ?? t("settings.sameAsInput")}</span>
          </div>
          <button
            type="button"
            aria-label={
              outputDir
                ? t("settings.changeOutputDirAria", { path: outputDir })
                : t("settings.chooseOutputDirAria")
            }
            onClick={() => void handlePickOutputDir()}
          >
            {t("common.browse")}
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
                <div className="settings-update-title">
                  {t("settings.updates")}
                </div>
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
                {t("settings.installAndRestart")}
              </button>
            )}
            {(updateStatus === "downloading" ||
              updateStatus === "restarting") && (
              <button type="button" disabled>
                {updateStatus === "restarting"
                  ? t("settings.pillRestarting")
                  : updatePercent != null
                    ? t("settings.downloadingPercent", {
                        percent: updatePercent,
                      })
                    : t("settings.pillDownloading")}
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
          <div>{t("settings.gpu", { vendor: gpuInfo.vendor })}</div>
          <div>
            {t("settings.vram", {
              value:
                gpuInfo.vram_bytes != null
                  ? formatVram(gpuInfo.vram_bytes)
                  : t("settings.vramUnknown"),
            })}
          </div>
          <div>
            {t("settings.eps", {
              list: gpuInfo.available_eps
                .map((epOption) => epLabel(epOption))
                .join(", "),
            })}
          </div>
          <div>{t("settings.opt", { value: gpuInfo.optimization })}</div>
        </div>
      )}

      {lastJobTimings && lastJobTimings.stages.length > 0 && (
        <div className="settings-meta">
          <div>{t("settings.lastJob")}</div>
          {lastJobTimings.stages.map((timing) => (
            <div key={timing.stage}>
              {stageLabel(timing.stage)}: {formatSeconds(timing.seconds)}
            </div>
          ))}
          <div>
            {t("settings.total", {
              value: formatSeconds(lastJobTimings.total_seconds),
            })}
          </div>
        </div>
      )}

      <div className="settings-footer">
        <button
          ref={aboutEntryRef}
          type="button"
          className="settings-about-link"
          onClick={onOpenAbout}
        >
          {t("settings.aboutAndLicenses")}
        </button>
      </div>
    </div>
  );
}
