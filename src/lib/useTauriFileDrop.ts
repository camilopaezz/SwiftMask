import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";

type DragDropPayload = {
  paths: string[];
};

export type TauriFileDropState = {
  isDragging: boolean;
  paths: string[] | null;
};

export function useTauriFileDrop(): TauriFileDropState {
  const [isDragging, setIsDragging] = useState(false);
  const [paths, setPaths] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unsubs: (() => void)[] = [];

    const setup = async () => {
      try {
        const dragOverUnsub = await listen("tauri://drag-over", () => {
          if (!cancelled) setIsDragging(true);
        });
        if (cancelled) {
          dragOverUnsub();
          return;
        }
        unsubs.push(dragOverUnsub);
        const dragLeaveUnsub = await listen("tauri://drag-leave", () => {
          if (!cancelled) setIsDragging(false);
        });
        if (cancelled) {
          dragLeaveUnsub();
          return;
        }
        unsubs.push(dragLeaveUnsub);
        const dragDropUnsub = await listen<DragDropPayload>(
          "tauri://drag-drop",
          (event) => {
            if (cancelled) return;
            setIsDragging(false);
            setPaths(event.payload.paths);
          },
        );
        if (cancelled) {
          dragDropUnsub();
          return;
        }
        unsubs.push(dragDropUnsub);
      } catch (err) {
        console.error("file drop listeners failed", err);
        for (const u of unsubs) u();
        unsubs.length = 0;
      }
    };

    void setup();

    // DEV / e2e: allow programmatic drop injection (Playwright + computer-use).
    if (import.meta.env.DEV || import.meta.env.VITE_E2E === "1") {
      window.__swiftmaskInjectDrop = (paths: string[]) => {
        setPaths(paths);
      };
    }

    return () => {
      cancelled = true;
      for (const unsub of unsubs) {
        unsub();
      }
    };
  }, []);

  return { isDragging, paths };
}
