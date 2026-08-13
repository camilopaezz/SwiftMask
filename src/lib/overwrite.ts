import i18n from "../i18n";

export async function shouldProceedWithOverwrite(
  outputPath: string,
  exists: (path: string) => Promise<boolean>,
  ask: (message: string) => Promise<boolean>,
): Promise<boolean> {
  const fileExists = await exists(outputPath);
  if (!fileExists) {
    return true;
  }
  return await ask(i18n.t("overwrite.singleAsk", { path: outputPath }));
}
