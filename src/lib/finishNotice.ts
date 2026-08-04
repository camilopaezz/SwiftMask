import { uiStore } from "../stores/uiStore";
import { maybeDesktopNotifyQueueFinished } from "./desktopNotify";
import { formatFallbackNotice } from "./errorCopy";

/**
 * Terminal finish banner for queue batch and single-image Process.
 * Dual-surface: always AppNotice; OS toast when background + terminalCount > 0.
 */
export function showFinishNotice(
  succeeded: number,
  failed: number,
  fallback: { from_ep: string; to_ep: string } | null,
): void {
  // Prefer the GPU→CPU warning over a generic finish banner when any job fell back.
  let title: string;
  let body: string | undefined;
  if (fallback) {
    const copy = formatFallbackNotice(fallback.from_ep, fallback.to_ep);
    title = copy.title;
    body = `${copy.body} ${succeeded} succeeded, ${failed} failed.`;
    uiStore.getState().showNotice({
      severity: "warning",
      title,
      body,
      code: "inference_fallback",
    });
  } else {
    const severity = failed > 0 ? ("warning" as const) : ("info" as const);
    title = `Finished: ${succeeded} succeeded, ${failed} failed`;
    body = undefined;
    uiStore.getState().showNotice({
      severity,
      title,
      code: "queue_finished",
    });
  }

  void maybeDesktopNotifyQueueFinished(
    { title, body },
    { terminalCount: succeeded + failed },
  );
}
