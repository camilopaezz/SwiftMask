import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  cancelProcess,
  isProcessBusy,
  prodCancelDeps,
  prodStartProcessDeps,
  startProcess,
} from "../lib/currentImage";
import { formatError, formatRevealFailedNotice } from "../lib/errorCopy";
import { isProcessableMode } from "../lib/models";
import { cancelQueueProcess, startQueueProcess } from "../lib/queueRunner";
import { showAppErrorNotice } from "../lib/showAppErrorNotice";
import { type ImageItem, useImageStore } from "../stores/imageStore";
import { fileNameFromPath, useQueueStore } from "../stores/queueStore";
import { useSettingsStore } from "../stores/settingsStore";
import { ProgressBar, stageLabel } from "./ProgressBar";

function statusLabel(item: ImageItem, t: (key: string) => string): string {
  switch (item.status) {
    case "ready":
      return t("status.ready");
    case "processing":
      return stageLabel(item.stage, t);
    case "done":
      return t("status.done");
    case "error":
      return t("status.error");
    case "cancelled":
      return t("status.cancelled");
    default:
      return item.status;
  }
}

export function ImagePanel() {
  const { t } = useTranslation();
  const current = useImageStore((state) => state.current);
  const queueActive = useQueueStore((state) => state.active);
  const queueItems = useQueueStore((state) => state.items);
  const queueRunning = useQueueStore((state) => state.running);
  const mode = useSettingsStore((state) => state.mode);
  const models = useSettingsStore((state) => state.models);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancellingRef = useRef(false);

  const isProcessing = current?.status === "processing";
  const showCancel = queueActive
    ? queueRunning || cancelling
    : isProcessing || cancelling;
  const hasImage = Boolean(current);
  const isDone = current?.status === "done";
  const canShowInFolder = isDone && Boolean(current?.outputPath);
  // Strict: never Process on Turbo or an undownloaded quality mode.
  const modeReady = isProcessableMode(mode, models);

  const pendingCount = queueItems.filter((i) => i.status === "pending").length;
  const doneCount = queueItems.filter((i) => i.status === "done").length;
  const failedCount = queueItems.filter((i) => i.status === "failed").length;
  const processingItem = queueItems.find((i) => i.status === "processing");

  const processDisabled = queueActive
    ? starting ||
      cancelling ||
      queueRunning ||
      pendingCount === 0 ||
      !modeReady ||
      isProcessBusy()
    : !hasImage || starting || cancelling || !modeReady || isProcessBusy();

  const handleProcess = async () => {
    if (processDisabled) return;
    setStarting(true);
    try {
      if (queueActive) {
        await startQueueProcess();
      } else {
        await startProcess(prodStartProcessDeps());
      }
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = () => {
    if (cancellingRef.current) return;
    if (queueActive) {
      if (!queueRunning) return;
      cancellingRef.current = true;
      setCancelling(true);
      void cancelQueueProcess().finally(() => {
        cancellingRef.current = false;
        setCancelling(false);
      });
      return;
    }
    if (!isProcessing) return;
    cancellingRef.current = true;
    setCancelling(true);
    void cancelProcess(prodCancelDeps()).finally(() => {
      cancellingRef.current = false;
      setCancelling(false);
    });
  };

  const handleShowInFolder = async () => {
    if (!current?.outputPath) return;
    try {
      await revealItemInDir(current.outputPath);
    } catch (err) {
      console.error("reveal in folder failed", err);
      showAppErrorNotice(err, {
        copy: formatRevealFailedNotice(),
        code: "reveal_failed",
      });
    }
  };

  const errorTitle = current?.error
    ? formatError(current.error.code, current.error.message).title
    : null;

  let statusText: string | null;
  if (queueActive) {
    if (queueRunning && processingItem) {
      statusText = t("imagePanel.queueRunningStatus", {
        done: doneCount,
        total: queueItems.length,
        name: fileNameFromPath(processingItem.inputPath),
        stage: stageLabel(processingItem.stage, t),
      });
    } else if (cancelling) {
      statusText = t("status.cancelling");
    } else if (failedCount) {
      statusText = t("imagePanel.queueIdleStatusWithFailed", {
        total: queueItems.length,
        pending: pendingCount,
        failed: failedCount,
      });
    } else {
      statusText = t("imagePanel.queueIdleStatus", {
        total: queueItems.length,
        pending: pendingCount,
      });
    }
  } else if (!current) {
    statusText = t("imagePanel.nothingToProcess");
  } else if (isProcessing) {
    statusText = null;
  } else if (cancelling) {
    statusText = t("status.cancelling");
  } else if (errorTitle) {
    statusText = t("imagePanel.statusWithError", {
      status: statusLabel(current, t),
      error: errorTitle,
    });
  } else {
    statusText = statusLabel(current, t);
  }

  return (
    <div className="image-panel">
      {queueActive && queueRunning && processingItem && (
        <ProgressBar
          stage={processingItem.stage}
          progress={processingItem.progress}
        />
      )}
      {current && isProcessing && !queueActive && (
        <ProgressBar stage={current.stage} progress={current.progress} />
      )}

      {statusText !== null && (
        <div
          className={`image-panel-status${current?.status === "error" || failedCount > 0 ? " is-error" : ""}`}
        >
          {statusText}
        </div>
      )}

      <div className="image-panel-actions">
        {canShowInFolder && !showCancel && !queueActive && (
          <button type="button" onClick={() => void handleShowInFolder()}>
            {t("imagePanel.showInFolder")}
          </button>
        )}

        {!showCancel ? (
          <button
            type="button"
            className="btn-primary"
            title={
              queueActive
                ? t("imagePanel.processPendingTitle")
                : t("imagePanel.processTitle")
            }
            onClick={() => void handleProcess()}
            disabled={processDisabled}
            aria-disabled={processDisabled}
          >
            {starting
              ? t("status.starting")
              : queueActive
                ? pendingCount > 0
                  ? t("imagePanel.processAll")
                  : t("imagePanel.process")
                : isDone
                  ? t("imagePanel.reRun")
                  : t("imagePanel.process")}
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary"
            title={t("imagePanel.cancelTitle")}
            onClick={handleCancel}
            disabled={cancelling}
            aria-disabled={cancelling}
          >
            {cancelling ? t("status.cancelling") : t("common.cancel")}
          </button>
        )}
      </div>
    </div>
  );
}
