# OpenAgent Cua Driver

The standard Agent Plugin package for OpenAgent desktop control. It declares
the `cua-driver` Runtime binding and the portable socket daemon contract so
Cua uses the same plugin identity and capability model as other OpenAgent
plugins.

The package owns the daemon launcher and process contract. The desktop host
only supervises the declared command, supplies the private endpoint and parent
liveness pipe, and connects the reserved MCP client. The launcher delegates to
a compatible `cua-driver` executable supplied by `OPENAGENT_CUA_DRIVER_BIN` or
`PATH`, so the desktop application never bundles or downloads the Cua process.

Install or update this package from its GitHub repository in OpenAgent. The
package follows Agent Plugins 1.0.0 and the OpenAgent
`extensions.openagent.runtime` and `daemon` contracts.

## Development

```bash
bun scripts/validate-plugin.mjs .
```

## License

MIT
