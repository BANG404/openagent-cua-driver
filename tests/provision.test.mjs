import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { provisionDriver, sha256File } from "../bin/lib/provision.mjs";
import { zipWithFile } from "./fixtures.mjs";

const ASSET = "cua-driver-rs-9.9.9-windows-x86_64-binary.zip";
const EXECUTABLE = "cua-driver.exe";

let root;
let dataRoot;
let server;
let requests;
let payload;
let status;

/** A pin table pointed at the fixture server rather than at GitHub. */
function pinsFor(digest) {
  return {
    repository: `http://127.0.0.1:${server.address().port}`,
    release: "cua-driver-rs-v9.9.9",
    version: "9.9.9",
    platforms: {
      "windows-x86_64": { asset: ASSET, sha256: digest, executable: EXECUTABLE },
    },
  };
}

function provision(pins, arch = "x64") {
  return provisionDriver({
    dataRoot,
    platform: "win32",
    arch,
    pins,
    log: () => {},
  });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cua-driver-provision-"));
  dataRoot = join(root, "plugin-data");
  requests = 0;
  payload = zipWithFile(EXECUTABLE, "driver bytes", 8);
  status = 200;
  server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(status);
    response.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

describe("provisionDriver", () => {
  test("downloads, verifies, and extracts the pinned asset", async () => {
    const digest = createHash("sha256").update(payload).digest("hex");

    const result = await provision(pinsFor(digest));

    expect(result.source).toBe("provisioned");
    expect(readFileSync(result.path, "utf8")).toBe("driver bytes");
    expect(result.path.startsWith(dataRoot)).toBe(true);
    expect(requests).toBe(1);
  });

  test("reuses a verified release without another download", async () => {
    const digest = createHash("sha256").update(payload).digest("hex");
    const first = await provision(pinsFor(digest));

    const second = await provision(pinsFor(digest));

    expect(second.source).toBe("cache");
    expect(second.path).toBe(first.path);
    expect(requests).toBe(1);
  });

  test("refuses an asset that does not match the pinned digest", async () => {
    const wrong = "0".repeat(64);

    await expect(provision(pinsFor(wrong))).rejects.toThrow(/not the pinned/);
    expect(existsSync(join(dataRoot, "driver", wrong))).toBe(false);
  });

  test("re-provisions when the cached executable no longer matches its record", async () => {
    const digest = createHash("sha256").update(payload).digest("hex");
    const first = await provision(pinsFor(digest));
    writeFileSync(first.path, "tampered");

    const second = await provision(pinsFor(digest));

    expect(second.source).toBe("provisioned");
    expect(readFileSync(second.path, "utf8")).toBe("driver bytes");
    expect(requests).toBe(2);
  });

  test("names the platform when the table does not cover this machine", async () => {
    const pins = pinsFor("0".repeat(64));

    await expect(provision(pins, "ia32")).rejects.toThrow(
      /publishes no pinned release for win32\/ia32/,
    );
    expect(requests).toBe(0);
  });

  test("names the missing key when the table omits one it could map", async () => {
    const pins = { ...pinsFor("0".repeat(64)), platforms: {} };

    await expect(provision(pins)).rejects.toThrow(/no entry for 'windows-x86_64'/);
    expect(requests).toBe(0);
  });

  test("reports the status when the download fails", async () => {
    status = 404;
    const digest = createHash("sha256").update(payload).digest("hex");

    await expect(provision(pinsFor(digest))).rejects.toThrow(/404/);
  });

  test("refuses an archive that does not contain the pinned executable", async () => {
    payload = zipWithFile("something-else.exe", "driver bytes", 8);
    const digest = createHash("sha256").update(payload).digest("hex");

    await expect(provision(pinsFor(digest))).rejects.toThrow(/does not contain 'cua-driver.exe'/);
  });

  test("removes the previous release and leaves anything else alone", async () => {
    const stale = join(dataRoot, "driver", "a".repeat(64));
    const staging = join(dataRoot, "driver", `${"b".repeat(64)}.staging-1234`);
    mkdirSync(stale, { recursive: true });
    mkdirSync(staging, { recursive: true });
    const digest = createHash("sha256").update(payload).digest("hex");

    const result = await provision(pinsFor(digest));

    expect(existsSync(stale)).toBe(false);
    // A sibling launcher may be mid-extraction in its own staging directory,
    // so a name that is not a digest is never a release to remove.
    expect(existsSync(staging)).toBe(true);
    const record = JSON.parse(readFileSync(join(result.path, "..", "openagent-driver.json"), "utf8"));
    expect(record.executableSha256).toBe(sha256File(result.path));
    expect(record.archiveSha256).toBe(digest);
  });
});
