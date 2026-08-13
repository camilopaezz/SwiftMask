import i18n from "../i18n";
import { licenseUrlFor } from "./licenseUrls";
import { isModelReady, type ModelMeta } from "./models";

export const NC_LICENSE_ACK_KEY = "swiftmask:nc-license-ack";

export function isNonCommercialModel(
  model: Pick<ModelMeta, "license">,
): boolean {
  return model.license.includes("NC");
}

export function hasNcLicenseAck(): boolean {
  try {
    return localStorage.getItem(NC_LICENSE_ACK_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNcLicenseAck(): void {
  try {
    localStorage.setItem(NC_LICENSE_ACK_KEY, "1");
  } catch {
    // Ignore quota / disabled storage — gate still applies this session.
  }
}

export function shouldShowNcBadge(
  model: Pick<ModelMeta, "license" | "bundled" | "downloaded">,
): boolean {
  return isNonCommercialModel(model) && isModelReady(model);
}

export function needsNcLicenseAck(
  model: Pick<ModelMeta, "license" | "bundled" | "downloaded">,
): boolean {
  return (
    isNonCommercialModel(model) && !isModelReady(model) && !hasNcLicenseAck()
  );
}

const NC_LICENSE_LABEL = "CC BY-NC 4.0";

export function getNcLicenseModalCopy() {
  return {
    title: i18n.t("ncLicense.title"),
    summary: i18n.t("ncLicense.summary"),
    commercialHint: i18n.t("ncLicense.commercialHint"),
    licenseLabel: i18n.t("ncLicense.licenseLabel"),
    licenseUrl: licenseUrlFor(NC_LICENSE_LABEL) ?? "",
    acceptLabel: i18n.t("ncLicense.accept"),
    cancelLabel: i18n.t("ncLicense.cancel"),
  };
}
