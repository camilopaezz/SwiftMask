import { getMockState } from "./mockState";

/** In-flight inference promise — cancel waits on this (mirrors wait_until_idle). */
let activeInference: Promise<void> | null = null;

/**
 * E2E runs in a browser with mocked IPC, not a Tauri webview.
 * Keep false so updater short-circuits without calling plugin:updater|check.
 */
export function isTauri(): boolean {
  return false;
}

/** Minimal Resource stub for @tauri-apps/plugin-updater (Update extends Resource). */
export class Resource {
  readonly rid: number;

  constructor(rid: number) {
    this.rid = rid;
  }

  async close(): Promise<void> {}
}

/** Minimal Channel stub so plugin-updater can load under the core alias. */
export class Channel<T = unknown> {
  id = 0;
  onmessage: (response: T) => void = () => {};

  constructor(onmessage?: (response: T) => void) {
    if (onmessage) {
      this.onmessage = onmessage;
    }
  }
}

export function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const state = getMockState();
  state.calls.push({ cmd, args: args ?? {} });

  switch (cmd) {
    case "get_config":
      return Promise.resolve(state.config.config as T);
    case "detect_gpu":
      return Promise.resolve(state.config.gpuInfo as T);
    case "run_benchmark":
      return Promise.resolve(state.config.benchmarkResult as T);
    case "set_ep": {
      const ep = args?.ep;
      if (typeof ep === "string") {
        state.config.config.execution_provider = ep.toLowerCase();
      }
      return Promise.resolve(undefined as T);
    }
    case "list_models":
      return Promise.resolve(state.config.models as T);
    case "download_model": {
      // FE uses camelCase `modelId`; tolerate snake_case too.
      const modelId = (args?.modelId ?? args?.model_id) as string;
      return simulateDownload(modelId) as Promise<T>;
    }
    case "cancel_download":
      return Promise.resolve(undefined as T);
    case "pick_output_dir":
      return Promise.resolve(state.config.config.output_dir as T);
    case "clear_output_dir":
      state.config.config.output_dir = null;
      return Promise.resolve(undefined as T);
    case "remove_image_background": {
      const inner = (args as Record<string, unknown>).args as {
        id: string;
        outputPath: string;
      };
      return simulateInference(inner) as Promise<T>;
    }
    case "cancel_inference":
      // Match production: resolve only after the in-flight worker finishes.
      return (activeInference ?? Promise.resolve()) as Promise<T>;
    case "path_exists":
      return Promise.resolve(false as T);
    case "path_is_dir": {
      // Fixture paths are files; treat bare paths without a trailing separator
      // as files so multi-drop enqueue works in mocked e2e.
      const path = String(args?.path ?? "");
      return Promise.resolve(
        (path.endsWith("/") || path.endsWith("\\")) as T,
      );
    }
    case "get_runtime_info":
      return Promise.resolve({
        app_version: "1.0.0",
        ort_version: "1.24",
      } as T);
    default:
      return Promise.reject(new Error(`Unhandled mock command: ${cmd}`));
  }
}

function emitEvent(event: string, payload: unknown) {
  const state = getMockState();
  for (const handler of state.listeners[event] ?? []) {
    handler({ payload });
  }
}

function simulateInference(args: {
  id: string;
  outputPath: string;
}): Promise<void> {
  const state = getMockState();
  const { id, outputPath } = args;
  const mode = state.inferenceMode ?? "success";

  const promise = new Promise<void>((resolve) => {
    setTimeout(() => {
      emitEvent("inference:progress", { id, stage: "preprocessing", pct: 0 });
    }, 50);

    setTimeout(() => {
      emitEvent("inference:progress", { id, stage: "inferring", pct: 50 });
    }, 150);

    setTimeout(() => {
      if (mode === "error") {
        // Job failures are event-only in production (command returns Ok).
        emitEvent("inference:error", {
          id,
          code: "oom",
          message: "CUDA out of memory",
        });
        resolve();
        return;
      }

      if (mode === "fallback") {
        emitEvent("inference:fallback", {
          id,
          reason: "oom",
          from_ep: "cuda",
          to_ep: "cpu",
        });
        emitEvent("inference:progress", {
          id,
          stage: "inferring-cpu",
          pct: 55,
        });
      }

      emitEvent("inference:progress", { id, stage: "encoding", pct: 100 });
      emitEvent("inference:done", {
        id,
        output_path: outputPath,
        timings: {
          stages: [
            { stage: "decoding", seconds: 0.01 },
            { stage: "preprocessing", seconds: 0.02 },
            { stage: "inferring", seconds: 0.15 },
            { stage: "postprocessing", seconds: 0.03 },
            { stage: "encoding", seconds: 0.02 },
          ],
          total_seconds: 0.23,
        },
      });
      resolve();
    }, 250);
  }).finally(() => {
    if (activeInference === promise) {
      activeInference = null;
    }
  });

  activeInference = promise;
  return promise;
}

function simulateDownload(modelId: string): Promise<void> {
  const state = getMockState();
  if (state.failNextDownload) {
    state.failNextDownload = false;
    return Promise.reject({
      code: "network",
      message: "request failed: connection refused",
    });
  }
  return new Promise((resolve) => {
    setTimeout(
      () =>
        emitEvent("model:download", {
          model_id: modelId,
          pct: 50,
          stage: "download",
        }),
      50,
    );
    setTimeout(() => {
      emitEvent("model:download", {
        model_id: modelId,
        pct: 100,
        stage: "verify",
      });
      // Mark model downloaded so retry / badge flip work like production.
      state.config.models = state.config.models.map((m) =>
        m.id === modelId ? { ...m, downloaded: true } : m,
      );
      resolve();
    }, 100);
  });
}

export function listen<T>(
  eventName: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  const state = getMockState();
  if (!state.listeners[eventName]) {
    state.listeners[eventName] = [];
  }
  const wrapped = (event: { payload: unknown }) =>
    handler(event as { payload: T });
  state.listeners[eventName].push(wrapped);
  return Promise.resolve(() => {
    const idx = state.listeners[eventName].indexOf(wrapped);
    if (idx >= 0) {
      state.listeners[eventName].splice(idx, 1);
    }
  });
}

const blobUrlCache = new Map<string, string>();

export function convertFileSrc(filePath: string, _protocol?: string): string {
  const state = getMockState();
  if (
    state.fixtureBytes.length > 0 &&
    /\.(png|jpe?g|webp|bmp)$/i.test(filePath)
  ) {
    let cached = blobUrlCache.get(filePath);
    if (!cached) {
      const blob = new Blob([state.fixtureBytes], { type: "image/png" });
      cached = URL.createObjectURL(blob);
      blobUrlCache.set(filePath, cached);
    }
    return cached;
  }
  return `file://${filePath}`;
}
