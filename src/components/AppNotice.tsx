import { useUiStore } from "../stores/uiStore";

/**
 * Single-slot banner under the title bar. Newest notice replaces; dismiss via X only.
 */
export function AppNotice() {
  const notice = useUiStore((s) => s.notice);
  const dismissNotice = useUiStore((s) => s.dismissNotice);

  if (!notice) return null;

  const role = notice.severity === "error" ? "alert" : "status";

  return (
    <div
      className={`app-notice is-${notice.severity}`}
      role={role}
      data-testid="app-notice"
      data-severity={notice.severity}
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
