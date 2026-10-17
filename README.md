# OpenAgent Cua Driver

This Agent Plugins 1.0 package declares its desktop-control server in root
`mcp.json`. Install, authorize, test, enable, disable and remove it through the
same plugin controls used by every other package. No host-reserved MCP entry,
native command, fixed socket, desktop daemon or standalone CUA application is
required. The manifest requests `desktop-control` and `network`; only the user's
ordinary per-plugin host-access grant authorizes access to the real desktop.

The package launches `mcp --direct --embedded`. The driver owns its runtime
inside the MCP process rather than spawning its application or a socket daemon.
The MCP connection owns process lifetime, so disabling, refreshing, revoking
host access or uninstalling uses ordinary Runtime MCP teardown. Domain launch
arguments and environment belong in this package, never in the frontend,
desktop shell, public configuration or Runtime package-ID branches.

`bin/cua-driver.mjs` resolves `OPENAGENT_CUA_DRIVER_BIN` when explicitly set,
otherwise verifies and reuses its cache under `PLUGIN_DATA/driver/<sha256>` or
downloads the pinned upstream release. Archive verification and atomic staging
retain the previous usable driver after failure. The first connection may need
time for the download. MCP startup checks for verified driver updates at most
once every six hours. All launcher notices use stderr; stdout is MCP only.
`--openagent-prepare` optionally provisions the driver without running it.

Explicit screenshot exports create parent directories; omitted output paths
retain inline MCP images. The installed package remains immutable and writable
state stays in `PLUGIN_DATA`. Version 2 replaces the old socket-daemon launch
contract; it retains the existing driver cache and screenshot data.

Run `bun test`, `bun run pack` and Plugin Kit's `scripts/validate-plugin.mjs .`.
The archive includes `plugin.json`, `mcp.json`, the launcher and its support
files, and bundled skills. Publish the verified archive independently of the
desktop application.
