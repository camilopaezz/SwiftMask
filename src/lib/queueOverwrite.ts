import { message } from "@tauri-apps/plugin-dialog";
import i18n from "../i18n";

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
  const overwriteAll = i18n.t("overwrite.overwriteAll");
  const skipExisting = i18n.t("overwrite.skipExisting");
  const result = await message(i18n.t("overwrite.batchBody", { count: n }), {
    title: i18n.t("overwrite.batchTitle"),
    kind: "warning",
    buttons: {
      yes: overwriteAll,
      no: skipExisting,
      cancel: i18n.t("common.cancel"),
    },
  });

  // Custom buttons return the label string; also accept defaults defensively.
  if (result === overwriteAll || result === "Yes") return "overwrite_all";
  if (result === skipExisting || result === "No") return "skip_existing";
  return "cancel";
}
