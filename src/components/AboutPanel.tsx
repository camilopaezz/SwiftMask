import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
        <div className="about-app-name">{t("about.appName")}</div>
        <div className="about-versions">
          <div>{t("about.versionLine", { version: appVersion })}</div>
          <div>{t("about.ortLine", { version: ortVersion })}</div>
        </div>
      </div>

      <p className="about-mit">
        {t("about.mit")}{" "}
        <ExternalLinkButton url={APP_LINKS.mit}>
          {t("about.mitLicense")}
        </ExternalLinkButton>
        {t("about.mitRest")}
      </p>

      <div className="about-models-heading">{t("about.modelsHeading")}</div>
      <table className="about-models-table">
        <thead>
          <tr>
            <th scope="col">{t("about.colMode")}</th>
            <th scope="col">{t("about.colModel")}</th>
            <th scope="col">{t("about.colLicense")}</th>
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
          {t("about.ncFootnote", { modes: ncModeNames })}
        </p>
      )}

      <div className="about-links">
        <ExternalLinkButton url={APP_LINKS.repo}>
          {t("about.github")}
        </ExternalLinkButton>
        <span aria-hidden="true"> · </span>
        <ExternalLinkButton url={APP_LINKS.issues}>
          {t("about.issues")}
        </ExternalLinkButton>
      </div>
    </div>
  );
}
