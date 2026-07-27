import type { ReactNode } from "react";
import { openExternalUrl } from "../lib/openExternalUrl";

export type ExternalLinkButtonProps = {
  url: string;
  children: ReactNode;
  className?: string;
};

/**
 * Opens an external URL in the system browser. Uses a button (not an anchor)
 * so the Tauri webview never navigates away on middle-click / context menu.
 */
export function ExternalLinkButton({
  url,
  children,
  className,
}: ExternalLinkButtonProps) {
  return (
    <button
      type="button"
      className={className ? `link-button ${className}` : "link-button"}
      onClick={() => {
        void openExternalUrl(url);
      }}
    >
      {children}
    </button>
  );
}
