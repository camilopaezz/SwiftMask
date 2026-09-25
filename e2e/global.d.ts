interface Window {
  __SWIFTMASK_MOCK__?: {
    config: {
      config: {
        execution_provider: string | null;
        output_dir: string | null;
      };
      gpuInfo: {
        vendor: string;
        vram_bytes: number | null;
        available_eps: string[];
        optimization: string;
      };
      benchmarkResult: {
        ep_latencies: { ep: string; seconds: number }[];
        winner_ep: string;
      };
      models: unknown[];
    };
    listeners: Record<string, Array<(event: { payload: unknown }) => void>>;
    calls: { cmd: string; args: unknown }[];
    fixtureBytes: Uint8Array;
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
  __swiftmaskInjectDrop?: (paths: string[]) => void;
}
