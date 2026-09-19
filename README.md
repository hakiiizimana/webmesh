# webmesh

Search, fetch, and browse the web from your AI agent. webmesh is one MCP server with three tools: `web_search`, `web_fetch`, and `browser`.

It runs on your machine and needs [Bun](https://bun.sh) 1.3 or later. Requests go out from your IP.

## Install

Install it once:

```sh
bun add -g @webmesh/cli
```

`npm install -g @webmesh/cli` works too. Either way, Bun has to be on your PATH.

Then run `webmesh setup`. It adds webmesh to every coding agent it finds on your machine.

Or add it by hand. Claude Code:

```sh
claude mcp add webmesh -s user -- webmesh mcp
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.webmesh]
command = "webmesh"
args = ["mcp"]
```

Cursor, in `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "webmesh": { "command": "webmesh", "args": ["mcp"] } } }
```

No API keys needed. To add a paid provider, save its key with `webmesh setup key <NAME>` and it joins as a fallback. `webmesh providers` prints the variable each one reads.

Getting blocked? `webmesh setup proxy <url>` sends scrapers, local fetches, and anonymous browsing through a proxy. Sites you logged into and API calls stay direct, so logins don't get flagged.

webmesh ships its own copy of [agent-browser](https://agent-browser.dev) and drives the Chrome or Chromium you already have. With neither installed, run `webmesh browser install`. Run `webmesh login <url>` once to log in to a site, and browser sessions start logged in after that.

## Use it from the terminal

```sh
webmesh search "sqlite wal mode" -n 5 --freshness week
webmesh fetch https://sqlite.org/wal.html
webmesh browser open https://example.com
webmesh browser snapshot -i
```

Search and fetch print JSON. Run `webmesh --help` for every flag.

## License

MIT
