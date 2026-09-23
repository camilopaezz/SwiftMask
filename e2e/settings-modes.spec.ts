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

  test("undownloaded High blocks Process; after download output uses birefnet", async ({
    page,
  }) => {
    await boot(page);
    await injectDrop(page, [E2E_FIXTURE_PATH]);

    const processBtn = page.getByRole("button", { name: /process/i });
    await expect(processBtn).toBeEnabled();

    await page.evaluate(() => {
      const state = window.__SWIFTMASK_MOCK__;
      if (!state) throw new Error("mock missing");
      state.downloadDelayMs = 800;
    });

    await page.locator('[data-mode="birefnet-general-lite"]').click();

    await expect(
      page.getByRole("heading", { name: "Downloading High" }),
    ).toBeVisible();
    await expect(processBtn).toBeDisabled();

    await expect(processBtn).toBeEnabled({ timeout: 10_000 });
    await processBtn.click();

    await expect
      .poll(
        async () => {
          const calls = await mockCalls(page);
          return calls.some(
            (call) =>
              call.cmd === "remove_image_background" &&
              JSON.stringify(call.args).includes("birefnet-general-lite") &&
              JSON.stringify(call.args).includes("-nobg-birefnet-general-lite"),
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);
  });

  test("compare slider mounts after done and ArrowRight moves value", async ({
    page,
  }) => {
    await bootAndLoadFixture(page);
    await page.getByRole("button", { name: /process/i }).click();

    await expect(page.locator(".queue-status.done")).toBeVisible({
      timeout: 10_000,
    });

    const previewImg = page.locator(".app-preview img").first();
    await expect(previewImg).toBeVisible();
    await expect
      .poll(async () => {
        return previewImg.evaluate(
          (el) => (el as HTMLImageElement).naturalWidth,
        );
      })
      .toBeGreaterThan(0);

    const slider = page.getByRole("slider", {
      name: "Before and after comparison",
    });
    await expect(slider).toBeVisible();

    const before = Number(await slider.getAttribute("aria-valuenow"));
    await slider.press("ArrowRight");
    await expect
      .poll(async () => Number(await slider.getAttribute("aria-valuenow")))
      .toBeGreaterThan(before);
  });

  test("Settings: theme, EP, output dir, benchmark", async ({ page }) => {
    await boot(page);

    const settingsBtn = page.getByRole("button", { name: "Settings" });
    await settingsBtn.click();

    const shell = page.getByRole("dialog");
    await expect(shell).toBeVisible();

    await page.getByRole("button", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect
      .poll(async () =>
        page.evaluate(() => localStorage.getItem("swiftmask:theme")),
      )
      .toBe("dark");

    const cudaChip = page.getByRole("button", { name: "CUDA" });
    await expect(cudaChip).toBeVisible();
    await cudaChip.click();
    await expect
      .poll(async () => {
        const calls = await mockCalls(page);
        return calls.some(
          (call) =>
            call.cmd === "set_ep" && JSON.stringify(call.args).includes("cuda"),
        );
      })
      .toBe(true);
    await expect(cudaChip).toHaveAttribute("aria-pressed", "true");

    await page.evaluate(() => {
      const state = window.__SWIFTMASK_MOCK__;
      if (!state) throw new Error("mock missing");
      state.pickOutputDirResult = "/swiftmask/e2e/out2";
    });
    await page
      .getByRole("button", {
        name: /change output directory|choose output directory/i,
      })
      .click();
    await expect(page.locator(".settings-path-value")).toContainText(
      "/swiftmask/e2e/out2",
    );

    await page.getByRole("button", { name: "Reset" }).click();
    await expect
      .poll(async () => {
        const calls = await mockCalls(page);
        return calls.some((call) => call.cmd === "clear_output_dir");
      })
      .toBe(true);
    await expect(page.locator(".settings-path-value")).toContainText(
      "Same as input",
    );

    await page.getByRole("button", { name: "Benchmark" }).click();
    await expect
      .poll(async () => {
        const calls = await mockCalls(page);
        return calls.some((call) => call.cmd === "run_benchmark");
      })
      .toBe(true);

    await page.keyboard.press("Escape");
    await expect(shell).toHaveCount(0);
    await expect(settingsBtn).toBeFocused();
  });
});
