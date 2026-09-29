import { describe, expect, it } from "vitest";
import {
  armWatchAutoRun,
  disarmWatchAutoRun,
  getWatchAutoRunGate,
  pauseWatchAutoRun,
  resetWatchAutoRunForTests,
} from "./watchAutoRun";

describe("watchAutoRun", () => {
  it("starts idle, arms, pauses only from armed, and disarms", () => {
    resetWatchAutoRunForTests();
    expect(getWatchAutoRunGate()).toBe("idle");
    pauseWatchAutoRun();
    expect(getWatchAutoRunGate()).toBe("idle");
    armWatchAutoRun();
    expect(getWatchAutoRunGate()).toBe("armed");
    pauseWatchAutoRun();
    expect(getWatchAutoRunGate()).toBe("paused");
    disarmWatchAutoRun();
    expect(getWatchAutoRunGate()).toBe("idle");
  });
});
