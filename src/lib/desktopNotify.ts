import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export type DesktopNotifyPayload = {
  title: string;
  body?: string;
};

export type DesktopNotifyDeps = {
  isPermissionGranted: () => Promise<boolean>;
  requestPermission: () => Promise<NotificationPermission>;
  /**
   * Deliver the OS notification. Default implementation uses the Web
   * Notification API (same as the Tauri plugin) so we can attach onclick
   * and raise the main window.
   */
  sendNotification: (
    options: { title: string; body?: string },
    focusMainWindow: () => Promise<void>,
  ) => void;
  isBackground: () => Promise<boolean>;
  focusMainWindow: () => Promise<void>;
};

async function defaultIsBackground(): Promise<boolean> {
  const win = getCurrentWindow();
  const [focused, minimized] = await Promise.all([
    win.isFocused(),
    win.isMinimized(),
  ]);
  return !focused || minimized;
}

async function defaultFocusMainWindow(): Promise<void> {
  const win = getCurrentWindow();
  try {
    await win.unminimize();
  } catch {
    // Already visible or platform rejected unminimize — still try focus.
  }
  await win.setFocus();
}

function defaultSendNotification(
  options: { title: string; body?: string },
  focusMainWindow: () => Promise<void>,
): void {
  // Prefer Web Notification so we can attach click → focus. The Tauri plugin's
  // sendNotification is the same API without a click hook on desktop.
  try {
    if (typeof window !== "undefined" && "Notification" in window) {
      const n = new window.Notification(options.title, {
        body: options.body,
        silent: true,
      });
      n.onclick = () => {
        n.close();
        void focusMainWindow().catch((err) => {
          console.error("desktop notification focus failed", err);
        });
      };
      return;
    }
  } catch (err) {
    console.error("desktop notification construct failed", err);
  }
  // Fallback: plugin path (no click handler).
  sendNotification({
    title: options.title,
    body: options.body,
    silent: true,
  });
}

const prodDeps: DesktopNotifyDeps = {
  isPermissionGranted,
  requestPermission,
  sendNotification: defaultSendNotification,
  isBackground: defaultIsBackground,
  focusMainWindow: defaultFocusMainWindow,
};

/**
 * OS desktop notification for queue terminal events when the main window is
 * unfocused or minimized. Silent on permission deny / plugin errors.
 * Always safe to call; never throws to the caller.
 */
export async function maybeDesktopNotifyQueueFinished(
  payload: DesktopNotifyPayload,
  options: {
    /** Total items that finished as done or failed (not cancel-only). */
    terminalCount: number;
    deps?: DesktopNotifyDeps;
  },
): Promise<void> {
  const deps = options.deps ?? prodDeps;
  if (options.terminalCount <= 0) return;

  try {
    if (!(await deps.isBackground())) return;

    let granted = await deps.isPermissionGranted();
    if (!granted) {
      // Only request when still undetermined. If the OS already denied,
      // requestPermission typically returns "denied" without a second prompt,
      // but we still treat non-granted as a silent skip.
      const permission = await deps.requestPermission();
      granted = permission === "granted";
    }
    if (!granted) return;

    deps.sendNotification(
      {
        title: payload.title,
        body: payload.body,
      },
      deps.focusMainWindow,
    );
  } catch (err) {
    console.error("desktop notification failed", err);
  }
}
