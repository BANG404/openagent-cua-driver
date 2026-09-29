import { describe, expect, test } from "bun:test";

import { archiveKind, platformKey } from "../bin/lib/platform.mjs";
import { readPins } from "../bin/lib/provision.mjs";

const pins = readPins();

describe("platformKey", () => {
  test("maps each supported machine to a pinned key", () => {
    expect(platformKey("win32", "x64")).toBe("windows-x86_64");
    expect(platformKey("win32", "arm64")).toBe("windows-arm64");
    expect(platformKey("darwin", "arm64")).toBe("darwin-universal");
    expect(platformKey("darwin", "x64")).toBe("darwin-universal");
    expect(platformKey("linux", "x64")).toBe("linux-x86_64");
    expect(platformKey("linux", "arm64")).toBe("linux-arm64");
  });

  test("refuses to guess a machine the table does not cover", () => {
    expect(platformKey("win32", "ia32")).toBeNull();
    expect(platformKey("linux", "ppc64")).toBeNull();
    expect(platformKey("freebsd", "x64")).toBeNull();
  });
});

describe("archiveKind", () => {
  test("recognizes the formats the pinned releases use", () => {
    expect(archiveKind("asset.zip")).toBe("zip");
    expect(archiveKind("asset.tar.gz")).toBe("tar.gz");
    expect(archiveKind("asset.tgz")).toBe("tar.gz");
    expect(archiveKind("asset.tar.xz")).toBeNull();
  });
});

describe("the pin table", () => {
  test("names a digest and an executable for every platform", () => {
    for (const [key, pin] of Object.entries(pins.platforms)) {
      expect(pin.sha256, key).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.executable.length, key).toBeGreaterThan(0);
      expect(archiveKind(pin.asset), key).not.toBeNull();
      expect(pin.asset, key).toContain(pins.version);
    }
  });

  test("covers every key the platform mapping can produce", () => {
    const producible = new Set([
      platformKey("win32", "x64"),
      platformKey("win32", "arm64"),
      platformKey("darwin", "arm64"),
      platformKey("darwin", "x64"),
      platformKey("linux", "x64"),
      platformKey("linux", "arm64"),
    ]);

    expect([...producible].sort()).toEqual(Object.keys(pins.platforms).sort());
  });

  test("keeps the Windows digest this package was reviewed against", () => {
    // The driver a user runs is the bytes this digest names, so an accidental
    // edit here would silently re-point the package at different software.
    expect(pins.platforms["windows-x86_64"].sha256).toBe(
      "96ebb5996c0e25adf40ed648a46959723d31df5d90f24ffe2fb2d3cc2ee780be",
    );
    expect(pins.platforms["windows-x86_64"].asset).toBe(
      "cua-driver-rs-0.30.1-windows-x86_64-binary.zip",
    );
  });

  test("is a stable release rather than a nightly", () => {
    expect(pins.release).toBe(`cua-driver-rs-v${pins.version}`);
    expect(pins.release).not.toContain("nightly");
  });
});
