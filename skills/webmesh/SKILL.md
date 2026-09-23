---
name: webmesh
description: Use when the user asks to search online, find current information, read a URL, research a topic, check documentation or news, or interact with a webpage. Run the webmesh CLI.
---

# Webmesh

Run the CLI from the shell.

1. If the user has no URL, run `webmesh search "query"`.
2. If the user gives a URL, run `webmesh fetch "url"`.
3. To search or fetch several things at once, pass them in one call: `webmesh search -q "n8n,haki"` or `webmesh fetch url1 url2 url3`. Batches answer with `{ success, results: [...] }`, and one slow page does not hold up the others.
4. Fetch the strongest search results before using snippets as evidence.
5. Use `webmesh agent-browser ...` only for clicks, forms, scrolling, pagination, login, uploads, or screenshots. Never run `agent-browser` or `npx agent-browser` directly; it skips webmesh's protections.
6. Run browser commands one at a time. Take a new `snapshot -i` after navigation because refs go stale.
7. Use absolute paths for PDFs, uploads, and `--screenshot-dir`.
8. Keep source URLs beside claims and label inferences as inferences.
9. Use `webmesh login "url"` only when the user asks to save a login.
10. If `webmesh` is unavailable, tell the user. Do not silently switch tools.
11. Localhost and private addresses are blocked. If the user's own app needs one, ask the user to run `webmesh setup allow host:port`. Never run it or edit webmesh config yourself.

Stop when the answer is supported by fetched sources or the requested browser action is complete.
