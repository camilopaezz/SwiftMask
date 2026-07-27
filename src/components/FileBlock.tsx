import { clearCurrent, isProcessBusy } from "../lib/currentImage";
import { openImageFile } from "../lib/openImage";
import { useImageStore } from "../stores/imageStore";
import { useSettingsStore } from "../stores/settingsStore";

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function FileBlock() {
  const current = useImageStore((state) => state.current);
  const mode = useSettingsStore((state) => state.mode);
  const outputDir = useSettingsStore((state) => state.outputDir);
  // Prefer domain busy gate for actions; UI disable covers processing status.
  // processGate during overwrite is enforced inside acceptDrop/clearCurrent.
  const busy = current?.status === "processing" || isProcessBusy();

  const handleSelect = async () => {
    await openImageFile({ mode, outputDir });
  };

  const handleRemove = () => {
    clearCurrent();
  };

  if (!current) {
    return (
      <div className="file-block">
        <div className="file-block-empty">No image</div>
        <div className="file-block-actions">
          <button
            type="button"
            className="btn-primary"
            title="Select image (Ctrl+O)"
            onClick={() => void handleSelect()}
          >
            Select image
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="file-block">
      <div className="file-block-name" title={current.inputPath}>
        {fileName(current.inputPath)}
      </div>
      <div className="file-block-actions">
        <button
          type="button"
          title="Change image (Ctrl+O)"
          onClick={() => void handleSelect()}
          disabled={busy}
        >
          Change
        </button>
        <button
          type="button"
          className="btn-danger"
          onClick={handleRemove}
          disabled={busy}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
