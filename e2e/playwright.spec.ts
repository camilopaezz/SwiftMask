import { expect, test } from "@playwright/test";
import {
  boot,
  bootAndLoadFixture,
  E2E_FIXTURE_PATH,
  injectDrop,
  installMock,
  mockCalls,
} from "./helpers";

test.describe("SwiftMask", () => {
  test.beforeEach(async ({ page }) => {
    await installMock(page);
  });

  test("end-to-end mocked flow", async ({ page }) => {
    await boot(page);

    const expectedOutputPath =
      "/swiftmask/e2e/output/sample-nobg-isnet-general-use.png";

    await injectDrop(page, [E2E_FIXTURE_PATH]);

    // Click "Process" button to trigger handleProcess ->
    // invokeRemoveImageBackground -> tauriInvoke("remove_image_background")
    await page.getByRole("button", { name: /process/i }).click();

    await expect
      .poll(
        async () => {
          const calls = await mockCalls(page);
          return calls.some(
            (call) =>
              call.cmd === "remove_image_background" &&
              JSON.stringify(call.args).includes(expectedOutputPath),
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // Queue path: finish notice + row marked done (no single-image "Done" label).
    await expect(page.getByTestId("app-notice")).toContainText(/1 succeeded/i, {
      timeout: 10_000,
    });
    await expect(page.locator(".queue-status.done")).toBeVisible();

    // Done state shows before/after comparison (img layers or slider).
    const previewImg = page.locator(".app-preview img").first();
    await expect(previewImg).toBeVisible();
    const size = await previewImg.evaluate((el) => ({
      width: (el as HTMLImageElement).naturalWidth,
      height: (el as HTMLImageElement).naturalHeight,
    }));
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
  });

  test("Ctrl+Enter starts process", async ({ page }) => {
    await bootAndLoadFixture(page);

    const expectedOutputPath =
      "/swiftmask/e2e/output/sample-nobg-isnet-general-use.png";

    await page.keyboard.press("Control+Enter");

    await expect
      .poll(
        async () => {
          const calls = await mockCalls(page);
          return calls.some(
            (call) =>
              call.cmd === "remove_image_background" &&
              JSON.stringify(call.args).includes(expectedOutputPath),
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  });

  test("Escape cancels while processing", async ({ page }) => {
    await bootAndLoadFixture(page);

    await page.keyboard.press("Control+Enter");
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible({
      timeout: 10_000,
    });

    await page.keyboard.press("Escape");

    await expect
      .poll(
        async () => {
          const calls = await mockCalls(page);
          return calls.some((call) => call.cmd === "cancel_inference");
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  });

  test("NC license modal gates first RMBG download", async ({ page }) => {
    await page.goto("/");

    // Hybrid rail: undownloaded segments start the download/NC gate on click.
    // Click the label — the radio input is opacity-0 and covered by the span.
    const balancedPlusSeg = page.locator('[data-mode="rmbg-1.4"]');
    await balancedPlusSeg.click();

    const ncDialog = page.getByRole("dialog", {
      name: "Non-commercial license",
    });
    await expect(ncDialog).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Downloading Balanced+" }),
    ).toHaveCount(0);

    await ncDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(ncDialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Downloading Balanced+" }),
    ).toHaveCount(0);

    await balancedPlusSeg.click();
    await expect(ncDialog).toBeVisible();

    await ncDialog.getByRole("button", { name: "I understand" }).click();
    await expect(ncDialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Downloading Balanced+" }),
    ).toBeVisible();
  });

  test("process error shows friendly footer copy", async ({ page }) => {
    await boot(page);

    await page.evaluate(() => {
      const state = window.__SWIFTMASK_MOCK__;
      if (!state) throw new Error("mock missing");
      state.inferenceMode = "error";
    });

    await injectDrop(page, [E2E_FIXTURE_PATH]);

    await page.getByRole("button", { name: /process/i }).click();

    // Queue footer summarizes failures; friendly copy is on the finish notice /
    // row title (not a single-image "Out of memory" status line).
    await expect(page.locator(".image-panel-status.is-error")).toContainText(
      /1 failed/i,
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("app-notice")).toContainText(/1 failed/i, {
      timeout: 10_000,
    });
    await expect(page.locator(".queue-row.is-failed")).toBeVisible();
  });

  test("GPU fallback shows sticky notice and still completes", async ({
    page,
  }) => {
    await boot(page);

    await page.evaluate(() => {
      const state = window.__SWIFTMASK_MOCK__;
      if (!state) throw new Error("mock missing");
      state.inferenceMode = "fallback";
    });

    await injectDrop(page, [E2E_FIXTURE_PATH]);

    await page.getByRole("button", { name: /process/i }).click();

    const notice = page.getByTestId("app-notice");
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toContainText("Finished on CPU");
    await expect(notice).toHaveAttribute("data-severity", "warning");
    await expect(page.locator(".queue-status.done")).toBeVisible();

    await notice.getByRole("button", { name: "Dismiss notice" }).click();
    await expect(notice).toHaveCount(0);
  });

  test("download failure shows Retry and can recover", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Quality mode")).toBeVisible();

    // High is free/MIT and not ready in the default mock (Balanced is pre-ready).
    await page.evaluate(() => {
      const state = window.__SWIFTMASK_MOCK__;
      if (!state) throw new Error("mock missing");
      state.failNextDownload = true;
    });

    // Click the segment label (radio is visually hidden under the short label).
    await page.locator('[data-mode="birefnet-general-lite"]').click();

    const downloadError = page.getByTestId("download-error");
    await expect(downloadError).toBeVisible({ timeout: 10_000 });
    await expect(downloadError).toContainText("Network error");

    await downloadError.getByRole("button", { name: "Retry" }).click();
    await expect(downloadError).toHaveCount(0);
    // After success the detail Download control is gone (model is ready).
    await expect(
      page.getByTestId("mode-detail").getByRole("button", { name: "Download" }),
    ).toHaveCount(0, { timeout: 10_000 });
  });

  test("Settings About panel: Escape, focus, no GPU re-fetch", async ({
    page,
  }) => {
    await boot(page);

    const settingsBtn = page.getByRole("button", { name: "Settings" });
    await settingsBtn.click();

    const shell = page.getByRole("dialog");
    await expect(shell).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();

    await expect
      .poll(async () => {
        const calls = await mockCalls(page);
        return calls.filter((c) => c.cmd === "detect_gpu").length;
      })
      .toBeGreaterThan(0);

    const gpuAfterOpen = (await mockCalls(page)).filter(
      (c) => c.cmd === "detect_gpu",
    ).length;

    await page.getByRole("button", { name: "About & licenses" }).click();
    await expect(
      page.getByRole("heading", { name: "About", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Back" })).toBeFocused();

    // Legal links are buttons — no navigable external href in the webview.
    await expect(page.locator('a[href^="http"]')).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "MIT License" }),
    ).toBeVisible();
    await expect(page.getByText("SwiftMask 1.2.0")).toBeVisible();
    await expect(page.getByText("ONNX Runtime 1.24")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "About & licenses" }),
    ).toBeFocused();

    const gpuAfterAboutRoundTrip = (await mockCalls(page)).filter(
      (c) => c.cmd === "detect_gpu",
    ).length;
    expect(gpuAfterAboutRoundTrip).toBe(gpuAfterOpen);

    await page.keyboard.press("Escape");
    await expect(shell).toHaveCount(0);
    await expect(settingsBtn).toBeFocused();
  });
});
