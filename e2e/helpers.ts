import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { MODEL_REGISTRY } from "../src/lib/models";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_PATH = path.join(__dirname, "fixtures", "sample.png");
export const E2E_FIXTURE_PATH = "/swiftmask/e2e/fixtures/sample.png";

export const DEFAULT_CONFIG = {
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
    // Balanced ready — Turbo is benchmark-only and hidden from the UI.
    downloaded: m.bundled || m.id === "isnet-general-use",
  })),
};

export type MockOverrides = {
  config?: typeof DEFAULT_CONFIG;
  inferenceMode?: "success" | "error" | "fallback";
  failNextDownload?: boolean;
  downloadDelayMs?: number;
  dialogOpenResult?: string | null;
  dialogAskResult?: boolean;
  dialogMessageResult?: string;
  pickFolderResult?: string | null;
  pickOutputDirResult?: string | null;
  folderImages?: Record<string, string[]>;
  existingPaths?: string[];
  folderPaths?: string[];
};

export async function installMock(page: Page, overrides?: MockOverrides) {
  const fixtureBytes = await readFile(FIXTURE_PATH);
  const { config, ...rest } = overrides ?? {};

  await page.addInitScript(
    ({ config, fixtureArray, rest }) => {
      localStorage.removeItem("swiftmask:nc-license-ack");
      window.__SWIFTMASK_MOCK__ = {
        config,
        listeners: {},
        calls: [],
        fixtureBytes: new Uint8Array(fixtureArray),
        dialogOpenResult: null,
        dialogAskResult: true,
        dialogMessageResult: "Ok",
        pickFolderResult: null,
        pickOutputDirResult: null,
        folderImages: {},
        existingPaths: [],
        folderPaths: [],
        ...rest,
      };
    },
    {
      config: config ?? DEFAULT_CONFIG,
      fixtureArray: Array.from(fixtureBytes),
      rest,
    },
  );
}

export async function boot(page: Page) {
  await page.goto("/");
  await expect(page.getByText(/Drop images or a folder/i)).toBeVisible();
}

export async function injectDrop(page: Page, paths: string[]) {
  await page.evaluate((dropPaths) => {
    const hook = window.__swiftmaskInjectDrop;
    if (!hook) {
      throw new Error("E2E drop hook not available");
    }
    hook(dropPaths);
  }, paths);
}

export async function bootAndLoadFixture(page: Page) {
  await boot(page);
  await injectDrop(page, [E2E_FIXTURE_PATH]);
  await expect(page.getByRole("button", { name: /process/i })).toBeEnabled();
}

export async function mockCalls(page: Page) {
  return page.evaluate(() => {
    const state = window.__SWIFTMASK_MOCK__;
    if (!state) {
      throw new Error("SwiftMask mock state not available");
    }
    return state.calls;
  });
}

export async function emitMockEvent(
  page: Page,
  name: string,
  payload: unknown,
) {
  await page.evaluate(
    ({ name, payload }) => {
      const state = window.__SWIFTMASK_MOCK__;
      if (!state) {
        throw new Error("SwiftMask mock state not available");
      }
      for (const handler of state.listeners[name] ?? []) {
        handler({ payload });
      }
    },
    { name, payload },
  );
}
