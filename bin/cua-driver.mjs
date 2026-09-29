#!/usr/bin/env node

/**
 * The Cua Driver launcher this package publishes.
 *
 * OpenAgent runs this file instead of a driver binary, under whatever command
 * line the host decided: `serve ...` to supervise a daemon, or `mcp ...` to
 * attach the reserved MCP client. This launcher's whole job is to put the
 * verified driver behind that command line.
 *
 * The driver itself is not in this package. Upstream publishes one build per
 * platform, and this package pins the asset and digest it was reviewed against,
 * so a launcher that has to fetch what it runs must not write into the package
 * it was loaded from: the host exports `PLUGIN_DATA` for that, and the cache
 * lives there. `OPENAGENT_CUA_DRIVER_BIN` overrides the whole mechanism for a
 * driver the user already has.
 *
 * `--openagent-prepare` fetches the driver and exits without starting anything.
 * It exists because fetching is tens of megabytes and a caller that supervises
 * this process as a daemon is waiting for it to *listen*, not to download: a
 * first launch that provisions in the middle of that wait spends the daemon's
 * whole startup budget on the network and is killed for it. Preparing first
 * turns that into a step whose budget is about the network, and makes the
 * daemon's own start quick on every launch.
 *
 * Nothing may be written to stdout. For the `mcp` subcommand stdout is the MCP
 * transport, so a stray byte corrupts the protocol rather than printing a
 * diagnostic; every message this file produces goes to stderr.
 */

import { spawn } from "node:child_process";

import { provisionDriver, readPins } from "./lib/provision.mjs";

/** Fetch the driver and exit, instead of running it. */
const PREPARE = "--openagent-prepare";

const override = (process.env.OPENAGENT_CUA_DRIVER_BIN ?? "").trim();

async function driverPath() {
  if (override) {
    return override;
  }
  const dataRoot = (process.env.PLUGIN_DATA ?? "").trim();
  if (!dataRoot) {
    throw new Error(
      "PLUGIN_DATA is not set, so this launcher has nowhere to keep the driver it downloads. " +
        "The OpenAgent host exports it as the package's own writable directory; set it to a " +
        "writable empty directory to run this package outside OpenAgent, or set " +
        "OPENAGENT_CUA_DRIVER_BIN to a Cua Driver already on this machine.",
    );
  }
  const pins = readPins();
  const { path } = await provisionDriver({
    dataRoot,
    platform: process.platform,
    arch: process.arch,
    pins,
    log: (message) => console.error(`[cua-driver] ${message}`),
  });
  return path;
}

const args = process.argv.slice(2);

let executable;
try {
  executable = await driverPath();
} catch (error) {
  console.error(`Unable to start Cua Driver: ${error.message}`);
  process.exit(1);
}

if (args.includes(PREPARE)) {
  // Only reachable when the driver resolved: the whole point of this mode is
  // that the answer is a verified executable on disk, so a caller can start the
  // daemon afterwards knowing the launch has nothing left to fetch.
  console.error(`[cua-driver] prepared ${executable}`);
  process.exit(0);
}

const child = spawn(executable, args, {
  stdio: "inherit",
  windowsHide: true,
});

child.on("error", (error) => {
  const hint = override ? " (from OPENAGENT_CUA_DRIVER_BIN)" : "";
  console.error(`Unable to start Cua Driver: ${error.message}${hint}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
