import { describe, expect, it } from "vitest";
import {
  matchShortcutKey,
  resolveShortcutAction,
  shortcutContextEnabled,
} from "./keyboardShortcuts";

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

const enabledCtx = {
  enabled: true,
  isProcessing: false,
  hasImage: true,
  isBusy: false,
};

describe("keyboardShortcuts", () => {
  describe("matchShortcutKey", () => {
    it("maps Ctrl+O, Ctrl+Enter, and Escape", () => {
      expect(matchShortcutKey(keyEvent({ key: "o", ctrlKey: true }))).toBe(
        "open",
      );
      expect(matchShortcutKey(keyEvent({ key: "Enter", ctrlKey: true }))).toBe(
        "process",
      );
      expect(matchShortcutKey(keyEvent({ key: "Escape" }))).toBe("cancel");
    });

    it("ignores unrelated keys", () => {
      expect(matchShortcutKey(keyEvent({ key: "Enter" }))).toBeNull();
      expect(matchShortcutKey(keyEvent({ key: "o" }))).toBeNull();
      expect(
        matchShortcutKey(keyEvent({ key: "p", ctrlKey: true })),
      ).toBeNull();
    });
  });

  describe("resolveShortcutAction", () => {
    it("blocks all shortcuts when disabled", () => {
      const ctx = { ...enabledCtx, enabled: false };
      expect(resolveShortcutAction("open", ctx)).toBeNull();
      expect(resolveShortcutAction("process", ctx)).toBeNull();
      expect(resolveShortcutAction("cancel", ctx)).toBeNull();
    });

    it("gates open and process on busy state", () => {
      expect(
        resolveShortcutAction("open", { ...enabledCtx, isBusy: true }),
      ).toBeNull();
      expect(
        resolveShortcutAction("process", { ...enabledCtx, isBusy: true }),
      ).toBeNull();
    });

    it("requires an image for process", () => {
      expect(
        resolveShortcutAction("process", { ...enabledCtx, hasImage: false }),
      ).toBeNull();
    });

    it("allows cancel only while processing", () => {
      expect(resolveShortcutAction("cancel", enabledCtx)).toBeNull();
      expect(
        resolveShortcutAction("cancel", { ...enabledCtx, isProcessing: true }),
      ).toBe("cancel");
    });
  });

  describe("shortcutContextEnabled", () => {
    it("is false during blockers and modals", () => {
      expect(
        shortcutContextEnabled({
          ready: true,
          firstRun: false,
          settingsOpen: false,
          modalBlocksShortcuts: false,
        }),
      ).toBe(true);
      expect(
        shortcutContextEnabled({
          ready: false,
          firstRun: false,
          settingsOpen: false,
          modalBlocksShortcuts: false,
        }),
      ).toBe(false);
      expect(
        shortcutContextEnabled({
          ready: true,
          firstRun: true,
          settingsOpen: false,
          modalBlocksShortcuts: false,
        }),
      ).toBe(false);
      expect(
        shortcutContextEnabled({
          ready: true,
          firstRun: false,
          settingsOpen: true,
          modalBlocksShortcuts: false,
        }),
      ).toBe(false);
      expect(
        shortcutContextEnabled({
          ready: true,
          firstRun: false,
          settingsOpen: false,
          modalBlocksShortcuts: true,
        }),
      ).toBe(false);
    });
  });
});
