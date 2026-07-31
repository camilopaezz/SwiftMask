import { useEffect, useRef, useState } from "react";
import { clearQueue, removeQueueItem, selectQueueItem } from "../lib/queue";
import { fileNameFromPath, useQueueStore } from "../stores/queueStore";

export function QueueDrawer() {
  const items = useQueueStore((s) => s.items);
  const selectedId = useQueueStore((s) => s.selectedId);
  const drawerOpen = useQueueStore((s) => s.drawerOpen);
  const toggleDrawer = useQueueStore((s) => s.toggleDrawer);

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const total = items.length;
  const selected = items.find((i) => i.id === selectedId) ?? items[0];
  const summaryName = selected
    ? fileNameFromPath(selected.inputPath)
    : "No selection";

  const handleClearAll = () => {
    setMenuOpen(false);
    clearQueue();
  };

  const overflowMenu = (
    <div className="queue-overflow" ref={menuRef}>
      <button
        type="button"
        className="btn-icon queue-overflow-btn"
        aria-label="Queue actions"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
      >
        <span aria-hidden>⋯</span>
      </button>
      {menuOpen && (
        <div className="queue-menu" role="menu">
          <button type="button" role="menuitem" onClick={handleClearAll}>
            Clear all
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className={`queue-drawer${drawerOpen ? " is-open" : ""}`}>
      <div className="queue-drawer-bar">
        <button
          type="button"
          className="queue-drawer-toggle"
          aria-expanded={drawerOpen}
          title={drawerOpen ? "Collapse queue" : "Expand queue"}
          onClick={() => toggleDrawer()}
        >
          <span className="queue-drawer-chev" aria-hidden>
            ▾
          </span>
          <span className="queue-drawer-summary">
            <span className="queue-drawer-title-row">
              <span className="queue-drawer-title">Queue</span>
              <span className="queue-drawer-pill">0/{total} · pending</span>
            </span>
            <span className="queue-drawer-sub">{summaryName}</span>
          </span>
        </button>
        {!drawerOpen && overflowMenu}
      </div>

      {drawerOpen && (
        <div className="queue-drawer-body">
          <div className="queue-list-header">
            <span className="queue-list-count">
              {total} image{total === 1 ? "" : "s"}
            </span>
            {overflowMenu}
          </div>
          <ul className="queue-list" aria-label="Queue items">
            {items.map((item) => {
              const selectedRow = item.id === selectedId;
              return (
                <li key={item.id}>
                  <div
                    className={`queue-row${selectedRow ? " is-selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="queue-row-main"
                      onClick={() => selectQueueItem(item.id)}
                      title={item.inputPath}
                    >
                      <span className="queue-status pending" aria-hidden>
                        ○
                      </span>
                      <span className="queue-name">
                        {fileNameFromPath(item.inputPath)}
                      </span>
                      <span className="queue-meta">queued</span>
                    </button>
                    <button
                      type="button"
                      className="queue-row-remove btn-ghost"
                      title="Remove from queue"
                      aria-label={`Remove ${fileNameFromPath(item.inputPath)}`}
                      onClick={() => removeQueueItem(item.id)}
                    >
                      ×
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
