import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";

const LAUNCHER = join(import.meta.dir, "..", "bin", "cua-driver.mjs");

/**
 * Run the launcher with a driver that is this same Node, so a test can observe
 * exactly what the launcher passed on.
 */
function run(args, environment = {}) {
  return spawnSync(process.execPath, [LAUNCHER, ...args], {
    encoding: "utf8",
    env: { ...process.env, PLUGIN_DATA: "", ...environment },
  });
}

function runAsync(args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LAUNCHER, ...args], {
      env: { ...process.env, PLUGIN_DATA: "", ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const ECHO_ARGV = "console.log(JSON.stringify(process.argv.slice(1)))";

describe("the launcher", () => {
  test("passes its arguments to the driver unchanged", () => {
    const result = run(["-e", ECHO_ARGV, "extra"], {
      OPENAGENT_CUA_DRIVER_BIN: process.execPath,
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["extra"]);
  });

  test("reports the driver's exit code", () => {
    const result = run(["-e", "process.exit(7)"], {
      OPENAGENT_CUA_DRIVER_BIN: process.execPath,
    });

    expect(result.status).toBe(7);
  });

  test("keeps stdout clean for the MCP transport", () => {
    // The driver's own stdout is the MCP channel, so the launcher's readiness
    // message and its fetch progress must never land there.
    const result = run(["--openagent-prepare"], {
      OPENAGENT_CUA_DRIVER_BIN: process.execPath,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("prepared");
  });

  test("uses the live host locale for launcher notices", async () => {
    const host = createServer(async (request, response) => {
      for await (const _chunk of request) {}
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: { version: 1, locale: "zh-CN" } }));
    });
    await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
    try {
      const result = await runAsync(["--openagent-prepare"], {
        OPENAGENT_CUA_DRIVER_BIN: process.execPath,
        OPENAGENT_PLUGIN_HOST_URL: `http://127.0.0.1:${host.address().port}/bridge`,
        OPENAGENT_PLUGIN_HOST_TOKEN: "test-token",
        OPENAGENT_PLUGIN_ID: "cua-driver",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("已准备 Cua Driver");
    } finally {
      await new Promise((resolve) => host.close(resolve));
    }
  });

  test("prepares without starting the driver, and never forwards the flag", () => {
    const result = run(["--openagent-prepare"], {
      OPENAGENT_CUA_DRIVER_BIN: process.execPath,
    });

    expect(result.stdout).toBe("");
    // Reaching the driver would have printed its argv, and this driver would
    // have refused `--openagent-prepare` as an unknown option.
    expect(result.stderr).not.toContain("extra");
  });

  test("names the missing data root instead of starting nothing", () => {
    const result = run(["--version"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PLUGIN_DATA is not set");
    expect(result.stderr).toContain("OPENAGENT_CUA_DRIVER_BIN");
  });

  test("names the failing driver when the override cannot start", () => {
    const result = run(["--version"], { OPENAGENT_CUA_DRIVER_BIN: "definitely-not-a-driver" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OPENAGENT_CUA_DRIVER_BIN");
  });
});
