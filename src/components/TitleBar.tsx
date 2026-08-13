import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import copyIcon from "../assets/icons/titlebar/copy.svg?raw";
import minusIcon from "../assets/icons/titlebar/minus.svg?raw";
// Vendored Lucide SVGs (ISC) — see src/assets/icons/titlebar/README.md
import settingsIcon from "../assets/icons/titlebar/settings.svg?raw";
import squareIcon from "../assets/icons/titlebar/square.svg?raw";
import xIcon from "../assets/icons/titlebar/x.svg?raw";
import { epLabel } from "../lib/epLabel";
import {
  onWindowDragDoubleClick,
  onWindowDragMouseDown,
  withWindow,
} from "../lib/windowControls";
import { InlineSvg } from "./InlineSvg";

export type TitleBarProps = {
  ep: string | null;
  onOpenSettings: () => void;
  settingsButtonRef?: Ref<HTMLButtonElement>;
};

export function TitleBar({
  ep,
  onOpenSettings,
  settingsButtonRef,
}: TitleBarProps) {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);

  const refreshMaximized = useCallback(async () => {
    try {
      setMaximized(await getCurrentWindow().isMaximized());
    } catch {
      // Browser / e2e without window plugin.
    }
  }, []);

  useEffect(() => {
    void refreshMaximized();
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onResized(() => {
        void refreshMaximized();
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, [refreshMaximized]);

  return (
    <header
      className="titlebar"
      onMouseDown={onWindowDragMouseDown}
      onDoubleClick={(e) => onWindowDragDoubleClick(e, setMaximized)}
    >
      <div className="titlebar-left" data-tauri-drag-region>
        <span
          className="ep-chip"
          title={ep ?? undefined}
          data-tauri-drag-region
        >
          {epLabel(ep)}
        </span>
      </div>

      <div className="titlebar-drag" data-tauri-drag-region aria-hidden />

      <div className="titlebar-right">
        <button
          ref={settingsButtonRef}
          type="button"
          className="btn-icon"
          aria-label={t("titleBar.settings")}
          title={t("titleBar.settings")}
          onClick={onOpenSettings}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <InlineSvg
            svg={settingsIcon}
            className="titlebar-icon-wrap"
            aria-hidden
          />
        </button>
        <WindowButton
          label={t("titleBar.minimize")}
          onClick={() => void withWindow((win) => win.minimize())}
        >
          <InlineSvg
            svg={minusIcon}
            className="titlebar-icon-wrap"
            aria-hidden
          />
        </WindowButton>
        <WindowButton
          label={maximized ? t("titleBar.restore") : t("titleBar.maximize")}
          onClick={() =>
            void withWindow(async (win) => {
              await win.toggleMaximize();
              setMaximized(await win.isMaximized());
            })
          }
        >
          <InlineSvg
            svg={maximized ? copyIcon : squareIcon}
            className="titlebar-icon-wrap"
            aria-hidden
          />
        </WindowButton>
        <WindowButton
          label={t("titleBar.close")}
          className="titlebar-close"
          onClick={() => void withWindow((win) => win.close())}
        >
          <InlineSvg svg={xIcon} className="titlebar-icon-wrap" aria-hidden />
        </WindowButton>
      </div>
    </header>
  );
}

function WindowButton({
  label,
  onClick,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`btn-icon titlebar-winbtn${className ? ` ${className}` : ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </button>
  );
}
