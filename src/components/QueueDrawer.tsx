import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import alertIcon from "../assets/icons/queue/alert.svg?raw";
import checkIcon from "../assets/icons/queue/check.svg?raw";
import externalLinkIcon from "../assets/icons/queue/external-link.svg?raw";
import rotateCcwIcon from "../assets/icons/queue/rotate-ccw.svg?raw";
import xIcon from "../assets/icons/queue/x.svg?raw";
import { formatRevealFailedNotice } from "../lib/errorCopy";
import { clearQueue, removeQueueItem, selectQueueItem } from "../lib/queue";
import { showAppErrorNotice } from "../lib/showAppErrorNotice";
import {
  fileNameFromPath,
  type QueueItem,
  queueStore,
  useQueueStore,
} from "../stores/queueStore";
import { InlineSvg } from "./InlineSvg";

async function revealPath(path: string) {
  try {
    await revealItemInDir(path);
  } catch (err) {
    console.error("reveal in folder failed", err);
    showAppErrorNotice(err, {
      copy: formatRevealFailedNotice(),
      code: "reveal_failed",
    });
  }
}

function StatusMark({ item }: { item: QueueItem }) {
  if (item.status === "done") {
    return (
      <InlineSvg svg={checkIcon} className="queue-status-icon" aria-hidden />
    );
  }
  if (item.status === "failed") {
    return (
      <InlineSvg svg={alertIcon} className="queue-status-icon" aria-hidden />
    );
  }
  if (item.status === "processing") {
    return <span className="queue-status-dot" aria-hidden />;
  }
  // pending / queued — leave the slot empty for alignment
  return null;
}

function rowTitle(item: QueueItem): string {
  if (item.status === "failed" && item.error?.message) {
    return `${item.inputPath} — ${item.error.message}`;
  }
  return item.inputPath;
}

export function QueueDrawer() {
  const items = useQueueStore((s) => s.items);
  const selectedId = useQueueStore((s) => s.selectedId);
  const pinnedId = useQueueStore((s) => s.pinnedId);
  const drawerOpen = useQueueStore((s) => s.drawerOpen);
  const running = useQueueStore((s) => s.running);
  const source = useQueueStore((s) => s.source);
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
  const done = items.filter((i) => i.status === "done").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const processing = items.find((i) => i.status === "processing");
  const previewId = pinnedId ?? selectedId ?? processing?.id ?? items[0]?.id;
  const preview = items.find((i) => i.id === previewId);
  const summaryName = preview
    ? fileNameFromPath(preview.inputPath)
    : "No selection";

  const pill =
    failed > 0
      ? `${done}/${total} · ${failed} failed`
      : running
        ? `${done}/${total} · running`
        : `${done}/${total} · pending`;

  const closeMenu = () => setMenuOpen(false);

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
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              queueStore.getState().clearByStatus("done");
            }}
          >
            Clear completed
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              queueStore.getState().clearByStatus("failed");
            }}
          >
            Clear failed
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={running}
            onClick={() => {
              closeMenu();
              queueStore.getState().clearByStatus("pending");
            }}
          >
            Clear pending
          </button>
          {failed > 0 && (
            <button
              type="button"
              role="menuitem"
              disabled={running}
              onClick={() => {
                closeMenu();
                queueStore.getState().retryAllFailed();
              }}
            >
              Retry failed
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              void clearQueue();
            }}
          >
            Clear all…
          </button>
          {source?.kind === "folder" && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu();
                void revealPath(source.outputDir);
              }}
            >
              Open outputs
            </button>
          )}
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
              <span
                className={`queue-drawer-pill${failed > 0 ? " is-error" : ""}${running ? " is-live" : ""}`}
              >
                {pill}
              </span>
            </span>
            <span className="queue-drawer-sub">
              {processing
                ? `${fileNameFromPath(processing.inputPath)} · ${processing.progress}%`
                : summaryName}
            </span>
          </span>
        </button>
        {overflowMenu}
      </div>

      {/* Always mounted so open/close can animate (grid 0fr → 1fr). */}
      <div
        className="queue-drawer-panel"
        aria-hidden={!drawerOpen}
        inert={!drawerOpen ? true : undefined}
      >
        <div className="queue-drawer-body">
          <div className="queue-list-header">
            <span className="queue-list-count">
              {total} image{total === 1 ? "" : "s"}
              {failed > 0 ? ` · ${failed} failed` : ""}
            </span>
          </div>
          <ul className="queue-list" aria-label="Queue items">
            {items.map((item) => {
              const selectedRow = item.id === selectedId;
              return (
                <li key={item.id}>
                  <div
                    className={`queue-row${selectedRow ? " is-selected" : ""}${item.status === "failed" ? " is-failed" : ""}`}
                  >
                    <button
                      type="button"
                      className="queue-row-main"
                      onClick={() => selectQueueItem(item.id)}
                      title={rowTitle(item)}
                      tabIndex={drawerOpen ? 0 : -1}
                    >
                      <span
                        className={`queue-status ${item.status}`}
                        aria-hidden
                      >
                        <StatusMark item={item} />
                      </span>
                      <span className="queue-name">
                        {fileNameFromPath(item.inputPath)}
                      </span>
                    </button>
                    {item.status === "failed" && (
                      <button
                        type="button"
                        className="queue-row-retry btn-ghost"
                        title="Retry"
                        aria-label={`Retry ${fileNameFromPath(item.inputPath)}`}
                        disabled={running}
                        tabIndex={drawerOpen ? 0 : -1}
                        onClick={() =>
                          queueStore.getState().resetToPending(item.id)
                        }
                      >
                        <InlineSvg
                          svg={rotateCcwIcon}
                          className="queue-row-icon"
                          aria-hidden
                        />
                      </button>
                    )}
                    {item.status === "done" && item.outputPath && (
                      <button
                        type="button"
                        className="queue-row-reveal btn-ghost"
                        title="Show in folder"
                        aria-label={`Show ${fileNameFromPath(item.outputPath)} in folder`}
                        tabIndex={drawerOpen ? 0 : -1}
                        onClick={() => {
                          void revealPath(item.outputPath);
                        }}
                      >
                        <InlineSvg
                          svg={externalLinkIcon}
                          className="queue-row-icon"
                          aria-hidden
                        />
                      </button>
                    )}
                    {item.status !== "processing" && (
                      <button
                        type="button"
                        className="queue-row-remove btn-ghost"
                        title="Remove from queue"
                        aria-label={`Remove ${fileNameFromPath(item.inputPath)}`}
                        tabIndex={drawerOpen ? 0 : -1}
                        onClick={() => removeQueueItem(item.id)}
                      >
                        <InlineSvg
                          svg={xIcon}
                          className="queue-row-icon"
                          aria-hidden
                        />
                      </button>
                    )}
                  </div>
                  {item.status === "processing" && (
                    <div className="queue-progress" aria-hidden>
                      <i style={{ width: `${item.progress}%` }} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
