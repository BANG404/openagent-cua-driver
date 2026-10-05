#!/usr/bin/env node

/**
 * Build the release asset from the package root.
 *
 * The archive OpenAgent installs has to hold `plugin.json` at its root, so it is
 * built from here rather than from a parent directory. It also has to hold only
 * what the package runs: tests, tooling, and the repository metadata are for
 * people reading the source, and shipping them would put files in a user's
 * plugin directory that no manifest can reach.
 *
 * The tar is written here instead of by a `tar` binary because the output is
 * meant to be reproducible: every entry is stamped with the same mode, zeroed
 * ownership, and a fixed modification time, so the same sources produce the same
 * bytes and a published digest stays meaningful.
 */

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Exactly the files the installed package needs, in archive order. */
const CONTENTS = [
  "plugin.json",
  "README.md",
  "LICENSE",
  "bin/cua-driver.mjs",
  "bin/i18n.mjs",
  "bin/lib/archive.mjs",
  "bin/lib/openagent-host.mjs",
  "bin/lib/platform.mjs",
  "bin/lib/provision.mjs",
  "bin/lib/pins.json",
  "skills/cua-driver/SKILL.md",
];

const BLOCK = 512;
/** Fixed timestamp, so the same sources always hash the same. */
const MODIFICATION_TIME = 0;

function header(name, size, mode) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, Math.min(Buffer.byteLength(name), 99), "utf8");
  block.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, "latin1");
  block.write("0000000\0", 108, "latin1");
  block.write("0000000\0", 116, "latin1");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  block.write(`${MODIFICATION_TIME.toString(8).padStart(11, "0")}\0`, 136, "latin1");
  block.write("0", 156, "latin1");
  block.write("ustar\0", 257, "latin1");
  block.write("00", 263, "latin1");
  block.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}

function member(name, contents) {
  const padding = (BLOCK - (contents.length % BLOCK)) % BLOCK;
  // Only the entry points are executable: the manifests and documents are read,
  // and marking them runnable would make the installed package's modes say
  // something the package does not mean.
  const mode = name.startsWith("bin/") ? 0o755 : 0o644;
  return Buffer.concat([header(name, contents.length, mode), contents, Buffer.alloc(padding)]);
}

const manifest = JSON.parse(readFileSync(join(repository, "plugin.json"), "utf8"));
const parts = CONTENTS.map((path) => {
  const contents = readFileSync(join(repository, path));
  if (statSync(join(repository, path)).isDirectory()) {
    throw new Error(`'${path}' is a directory, and the release lists files`);
  }
  return member(path, contents);
});
parts.push(Buffer.alloc(BLOCK * 2));

const archive = gzipSync(Buffer.concat(parts), { level: 9 });
const output = join(repository, `openagent-cua-driver-v${manifest.version}.tar.gz`);
writeFileSync(output, archive);
console.log(`${output} (${archive.length} bytes)`);
