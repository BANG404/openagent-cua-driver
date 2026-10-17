---
name: cua-driver
description: Use the OpenAgent Cua Driver plugin when a task requires desktop or browser interaction through its standard embedded MCP server.
---

# Cua Driver

Cua Driver is an ordinary Agent Plugin package. Keep desktop-control requests
inside its declared MCP server. Root mcp.json selects direct embedded mode:
the MCP process owns the desktop runtime and exits when its input closes,
without starting a standalone CUA application or a socket daemon.

The manifest's `desktop-control` capability requests access to the real computer
environment; it does not grant access. The user must explicitly enable the
plugin's **Allow real computer access** authorization in OpenAgent settings.
Never describe Cua as unconditionally unrestricted, and never add a second
plugin-specific bypass. Without the user grant, the MCP server must remain confined
or fail closed.

The launcher checks upstream driver updates at MCP startup or `--openagent-prepare`,
at most once per six hours, and activates only SHA-256-verified releases for the
current platform. Serve and stop reuse that selection without checking the
network. A failed update keeps the verified driver or uses the built-in pin;
`OPENAGENT_CUA_DRIVER_BIN` bypasses provisioning and updating. The Runtime
owns the ordinary MCP connection lifecycle: a running server changes versions
on its next connection. Never restart a live MCP server to apply an update.
See the package README for release selection, cache recovery, and lock behavior.

## Screenshots

For MCP window or desktop reads, omit `screenshot_out_file` by default: the
driver returns the PNG as an image content block alongside window state. This
avoids filesystem dependencies; do not invent temporary paths for routine reads.
Use `include_screenshot:false` when only the accessibility tree is needed.

When an exported PNG is required, the plugin's MCP launcher expands `~/` and
`~\\`, creates the parent directory recursively, and passes an absolute path to
the driver. Absolute paths retain their destination. Relative paths resolve
under `<PLUGIN_DATA>/screenshots/`, independently of the driver's working
directory (outside OpenAgent without PLUGIN_DATA, the launcher's starting cwd
is the base for `screenshots/`). Prefer absolute paths when another tool will
read the file, and use the returned `screenshot_file_path`. Empty paths and
Windows drive-relative paths such as `C:shot.png` are rejected.

A parent-directory failure returns a localized tool error without closing MCP
or retrying the capture. Fix the destination or re-read without the export
parameter; do not repeatedly submit the failing path. Existing permissions
still apply. CLI calls that bypass MCP must create parents and use expanded
absolute paths themselves. See the [upstream window-state contract](https://cua.ai/docs/cua-driver/reference/mcp-tools/window-state).

The release packer's explicit file list must include `bin/lib/mcp-screenshots.mjs`.
Package qualification includes extracting the archive and starting its launcher;
source-directory validation alone cannot detect missing runtime imports.
