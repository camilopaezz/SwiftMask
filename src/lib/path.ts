/** Prefer Windows separators when either path looks Windows-like. */
function pathSeparator(...paths: (string | null | undefined)[]): string {
  for (const p of paths) {
    if (!p) continue;
    if (p.includes("\\") || /^[A-Za-z]:/.test(p)) return "\\";
  }
  return "/";
}

export function deriveOutputPath(
  inputPath: string,
  outputDir: string | null,
  modelId: string,
): string {
  const lastSep = Math.max(
    inputPath.lastIndexOf("/"),
    inputPath.lastIndexOf("\\"),
  );
  const dir = outputDir ?? (lastSep >= 0 ? inputPath.slice(0, lastSep) : ".");
  const file = lastSep >= 0 ? inputPath.slice(lastSep + 1) : inputPath;
  const dot = file.lastIndexOf(".");
  const stem = dot >= 0 ? file.slice(0, dot) : file;
  const sep = pathSeparator(inputPath, outputDir);
  return `${dir.replace(/[\\/]+$/, "")}${sep}${stem}-nobg-${modelId}.png`;
}
