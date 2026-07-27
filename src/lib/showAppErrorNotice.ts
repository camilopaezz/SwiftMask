import { type NoticeSeverity, uiStore } from "../stores/uiStore";
import { type ErrorCopy, formatError } from "./errorCopy";
import { parseAppError } from "./parseAppError";

export type ShowNoticeOptions = {
  severity?: NoticeSeverity;
  /** Override mapped copy (e.g. first-run soft-degrade wording). */
  copy?: ErrorCopy;
  code?: string;
};

/**
 * Parse any failure, map to FE copy, push the single shared notice slot.
 * Call from catch sites that use the out-of-flow notice (not process footer /
 * download local panel).
 */
export function showAppErrorNotice(
  err: unknown,
  options: ShowNoticeOptions = {},
): void {
  const parsed = parseAppError(err);
  const copy = options.copy ?? formatError(parsed.code, parsed.message);
  uiStore.getState().showNotice({
    severity: options.severity ?? "error",
    title: copy.title,
    body: copy.body,
    code: options.code ?? parsed.code,
  });
}

/** Push a non-error / soft-degrade notice without an underlying throw. */
export function showAppNotice(
  copy: ErrorCopy,
  severity: NoticeSeverity = "warning",
  code?: string,
): void {
  uiStore.getState().showNotice({
    severity,
    title: copy.title,
    body: copy.body,
    code,
  });
}
