/**
 * Put a verified Cua Driver executable on disk, or explain why none is there.
 *
 * This package ships no driver. The upstream project publishes one binary per
 * platform, and the table in `pins.json` names the exact asset and digest this
 * package was reviewed against, so the program a user runs is the bytes this
 * package's authors verified rather than "whatever is newest today". Nothing
 * here executes a downloaded file: the digest is checked first, and a mismatch
 * ends the launch.
 *
 * Every failure is named, because the alternative — a launcher that exits
 * silently — is indistinguishable from a Cua feature that is simply broken.
 * Missing state, an unsupported platform, no network, and a changed upstream
 * asset are four different problems with four different answers, and the error
 * says which one this is and what to do about it.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { extractBuffer } from "./archive.mjs";
import { archiveKind, platformKey } from "./platform.mjs";

/** Name of the record written beside an extracted release. */
const RECORD_NAME = "openagent-driver.json";

/** Subdirectory of the package's data root that holds extracted releases. */
const RELEASE_ROOT = "driver";

/** How long one release download may take before it is abandoned. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** No pinned asset is close to this; it exists so a redirect cannot stream forever. */
const MAXIMUM_DOWNLOAD_BYTES = 256 * 1024 * 1024;

const REQUEST_HEADERS = { "user-agent": "OpenAgent-CuaDriver/1.0" };

export function readPins() {
  return JSON.parse(readFileSync(new URL("./pins.json", import.meta.url), "utf8"));
}

/**
 * Resolve the driver for this machine.
 *
 * Returns `{ path, source }`, where `source` is `"cache"` or `"provisioned"`.
 * Throws with an actionable message when no driver can be produced.
 */
export async function provisionDriver({ dataRoot, platform, arch, pins, log, prune = true, signal }) {
  const key = platformKey(platform, arch);
  const supported = Object.keys(pins.platforms).sort();
  if (key === null) {
    throw new Error(
      `Cua Driver publishes no pinned release for ${platform}/${arch}. ` +
        `Pinned platforms: ${supported.join(", ")}. ` +
        "Set OPENAGENT_CUA_DRIVER_BIN to a driver built for this machine to run one anyway.",
    );
  }
  const pin = pins.platforms[key];
  if (!pin) {
    throw new Error(
      `The pinned table has no entry for '${key}'. Pinned platforms: ${supported.join(", ")}. ` +
        "Set OPENAGENT_CUA_DRIVER_BIN to a driver built for this machine to run one anyway.",
    );
  }
  const kind = archiveKind(pin.asset);
  if (kind === null) {
    throw new Error(`The pin for '${key}' names '${pin.asset}', which is not a supported archive`);
  }

  const url = `${pins.repository}/releases/download/${pins.release}/${pin.asset}`;
  const release = join(dataRoot, RELEASE_ROOT, pin.sha256);
  const cached = join(release, pin.executable);
  if (matchesRecord(release, cached, pin)) {
    return { path: cached, source: "cache" };
  }

  // Worth a line of its own: the pinned asset is tens of megabytes, so a first
  // launch spends a while here and a silent pause reads as a hang.
  log(`fetching Cua Driver ${pins.version} for ${key} from ${url}`);
  const staging = `${release}.staging-${randomUUID()}`;
  try {
    const archive = await download(url, pin.sha256, signal);
    extractBuffer(archive, kind, staging, pin.asset);
    const extracted = join(staging, pin.executable);
    if (!existsSync(extracted) || !statSync(extracted).isFile()) {
      throw new Error(`'${pin.asset}' does not contain '${pin.executable}'`);
    }
    writeFileSync(
      join(staging, RECORD_NAME),
      `${JSON.stringify(
        {
          version: pins.version,
          platform: key,
          asset: pin.asset,
          archiveSha256: pin.sha256,
          executable: pin.executable,
          executableSha256: sha256File(extracted),
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `Cua Driver ${pins.version} could not be provisioned for ${key}: ${error.message}. ` +
        `The download is ${url}, and it is cached under ${release}. ` +
        "If this machine has no network access, provision it once on a connected machine and " +
        "copy the directory, or set OPENAGENT_CUA_DRIVER_BIN to an existing driver.",
    );
  }

  // Two launchers can provision at once — the host starts the daemon and mounts
  // the client around the same moment — so losing the rename race means the
  // other process already installed the same digest, not that this one failed.
  // The directory being replaced is a release that failed verification or the
  // cache would have been used, but another process may still be running a
  // driver from it, which is the one way this can fail on a healthy machine.
  try {
    if (matchesRecord(release, cached, pin)) {
      rmSync(staging, { recursive: true, force: true });
      return { path: cached, source: "cache" };
    }
    if (existsSync(release)) rmSync(release, { recursive: true, force: true });
    renameSync(staging, release);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (!matchesRecord(release, cached, pin)) {
      throw new Error(
        `Cua Driver ${pins.version} could not be installed under ${release}: ${error.message}. ` +
          "Another OpenAgent process may be running a driver that has to be stopped before this " +
          "release can replace it.",
      );
    }
  }
  if (prune) pruneReleases(join(dataRoot, RELEASE_ROOT), pin.sha256);
  return { path: cached, source: "provisioned" };
}

/** Whether a release directory holds the executable the pin and record agree on. */
function matchesRecord(release, cached, pin) {
  let record;
  try {
    if (!statSync(cached).isFile()) return false;
    record = JSON.parse(readFileSync(join(release, RECORD_NAME), "utf8"));
    if (record.archiveSha256 !== pin.sha256 || record.executable !== pin.executable) return false;
    return record.executableSha256 === sha256File(cached);
  } catch {
    return false;
  }
}

/**
 * Remove releases this pin does not name.
 *
 * Only names that are a bare digest are releases. A staging directory is not
 * one, and that distinction is load-bearing rather than tidy: a second launcher
 * provisioning the same moment is mid-extraction in its own staging directory,
 * and pruning by "any directory that is not mine" would delete the files under
 * it. Best effort by construction: another OpenAgent process may be running a
 * driver from its own copy, and no platform has to let this one delete it. A
 * failed removal costs disk space, which is why it is not an error.
 */
function pruneReleases(root, current) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === current) continue;
    if (!/^[0-9a-f]{64}$/.test(entry.name)) continue;
    try {
      rmSync(join(root, entry.name), { recursive: true, force: true });
    } catch {
      // Windows can hold a previous executable open until its daemon exits.
    }
  }
}

async function download(url, expected, signal) {
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    redirect: "follow",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
      : AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`the download answered ${response.status} ${response.statusText}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAXIMUM_DOWNLOAD_BYTES) {
    throw new Error(`the download declares ${declared} bytes, beyond the accepted limit`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAXIMUM_DOWNLOAD_BYTES) {
    throw new Error(`the download returned ${bytes.length} bytes, beyond the accepted limit`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `the asset digest is ${actual}, not the pinned ${expected}, so the release has changed ` +
        "under this package's pin and nothing was installed",
    );
  }
  return bytes;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
