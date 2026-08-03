/** Minimal mock of @tauri-apps/plugin-notification for Playwright e2e. */

export async function isPermissionGranted(): Promise<boolean> {
  return false;
}

export async function requestPermission(): Promise<NotificationPermission> {
  return "denied";
}

export function sendNotification(_options: {
  title: string;
  body?: string;
  silent?: boolean;
}): void {}
