import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useRef, useState } from "react";
import {
  cancelProcess,
  isProcessBusy,
  prodCancelDeps,
  prodStartProcessDeps,
  startProcess,
} from "../lib/currentImage";
import { formatError, formatRevealFailedNotice } from "../lib/errorCopy";
import { cancelQueueProcess, startQueueProcess } from "../lib/queueRunner";
import { showAppErrorNotice } from "../lib/showAppErrorNotice";
import { type ImageItem, useImageStore } from "../stores/imageStore";
import { fileNameFromPath, useQueueStore } from "../stores/queueStore";
import { ProgressBar } from "./ProgressBar";

function statusLabel(item: ImageItem): string {
  switch (item.status) {
    case "ready":
      return "Ready";
    case "processing":
      return item.stage ?? "Processing";
    case "done":
      return "Done";
    case "error":
      return "Error";
    case "cancelled":
      return "Cancelled";
    default:
      return item.status;
  }
}

export function ImagePanel() {
  const current = useImageStore((state) => state.current);
  const queueActive = useQueueStore((state) => state.active);
  const queueItems = useQueueStore((state) => state.items);
  const queueRunning = useQueueStore((state) => state.running);
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

  const pendingCount = queueItems.filter((i) => i.status === "pending").length;
  const doneCount = queueItems.filter((i) => i.status === "done").length;
  const failedCount = queueItems.filter((i) => i.status === "failed").length;
  const processingItem = queueItems.find((i) => i.status === "processing");

  const processDisabled = queueActive
    ? starting ||
      cancelling ||
      queueRunning ||
      pendingCount === 0 ||
      isProcessBusy()
    : !hasImage || starting || cancelling || isProcessBusy();

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
      statusText = `${doneCount}/${queueItems.length} · ${fileNameFromPath(processingItem.inputPath)} · ${processingItem.stage ?? "processing"}`;
    } else if (cancelling) {
      statusText = "Cancelling…";
    } else {
      statusText = `${queueItems.length} in queue · ${pendingCount} pending${failedCount ? ` · ${failedCount} failed` : ""}`;
    }
  } else if (!current) {
    statusText = "No image selected";
  } else if (isProcessing) {
    statusText = null;
  } else if (cancelling) {
    statusText = "Cancelling…";
  } else {
    statusText = `${statusLabel(current)}${errorTitle ? `: ${errorTitle}` : ""}`;
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
            Show in folder
          </button>
        )}

        {!showCancel ? (
          <button
            type="button"
            className="btn-primary"
            title={
              queueActive
                ? "Process pending (Ctrl+Enter)"
                : "Process (Ctrl+Enter)"
            }
            onClick={() => void handleProcess()}
            disabled={processDisabled}
            aria-disabled={processDisabled}
          >
            {starting
              ? "Starting…"
              : queueActive
                ? pendingCount > 0
                  ? `Process (${pendingCount})`
                  : "Process"
                : isDone
                  ? "Re-run"
                  : "Process"}
          </button>
        ) : (
          <button
            type="button"
            className="btn-primary"
            title="Cancel (Esc)"
            onClick={handleCancel}
            disabled={cancelling}
            aria-disabled={cancelling}
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>
    </div>
  );
}
