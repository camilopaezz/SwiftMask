import { getNcLicenseModalCopy } from "../lib/ncLicense";
import { ExternalLinkButton } from "./ExternalLinkButton";

export type NcLicenseModalProps = {
  open: boolean;
  onAccept: () => void;
  onCancel: () => void;
};

export function NcLicenseModal({
  open,
  onAccept,
  onCancel,
}: NcLicenseModalProps) {
  const copy = getNcLicenseModalCopy();
  return (
    <div className={`nc-license-modal-backdrop${open ? " is-open" : ""}`}>
      <div
        className={`nc-license-modal-card${open ? " is-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="nc-license-modal-title"
      >
        <h3 id="nc-license-modal-title">{copy.title}</h3>
        <p className="nc-license-modal-summary">{copy.summary}</p>
        <p className="nc-license-modal-hint">{copy.commercialHint}</p>
        <p className="nc-license-modal-license">
          <ExternalLinkButton url={copy.licenseUrl}>
            {copy.licenseLabel}
          </ExternalLinkButton>
        </p>
        <div className="nc-license-modal-actions">
          <button type="button" onClick={onCancel}>
            {copy.cancelLabel}
          </button>
          <button type="button" className="btn-primary" onClick={onAccept}>
            {copy.acceptLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
