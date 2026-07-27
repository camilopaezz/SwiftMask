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
import { showAppErrorNotice } from "../lib/showAppErrorNotice";
import { type ImageItem, useImageStore } from "../stores/imageStore";
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
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const cancellingRef = useRef(false);

  const isProcessing = current?.status === "processing";
  // Keep Cancel chrome while backend cancel is still freeing the slot.
  const showCancel = isProcessing || cancelling;
  const hasImage = Boolean(current);
  const isDone = current?.status === "done";
  const canShowInFolder = isDone && Boolean(current?.outputPath);
  const processDisabled =
    !hasImage || starting || cancelling || isProcessBusy();

  const handleProcess = async () => {
    if (processDisabled || !current) return;
    setStarting(true);
    try {
      await startProcess(prodStartProcessDeps());
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = () => {
    if (cancellingRef.current || !isProcessing) return;
    cancellingRef.current = true;
    setCancelling(true);
    // Optimistic cancel ends "processing"; keep Cancel disabled until the
    // backend slot is free so Process cannot start a second overlapping job.
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

  // While processing, ProgressBar already shows stage + % — skip duplicate status line.
  // During cancel wait status is already "cancelled" but Cancel chrome is still up.
  const errorTitle = current?.error
    ? formatError(current.error.code, current.error.message).title
    : null;
  const statusText = !current
    ? "No image selected"
    : isProcessing
      ? null
      : cancelling
        ? "Cancelling…"
        : `${statusLabel(current)}${errorTitle ? `: ${errorTitle}` : ""}`;

  return (
    <div className="image-panel">
      {current && isProcessing && (
        <ProgressBar stage={current.stage} progress={current.progress} />
      )}

      {statusText !== null && (
        <div
          className={`image-panel-status${current?.status === "error" ? " is-error" : ""}`}
        >
          {statusText}
        </div>
      )}

      <div className="image-panel-actions">
        {canShowInFolder && !showCancel && (
          <button type="button" onClick={() => void handleShowInFolder()}>
            Show in folder
          </button>
        )}

        {/* Always mount Process when idle so it stays visible (disabled if no image). */}
        {!showCancel ? (
          <button
            type="button"
            className="btn-primary"
            title="Process (Ctrl+Enter)"
            onClick={() => void handleProcess()}
            disabled={processDisabled}
            aria-disabled={processDisabled}
          >
            {starting ? "Starting…" : isDone ? "Re-run" : "Process"}
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
