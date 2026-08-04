import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uiStore } from "../stores/uiStore";
import { AppNotice } from "./AppNotice";

// React 19: act() is a no-op unless the test env opts in.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function mount(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<AppNotice />);
  });
  return { container, root };
}

describe("AppNotice auto-dismiss", () => {
  let mounted: { container: HTMLDivElement; root: Root } | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    uiStore.getState().dismissNotice();
  });

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted!.root.unmount();
      });
      mounted.container.remove();
      mounted = null;
    }
    vi.useRealTimers();
    uiStore.getState().dismissNotice();
  });

  it("auto-dismisses info after 5s", () => {
    uiStore.getState().showNotice({
      severity: "info",
      title: "Finished: 1 succeeded, 0 failed",
      code: "queue_finished",
    });
    mounted = mount();
    expect(
      mounted.container.querySelector('[data-testid="app-notice"]'),
    ).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(
      mounted.container.querySelector('[data-testid="app-notice"]'),
    ).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(
      mounted.container.querySelector('[data-testid="app-notice"]'),
    ).toBeNull();
  });

  it("auto-dismisses warning after 8s", () => {
    uiStore.getState().showNotice({
      severity: "warning",
      title: "Finished: 1 succeeded, 1 failed",
    });
    mounted = mount();

    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(
      mounted.container.querySelector('[data-testid="app-notice"]'),
    ).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(
      mounted.container.querySelector('[data-testid="app-notice"]'),
    ).toBeNull();
  });

  it("keeps errors until dismissed", () => {
    uiStore.getState().showNotice({
      severity: "error",
      title: "Something broke",
    });
    mounted = mount();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(
      mounted.container.querySelector('[data-testid="app-notice"]'),
    ).toBeTruthy();

    const btn = mounted.container.querySelector(
      'button[aria-label="Dismiss notice"]',
    ) as HTMLButtonElement;
    act(() => {
      btn.click();
    });
    expect(
      mounted.container.querySelector('[data-testid="app-notice"]'),
    ).toBeNull();
  });

  it("pauses auto-dismiss while hovered", () => {
    uiStore.getState().showNotice({
      severity: "info",
      title: "hi",
    });
    mounted = mount();
    const el = mounted.container.querySelector(
      '[data-testid="app-notice"]',
    ) as HTMLElement;

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    // React maps onMouseEnter/Leave to mouseover/mouseout with relatedTarget.
    act(() => {
      el.dispatchEvent(
        new MouseEvent("mouseover", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(
      mounted.container.querySelector('[data-testid="app-notice"]'),
    ).toBeTruthy();

    act(() => {
      el.dispatchEvent(
        new MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(
      mounted.container.querySelector('[data-testid="app-notice"]'),
    ).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(
      mounted.container.querySelector('[data-testid="app-notice"]'),
    ).toBeNull();
  });

  it("resets timer when a new notice replaces the old one", () => {
    uiStore.getState().showNotice({
      id: "a",
      severity: "info",
      title: "first",
    });
    mounted = mount();

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    act(() => {
      uiStore.getState().showNotice({
        id: "b",
        severity: "info",
        title: "second",
      });
    });
    expect(mounted.container.textContent).toContain("second");

    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(
      mounted.container.querySelector('[data-testid="app-notice"]'),
    ).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(
      mounted.container.querySelector('[data-testid="app-notice"]'),
    ).toBeNull();
  });

  it("keeps pause when a notice is replaced while hovered", () => {
    uiStore.getState().showNotice({
      id: "a",
      severity: "info",
      title: "first",
    });
    mounted = mount();
    const el = mounted.container.querySelector(
      '[data-testid="app-notice"]',
    ) as HTMLElement;

    act(() => {
      el.dispatchEvent(
        new MouseEvent("mouseover", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });

    act(() => {
      uiStore.getState().showNotice({
        id: "b",
        severity: "info",
        title: "second",
      });
    });
    expect(mounted.container.textContent).toContain("second");

    // Full 5s would have elapsed if the replace re-armed a running timer.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(
      mounted.container.querySelector('[data-testid="app-notice"]'),
    ).toBeTruthy();

    act(() => {
      el.dispatchEvent(
        new MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
    });
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(
      mounted.container.querySelector('[data-testid="app-notice"]'),
    ).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(
      mounted.container.querySelector('[data-testid="app-notice"]'),
    ).toBeNull();
  });
});
