import i18n from "../i18n";
import { epLabel } from "./epLabel";
import { ERROR_CODES } from "./parseAppError";

export type ErrorCopy = {
  title: string;
  body?: string;
};

/** FE-owned primary copy for stable error codes (wire `message` stays technical). */
function catalogErrorCopy(code: string): ErrorCopy | undefined {
  const titleKey = `errors.${code}.title`;
  if (!i18n.exists(titleKey)) return undefined;
  const copy: ErrorCopy = { title: i18n.t(titleKey) };
  const bodyKey = `errors.${code}.body`;
  if (i18n.exists(bodyKey)) {
    copy.body = i18n.t(bodyKey);
  }
  return copy;
}

/** Strip internal Display prefixes and collapse whitespace for unmapped fallbacks. */
export function sanitizeTechnicalMessage(message: string): string {
  let s = message.trim();
  s = s.replace(
    /^(inference|model|gpu detection|pipeline|image io|dialog|config|io|serde) error:\s*/i,
    "",
  );
  s = s.replace(/\s+/g, " ");
  if (s.length > 160) {
    s = `${s.slice(0, 157)}…`;
  }
  return s;
}

/**
 * Primary UI copy for a catalog code. Unmapped codes use a sanitized technical
 * message so the user still sees something useful.
 */
export function formatError(code: string, message: string): ErrorCopy {
  if (code === ERROR_CODES.cancelled) {
    return { title: i18n.t("errors.cancelled.title") };
  }
  const entry = catalogErrorCopy(code);
  if (entry) {
    // Catalog `unknown` keeps the generic title but surfaces sanitized detail.
    if (code === ERROR_CODES.unknown) {
      const sanitized = sanitizeTechnicalMessage(message);
      return {
        title: entry.title,
        body: sanitized && sanitized !== entry.title ? sanitized : entry.body,
      };
    }
    return { title: entry.title, body: entry.body };
  }
  const sanitized = sanitizeTechnicalMessage(message);
  return {
    title: sanitized || i18n.t("errors.unknown.title"),
  };
}

/** Sticky notice when GPU OOM fell back to CPU and the job still completed. */
export function formatFallbackNotice(fromEp: string, toEp: string): ErrorCopy {
  const from = epLabel(fromEp);
  const to = epLabel(toEp);
  return {
    title: i18n.t("errors.fallback.title"),
    body: i18n.t("errors.fallback.body", { from, to }),
  };
}

/** First-run GPU/benchmark soft-degrade (app continues on CPU). */
export function formatFirstRunGpuDegradeNotice(): ErrorCopy {
  return {
    title: i18n.t("errors.firstRunGpu.title"),
    body: i18n.t("errors.firstRunGpu.body"),
  };
}

/** First-run / catalog list_models soft-degrade (Process stays blocked). */
export function formatModelsUnavailableNotice(): ErrorCopy {
  return {
    title: i18n.t("errors.modelsUnavailable.title"),
    body: i18n.t("errors.modelsUnavailable.body"),
  };
}

/** Cancel download invoke failed after UI already cleared the transfer. */
export function formatDownloadCancelUnconfirmedNotice(): ErrorCopy {
  return {
    title: i18n.t("errors.downloadCancelUnconfirmed.title"),
    body: i18n.t("errors.downloadCancelUnconfirmed.body"),
  };
}

/** Reveal-in-folder failed (opener plugin). */
export function formatRevealFailedNotice(): ErrorCopy {
  return {
    title: i18n.t("errors.revealFailed.title"),
    body: i18n.t("errors.revealFailed.body"),
  };
}

/** Signed updater: a newer stable build is available (startup / Settings). */
export function formatUpdateAvailableNotice(version: string): ErrorCopy {
  return {
    title: i18n.t("errors.updateAvailable.title", { version }),
    body: i18n.t("errors.updateAvailable.body"),
  };
}

/** Signed updater: check found no newer release. */
export function formatUpToDateCopy(): ErrorCopy {
  return {
    title: i18n.t("errors.upToDate.title"),
    body: i18n.t("errors.upToDate.body"),
  };
}

/** Signed updater: manual check failed (surface to user). */
export function formatUpdateCheckFailedCopy(detail?: string): ErrorCopy {
  return {
    title: i18n.t("errors.updateCheckFailed.title"),
    body: detail || i18n.t("errors.updateCheckFailed.body"),
  };
}

/** Signed updater: download/install failed. */
export function formatUpdateInstallFailedCopy(detail?: string): ErrorCopy {
  return {
    title: i18n.t("errors.updateInstallFailed.title"),
    body: detail || i18n.t("errors.updateInstallFailed.body"),
  };
}
