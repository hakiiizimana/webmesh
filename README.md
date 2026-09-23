# webmesh

Web search, page reading, and browser control for you and your AI agents.

Run Webmesh from the terminal, or add it to your coding agent. It runs locally and requests leave from your IP.

## Install

Webmesh needs [Bun](https://bun.sh) 1.4.1 or newer.

```sh
npm install -g webmesh.js
```

`bun add -g webmesh.js` works too.

The first `agent-browser` command uses the Chrome or Chromium already on your machine. If neither is installed, it downloads Chromium once, on first use.

npm 12 blocks dependency install scripts by default, so it warns about `agent-browser`. Webmesh does not need that script — Chromium is downloaded on first use either way. To silence the warning:

```sh
npm install -g --allow-scripts=agent-browser webmesh.js
```

## Use it from the terminal

```sh
webmesh search "sqlite wal mode"
webmesh search -q "sqlite wal mode,sqlite indexes"
webmesh fetch https://sqlite.org/wal.html
webmesh fetch https://sqlite.org/wal.html https://sqlite.org/lang_vacuum.html
webmesh agent-browser open https://example.com
```

`search` finds sources. `fetch` reads a URL and returns page content. `agent-browser` opens a real browser for pages that need clicks, JavaScript, downloads, or a login.

Both take several inputs in one call: repeat `-q`, comma-separate it, or pass more URLs. A batch answers with `{ success, results: [...] }`, where each entry carries its own result, and runs a few at a time.

Run `webmesh --help` for every command. Run `webmesh agent-browser --help` for browser commands.

## Use it with your agent

```sh
webmesh setup
```

This adds Webmesh to the coding agents found on your machine. Restart the agent, then ask it to search the web, read a URL, or open a page.

To add Webmesh yourself, point your agent's MCP configuration at:

```toml
# ~/.codex/config.toml
[mcp_servers.webmesh]
command = "webmesh"
args = ["mcp"]
```

The MCP server exposes `web_search`, `web_fetch`, and `agent-browser`.

## Add an API key

Webmesh works without API keys. Add one when you want to use a paid provider.

For example, to add an Exa key:

```sh
webmesh setup key EXA_API_KEY
```

Webmesh asks you to paste the actual key, then saves it locally. Run `webmesh providers` to see available providers and the key name each one expects.

## Reach a local app

Webmesh blocks localhost and private network addresses, so a web page can't steer your agent into services on your machine. To let it test your own dev server, allow that one address:

```sh
webmesh setup allow localhost:3000
```

Only that host and port open up. Run `webmesh setup allow localhost:3000 --remove` to block it again.

## Log in to a site

```sh
webmesh login https://example.com
```

Log in in the browser window, then press Enter in the terminal. Webmesh saves that login for later browser sessions. Run `webmesh logout` to remove saved logins.

## License

MIT. See `THIRD_PARTY_NOTICES.txt` in the published package for bundled third-party notices.
