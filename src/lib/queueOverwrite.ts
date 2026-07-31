export type BatchOverwriteChoice = "overwrite_all" | "skip_existing" | "cancel";

/**
 * When any derived outputs already exist, ask once for the whole run.
 * Returns overwrite_all when none exist (no dialog).
 */
export async function resolveBatchOverwrite(
  outputPaths: string[],
  exists: (path: string) => Promise<boolean>,
  ask: (message: string) => Promise<boolean>,
): Promise<BatchOverwriteChoice> {
  const existing: string[] = [];
  for (const p of outputPaths) {
    if (await exists(p)) existing.push(p);
  }
  if (existing.length === 0) return "overwrite_all";

  const n = existing.length;
  const overwrite = await ask(
    `${n} output file${n === 1 ? "" : "s"} already exist. Overwrite all? (Cancel skips existing)`,
  );
  // Native ask is Yes/No only — map No to skip_existing (safer than aborting).
  // Use a second prompt only if we need Cancel as abort: keep simple — No = skip.
  if (overwrite) return "overwrite_all";

  const skip = await ask(
    `Skip ${n} existing output${n === 1 ? "" : "s"} and process the rest? (No cancels the run)`,
  );
  if (skip) return "skip_existing";
  return "cancel";
}
