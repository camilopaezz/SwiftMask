import { openUrl } from "@tauri-apps/plugin-opener";
import { showAppNotice } from "./showAppErrorNotice";

/**
 * Open a URL in the system browser. Logs failures and shows a user notice.
 */
export async function openExternalUrl(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (err) {
    console.error("openExternalUrl failed", url, err);
    showAppNotice(
      {
        title: "Couldn’t open link",
        body: "Open it manually in your browser, or check system permissions.",
      },
      "warning",
      "open_url",
    );
  }
}
