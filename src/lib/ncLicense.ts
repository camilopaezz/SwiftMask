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

export function clearNcLicenseAck(): void {
  try {
    localStorage.removeItem(NC_LICENSE_ACK_KEY);
  } catch {
    // Ignore unavailable storage.
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

export const NC_LICENSE_MODAL_COPY = {
  title: "Non-commercial license",
  summary:
    "Balanced+ and Max Quality use models under CC BY-NC 4.0. You may use outputs for personal or non-commercial work only — not for paid work, client deliverables, product photography, or other commercial purposes.",
  commercialHint:
    "For commercial use, choose Turbo or Balanced, or obtain a separate license from the model rights holder (BRIA).",
  licenseLabel: NC_LICENSE_LABEL,
  licenseUrl: licenseUrlFor(NC_LICENSE_LABEL) ?? "",
  acceptLabel: "I understand",
  cancelLabel: "Cancel",
} as const;
