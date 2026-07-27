import { epLabel } from "./epLabel";
import { ERROR_CODES } from "./parseAppError";

export type ErrorCopy = {
  title: string;
  body?: string;
};

/** FE-owned primary copy for stable error codes (wire `message` stays technical). */
const ERROR_COPY: Record<string, ErrorCopy> = {
  [ERROR_CODES.busy]: {
    title: "Already processing",
    body: "Wait for the current job to finish or cancel it.",
  },
  [ERROR_CODES.download_busy]: {
    title: "Download already in progress",
    body: "Wait for the current download to finish or cancel it.",
  },
  [ERROR_CODES.network]: {
    title: "Network error",
    body: "Check your connection and try again.",
  },
  [ERROR_CODES.disk_full]: {
    title: "Not enough disk space",
    body: "Free some space and try again.",
  },
  [ERROR_CODES.model_corrupt]: {
    title: "Model file is damaged",
    body: "Delete it from the model list and download again.",
  },
  [ERROR_CODES.model_not_ready]: {
    title: "Model not downloaded",
    body: "Download this quality mode before processing.",
  },
  [ERROR_CODES.model_unknown]: {
    title: "Unknown model",
    body: "Pick a quality mode from the list.",
  },
  [ERROR_CODES.oom]: {
    title: "Out of memory",
    body: "Try a smaller image or switch to CPU in Settings.",
  },
  [ERROR_CODES.gpu]: {
    title: "GPU problem",
    body: "Check drivers or switch to CPU in Settings.",
  },
  [ERROR_CODES.image_unreadable]: {
    title: "Couldn’t read that image",
    body: "Try another file (PNG, JPG, WEBP, or BMP).",
  },
  [ERROR_CODES.output_failed]: {
    title: "Couldn’t save the result",
    body: "Check the output folder permissions.",
  },
  [ERROR_CODES.config]: {
    title: "Couldn’t update settings",
  },
  [ERROR_CODES.dialog]: {
    title: "Couldn’t open the file dialog",
  },
  [ERROR_CODES.inference_failed]: {
    title: "Processing failed",
    body: "Try again. If it keeps failing, switch quality mode or EP.",
  },
  [ERROR_CODES.unknown]: {
    title: "Something went wrong",
  },
  // cancelled intentionally omitted — no error chrome
};

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
    return { title: "Cancelled" };
  }
  const entry = ERROR_COPY[code];
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
    title: sanitized || ERROR_COPY[ERROR_CODES.unknown].title,
  };
}

/** Sticky notice when GPU OOM fell back to CPU and the job still completed. */
export function formatFallbackNotice(fromEp: string, toEp: string): ErrorCopy {
  const from = epLabel(fromEp);
  const to = epLabel(toEp);
  return {
    title: "Finished on CPU",
    body: `GPU ran out of memory (${from} → ${to}). Settings still use your GPU for next runs.`,
  };
}

/** First-run GPU/benchmark soft-degrade (app continues on CPU). */
export function formatFirstRunGpuDegradeNotice(): ErrorCopy {
  return {
    title: "Couldn't finish GPU setup",
    body: "Using CPU. You can re-run the benchmark in Settings.",
  };
}

/** First-run / catalog list_models soft-degrade (force bundled Turbo). */
export function formatModelsUnavailableNotice(): ErrorCopy {
  return {
    title: "Couldn't load model list",
    body: "Using Turbo (bundled). Try restarting the app.",
  };
}

/** Cancel download invoke failed after UI already cleared the transfer. */
export function formatDownloadCancelUnconfirmedNotice(): ErrorCopy {
  return {
    title: "Couldn't confirm cancel",
    body: "The download may still finish in the background.",
  };
}

/** Reveal-in-folder failed (opener plugin). */
export function formatRevealFailedNotice(): ErrorCopy {
  return {
    title: "Couldn't show file in folder",
    body: "Check that the output path still exists.",
  };
}

/** Signed updater: a newer stable build is available (startup / Settings). */
export function formatUpdateAvailableNotice(version: string): ErrorCopy {
  return {
    title: `Update ${version} available`,
    body: "Open Settings to install and restart.",
  };
}

/** Signed updater: check found no newer release. */
export function formatUpToDateCopy(): ErrorCopy {
  return {
    title: "You're up to date",
    body: "No newer stable release was found.",
  };
}

/** Signed updater: manual check failed (surface to user). */
export function formatUpdateCheckFailedCopy(detail?: string): ErrorCopy {
  return {
    title: "Couldn't check for updates",
    body: detail || "Check your connection and try again.",
  };
}

/** Signed updater: download/install failed. */
export function formatUpdateInstallFailedCopy(detail?: string): ErrorCopy {
  return {
    title: "Couldn't install the update",
    body:
      detail || "Try again, or download the installer from GitHub Releases.",
  };
}
