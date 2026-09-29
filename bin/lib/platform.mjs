/**
 * Which pinned release asset this machine needs.
 *
 * The keys are the table's own, not Node's, because the archive that fits a
 * machine is a property of the upstream release rather than of the runtime that
 * reads it: macOS ships one universal driver for both architectures, so both
 * `darwin` architectures answer with the same key instead of two entries that
 * would have to hold identical bytes.
 *
 * An unsupported pair answers `null` rather than guessing. A machine that
 * resolves to no key gets a named failure that prints the supported ones, and a
 * wrong guess would instead download and run a binary built for another kernel.
 */
export function platformKey(platform, arch) {
  if (platform === "win32") {
    if (arch === "x64") return "windows-x86_64";
    if (arch === "arm64") return "windows-arm64";
    return null;
  }
  if (platform === "darwin") {
    return arch === "x64" || arch === "arm64" ? "darwin-universal" : null;
  }
  if (platform === "linux") {
    if (arch === "x64") return "linux-x86_64";
    if (arch === "arm64") return "linux-arm64";
    return null;
  }
  return null;
}

/** The archive format of a pinned asset name, or `null` if it is neither. */
export function archiveKind(asset) {
  const name = String(asset).toLowerCase();
  if (name.endsWith(".zip")) return "zip";
  if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) return "tar.gz";
  return null;
}
