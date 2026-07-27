/** Frontend map from license display string → official license URL. */
const LICENSE_URLS: Readonly<Record<string, string>> = {
  "Apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
  "CC BY-NC 4.0": "https://creativecommons.org/licenses/by-nc/4.0/",
};

export const APP_LINKS = {
  repo: "https://github.com/camilopaezz/SwiftMask",
  issues: "https://github.com/camilopaezz/SwiftMask/issues",
  mit: "https://github.com/camilopaezz/SwiftMask/blob/main/LICENSE",
} as const;

export function licenseUrlFor(license: string): string | null {
  return LICENSE_URLS[license] ?? null;
}
