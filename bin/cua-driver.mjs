#!/usr/bin/env node

import { spawn } from "node:child_process";

const executable = process.env.OPENAGENT_CUA_DRIVER_BIN || "cua-driver";
const child = spawn(executable, process.argv.slice(2), {
  stdio: "inherit",
  windowsHide: true,
});

child.on("error", (error) => {
  console.error(`Unable to start Cua Driver: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
