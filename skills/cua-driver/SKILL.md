---
name: cua-driver
description: Use the OpenAgent Cua Driver plugin when a task requires controlled desktop or browser interaction through the host-supervised Cua daemon.
---

# Cua Driver

Cua Driver is an ordinary Agent Plugin package. Keep desktop-control requests
inside the host-supervised daemon and reserved MCP client so permissions,
endpoint ownership, and parent liveness remain enforced.

The manifest's `desktop-control` capability requests access to the real computer
environment; it does not grant access. The user must explicitly enable the
plugin's **Allow real computer access** authorization in OpenAgent settings.
Never describe Cua as unconditionally unrestricted, and never add a second
plugin-specific bypass. Without the user grant, the daemon must remain confined
or fail closed.

The launcher checks upstream driver updates only during `--openagent-prepare`,
at most once per six hours, and activates only SHA-256-verified releases for the
current platform. Serve, MCP and stop reuse that selection without checking the
network. A failed update keeps the verified driver or uses the built-in pin;
`OPENAGENT_CUA_DRIVER_BIN` bypasses provisioning and updating. The desktop host
owns daemon restart and liveness: a running daemon changes versions on its next
prepared start. Never kill or restart a live daemon from the plugin to update it.
See the package README for release selection, cache recovery, and lock behavior.
