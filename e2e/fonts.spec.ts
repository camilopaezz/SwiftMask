import { expect, test } from "@playwright/test";
import { boot, installMock } from "./helpers";

test("bundled IBM Plex Sans loads offline and renders app text and controls", async ({
  page,
  baseURL,
}) => {
  await installMock(page);
  // A CDN import must not silently substitute the system font offline.
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === new URL(baseURL!).origin
      ? route.continue()
      : route.abort(),
  );
  await boot(page);

  for (const weight of [400, 500, 600, 650, 700]) {
    const loaded = await page.evaluate(async (fontWeight) => {
      const faces = await document.fonts.load(
        `${fontWeight} 14px "IBM Plex Sans"`,
        "SwiftMask imágenes configuración",
      );
      return (
        faces.length > 0 && faces.every((face) => face.status === "loaded")
      );
    }, weight);
    expect(loaded, `bundled IBM Plex Sans weight ${weight} must load`).toBe(
      true,
    );
  }

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const controls = page.locator("button, input, select");
  expect(await controls.count()).toBeGreaterThan(0);
  for (const control of await controls.all()) {
    await expect(control).toHaveCSS("font-family", /IBM Plex Sans/);
  }

  // Computed CSS alone can claim IBM Plex Sans while a fallback renders the glyphs.
  const session = await page.context().newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const { root } = await session.send("DOM.getDocument");
  for (const selector of [
    ".preview-empty-title",
    "#settings-shell-title",
    ".settings-update-title",
    ".settings-update-actions button",
  ]) {
    const { nodeId } = await session.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });
    const { fonts } = await session.send("CSS.getPlatformFontsForNode", {
      nodeId,
    });
    expect(fonts.length).toBeGreaterThan(0);
    expect(
      fonts.every(
        (font) =>
          font.isCustomFont && font.familyName.startsWith("IBM Plex Sans"),
      ),
    ).toBe(true);
  }
});
