export type ShortcutKey = "open" | "process" | "cancel";

export type ShortcutContext = {
  enabled: boolean;
  isProcessing: boolean;
  hasImage: boolean;
  isBusy: boolean;
};

/** Map a keydown event to a shortcut key, ignoring context. */
export function matchShortcutKey(event: KeyboardEvent): ShortcutKey | null {
  if (event.key === "Escape") return "cancel";
  if (event.ctrlKey && event.key.toLowerCase() === "o") return "open";
  if (event.ctrlKey && event.key === "Enter") return "process";
  return null;
}

/** Apply gating rules from the agreed shortcut policy. */
export function resolveShortcutAction(
  key: ShortcutKey,
  ctx: ShortcutContext,
): ShortcutKey | null {
  if (!ctx.enabled) return null;

  switch (key) {
    case "open":
      return ctx.isBusy ? null : "open";
    case "process":
      return ctx.isBusy || !ctx.hasImage ? null : "process";
    case "cancel":
      return ctx.isProcessing ? "cancel" : null;
    default:
      return null;
  }
}

export function shortcutContextEnabled(flags: {
  ready: boolean;
  firstRun: boolean;
  settingsOpen: boolean;
  modalBlocksShortcuts: boolean;
}): boolean {
  return (
    flags.ready &&
    !flags.firstRun &&
    !flags.settingsOpen &&
    !flags.modalBlocksShortcuts
  );
}
