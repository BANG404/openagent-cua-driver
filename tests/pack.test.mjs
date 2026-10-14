import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractBuffer } from "../bin/lib/archive.mjs";

test("the installed archive includes all launcher imports and starts after extraction", () => {
  const root = join(import.meta.dir, "..");
  const manifest = JSON.parse(readFileSync(join(root, "plugin.json"), "utf8"));
  const packed = spawnSync(process.execPath, [join(root, "scripts", "pack.mjs")], { encoding: "utf8" });
  expect(packed.status).toBe(0);
  const archive = readFileSync(join(root, `openagent-cua-driver-v${manifest.version}.tar.gz`));
  const destination = mkdtempSync(join(tmpdir(), "cua-installed-"));
  try {
    extractBuffer(archive, "tar.gz", destination, "plugin.tar.gz");
    expect(readFileSync(join(destination, "bin", "lib", "mcp-screenshots.mjs"), "utf8"))
      .toContain("prepareScreenshotRequest");
    const installed = spawnSync(process.execPath, [join(destination, "bin", "cua-driver.mjs"), "--openagent-prepare"], {
      encoding: "utf8", env: { ...process.env, OPENAGENT_CUA_DRIVER_BIN: process.execPath,
        OPENAGENT_PLUGIN_HOST_URL: "", OPENAGENT_PLUGIN_HOST_TOKEN: "" },
    });
    expect(installed.status).toBe(0);
    expect(installed.stdout).toBe("");
    expect(installed.stderr).toContain("prepared");
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
