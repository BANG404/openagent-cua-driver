# OpenAgent Cua Driver

The standard Agent Plugin package for OpenAgent desktop control. It declares
the portable socket daemon contract and uses the same plugin identity and
capability model as every other OpenAgent package.

Install or update this package from its GitHub repository in OpenAgent. The
package follows Agent Plugins 1.0.0 and the OpenAgent generic
`extensions.openagent` and `daemon` contracts.

## Desktop authorization

The `desktop-control` capability is a request, not a permission grant. OpenAgent
shows a per-plugin **Allow real computer access** control for this package. The
daemon starts only after the user enables that control; without it, the Runtime
keeps the process under the standard managed plugin sandbox and refuses a Cua
daemon launch that cannot operate the interactive desktop. This is the same
authorization contract used by every plugin that requests `desktop-control`,
`host-access`, or `computer-use`.

## How the driver is provided

This package ships a launcher, not a driver. `bin/cua-driver.mjs` is what
OpenAgent starts — `serve …` to supervise the daemon, `mcp …` to attach the
reserved MCP client — and it resolves the actual program in this order:

1. **`OPENAGENT_CUA_DRIVER_BIN`**, when set. The variable names a Cua Driver
   the user already has, for example one built from source or installed by the
   upstream installer, and nothing else is consulted.
2. **The verified cache** under `PLUGIN_DATA/driver/<sha256>/`, where
   `PLUGIN_DATA` is the writable directory OpenAgent gives the package. A
   release is reused only while its recorded digests still match the files on
   disk; anything else is replaced.
3. **A download** of the pinned upstream release for this platform, described
   by `bin/lib/pins.json`. The archive's SHA-256 is checked against the pin
   before anything is extracted, and the extraction runs from a staging
   directory so a failure never leaves a half-installed driver behind.

`bin/lib/pins.json` names one asset and digest per platform. It exists so the
program that runs is the one this package was reviewed against rather than
whatever upstream published most recently, and so a changed or re-cut upstream
asset fails the launch instead of executing new bytes quietly. A release that
has changed under the pin reports both digests.

Nothing is downloaded when the cache is warm. The first launch on a machine
fetches tens of megabytes, so it takes a moment and says so on stderr; the
package declares the `network` capability for that reason. Everything the
launcher writes goes to stderr — for the `mcp` subcommand stdout is the MCP
transport, and a diagnostic printed there would corrupt the protocol.

### Prepare before serving

```bash
node bin/cua-driver.mjs --openagent-prepare   # fetch and verify, start nothing
```

A supervisor that runs this process as a daemon is waiting for it to *listen*,
with a deadline that has nothing to do with the network. Provisioning inside
that wait spends the daemon's whole startup budget on a download: measured on a
fast connection, a cold provision takes about 14.6 s against OpenAgent's 15 s
deadline, and the launcher is killed for it. Preparing first makes that wait
about the network and leaves the daemon's own start at roughly 0.3 s.

`--openagent-prepare` is consumed by the launcher and never forwarded to the
driver, so it cannot collide with a driver subcommand. It exits 0 only when a
verified driver is on disk, and exits 1 with the same named failures as any
other invocation. It writes nothing to stdout.

This package pins a release and does not follow upstream's newest one, and the
driver has its own update check that announces a newer release on stderr at
every start. That notice is upstream's, not this launcher's: what is running is
still the pinned build whose digest was verified, until this package's pin
moves.

### It fails loudly, not silently

There is no state in which the launcher starts nothing and says nothing. Each
failure names itself and what to do about it: an unset `PLUGIN_DATA`, a
platform the pin table does not cover, no network, a download that answered
with an error, an asset whose digest is not the pinned one, an archive that
does not contain the driver, and a driver that will not start. Set
`OPENAGENT_CUA_DRIVER_BIN` to run an existing driver through any of them.

## Language support

The package declares English and Chinese in `plugin.json`. The launcher reads
the current OpenAgent language through the versioned `locale.get` host
operation when it reports download, preparation, or startup notices. Plugin
metadata and launcher-generated failures are translated; upstream driver
output, executable paths, platform IDs, and diagnostic codes keep their
original values.

### Which digests were checked, and how

`windows-x86_64` and `linux-x86_64` were downloaded and their SHA-256 measured
against upstream's published `checksums.txt`. The other three (`windows-arm64`,
`darwin-universal`, `linux-arm64`) are transcribed from the same upstream
release manifest, which agreed with the two that were measured, and neither
archive could be executed on the machine that wrote this table. A transcription
mistake is not a security hole — the launcher compares the digest before it
extracts anything — but it is a first-launch failure on those platforms, so
report it if you hit one.

## What the host supplies

The desktop host supervises the daemon and owns the product policy that is not
the package's to decide: the private endpoint, the user authorization, and the
parent-liveness contract. It passes two things the launcher needs — the
`PLUGIN_DATA` directory above, and the endpoint on the command line — and never
a driver binary. That is the whole reason the launcher exists.

## Development

```bash
bun test                                  # launcher, pin table, and extractor tests
bun run pack                              # build the release asset
bun <plugin-kit>/scripts/validate-plugin.mjs .
```

`bun run pack` writes `openagent-cua-driver-v<version>.tar.gz` from the package
root, with `plugin.json` at the archive root as the installer requires. It
excludes tests, tooling, and repository metadata, and it stamps every member
with the same mode and timestamp so the same sources produce the same bytes.

Attach that archive to the release and confirm GitHub reports a `sha256:`
digest for it; OpenAgent accepts an asset only when the digest is present and
matches. See `openagent-plugin-kit`'s `docs/publishing.md` for the full
checklist.

## License

MIT
