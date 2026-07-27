import { formatError } from "../lib/errorCopy";
import { isModelReady, type ModelMeta, type ModelMode } from "../lib/models";
import { shouldShowNcBadge } from "../lib/ncLicense";
import { useModelDownload } from "../lib/useModelDownload";
import { useSettingsStore } from "../stores/settingsStore";
import { DownloadModal } from "./DownloadModal";
import { NcLicenseModal } from "./NcLicenseModal";

export function ModeSelector() {
  const mode = useSettingsStore((state) => state.mode);
  const setMode = useSettingsStore((state) => state.setMode);
  // Catalog is loaded once in App bootstrap and refreshed after download/cancel.
  const models = useSettingsStore((state) => state.models);
  const download = useModelDownload();

  const handleSelect = (model: ModelMeta) => {
    if (download.isBusy) return;
    if (isModelReady(model)) {
      setMode(model.id as ModelMode);
      return;
    }
    download.startDownload(model);
  };

  return (
    <div className="mode-selector">
      <h3 className="app-rail-section-title">Quality mode</h3>
      {models.map((model) => {
        const available = isModelReady(model);
        return (
          <label
            key={model.id}
            className={`mode-option${mode === model.id ? " is-selected" : ""}`}
            title={`${model.name} (${model.id}) — ${model.input_size}px`}
          >
            <input
              type="radio"
              name="mode"
              value={model.id}
              checked={mode === model.id}
              onChange={() => handleSelect(model)}
            />
            <span className="mode-option-name">{model.name}</span>
            {available ? (
              <span className="mode-option-badges">
                {shouldShowNcBadge(model) ? (
                  <span className="mode-option-badge mode-option-nc">
                    Non-commercial
                  </span>
                ) : null}
                <span className="mode-option-badge mode-option-model">
                  {model.id}
                </span>
              </span>
            ) : (
              <button
                type="button"
                className="mode-option-badge mode-option-download"
                disabled={download.isBusy}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  download.startDownload(model);
                }}
              >
                Download
              </button>
            )}
          </label>
        );
      })}

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
              Retry
            </button>
            <button type="button" onClick={download.handleDownloadErrorDismiss}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
