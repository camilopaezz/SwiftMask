export type DownloadModalProps = {
  open: boolean;
  modelName: string;
  progress: number;
  stage: "download" | "verify";
  cancelling: boolean;
  onCancel: () => void;
};

export function DownloadModal({
  open,
  modelName,
  progress,
  stage,
  cancelling,
  onCancel,
}: DownloadModalProps) {
  const title = cancelling
    ? `Cancelling ${modelName}…`
    : stage === "verify"
      ? `Verifying ${modelName}`
      : `Downloading ${modelName}`;

  const status = cancelling
    ? "Cancelling…"
    : stage === "verify"
      ? "Verifying…"
      : `${Math.round(progress)}%`;

  return (
    <div className={`download-modal-backdrop${open ? " is-open" : ""}`}>
      <div className={`download-modal-card${open ? " is-open" : ""}`}>
        <h3>{title}</h3>
        <div className="progress-bar-track">
          <div
            className="progress-bar-fill"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="download-modal-pct">{status}</div>
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          aria-disabled={cancelling}
        >
          {cancelling ? "Cancelling…" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
