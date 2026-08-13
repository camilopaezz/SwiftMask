import { useTranslation } from "react-i18next";

export type ProgressBarProps = {
  stage: string | null;
  progress: number;
};

const STAGE_KEYS: Record<string, string> = {
  decoding: "stages.decoding",
  preprocessing: "stages.preprocessing",
  inferring: "stages.inferring",
  "inferring-cpu": "stages.inferringCpu",
  postprocessing: "stages.postprocessing",
  encoding: "stages.encoding",
  Processing: "stages.processing",
  processing: "stages.processing",
};

export function stageLabel(
  stage: string | null | undefined,
  t: (key: string) => string,
): string {
  if (!stage) return t("stages.processing");
  const key = STAGE_KEYS[stage];
  return key ? t(key) : stage;
}

export function ProgressBar({ stage, progress }: ProgressBarProps) {
  const { t } = useTranslation();
  const clamped = Math.max(0, Math.min(100, progress));

  return (
    <div className="progress-bar">
      <div className="progress-bar-meta">
        <span>{stageLabel(stage, t)}</span>
        <span>{Math.round(clamped)}%</span>
      </div>
      <div className="progress-bar-track">
        <div className="progress-bar-fill" style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}
