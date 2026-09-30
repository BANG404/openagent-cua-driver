---
name: cua-driver
description: Use the OpenAgent Cua Driver plugin when a task requires controlled desktop or browser interaction through the host-supervised Cua daemon.
---

# Cua Driver

Cua Driver is provided through the `cua-driver` Runtime binding. Keep desktop
control requests inside the host-supervised daemon and reserved MCP client so
permissions, endpoint ownership, and parent liveness remain enforced.

The manifest's `desktop-control` capability requests access to the real computer
environment; it does not grant access. The user must explicitly enable the
plugin's **Allow real computer access** authorization in OpenAgent settings.
Never describe Cua as unconditionally unrestricted, and never add a second
plugin-specific bypass. Without the user grant, the daemon must remain confined
or fail closed.
