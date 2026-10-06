import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { latestDriverPins, resolveDriver } from "../bin/lib/update.mjs";
import { provisionDriver } from "../bin/lib/provision.mjs";
import { zipWithFile } from "./fixtures.mjs";

const repository = "https://github.com/trycua/cua";
const key = "windows-x86_64";
const assetName = (version) => `cua-driver-rs-${version}-${key}-binary.zip`;
const archive = (version) => zipWithFile("cua-driver.exe", `driver ${version}`, 8);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function selection(version) {
  return {
    repository, version, release: `cua-driver-rs-v${version}`,
    platforms: { [key]: { asset: assetName(version), executable: "cua-driver.exe", sha256: digest(archive(version)) } },
  };
}
function release(version, extra = {}) {
  return {
    tag_name: `cua-driver-rs-v${version}`, prerelease: true, draft: false,
    assets: [{ name: assetName(version), digest: `sha256:${digest(archive(version))}`,
      browser_download_url: `${repository}/releases/download/cua-driver-rs-v${version}/${assetName(version)}` }],
    ...extra,
  };
}
let root, server, downloadRequests, failedDownload;
let releases, checks, logs;
const pins = selection("0.30.1");
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cua-update-"));
  checks = 0;
  downloadRequests = [];
  failedDownload = false;
  releases = [release("0.34.0")];
  logs = [];
  server = createServer((request, response) => {
    downloadRequests.push(request.url);
    const version = /cua-driver-rs-v([\d.]+)\//.exec(request.url)?.[1];
    response.writeHead(failedDownload && version !== pins.version ? 503 : 200);
    response.end(version ? archive(version) : "missing");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});
function options(extra = {}) {
  return {
    dataRoot: root, pins, platform: "win32", arch: "x64", log: (message) => logs.push(message),
    now: 1_000_000, checkUpdates: true,
    fetchImpl: async () => { checks += 1; return Response.json(releases); },
    provision: (input) => provisionDriver({ ...input, pins: {
      ...input.pins, repository: `http://127.0.0.1:${server.address().port}`,
    } }),
    ...extra,
  };
}
const statePath = () => join(root, "driver", "update.json");

describe("Cua Driver automatic updates", () => {
  test("selects the highest stable component tag even when GitHub marks it prerelease", async () => {
    releases = [release("0.33.4"), release("0.34.0"), release("0.35.0", { draft: true }),
      release("0.99.0", { tag_name: "nightly-cua-driver-rs-v0.99.0" }),
      release("0.40.0-rc.1"), release("8.0.0", { tag_name: "cua-sdk-v8.0.0" })];
    const result = await resolveDriver(options());
    expect(readFileSync(result.path, "utf8")).toBe("driver 0.34.0");
    expect(JSON.parse(readFileSync(statePath(), "utf8")).selection.version).toBe("0.34.0");
    expect(downloadRequests).toHaveLength(1);
  });

  test("serve, MCP and stop reuse the activated driver without a release check or download", async () => {
    const prepared = await resolveDriver(options());
    const result = await resolveDriver(options({ checkUpdates: false, now: 99_000_000 }));
    expect(result.path).toBe(prepared.path);
    expect(result.source).toBe("cache");
    expect(checks).toBe(1);
    expect(downloadRequests).toHaveLength(1);
  });

  test("throttles checks and advances after six hours without downgrading", async () => {
    await resolveDriver(options());
    await resolveDriver(options({ now: 2_000_000 }));
    expect(checks).toBe(1);
    releases = [release("0.33.4")];
    const result = await resolveDriver(options({ now: 1_000_000 + 6 * 60 * 60 * 1000 }));
    expect(checks).toBe(2);
    expect(readFileSync(result.path, "utf8")).toBe("driver 0.34.0");
  });

  test("keeps the verified active driver when a newer download fails and throttles retries", async () => {
    const current = await resolveDriver(options());
    releases = [release("0.35.0")];
    failedDownload = true;
    const now = 30_000_000;
    const result = await resolveDriver(options({ now }));
    expect(result.path).toBe(current.path);
    expect(existsSync(current.path)).toBe(true);
    expect(logs.some((message) => message.includes("automatic update failed"))).toBe(true);
    await resolveDriver(options({ now: now + 1000 }));
    expect(checks).toBe(2);
    expect(JSON.parse(readFileSync(statePath(), "utf8")).selection.version).toBe("0.34.0");
  });

  test("retains the previous driver and built-in pin after successful activation", async () => {
    const original = await resolveDriver(options({ checkUpdates: false }));
    const first = await resolveDriver(options());
    releases = [release("0.35.0")];
    const second = await resolveDriver(options({ now: 30_000_000 }));
    expect(readFileSync(second.path, "utf8")).toBe("driver 0.35.0");
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(original.path)).toBe(true);
  });

  test("falls back to the built-in pin on offline first preparation and rate limiting", async () => {
    const result = await resolveDriver(options({ fetchImpl: async () => {
      checks += 1; return new Response("quota", { status: 403 });
    } }));
    expect(readFileSync(result.path, "utf8")).toBe("driver 0.30.1");
    await resolveDriver(options());
    expect(checks).toBe(1);
  });

  test("rejects missing digests, digest mismatches and untrusted asset URLs", async () => {
    for (const modification of [
      { digest: null }, { digest: `sha256:${"0".repeat(64)}` },
      { browser_download_url: "https://evil.example/driver.zip" },
    ]) {
      rmSync(join(root, "driver"), { recursive: true, force: true });
      const latest = release("0.34.0");
      Object.assign(latest.assets[0], modification);
      releases = [latest];
      const result = await resolveDriver(options());
      expect(readFileSync(result.path, "utf8")).toBe("driver 0.30.1");
      expect(JSON.parse(readFileSync(statePath(), "utf8")).selection).toBeUndefined();
    }
  });

  test("repairs a damaged selected driver and falls back if its download is unavailable", async () => {
    const current = await resolveDriver(options());
    writeFileSync(current.path, "tampered");
    const repaired = await resolveDriver(options({ checkUpdates: false }));
    expect(readFileSync(repaired.path, "utf8")).toBe("driver 0.34.0");
    writeFileSync(repaired.path, "tampered again");
    failedDownload = true;
    const fallback = await resolveDriver(options());
    expect(readFileSync(fallback.path, "utf8")).toBe("driver 0.30.1");
    expect(JSON.parse(readFileSync(statePath(), "utf8")).selection).toBeUndefined();
  });

  test("ignores corrupt state and selectors that escape the release cache", async () => {
    await resolveDriver(options());
    for (const state of ["{broken", JSON.stringify({ version: 1, repository, platform: key,
      selection: { ...selection("0.34.0"), platforms: { [key]: {
        ...selection("0.34.0").platforms[key], sha256: "../../outside",
      } } } })]) {
      writeFileSync(statePath(), state);
      const result = await resolveDriver(options({ checkUpdates: false }));
      expect(readFileSync(result.path, "utf8")).toBe("driver 0.30.1");
    }
  });

  test("paginates the monorepo and skips a release missing this platform", async () => {
    const requested = [];
    const result = await latestDriverPins({ ...options(), fetchImpl: async (url) => {
      requested.push(url);
      return Response.json(requested.length === 1
        ? Array.from({ length: 100 }, () => ({ tag_name: "cua-sdk-v8.0.0" }))
        : [release("0.35.0", { assets: [] }), release("0.34.0")]);
    } });
    expect(result.version).toBe("0.34.0");
    expect(requested[1]).toContain("page=2");
  });

  test("concurrent preparation installs complete verified archives", async () => {
    const results = await Promise.all([resolveDriver(options()), resolveDriver(options())]);
    for (const result of results) {
      expect(readFileSync(result.path, "utf8")).toBe("driver 0.34.0");
      expect(JSON.parse(readFileSync(join(dirname(result.path), "openagent-driver.json"), "utf8"))
        .executableSha256).toBe(digest(Buffer.from("driver 0.34.0")));
    }
  });

  test("serve does not wait for another process's preparation lock", async () => {
    const prepared = await resolveDriver(options());
    mkdirSync(join(root, "driver", "update.lock"));
    const result = await resolveDriver(options({ checkUpdates: false }));
    expect(result.path).toBe(prepared.path);
    expect(checks).toBe(1);
  });

  test("an exhausted preparation deadline retains a verified fallback without a partial activation", async () => {
    const original = await resolveDriver(options({ checkUpdates: false }));
    const result = await resolveDriver(options({ signal: AbortSignal.abort() }));
    expect(result.path).toBe(original.path);
    expect(JSON.parse(readFileSync(statePath(), "utf8")).selection).toBeUndefined();
  });

  test("recovers a lock left by a dead preparation process", async () => {
    const lock = join(root, "driver", "update.lock");
    mkdirSync(lock, { recursive: true });
    // This PID is beyond the platform's live PID range but valid for kill(pid, 0).
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 2_147_483_647 }));
    const result = await resolveDriver(options());
    expect(readFileSync(result.path, "utf8")).toBe("driver 0.34.0");
    expect(existsSync(lock)).toBe(false);
  });

  test("supports every pinned platform's binary asset naming and macOS universal builds", async () => {
    const builtIn = JSON.parse(readFileSync(new URL("../bin/lib/pins.json", import.meta.url), "utf8"));
    for (const [platform, arch, platformId] of [
      ["win32", "x64", "windows-x86_64"], ["win32", "arm64", "windows-arm64"],
      ["darwin", "x64", "darwin-universal"], ["darwin", "arm64", "darwin-universal"],
      ["linux", "x64", "linux-x86_64"], ["linux", "arm64", "linux-arm64"],
    ]) {
      const name = builtIn.platforms[platformId].asset.replace(builtIn.version, "0.34.0");
      const result = await latestDriverPins({ pins: builtIn, platform, arch, fetchImpl: async () =>
        Response.json([{ ...release("0.34.0"), assets: [{ name, digest: `sha256:${"a".repeat(64)}`,
          browser_download_url: `${repository}/releases/download/cua-driver-rs-v0.34.0/${name}` }] }]) });
      expect(result.platforms[platformId].asset).toBe(name);
      expect(result.platforms[platformId].executable).toBe(builtIn.platforms[platformId].executable);
    }
  });
});
