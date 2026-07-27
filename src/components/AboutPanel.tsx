import { useEffect, useMemo } from "react";
import { APP_LINKS, licenseUrlFor } from "../lib/licenseUrls";
import { MODEL_REGISTRY } from "../lib/models.generated";
import { isNonCommercialModel } from "../lib/ncLicense";
import { invokeGetRuntimeInfo } from "../lib/tauri";
import { useSettingsStore } from "../stores/settingsStore";
import { ExternalLinkButton } from "./ExternalLinkButton";

export type AboutPanelProps = {
  visible: boolean;
};

export function AboutPanel({ visible }: AboutPanelProps) {
  const runtimeInfo = useSettingsStore((s) => s.runtimeInfo);
  const setRuntimeInfo = useSettingsStore((s) => s.setRuntimeInfo);

  useEffect(() => {
    if (!visible || runtimeInfo) return;
    invokeGetRuntimeInfo()
      .then((info) => setRuntimeInfo(info))
      .catch((err: unknown) => {
        console.error("get_runtime_info failed", err);
      });
  }, [visible, runtimeInfo, setRuntimeInfo]);

  const appVersion = runtimeInfo?.app_version ?? "…";
  const ortVersion = runtimeInfo?.ort_version ?? "…";

  const ncModeNames = useMemo(
    () =>
      MODEL_REGISTRY.filter((m) => isNonCommercialModel(m))
        .map((m) => m.name)
        .join(" and "),
    [],
  );

  return (
    <div className="about-panel" aria-hidden={!visible} inert={!visible}>
      <div className="about-identity">
        <div className="about-app-name">SwiftMask</div>
        <div className="about-versions">
          <div>SwiftMask {appVersion}</div>
          <div>ONNX Runtime {ortVersion}</div>
        </div>
      </div>

      <p className="about-mit">
        SwiftMask is open source under the{" "}
        <ExternalLinkButton url={APP_LINKS.mit}>MIT License</ExternalLinkButton>
        . That covers the application itself. The ONNX models are third-party
        works with their own terms (see below).
      </p>

      <div className="about-models-heading">Models</div>
      <table className="about-models-table">
        <thead>
          <tr>
            <th scope="col">Mode</th>
            <th scope="col">Model</th>
            <th scope="col">License</th>
          </tr>
        </thead>
        <tbody>
          {MODEL_REGISTRY.map((model) => {
            const licenseUrl = licenseUrlFor(model.license);
            return (
              <tr key={model.id}>
                <td>{model.name}</td>
                <td>
                  <code>{model.id}</code>
                </td>
                <td>
                  {licenseUrl ? (
                    <ExternalLinkButton url={licenseUrl}>
                      {model.license}
                    </ExternalLinkButton>
                  ) : (
                    model.license
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {ncModeNames.length > 0 && (
        <p className="about-nc-footnote">
          {ncModeNames} are CC BY-NC 4.0 (non-commercial). Personal use is fine;
          commercial use requires a separate license from the model rights
          holder.
        </p>
      )}

      <div className="about-links">
        <ExternalLinkButton url={APP_LINKS.repo}>GitHub</ExternalLinkButton>
        <span aria-hidden="true"> · </span>
        <ExternalLinkButton url={APP_LINKS.issues}>Issues</ExternalLinkButton>
      </div>
    </div>
  );
}
