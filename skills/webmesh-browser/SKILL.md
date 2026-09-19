---
name: webmesh-browser
description: Use Webmesh browser interaction for rendered pages, forms, logins, pagination, screenshots, uploads, and other stateful web tasks.
---

# Webmesh browser

Use the `browser` MCP tool only when page interaction or rendered state is required.

## Command loop

1. Open the URL.
2. Run `snapshot -i` to get interactive refs such as `@e1`.
3. Click, fill, press, select, or scroll using those refs.
4. Take a fresh snapshot after navigation or a page update because refs go stale.
5. Use `read` for rendered text or `screenshot` when visual state matters.

Send one agent-browser command per tool call. The server serializes commands through one session.

## Paths

Use absolute paths for PDFs, uploads, and `--screenshot-dir`. Relative paths resolve against agent-browser's background process, not the agent's working directory.

## Sessions and secrets

Webmesh loads logins saved by `webmesh login` in read-only mode. Keep credentials out of commands and prompts. Webmesh redacts secrets in browser output.

The browser session belongs to this MCP server. Close the session without `--all`; that flag is rejected because it would close other agents' sessions on the machine.

## Network boundary

Private, loopback, and link-local addresses are blocked by default. Use the configured allow-private-networks setting only when the task explicitly requires an internal address.
