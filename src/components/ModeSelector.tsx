import { useTranslation } from "react-i18next";
import { formatError } from "../lib/errorCopy";
import {
  isModelReady,
  isUserFacingModel,
  type ModelMeta,
  type ModelMode,
} from "../lib/models";
import { isNonCommercialModel } from "../lib/ncLicense";
import { isQueueRunActive } from "../lib/queueRunner";
import { useModelDownload } from "../lib/useModelDownload";
import { useQueueStore } from "../stores/queueStore";
import { useSettingsStore } from "../stores/settingsStore";
import { DownloadModal } from "./DownloadModal";
import { NcLicenseModal } from "./NcLicenseModal";

/** Compact labels for the segmented control (mock hybrid D). Turbo is hidden. */
const MODE_SEG_LABEL: Partial<Record<ModelMode, string>> = {
  "isnet-general-use": "Balanced",
  "rmbg-1.4": "Bal+",
  "birefnet-general-lite": "High",
  "rmbg-2.0": "Max",
};

export function ModeSelector() {
  const { t } = useTranslation();
  const mode = useSettingsStore((state) => state.mode);
  const setMode = useSettingsStore((state) => state.setMode);
  // Catalog is loaded once in App bootstrap and refreshed after download/cancel.
  const models = useSettingsStore((state) => state.models);
  const download = useModelDownload();
  const queueRunning = useQueueStore((s) => s.running);
  const modeLocked = queueRunning || isQueueRunActive();

  // Turbo stays in the backend registry for EP benchmark only.
  const visibleModels = models.filter(isUserFacingModel);
  const selected =
    visibleModels.find((m) => m.id === mode) ?? visibleModels[0] ?? null;
  const selectedReady = selected ? isModelReady(selected) : false;
  const selectedLicense = selected
    ? isNonCommercialModel(selected)
      ? { text: t("modeSelector.nonCommercial"), nc: true }
      : { text: t("modeSelector.commercialOk"), nc: false }
    : null;

  const handleSelect = (model: ModelMeta) => {
    if (download.isBusy || modeLocked) return;
    if (isModelReady(model)) {
      setMode(model.id as ModelMode);
      return;
    }
    download.startDownload(model);
  };

  return (
    <div className="mode-selector">
      <h3 className="app-rail-section-title">{t("modeSelector.qualityMode")}</h3>

      <div
        className="mode-seg"
        role="radiogroup"
        aria-label={t("modeSelector.qualityMode")}
      >
        {visibleModels.map((model) => {
          const active = mode === model.id;
          const available = isModelReady(model);
          const short = MODE_SEG_LABEL[model.id as ModelMode] ?? model.name;
          return (
            <label
              key={model.id}
              className={`mode-seg-btn${active ? " is-active" : ""}${available ? "" : " is-undownloaded"}`}
              title={
                available
                  ? t("modeSelector.modeTitle", {
                      name: model.name,
                      id: model.id,
                      size: model.input_size,
                    })
                  : t("modeSelector.downloadRequired", { name: model.name })
              }
              data-mode={model.id}
            >
              <input
                type="radio"
                name="mode"
                value={model.id}
                checked={active}
                disabled={modeLocked || download.isBusy}
                aria-label={
                  available
                    ? model.name
                    : t("modeSelector.notDownloadedAria", { name: model.name })
                }
                onChange={() => handleSelect(model)}
              />
              <span aria-hidden>{short}</span>
            </label>
          );
        })}
      </div>

      {selected && (
        <div
          className={`mode-detail${modeLocked ? " is-locked" : ""}`}
          data-testid="mode-detail"
        >
          <strong className="mode-detail-name">{selected.name}</strong>
          <div className="mode-detail-row">
            <span>{t("modeSelector.model")}</span>
            <b className="mode-detail-model">{selected.id}</b>
          </div>
          <div className="mode-detail-row">
            <span>{t("modeSelector.license")}</span>
            <span
              className={
                selectedLicense?.nc
                  ? "mode-detail-license is-nc"
                  : "mode-detail-license"
              }
            >
              {selectedLicense?.text}
            </span>
          </div>
          {!selectedReady && (
            <button
              type="button"
              className="mode-detail-download"
              disabled={download.isBusy || modeLocked}
              onClick={() => download.startDownload(selected)}
            >
              {t("modeSelector.download")}
            </button>
          )}
        </div>
      )}

      {download.ncAckPresence.rendered && download.ncAckModel && (
        <NcLicenseModal
          open={download.ncAckPresence.open}
          onAccept={download.handleNcAckAccept}
          onCancel={download.handleNcAckCancel}
        />
      )}

      {download.downloadPresence.rendered && download.displayModel && (
        <DownloadModal
          open={download.downloadPresence.open}
          modelName={download.displayModel.name}
          progress={download.downloadProgress}
          stage={download.downloadStage}
          cancelling={download.cancelling}
          onCancel={download.handleCancel}
        />
      )}

      {download.downloadError && !download.downloading && (
        <div
          className="mode-download-error"
          role="alert"
          data-testid="download-error"
        >
          {(() => {
            const copy = formatError(
              download.downloadError.code,
              download.downloadError.message,
            );
            return (
              <>
                <div className="mode-download-error-title">
                  {copy.title}
                  {download.downloadError.model.name
                    ? ` — ${download.downloadError.model.name}`
                    : ""}
                </div>
                {copy.body ? (
                  <div className="mode-download-error-body">{copy.body}</div>
                ) : null}
              </>
            );
          })()}
          <div className="mode-download-error-actions">
            <button
              type="button"
              className="btn-primary"
              onClick={download.handleDownloadRetry}
            >
              {t("common.retry")}
            </button>
            <button type="button" onClick={download.handleDownloadErrorDismiss}>
              {t("common.dismiss")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
