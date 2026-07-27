import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { MODEL_REGISTRY } from "../src/lib/models";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "sample.png");

const DEFAULT_CONFIG = {
  config: {
    execution_provider: "cpu",
    output_dir: "/swiftmask/e2e/output",
  },
  gpuInfo: {
    vendor: "NVIDIA",
    vram_bytes: 4_000_000_000,
    available_eps: ["cuda", "cpu"],
    optimization: "Level1 (<4 GiB)",
  },
  benchmarkResult: {
    ep_latencies: [
      { ep: "cpu", seconds: 0.5 },
      { ep: "cuda", seconds: 0.1 },
    ],
    winner_ep: "cpu",
  },
  models: MODEL_REGISTRY.map((m) => ({
    ...m,
    downloaded: m.bundled,
  })),
};

const E2E_FIXTURE_PATH = "/swiftmask/e2e/fixtures/sample.png";

async function bootAndLoadFixture(page: Page) {
  await page.goto("/");
  await expect(page.getByText("Drop an image here")).toBeVisible();

  await page.evaluate((fixturePath) => {
    const hook = window.__swiftmaskInjectDrop;
    if (!hook) {
      throw new Error("E2E drop hook not available");
    }
    hook([fixturePath]);
  }, E2E_FIXTURE_PATH);

  await expect(page.getByRole("button", { name: /process/i })).toBeEnabled();
}

test.describe("SwiftMask", () => {
  test.beforeEach(async ({ page }) => {
    const fixtureBytes = await readFile(FIXTURE_PATH);

    await page.addInitScript(
      ({ config, fixtureArray }) => {
        localStorage.removeItem("swiftmask:nc-license-ack");
        window.__SWIFTMASK_MOCK__ = {
          config,
          listeners: {},
          calls: [],
          fixtureBytes: new Uint8Array(fixtureArray),
        };
      },
      {
        config: DEFAULT_CONFIG,
        fixtureArray: Array.from(fixtureBytes),
      },
    );
  });

  test("end-to-end mocked flow", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Drop an image here")).toBeVisible();

    const inputPath = "/swiftmask/e2e/fixtures/sample.png";
    const expectedOutputPath = "/swiftmask/e2e/output/sample-nobg-u2netp.png";

    await page.evaluate((path) => {
      const hook = window.__swiftmaskInjectDrop;
      if (!hook) {
        throw new Error("E2E drop hook not available");
      }
      hook([path]);
    }, inputPath);

    // Click "Process" button to trigger handleProcess ->
    // invokeRemoveImageBackground -> tauriInvoke("remove_image_background")
    await page.getByRole("button", { name: /process/i }).click();

    await expect
      .poll(
        async () => {
          const calls = await page.evaluate(() => {
            const state = window.__SWIFTMASK_MOCK__;
            if (!state) {
              throw new Error("SwiftMask mock state not available");
            }
            return state.calls;
          });
          return calls.some(
            (call) =>
              call.cmd === "remove_image_background" &&
              JSON.stringify(call.args).includes(expectedOutputPath),
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    await expect(page.getByText("Done")).toBeVisible();

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

    const expectedOutputPath = "/swiftmask/e2e/output/sample-nobg-u2netp.png";

    await page.keyboard.press("Control+Enter");

    await expect
      .poll(
        async () => {
          const calls = await page.evaluate(() => {
            const state = window.__SWIFTMASK_MOCK__;
            if (!state) {
              throw new Error("SwiftMask mock state not available");
            }
            return state.calls;
          });
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
          const calls = await page.evaluate(() => {
            const state = window.__SWIFTMASK_MOCK__;
            if (!state) {
              throw new Error("SwiftMask mock state not available");
            }
            return state.calls;
          });
          return calls.some((call) => call.cmd === "cancel_inference");
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  });

  test("NC license modal gates first RMBG download", async ({ page }) => {
    await page.goto("/");

    const balancedPlusRow = page
      .locator(".mode-option")
      .filter({ hasText: "Balanced+" });
    await balancedPlusRow.getByRole("button", { name: "Download" }).click();

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

    await balancedPlusRow.getByRole("button", { name: "Download" }).click();
    await expect(ncDialog).toBeVisible();

    await ncDialog.getByRole("button", { name: "I understand" }).click();
    await expect(ncDialog).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Downloading Balanced+" }),
    ).toBeVisible();
  });

  test("process error shows friendly footer copy", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Drop an image here")).toBeVisible();

    await page.evaluate(() => {
      const state = window.__SWIFTMASK_MOCK__;
      if (!state) throw new Error("mock missing");
      state.inferenceMode = "error";
    });

    await page.evaluate((fixturePath) => {
      const hook = window.__swiftmaskInjectDrop;
      if (!hook) throw new Error("E2E drop hook not available");
      hook([fixturePath]);
    }, E2E_FIXTURE_PATH);

    await page.getByRole("button", { name: /process/i }).click();

    await expect(page.locator(".image-panel-status.is-error")).toContainText(
      "Out of memory",
      { timeout: 10_000 },
    );
    // Must not dump raw CUDA strings as the only copy.
    await expect(
      page.locator(".image-panel-status.is-error"),
    ).not.toContainText("CUDA");
  });

  test("GPU fallback shows sticky notice and still completes", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("Drop an image here")).toBeVisible();

    await page.evaluate(() => {
      const state = window.__SWIFTMASK_MOCK__;
      if (!state) throw new Error("mock missing");
      state.inferenceMode = "fallback";
    });

    await page.evaluate((fixturePath) => {
      const hook = window.__swiftmaskInjectDrop;
      if (!hook) throw new Error("E2E drop hook not available");
      hook([fixturePath]);
    }, E2E_FIXTURE_PATH);

    await page.getByRole("button", { name: /process/i }).click();

    const notice = page.getByTestId("app-notice");
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toContainText("Finished on CPU");
    await expect(notice).toHaveAttribute("data-severity", "warning");
    await expect(page.getByText("Done")).toBeVisible();

    await notice.getByRole("button", { name: "Dismiss notice" }).click();
    await expect(notice).toHaveCount(0);
  });

  test("download failure shows Retry and can recover", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Quality mode")).toBeVisible();

    // Turbo is bundled; use Balanced (isnet) which is free and not bundled.
    const balancedRow = page
      .locator(".mode-option")
      .filter({ hasText: "Balanced" })
      .filter({ hasNotText: "Balanced+" });

    await page.evaluate(() => {
      const state = window.__SWIFTMASK_MOCK__;
      if (!state) throw new Error("mock missing");
      state.failNextDownload = true;
    });

    await balancedRow.getByRole("button", { name: "Download" }).click();

    const downloadError = page.getByTestId("download-error");
    await expect(downloadError).toBeVisible({ timeout: 10_000 });
    await expect(downloadError).toContainText("Network error");

    await downloadError.getByRole("button", { name: "Retry" }).click();
    await expect(downloadError).toHaveCount(0);
    // After success the Download chip becomes model id badge / ready.
    await expect(
      balancedRow.getByRole("button", { name: "Download" }),
    ).toHaveCount(0, { timeout: 10_000 });
  });

  test("Settings About panel: Escape, focus, no GPU re-fetch", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("Drop an image here")).toBeVisible();

    const settingsBtn = page.getByRole("button", { name: "Settings" });
    await settingsBtn.click();

    const shell = page.getByRole("dialog");
    await expect(shell).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();

    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const state = window.__SWIFTMASK_MOCK__;
          if (!state) throw new Error("mock missing");
          return state.calls.filter((c) => c.cmd === "detect_gpu").length;
        });
      })
      .toBeGreaterThan(0);

    const gpuAfterOpen = await page.evaluate(() => {
      const state = window.__SWIFTMASK_MOCK__;
      if (!state) throw new Error("mock missing");
      return state.calls.filter((c) => c.cmd === "detect_gpu").length;
    });

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
    await expect(page.getByText("SwiftMask 0.1.0")).toBeVisible();
    await expect(page.getByText("ONNX Runtime 1.24")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "About & licenses" }),
    ).toBeFocused();

    const gpuAfterAboutRoundTrip = await page.evaluate(() => {
      const state = window.__SWIFTMASK_MOCK__;
      if (!state) throw new Error("mock missing");
      return state.calls.filter((c) => c.cmd === "detect_gpu").length;
    });
    expect(gpuAfterAboutRoundTrip).toBe(gpuAfterOpen);

    await page.keyboard.press("Escape");
    await expect(shell).toHaveCount(0);
    await expect(settingsBtn).toBeFocused();
  });
});
