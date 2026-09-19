---
name: setup-webmesh
description: Configure Webmesh for the current project and coding agents.
---

# Set up Webmesh

Run this once from the project where agents should use Webmesh:

```sh
webmesh setup
```

This registers the Webmesh MCP server with detected coding agents and installs the project skills under `.agents/skills/`.

Configure optional credentials with:

```sh
webmesh setup key NAME VALUE
```

Configure a scraper, local-fetch, and anonymous-browser proxy with:

```sh
webmesh setup proxy http://user:pass@host:port
```

Use `--remove` with either command to remove that setting. Run `webmesh check` after setup to probe available providers. Run `webmesh providers` to inspect provider health and cooldowns.

Restart the coding agent after setup so it reloads the MCP server and project skills.
