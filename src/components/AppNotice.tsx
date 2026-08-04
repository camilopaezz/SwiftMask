import { useEffect, useRef } from "react";
import { type NoticeSeverity, useUiStore } from "../stores/uiStore";

const AUTO_DISMISS_MS: Record<NoticeSeverity, number | null> = {
  info: 5000,
  warning: 8000,
  error: null,
};

/**
 * Single-slot banner under the title bar. Newest notice replaces; dismiss via X.
 * Info/warning auto-dismiss (paused while hovered); errors stick until dismissed.
 */
export function AppNotice() {
  const notice = useUiStore((s) => s.notice);
  const dismissNotice = useUiStore((s) => s.dismissNotice);
  const hoveredRef = useRef(false);
  const remainingRef = useRef(0);
  const deadlineRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (!notice) {
      hoveredRef.current = false;
      return;
    }

    const duration = AUTO_DISMISS_MS[notice.severity];
    if (duration === null) return;

    // Full countdown for the new notice. If the pointer is still over the
    // banner (DOM node reused on replace → no mouseenter), keep paused.
    remainingRef.current = duration;
    deadlineRef.current = Date.now() + duration;

    if (hoveredRef.current) {
      return;
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      dismissNotice();
    }, remainingRef.current);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [notice, dismissNotice]);

  if (!notice) return null;

  const role = notice.severity === "error" ? "alert" : "status";
  const canAutoDismiss = AUTO_DISMISS_MS[notice.severity] !== null;

  const onMouseEnter = () => {
    if (!canAutoDismiss) return;
    hoveredRef.current = true;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      remainingRef.current = Math.max(0, deadlineRef.current - Date.now());
    }
  };

  const onMouseLeave = () => {
    if (!canAutoDismiss) return;
    hoveredRef.current = false;
    if (remainingRef.current <= 0) {
      dismissNotice();
      return;
    }
    deadlineRef.current = Date.now() + remainingRef.current;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      dismissNotice();
    }, remainingRef.current);
  };

  return (
    <div
      className={`app-notice is-${notice.severity}`}
      role={role}
      data-testid="app-notice"
      data-severity={notice.severity}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="app-notice-body">
        <div className="app-notice-title">{notice.title}</div>
        {notice.body ? (
          <div className="app-notice-text">{notice.body}</div>
        ) : null}
      </div>
      <button
        type="button"
        className="app-notice-dismiss"
        aria-label="Dismiss notice"
        onClick={() => dismissNotice()}
      >
        ✕
      </button>
    </div>
  );
}
