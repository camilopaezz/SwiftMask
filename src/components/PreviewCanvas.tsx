import { convertFileSrc } from "@tauri-apps/api/core";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type PreviewCanvasProps = {
  inputPath: string | null;
  outputPath: string | null;
  /** When true, show comparison slider (typically status === "done"). */
  canCompare?: boolean;
  isDragging?: boolean;
};

/**
 * Serve local files via Tauri asset protocol (no scoped plugin-fs read).
 * Works for any user path once assetProtocol.scope allows it.
 */
function useLocalFileUrl(path: string | null): string | null {
  return useMemo(() => (path ? convertFileSrc(path) : null), [path]);
}

/** Natural width/height ratio once the image has loaded (null while pending). */
function useImageAspectRatio(url: string | null): number | null {
  const [ratio, setRatio] = useState<number | null>(null);

  useEffect(() => {
    if (!url) {
      setRatio(null);
      return;
    }

    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        setRatio(img.naturalWidth / img.naturalHeight);
      }
    };
    img.onerror = () => {
      if (!cancelled) setRatio(null);
    };
    img.src = url;

    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
      img.src = "";
    };
  }, [url]);

  return ratio;
}

type CompareSliderProps = {
  inputUrl: string;
  outputUrl: string;
  aspectRatio: number;
};

function CompareSlider({
  inputUrl,
  outputUrl,
  aspectRatio,
}: CompareSliderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(50);
  const draggingRef = useRef(false);
  const positionRef = useRef(50);

  const setPositionBoth = useCallback((pct: number) => {
    const next = Math.max(0, Math.min(100, pct));
    positionRef.current = next;
    setPosition(next);
  }, []);

  const updateFromClientX = useCallback(
    (clientX: number) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      setPositionBoth(((clientX - rect.left) / rect.width) * 100);
    },
    [setPositionBoth],
  );

  useEffect(() => {
    const endDrag = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.classList.remove("is-slider-dragging");
    };
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      e.preventDefault();
      updateFromClientX(e.clientX);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      document.body.classList.remove("is-slider-dragging");
    };
  }, [updateFromClientX]);

  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    document.body.classList.add("is-slider-dragging");
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Some environments reject capture; window listeners still work.
    }
    updateFromClientX(e.clientX);
  };

  const beforeClip = `inset(0 ${100 - position}% 0 0)`;

  return (
    <div
      ref={containerRef}
      className="compare-slider"
      style={{ ["--img-ar" as string]: String(aspectRatio) }}
      onPointerDown={onPointerDown}
      role="slider"
      aria-label="Before and after comparison"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(position)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setPositionBoth(positionRef.current - 2);
        if (e.key === "ArrowRight") setPositionBoth(positionRef.current + 2);
      }}
    >
      <img
        className="compare-img compare-img-after"
        src={outputUrl}
        alt=""
        draggable={false}
      />
      <img
        className="compare-img compare-img-before"
        src={inputUrl}
        alt=""
        draggable={false}
        style={{ clipPath: beforeClip }}
      />
      <div
        className="compare-handle"
        style={{ left: `${position}%` }}
        aria-hidden
      >
        <span className="compare-handle-knob" />
      </div>
      <div className="compare-labels" aria-hidden>
        <span>Before</span>
        <span>After</span>
      </div>
    </div>
  );
}

export function PreviewCanvas({
  inputPath,
  outputPath,
  canCompare = false,
  isDragging = false,
}: PreviewCanvasProps) {
  const inputUrl = useLocalFileUrl(inputPath);
  const outputUrl = useLocalFileUrl(canCompare ? outputPath : null);
  const showCompare = Boolean(
    canCompare && inputPath && outputPath && inputUrl && outputUrl,
  );

  const inputAr = useImageAspectRatio(inputUrl);
  const outputAr = useImageAspectRatio(showCompare ? outputUrl : null);
  const aspectRatio = (showCompare ? outputAr : null) ?? inputAr;

  if (!inputPath) {
    return (
      <div className={`preview-canvas${isDragging ? " is-dragging" : ""}`}>
        <div className="preview-empty">
          <p className="preview-empty-title">
            {isDragging ? "Drop image here" : "Drop an image here"}
          </p>
          <p className="preview-empty-formats">PNG, JPG, WEBP, BMP</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`preview-canvas${isDragging ? " is-dragging" : ""}`}>
      <div className="preview-stage">
        {showCompare && aspectRatio != null && inputUrl && outputUrl ? (
          <CompareSlider
            inputUrl={inputUrl}
            outputUrl={outputUrl}
            aspectRatio={aspectRatio}
          />
        ) : inputUrl && aspectRatio != null ? (
          <div
            className="preview-image-frame"
            style={{ ["--img-ar" as string]: String(aspectRatio) }}
          >
            <img src={inputUrl} alt="Input" draggable={false} />
          </div>
        ) : inputUrl ? (
          <div className="preview-image-frame preview-image-frame-fallback">
            <img src={inputUrl} alt="Input" draggable={false} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
