import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import { uiStore } from "../stores/uiStore";
import {
  formatDownloadCancelUnconfirmedNotice,
  formatModelsUnavailableNotice,
} from "./errorCopy";
import { isModelReady, type ModelMeta, type ModelMode } from "./models";
import { needsNcLicenseAck, setNcLicenseAck } from "./ncLicense";
import { isCancelledError, parseAppError } from "./parseAppError";
import { showAppErrorNotice, showAppNotice } from "./showAppErrorNotice";
import {
  invokeCancelDownload,
  invokeDownloadModel,
  invokeListModels,
  listenModelDownload,
} from "./tauri";
import { useAnimatedPresence } from "./useAnimatedPresence";

export type DownloadErrorState = {
  model: ModelMeta;
  code: string;
  message: string;
};

/**
 * Model download session machine: progress events, cancel races, NC license
 * ack, and catalog refresh via settingsStore.applyModels.
 */
export function useModelDownload() {
  const setMode = useSettingsStore((state) => state.setMode);
  const applyModels = useSettingsStore((state) => state.applyModels);
  const markModelDownloaded = useSettingsStore(
    (state) => state.markModelDownloaded,
  );

  const [downloading, setDownloading] = useState<ModelMeta | null>(null);
  const [displayModel, setDisplayModel] = useState<ModelMeta | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadStage, setDownloadStage] = useState<"download" | "verify">(
    "download",
  );
  const [cancelling, setCancelling] = useState(false);
  const cancellingRef = useRef(false);
  const [ncAckModel, setNcAckModel] = useState<ModelMeta | null>(null);
  const [downloadError, setDownloadError] = useState<DownloadErrorState | null>(
    null,
  );
  /** Bumped only when a new download starts; invalidates stale in-flight work. */
  const downloadSessionRef = useRef(0);
  const downloadPresence = useAnimatedPresence(Boolean(downloading));
  const ncAckPresence = useAnimatedPresence(Boolean(ncAckModel));

  useEffect(() => {
    uiStore
      .getState()
      .setModalBlocksShortcuts(
        ncAckPresence.rendered || downloadPresence.rendered,
      );
    return () => uiStore.getState().setModalBlocksShortcuts(false);
  }, [ncAckPresence.rendered, downloadPresence.rendered]);

  useEffect(() => {
    if (downloading) {
      setDisplayModel(downloading);
    }
  }, [downloading]);

  useEffect(() => {
    if (!downloadPresence.rendered) {
      setDisplayModel(null);
      // Reset progress only after exit animation so the modal does not flash
      // back to an empty "Downloading 0%" state on completion.
      setDownloadProgress(0);
      setDownloadStage("download");
    }
  }, [downloadPresence.rendered]);

  useEffect(() => {
    if (!downloading) return;

    let unsubscribe: (() => void) | undefined;
    let cleanedUp = false;
    const modelId = downloading.id;
    const modelMode = downloading.id as ModelMode;
    const session = downloadSessionRef.current;
    const isCurrentSession = () => downloadSessionRef.current === session;

    // Subscribe first, then start the transfer. Starting both in parallel can
    // miss early progress/verify events (worse on slower Windows WebView2 IPC).
    void (async () => {
      try {
        const unsub = await listenModelDownload((payload) => {
          if (payload.model_id !== modelId) return;
          if (!isCurrentSession()) return;
          if (cancellingRef.current) return;
          setDownloadProgress(Math.max(0, Math.min(100, payload.pct)));
          setDownloadStage(payload.stage === "verify" ? "verify" : "download");
        });
        if (cleanedUp || !isCurrentSession()) {
          unsub();
          return;
        }
        unsubscribe = unsub;

        await invokeDownloadModel(modelId);
        if (!isCurrentSession()) return;

        // Close the modal as soon as the backend finishes — do not wait on
        // list_models (that left "Verifying" up while the badge already updated).
        setDownloading(null);

        setMode(modelMode);
        // Optimistic ready flag so the Download chip flips even if list is slow.
        markModelDownloaded(modelId);
        try {
          const list = await invokeListModels();
          // Session still current means user did not cancel/re-start mid-refresh.
          if (isCurrentSession()) {
            applyModels(list);
          }
        } catch (err: unknown) {
          console.error("failed to refresh models", err);
          // Download already finished; model is optimistically ready — soft notice.
          showAppErrorNotice(err, {
            severity: "warning",
            copy: formatModelsUnavailableNotice(),
            code: "list_models_refresh",
          });
        }
      } catch (err: unknown) {
        if (isCancelledError(err)) {
          if (isCurrentSession() && !cancellingRef.current) {
            setDownloading(null);
          }
          return;
        }
        console.error("download failed", err);
        if (isCurrentSession() && !cancellingRef.current) {
          const parsed = parseAppError(err);
          setDownloadError({
            model: downloading,
            code: parsed.code,
            message: parsed.message,
          });
          setDownloading(null);
        }
      }
    })();

    return () => {
      cleanedUp = true;
      unsubscribe?.();
    };
  }, [downloading, setMode, applyModels, markModelDownloaded]);

  const beginDownload = (model: ModelMeta) => {
    downloadSessionRef.current += 1;
    cancellingRef.current = false;
    setCancelling(false);
    setDownloadProgress(0);
    setDownloadStage("download");
    setDownloadError(null);
    setDownloading(model);
  };

  const startDownload = (model: ModelMeta) => {
    if (downloading || isModelReady(model)) return;
    if (needsNcLicenseAck(model)) {
      setNcAckModel(model);
      return;
    }
    beginDownload(model);
  };

  const handleNcAckAccept = () => {
    if (!ncAckModel) return;
    setNcLicenseAck();
    const model = ncAckModel;
    setNcAckModel(null);
    beginDownload(model);
  };

  const handleNcAckCancel = () => {
    setNcAckModel(null);
  };

  const handleDownloadRetry = () => {
    if (!downloadError || downloading) return;
    beginDownload(downloadError.model);
  };

  const handleDownloadErrorDismiss = () => {
    setDownloadError(null);
  };

  const handleCancel = () => {
    if (cancellingRef.current) return;
    cancellingRef.current = true;
    setCancelling(true);
    // Capture session so a newer beginDownload does not get cleared / reconciled
    // by this cancel's finally (list_models can outlive a re-start).
    const session = downloadSessionRef.current;
    void (async () => {
      let cancelFailed = false;
      try {
        await invokeCancelDownload();
      } catch (err: unknown) {
        cancelFailed = true;
        console.error("failed to cancel download", err);
      } finally {
        if (downloadSessionRef.current === session) {
          cancellingRef.current = false;
          setCancelling(false);
          setDownloading(null);
          if (cancelFailed) {
            // UI already cleared; warn that the transfer may still complete.
            showAppNotice(
              formatDownloadCancelUnconfirmedNotice(),
              "warning",
              "download_cancel_unconfirmed",
            );
          }
          try {
            const list = await invokeListModels();
            if (downloadSessionRef.current === session) {
              applyModels(list);
            }
          } catch (listErr: unknown) {
            console.error("failed to refresh models", listErr);
            showAppErrorNotice(listErr, {
              severity: "warning",
              copy: formatModelsUnavailableNotice(),
              code: "list_models_refresh",
            });
          }
        }
      }
    })();
  };

  return {
    downloading,
    displayModel,
    downloadProgress,
    downloadStage,
    cancelling,
    ncAckModel,
    downloadError,
    downloadPresence,
    ncAckPresence,
    startDownload,
    handleNcAckAccept,
    handleNcAckCancel,
    handleDownloadRetry,
    handleDownloadErrorDismiss,
    handleCancel,
    // Expose for select-when-ready path without starting a download.
    isBusy: Boolean(downloading),
  };
}
