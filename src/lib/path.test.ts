import { describe, expect, it } from "vitest";
import { deriveOutputPath } from "./path";

describe("deriveOutputPath", () => {
  it("places output next to input when outputDir is unset", () => {
    expect(deriveOutputPath("/home/user/pics/photo.jpg", null, "u2netp")).toBe(
      "/home/user/pics/photo-nobg-u2netp.png",
    );
  });

  it("places output in configured outputDir", () => {
    expect(
      deriveOutputPath("/home/user/pics/photo.jpg", "/tmp/outputs", "rmbg-2.0"),
    ).toBe("/tmp/outputs/photo-nobg-rmbg-2.0.png");
  });

  it("handles windows-style input paths with consistent separators", () => {
    expect(
      deriveOutputPath(
        "C:\\Users\\pics\\photo.jpg",
        "D:\\Outputs",
        "isnet-general-use",
      ),
    ).toBe("D:\\Outputs\\photo-nobg-isnet-general-use.png");
  });

  it("keeps windows separators when output defaults next to input", () => {
    expect(
      deriveOutputPath(
        "C:\\TRABAJOS 2021\\WhatsApp Image.jpg",
        null,
        "isnet-general-use",
      ),
    ).toBe("C:\\TRABAJOS 2021\\WhatsApp Image-nobg-isnet-general-use.png");
  });

  it("strips trailing separators from outputDir", () => {
    expect(
      deriveOutputPath(
        "/home/user/pics/photo.jpg",
        "/tmp/outputs/",
        "rmbg-1.4",
      ),
    ).toBe("/tmp/outputs/photo-nobg-rmbg-1.4.png");
  });

  it("handles input paths without a directory", () => {
    expect(deriveOutputPath("photo.jpg", "/tmp/outputs", "u2netp")).toBe(
      "/tmp/outputs/photo-nobg-u2netp.png",
    );
    expect(deriveOutputPath("photo.jpg", null, "u2netp")).toBe(
      "./photo-nobg-u2netp.png",
    );
  });
});
