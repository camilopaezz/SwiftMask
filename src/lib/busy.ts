import { isProcessBusy } from "./currentImage";
import { isQueueRunActive } from "./queueRunner";

/** True while single-image or queue processing (including cancel/start handoff). */
export function isUiLocked(): boolean {
  return isProcessBusy() || isQueueRunActive();
}
