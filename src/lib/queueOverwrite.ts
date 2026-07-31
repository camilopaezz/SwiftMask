import { message } from "@tauri-apps/plugin-dialog";

export type BatchOverwriteChoice = "overwrite_all" | "skip_existing" | "cancel";

export type BatchOverwriteChooser = (info: {
  count: number;
}) => Promise<BatchOverwriteChoice>;

/**
 * When any derived outputs already exist, ask once for the whole run.
 * Returns overwrite_all when none exist (no dialog).
 */
export async function resolveBatchOverwrite(
  outputPaths: string[],
  exists: (path: string) => Promise<boolean>,
  choose: BatchOverwriteChooser,
): Promise<BatchOverwriteChoice> {
  const existing: string[] = [];
  for (const p of outputPaths) {
    if (await exists(p)) existing.push(p);
  }
  if (existing.length === 0) return "overwrite_all";
  return choose({ count: existing.length });
}

/** Production one-shot dialog: Overwrite all / Skip existing / Cancel. */
export async function prodBatchOverwriteChooser(info: {
  count: number;
}): Promise<BatchOverwriteChoice> {
  const n = info.count;
  const result = await message(
    `${n} output file${n === 1 ? "" : "s"} already exist.`,
    {
      title: "Outputs already exist",
      kind: "warning",
      buttons: {
        yes: "Overwrite all",
        no: "Skip existing",
        cancel: "Cancel",
      },
    },
  );

  // Custom buttons return the label string; also accept defaults defensively.
  if (result === "Overwrite all" || result === "Yes") return "overwrite_all";
  if (result === "Skip existing" || result === "No") return "skip_existing";
  return "cancel";
}
