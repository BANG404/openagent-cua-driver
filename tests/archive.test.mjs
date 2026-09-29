import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractBuffer } from "../bin/lib/archive.mjs";
import {
  buildTarGz,
  buildZip,
  zipSymbolicLink,
  zipTraversal,
  zipWithFile,
} from "./fixtures.mjs";

let destination;
let outside;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "cua-driver-archive-"));
  destination = join(root, "extracted");
  outside = join(root, "escaped.txt");
});

afterEach(() => {
  rmSync(join(destination, ".."), { recursive: true, force: true });
});

describe("zip", () => {
  test("extracts a deflated member at its name", () => {
    extractBuffer(zipWithFile("cua-driver.exe", "binary", 8), "zip", destination, "asset.zip");

    expect(readFileSync(join(destination, "cua-driver.exe"), "utf8")).toBe("binary");
  });

  test("extracts a stored member", () => {
    extractBuffer(zipWithFile("cua-driver.exe", "stored", 0), "zip", destination, "asset.zip");

    expect(readFileSync(join(destination, "cua-driver.exe"), "utf8")).toBe("stored");
  });

  test("creates the directories a nested member names", () => {
    extractBuffer(
      zipWithFile("wayland-helper/install.sh", "script", 8),
      "zip",
      destination,
      "asset.zip",
    );

    expect(readFileSync(join(destination, "wayland-helper", "install.sh"), "utf8")).toBe("script");
  });

  test("refuses a member that walks out of the destination", () => {
    expect(() =>
      extractBuffer(zipTraversal(), "zip", destination, "asset.zip"),
    ).toThrow(/traversing entry/);
    expect(existsSync(outside)).toBe(false);
  });

  test("refuses a member marked as a symbolic link", () => {
    expect(() =>
      extractBuffer(zipSymbolicLink(), "zip", destination, "asset.zip"),
    ).toThrow(/links 'cua-driver'/);
  });

  test("refuses a compression method it cannot read", () => {
    const archive = buildZip([{ name: "cua-driver.exe", contents: "x", method: 12 }]);

    expect(() => extractBuffer(archive, "zip", destination, "asset.zip")).toThrow(
      /unsupported method 12/,
    );
  });

  test("refuses bytes that are not a zip at all", () => {
    expect(() => extractBuffer(Buffer.from("not a zip"), "zip", destination, "asset.zip")).toThrow(
      /central directory/,
    );
  });
});

describe("tar.gz", () => {
  test("extracts a file with the mode the archive recorded", () => {
    const archive = buildTarGz([
      { name: "cua-driver", contents: "binary", type: "0", mode: 0o755 },
    ]);

    extractBuffer(archive, "tar.gz", destination, "asset.tar.gz");

    const extracted = join(destination, "cua-driver");
    expect(readFileSync(extracted, "utf8")).toBe("binary");
    if (process.platform !== "win32") {
      // The driver is started directly, so the bit that makes it runnable is
      // part of what extraction has to preserve.
      expect(statSync(extracted).mode & 0o100).toBe(0o100);
    }
  });

  test("extracts nested members under their directory", () => {
    const archive = buildTarGz([
      { name: "wayland-helper", type: "5" },
      { name: "wayland-helper/install.sh", contents: "script", type: "0" },
    ]);

    extractBuffer(archive, "tar.gz", destination, "asset.tar.gz");

    expect(readFileSync(join(destination, "wayland-helper", "install.sh"), "utf8")).toBe("script");
  });

  test("refuses a member that walks out of the destination", () => {
    const archive = buildTarGz([{ name: "../escaped.txt", contents: "escaped", type: "0" }]);

    expect(() => extractBuffer(archive, "tar.gz", destination, "asset.tar.gz")).toThrow(
      /traversing entry/,
    );
    expect(existsSync(outside)).toBe(false);
  });

  test("refuses a symbolic link member", () => {
    const archive = buildTarGz([
      { name: "cua-driver", type: "2", linkname: "/etc/passwd" },
    ]);

    expect(() => extractBuffer(archive, "tar.gz", destination, "asset.tar.gz")).toThrow(
      /member type '2'/,
    );
  });

  test("refuses a PAX header rather than half-reading its path", () => {
    const archive = buildTarGz([{ name: "PaxHeaders/x", contents: "path=x", type: "x" }]);

    expect(() => extractBuffer(archive, "tar.gz", destination, "asset.tar.gz")).toThrow(
      /member type 'x'/,
    );
  });

  test("refuses bytes that are not a gzipped tar", () => {
    const notGzip = Buffer.from("not gzip".padEnd(1024, "\0"));

    expect(() => extractBuffer(notGzip, "tar.gz", destination, "asset.tar.gz")).toThrow();
  });
});
