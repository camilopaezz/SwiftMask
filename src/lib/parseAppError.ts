/** Stable product error codes (must match backend `error::code`). */
export const ERROR_CODES = {
  cancelled: "cancelled",
  busy: "busy",
  download_busy: "download_busy",
  network: "network",
  disk_full: "disk_full",
  model_corrupt: "model_corrupt",
  model_not_ready: "model_not_ready",
  model_unknown: "model_unknown",
  oom: "oom",
  gpu: "gpu",
  image_unreadable: "image_unreadable",
  output_failed: "output_failed",
  config: "config",
  dialog: "dialog",
  inference_failed: "inference_failed",
  unknown: "unknown",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES] | string;

export type AppErrorPayload = {
  code: ErrorCode;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fromCodeMessage(
  code: unknown,
  message: unknown,
): AppErrorPayload | null {
  if (typeof code !== "string" || code.length === 0) return null;
  const msg =
    typeof message === "string"
      ? message
      : message == null
        ? code
        : String(message);
  return { code, message: msg };
}

/**
 * Normalize invoke errors, event payloads, plugin throws, and junk into
 * `{ code, message }`. Single choke point for FE control flow and UI.
 */
export function parseAppError(err: unknown): AppErrorPayload {
  if (err == null) {
    return { code: ERROR_CODES.unknown, message: "unknown error" };
  }

  // Prefer Error before plain-object: `Error` is a record with `.message`.
  if (err instanceof Error) {
    const fromJson = tryParseJsonObject(err.message);
    if (fromJson) return fromJson;
    return classifyLegacyString(err.message);
  }

  if (typeof err === "string") {
    const fromJson = tryParseJsonObject(err);
    if (fromJson) return fromJson;
    return classifyLegacyString(err);
  }

  // Structured AppError / nested Tauri shapes.
  if (isRecord(err)) {
    const direct = fromCodeMessage(err.code, err.message);
    if (direct) return direct;

    for (const key of ["error", "data", "payload"] as const) {
      const nested = err[key];
      if (isRecord(nested)) {
        const parsed = fromCodeMessage(nested.code, nested.message);
        if (parsed) return parsed;
      }
    }

    // Message-only object (partial event / mock).
    if (typeof err.message === "string") {
      const fromJson = tryParseJsonObject(err.message);
      if (fromJson) return fromJson;
      return classifyLegacyString(err.message);
    }
  }

  return { code: ERROR_CODES.unknown, message: String(err) };
}

function tryParseJsonObject(text: string): AppErrorPayload | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!isRecord(value)) return null;
    return fromCodeMessage(value.code, value.message);
  } catch {
    return null;
  }
}

/** Best-effort for leftover plain strings (tests, plugins, old mocks). */
function classifyLegacyString(message: string): AppErrorPayload {
  const msg = message.trim();
  if (msg === "cancelled" || msg.endsWith(": cancelled")) {
    return { code: ERROR_CODES.cancelled, message: "cancelled" };
  }
  const lower = msg.toLowerCase();
  if (lower.includes("already processing")) {
    return { code: ERROR_CODES.busy, message: msg };
  }
  if (lower.includes("download already in progress")) {
    return { code: ERROR_CODES.download_busy, message: msg };
  }
  if (lower.includes("sha-256 mismatch")) {
    return { code: ERROR_CODES.model_corrupt, message: msg };
  }
  if (lower.includes("out of memory") || lower.includes("bad_alloc")) {
    return { code: ERROR_CODES.oom, message: msg };
  }
  return { code: ERROR_CODES.unknown, message: msg || "unknown error" };
}

export function isCancelledError(err: unknown): boolean {
  return parseAppError(err).code === ERROR_CODES.cancelled;
}
