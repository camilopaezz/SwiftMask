/**
 * Watch auto-run gate for the current folder session:
 * - idle: no full Process yet (or session reset) — enqueue only
 * - armed: auto-process watch arrivals when worker idle
 * - paused: user cancelled a run — enqueue only until Process again
 *
 * Lives in its own module so queueRunner can arm/pause without importing
 * folderWatch (which would cycle through queue/queueRunner).
 */
export type AutoRunGate = "idle" | "armed" | "paused";

let autoRunGate: AutoRunGate = "idle";

/** User cancelled a queue run — keep enqueueing, stop auto-start until Process. */
export function pauseWatchAutoRun(): void {
  if (autoRunGate === "armed") autoRunGate = "paused";
}

/** Manual Process that actually starts arms auto-run for subsequent watch arrivals. */
export function armWatchAutoRun(): void {
  autoRunGate = "armed";
}

export function disarmWatchAutoRun(): void {
  autoRunGate = "idle";
}

export function getWatchAutoRunGate(): AutoRunGate {
  return autoRunGate;
}

/** Test-only: reset between suites. */
export function resetWatchAutoRunForTests(): void {
  autoRunGate = "idle";
}
