# webmesh

Web search, page reading, and browser control for you and your AI agents.

Run Webmesh from the terminal, or add it to your coding agent. It runs locally and requests leave from your IP.

## Install

Webmesh needs [Bun](https://bun.sh) 1.4.1 or newer.

```sh
npm install -g @hakiizimana/webmesh
```

`bun add -g @hakiizimana/webmesh` works too.

The installer uses Chrome or Chromium already on your machine. If neither is installed, it downloads Chromium for browser commands.

## Use it from the terminal

```sh
webmesh search "sqlite wal mode"
webmesh fetch https://sqlite.org/wal.html
webmesh browser open https://example.com
```

`search` finds sources. `fetch` reads a URL and returns page content. `browser` opens a real browser for pages that need clicks, JavaScript, downloads, or a login.

Run `webmesh --help` for every command. Run `webmesh browser --help` for browser commands.

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

## Add an API key

Webmesh works without API keys. Add one when you want to use a paid provider.

For example, to add an Exa key:

```sh
webmesh setup key EXA_API_KEY
```

Webmesh asks you to paste the actual key, then saves it locally. Run `webmesh providers` to see available providers and the key name each one expects.

## Log in to a site

```sh
webmesh login https://example.com
```

Log in in the browser window, then press Enter in the terminal. Webmesh saves that login for later browser sessions. Run `webmesh logout` to remove saved logins.

## License

MIT. See `THIRD_PARTY_NOTICES.txt` in the published package for bundled third-party notices.
