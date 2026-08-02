/**
 * Frontend model types and helpers.
 * Static registry is generated from Rust (`src-tauri/src/models.rs`).
 * Runtime availability (`downloaded`) comes only from `list_models`.
 */
export type { ModelMode, ModelStaticMeta } from "./models.generated";
export { getModelById, MODEL_REGISTRY } from "./models.generated";

import type { ModelMode, ModelStaticMeta } from "./models.generated";

/** Preferred default quality mode when its weights are on disk. */
export const PREFERRED_DEFAULT_MODE: ModelMode = "isnet-general-use";

/**
 * Bundled model used only for offline EP benchmark (and smoke tests).
 * Not user-facing — never select for Process or show in the mode rail.
 */
export const INTERNAL_BENCHMARK_MODE: ModelMode = "u2netp";

/** Runtime model metadata returned by `list_models` (static fields + download state). */
export type ModelMeta = ModelStaticMeta & {
  downloaded: boolean;
};

export function isModelReady(
  model: Pick<ModelMeta, "bundled" | "downloaded">,
): boolean {
  return model.bundled || model.downloaded;
}

/** Models shown in the quality-mode UI and allowed for Process. */
export function isUserFacingModel(model: { id: string }): boolean {
  return model.id !== INTERNAL_BENCHMARK_MODE;
}

/** True when `mode` is a ready, user-facing catalog entry. */
export function isProcessableMode(
  mode: string,
  models: readonly ModelMeta[],
): boolean {
  const meta = models.find((m) => m.id === mode);
  return Boolean(meta && isUserFacingModel(meta) && isModelReady(meta));
}

/**
 * Reconcile the selected mode against the runtime catalog (strict).
 * - Keep current when it is user-facing and ready.
 * - Prefer Balanced when ready.
 * - Else first ready user-facing model.
 * - If nothing is ready: keep current when it is user-facing (download target),
 *   else preferred — never Turbo.
 */
export function resolveMode(
  current: ModelMode,
  models: readonly ModelMeta[],
  preferred: ModelMode = PREFERRED_DEFAULT_MODE,
): ModelMode {
  const currentMeta = models.find((m) => m.id === current);
  if (
    currentMeta &&
    isUserFacingModel(currentMeta) &&
    isModelReady(currentMeta)
  ) {
    return current;
  }

  const preferredMeta = models.find((m) => m.id === preferred);
  if (
    preferredMeta &&
    isUserFacingModel(preferredMeta) &&
    isModelReady(preferredMeta)
  ) {
    return preferred;
  }

  const firstReady = models.find(
    (m) => isUserFacingModel(m) && isModelReady(m),
  );
  if (firstReady) {
    return firstReady.id as ModelMode;
  }

  // Nothing ready: stick to a user-facing download target (not Turbo).
  if (currentMeta && isUserFacingModel(currentMeta)) {
    return current;
  }
  return preferred;
}
