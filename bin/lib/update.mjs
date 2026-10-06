/** Driver updates belong to package preparation, before the host starts its daemon. */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platformKey } from "./platform.mjs";
import { provisionDriver } from "./provision.mjs";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 10_000;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function compareVersions(left, right) {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

/** Validate downloaded and persisted selectors before using them as filesystem paths. */
function validSelection(selection, pins, key) {
  const pin = selection?.platforms?.[key];
  const baseline = pins.platforms[key];
  if (!baseline || !STABLE_VERSION.test(selection?.version ?? "")) return false;
  const asset = baseline.asset.replace(pins.version, selection.version);
  return selection.repository === pins.repository &&
    selection.release === `cua-driver-rs-v${selection.version}` &&
    compareVersions(selection.version, pins.version) >= 0 &&
    pin?.asset === asset && pin.executable === baseline.executable &&
    /^[0-9a-f]{64}$/.test(pin.sha256);
}

function readState(path, pins, key) {
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state.version !== 1 || state.platform !== key || state.repository !== pins.repository) return {};
    return {
      checkedAt: Number.isFinite(state.checkedAt) ? state.checkedAt : undefined,
      selection: validSelection(state.selection, pins, key) ? state.selection : undefined,
    };
  } catch {
    return {};
  }
}

function saveState(path, pins, key, state) {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, platform: key, repository: pins.repository, ...state }) + "\n");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * This monorepo marks stable component releases as prereleases to keep its
 * repository-wide Latest pointer stable. Plain driver SemVer tags are stable;
 * nightly and suffixed tags are excluded, regardless of GitHub's label.
 */
export async function latestDriverPins({ pins, platform, arch, fetchImpl = fetch }) {
  const key = platformKey(platform, arch);
  if (!pins.platforms[key]) return null;
  const repository = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(pins.repository);
  if (!repository) throw new Error("Invalid Cua Driver update repository");
  const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  const releases = [];
  for (let page = 1; page <= 3; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository[1]}/${repository[2]}/releases?per_page=100&page=${page}`,
      { headers: { accept: "application/vnd.github+json", "user-agent": "OpenAgent-CuaDriver/1.0" }, signal, redirect: "error" },
    );
    if (!response.ok) throw new Error(`Cua Driver update check answered ${response.status}`);
    const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error("Invalid Cua Driver release list");
    releases.push(...entries);
    if (entries.length < 100) break;
  }
  const candidates = releases.filter((release) => !release.draft &&
    typeof release.tag_name === "string" &&
    release.tag_name.startsWith("cua-driver-rs-v") &&
    STABLE_VERSION.test(release.tag_name.slice("cua-driver-rs-v".length)));
  candidates.sort((a, b) => compareVersions(
    b.tag_name.slice("cua-driver-rs-v".length), a.tag_name.slice("cua-driver-rs-v".length),
  ));
  for (const release of candidates) {
    const version = release.tag_name.slice("cua-driver-rs-v".length);
    if (compareVersions(version, pins.version) <= 0) return null;
    const baseline = pins.platforms[key];
    const assetName = baseline.asset.replace(pins.version, version);
    const asset = release.assets?.find((entry) => entry.name === assetName);
    if (!asset) continue; // A release for another platform must not block this one.
    const digest = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "");
    const expectedUrl = `${pins.repository}/releases/download/${release.tag_name}/${assetName}`;
    if (!digest || asset.browser_download_url !== expectedUrl) {
      throw new Error("Cua Driver update asset has no trusted SHA-256 digest or download URL");
    }
    return {
      repository: pins.repository, release: release.tag_name, version,
      platforms: { [key]: { asset: assetName, sha256: digest[1], executable: baseline.executable } },
    };
  }
  return null;
}

/**
 * Preparation checks at most once per six hours. Serve, MCP and stop only use
 * the activated, verified cache. Failed updates leave that selection intact.
 * Explicit binary overrides are handled by the launcher before reaching here.
 */
async function resolveUnlocked({
  dataRoot, platform, arch, pins, log, checkUpdates = false,
  fetchImpl = fetch, now = Date.now(), provision = provisionDriver,
  signal = AbortSignal.timeout(150_000),
}) {
  const key = platformKey(platform, arch);
  const statePath = join(dataRoot, "driver", "update.json");
  const state = readState(statePath, pins, key);
  const current = state.selection ?? pins;
  // A peer can still be serving an older digest. Versioned releases are retained;
  // preparation never overwrites or removes a running process's installation.
  const provisionOptions = { dataRoot, platform, arch, log, prune: false, signal };
  if (checkUpdates && pins.platforms[key] &&
      !(state.checkedAt <= now && now - state.checkedAt < CHECK_INTERVAL_MS)) {
    try {
      // Record attempts too: offline starts and quota failures should not hammer GitHub.
      state.checkedAt = now;
      saveState(statePath, pins, key, state);
      log("checking for Cua Driver updates");
      const latest = await latestDriverPins({ pins: current, platform, arch, fetchImpl });
      if (latest) {
        const result = await provision({ ...provisionOptions, pins: latest });
        saveState(statePath, pins, key, { checkedAt: now, selection: latest });
        log(`updated Cua Driver to ${latest.version}`);
        return result;
      }
    } catch {
      log("Cua Driver automatic update failed; using the last verified driver");
    }
  }
  try {
    return await provision({ ...provisionOptions, pins: current });
  } catch (error) {
    if (!state.selection) throw error;
    log("Cua Driver automatic update failed; using the last verified driver");
    const result = await provision({ ...provisionOptions, pins });
    // Do not keep selecting a release whose executable cannot be recovered.
    if (checkUpdates) saveState(statePath, pins, key, { checkedAt: now });
    return result;
  }
}

/** Serialize prepare processes; serve/MCP/stop never wait for this lock. */
export async function resolveDriver(options) {
  options = { ...options, signal: options.signal ?? AbortSignal.timeout(150_000) };
  if (!options.checkUpdates) return resolveUnlocked(options);
  const root = join(options.dataRoot, "driver");
  const lock = join(root, "update.lock");
  mkdirSync(root, { recursive: true });
  const deadline = Date.now() + 140_000;
  while (true) {
    let created = false;
    try {
      mkdirSync(lock);
      created = true;
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
      break;
    } catch (error) {
      if (created) rmSync(lock, { recursive: true, force: true });
      if (error.code !== "EEXIST") throw error;
      try {
        let abandoned = false;
        try {
          const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
          if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); } catch (failure) {
              abandoned = failure.code === "ESRCH";
            }
          }
        } catch {
          abandoned = Date.now() - statSync(lock).mtimeMs > 180_000;
        }
        if (abandoned) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch (failure) {
        if (failure.code === "ENOENT") continue;
        throw failure;
      }
      if (Date.now() >= deadline) return resolveUnlocked({ ...options, checkUpdates: false });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await resolveUnlocked(options);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
