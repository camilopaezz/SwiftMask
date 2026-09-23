import { describe, expect, it } from "vitest";
import { IMAGE_PICKER_EXTENSIONS, isImageFile } from "./imageExt";

describe("isImageFile", () => {
  it("accepts supported extensions case-insensitively", () => {
    expect(isImageFile("/a/b.PNG")).toBe(true);
    expect(isImageFile("x.webp")).toBe(true);
    expect(IMAGE_PICKER_EXTENSIONS).toEqual([
      "png",
      "jpg",
      "jpeg",
      "webp",
      "bmp",
    ]);
  });

  it("rejects non-images and extensionless paths", () => {
    expect(isImageFile("/a/b.txt")).toBe(false);
    expect(isImageFile("/folder")).toBe(false);
  });
});
