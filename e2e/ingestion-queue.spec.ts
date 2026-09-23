import { expect, test } from "@playwright/test";
import {
  boot,
  E2E_FIXTURE_PATH,
  emitMockEvent,
  injectDrop,
  installMock,
  type MockOverrides,
  mockCalls,
} from "./helpers";

const PATH_A = "/swiftmask/e2e/fixtures/alpha.png";
const PATH_B = "/swiftmask/e2e/fixtures/beta.png";
const FOLDER = "/swiftmask/e2e/folder";
const FOLDER_IMAGES = [`${FOLDER}/one.png`, `${FOLDER}/two.png`];
const FOLDER_NOBG = "/swiftmask/e2e/folder-nobg";
const WATCH_A = `${FOLDER}/new-a.png`;
const WATCH_B = `${FOLDER}/new-b.png`;

function folderMock(extra?: MockOverrides): MockOverrides {
  return {
    pickFolderResult: FOLDER,
    folderImages: { [FOLDER]: FOLDER_IMAGES },
    folderPaths: [FOLDER],
    ...extra,
  };
}

function removeBgCalls(calls: Awaited<ReturnType<typeof mockCalls>>) {
  return calls.filter((c) => c.cmd === "remove_image_background");
}

test.describe("ingestion and queue", () => {
  test.beforeEach(async ({ page }) => {
    await installMock(page);
  });

  test("multi-drop builds queue and processes serially", async ({ page }) => {
    await boot(page);
    await injectDrop(page, [PATH_A, PATH_B]);

    await expect(page.locator(".queue-drawer")).toBeVisible();
    await expect(page.locator(".queue-drawer-pill")).toContainText("0/2");
    await expect(page.getByText("2 images in queue")).toBeVisible();
    await expect(page.getByRole("button", { name: /process/i })).toBeEnabled();

    await page.getByRole("button", { name: /process/i }).click();

    await expect
      .poll(
        async () => {
          const inf = removeBgCalls(await mockCalls(page));
          return inf.map((c) => JSON.stringify(c.args));
        },
        { timeout: 10_000 },
      )
      .toEqual([
        expect.stringContaining(PATH_A),
        expect.stringContaining(PATH_B),
      ]);

    await expect(page.getByTestId("app-notice")).toContainText(/2 succeeded/i, {
      timeout: 10_000,
    });
    await expect(page.locator(".queue-status.done")).toHaveCount(2);
  });

  test("Open folder starts folder session and writes under sibling -nobg", async ({
    page,
  }) => {
    await installMock(page, folderMock());
    await boot(page);

    await page.getByRole("button", { name: /open folder/i }).click();

    await expect(page.getByRole("switch", { name: "Watch" })).toBeVisible();
    await expect(page.locator(".queue-drawer-pill")).toContainText("0/2");
    await expect(page.locator(".file-block-source-text strong")).toHaveText(
      "folder",
    );

    await page.getByRole("button", { name: /process/i }).click();

    await expect
      .poll(
        async () => {
          const calls = await mockCalls(page);
          return calls.some(
            (c) =>
              c.cmd === "ensure_dir" &&
              JSON.stringify(c.args).includes(FOLDER_NOBG),
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    await expect
      .poll(
        async () => {
          const inf = removeBgCalls(await mockCalls(page));
          return (
            inf.length === 2 &&
            inf.every((c) => JSON.stringify(c.args).includes(`${FOLDER_NOBG}/`))
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    await expect(page.getByTestId("app-notice")).toContainText(/2 succeeded/i, {
      timeout: 10_000,
    });
  });

  test("Select image loads classic single (no queue)", async ({ page }) => {
    await installMock(page, { dialogOpenResult: E2E_FIXTURE_PATH });
    await boot(page);

    await page.getByRole("button", { name: "Select image" }).click();

    await expect(page.locator(".file-block-source-text strong")).toHaveText(
      "sample.png",
    );
    await expect(page.getByText("Single image")).toBeVisible();
    await expect(page.locator(".queue-drawer")).toHaveCount(0);
    await expect(page.locator(".queue-drawer-pill")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /process/i })).toBeEnabled();

    await page.getByRole("button", { name: /process/i }).click();

    await expect
      .poll(async () => removeBgCalls(await mockCalls(page)).length, {
        timeout: 10_000,
      })
      .toBe(1);
  });

  test("batch overwrite Skip existing only runs missing outputs", async ({
    page,
  }) => {
    await installMock(page, {
      existingPaths: ["/swiftmask/e2e/output/alpha-nobg-isnet-general-use.png"],
      dialogMessageResult: "Skip existing",
    });
    await boot(page);
    await injectDrop(page, [PATH_A, PATH_B]);
    await expect(page.locator(".queue-drawer-pill")).toContainText("0/2");

    await page.getByRole("button", { name: /process/i }).click();

    await expect
      .poll(
        async () => {
          const inf = removeBgCalls(await mockCalls(page));
          return inf.map((c) => JSON.stringify(c.args));
        },
        { timeout: 10_000 },
      )
      .toEqual([expect.stringContaining(PATH_B)]);

    await expect(page.locator(".queue-status.done")).toHaveCount(2, {
      timeout: 10_000,
    });
    const notice = page.getByTestId("app-notice");
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toHaveAttribute("data-severity", "info");
    await expect(notice).toContainText(/2 succeeded/i);
  });

  test("Watch on + folder:ready auto-runs only after first Process", async ({
    page,
  }) => {
    await installMock(
      page,
      folderMock({
        existingPaths: [`${FOLDER_NOBG}/new-b-nobg-isnet-general-use.png`],
        dialogMessageResult: "Cancel",
      }),
    );
    await boot(page);

    await page.getByRole("button", { name: /open folder/i }).click();
    const watch = page.getByRole("switch", { name: "Watch" });
    await expect(watch).toBeVisible();
    await page.locator(".watch-toggle").click();
    await expect(watch).toBeChecked();

    await expect
      .poll(async () => {
        const calls = await mockCalls(page);
        return calls.some((c) => c.cmd === "watch_folder_start");
      })
      .toBe(true);

    await emitMockEvent(page, "folder:ready", { path: WATCH_A });
    await expect(page.locator(".queue-row")).toHaveCount(3);
    expect(removeBgCalls(await mockCalls(page))).toHaveLength(0);

    await page.getByRole("button", { name: /process/i }).click();
    await expect(page.getByTestId("app-notice")).toContainText(/3 succeeded/i, {
      timeout: 10_000,
    });
    expect(removeBgCalls(await mockCalls(page))).toHaveLength(3);

    const messagesBefore = (await mockCalls(page)).filter(
      (c) => c.cmd === "dialog.message",
    ).length;

    await emitMockEvent(page, "folder:ready", { path: WATCH_B });

    await expect
      .poll(
        async () => {
          const inf = removeBgCalls(await mockCalls(page));
          return (
            inf.length === 4 && JSON.stringify(inf[3]?.args).includes(WATCH_B)
          );
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    const messagesAfter = (await mockCalls(page)).filter(
      (c) => c.cmd === "dialog.message",
    ).length;
    expect(messagesAfter).toBe(messagesBefore);

    await page.locator(".watch-toggle").click();
    await expect(watch).not.toBeChecked();
    await expect
      .poll(async () => {
        const calls = await mockCalls(page);
        return calls.some((c) => c.cmd === "watch_folder_stop");
      })
      .toBe(true);
  });

  test("queue row select switches preview; Clear completed prunes done rows", async ({
    page,
  }) => {
    await boot(page);
    await injectDrop(page, [PATH_A, PATH_B]);
    await page.getByRole("button", { name: /process/i }).click();
    await expect(page.locator(".queue-status.done")).toHaveCount(2, {
      timeout: 10_000,
    });

    await page
      .locator(".queue-row-main")
      .filter({ hasText: "alpha.png" })
      .click();
    await expect(page.locator(".queue-drawer-sub")).toContainText("alpha.png");
    await expect(page.locator(".queue-row.is-selected .queue-name")).toHaveText(
      "alpha.png",
    );

    await page
      .locator(".queue-row-main")
      .filter({ hasText: "beta.png" })
      .click();
    await expect(page.locator(".queue-drawer-sub")).toContainText("beta.png");
    await expect(page.locator(".queue-row.is-selected .queue-name")).toHaveText(
      "beta.png",
    );

    await page.getByRole("button", { name: "Queue actions" }).click();
    await page.getByRole("menuitem", { name: "Clear completed" }).click();
    await expect(page.locator(".queue-row")).toHaveCount(0);
    await expect(page.locator(".queue-drawer")).toHaveCount(0);
  });

  test("Show in folder records reveal after done", async ({ page }) => {
    await installMock(page, { dialogOpenResult: E2E_FIXTURE_PATH });
    await boot(page);

    await page.getByRole("button", { name: "Select image" }).click();
    await page.getByRole("button", { name: /process/i }).click();

    const show = page.getByRole("button", { name: "Show in folder" });
    await expect(show).toBeVisible({ timeout: 10_000 });
    await show.click();

    const expectedOutput =
      "/swiftmask/e2e/output/sample-nobg-isnet-general-use.png";
    await expect
      .poll(async () => {
        const calls = await mockCalls(page);
        return calls.some(
          (c) =>
            c.cmd === "revealItemInDir" &&
            JSON.stringify(c.args).includes(expectedOutput),
        );
      })
      .toBe(true);
  });

  test("Ctrl+Shift+O opens folder path into queue", async ({ page }) => {
    await installMock(page, folderMock());
    await boot(page);

    await page.keyboard.press("Control+Shift+O");

    await expect(page.getByRole("switch", { name: "Watch" })).toBeVisible();
    await expect(page.locator(".queue-drawer-pill")).toContainText("0/2");
    await expect(page.locator(".file-block-source-text strong")).toHaveText(
      "folder",
    );
  });
});
