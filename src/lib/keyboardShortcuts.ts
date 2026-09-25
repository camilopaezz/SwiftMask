export type ShortcutKey =
  | "open"
  | "openFolder"
  | "process"
  | "cancel"
  | "paste";

export type ShortcutContext = {
  enabled: boolean;
  isProcessing: boolean;
  hasImage: boolean;
  isBusy: boolean;
};

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable='true']") !== null
  );
}

/** Map a keydown event to a shortcut key, ignoring context. */
export function matchShortcutKey(event: KeyboardEvent): ShortcutKey | null {
  if (event.key === "Escape") return "cancel";
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "v"
  ) {
    return "paste";
  }
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "o") {
    return "openFolder";
  }
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
    case "openFolder":
      return ctx.isBusy ? null : key;
    case "paste":
      // The paste workflow reports single-image busy state itself; queues may
      // always accept appended clipboard images while processing.
      return key;
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
