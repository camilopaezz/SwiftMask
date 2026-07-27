import { useEffect, useState } from "react";

export const ANIMATION_DURATION_MS = 220;

function useMotionDuration(duration: number): number {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced ? 0 : duration;
}

type AnimatedPresence = {
  /** Keep the element mounted while exit animations play. */
  rendered: boolean;
  /** Drives enter/exit CSS classes (`is-open`). */
  open: boolean;
};

/**
 * Mount immediately on show; delay unmount until exit transitions finish.
 * Sets `open` on the next frame so enter keyframes/transitions can run.
 *
 * Exit always schedules an unmount timer when `visible` is false — do not gate
 * that timer on impure setState updater side effects (React may defer updaters,
 * which left the download modal stuck on "Verifying" after success).
 */
export function useAnimatedPresence(
  visible: boolean,
  duration = ANIMATION_DURATION_MS,
): AnimatedPresence {
  const motionDuration = useMotionDuration(duration);
  const [state, setState] = useState<AnimatedPresence>(() => ({
    rendered: visible,
    open: visible,
  }));

  useEffect(() => {
    if (visible) {
      setState({ rendered: true, open: false });
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          setState({ rendered: true, open: true });
        });
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }

    // Begin exit: drop `open` so CSS can fade out, then unmount after duration.
    setState((prev) =>
      prev.rendered || prev.open ? { rendered: true, open: false } : prev,
    );

    const timer = window.setTimeout(() => {
      setState({ rendered: false, open: false });
    }, motionDuration);
    return () => window.clearTimeout(timer);
  }, [visible, motionDuration]);

  return state;
}
