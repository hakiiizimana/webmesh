---
name: webmesh
description: Use when the user asks to search online, find current information, read a URL, research a topic, check documentation or news, or interact with a webpage. Run the webmesh CLI.
---

# Webmesh

Run the CLI from the shell.

1. If the user has no URL, run `webmesh search "query"`.
2. If the user gives a URL, run `webmesh fetch "url"`.
3. Fetch the strongest search results before using snippets as evidence.
4. Use `webmesh browser ...` only for clicks, forms, scrolling, pagination, login, uploads, or screenshots.
5. Run browser commands one at a time. Take a new `snapshot -i` after navigation because refs go stale.
6. Use absolute paths for PDFs, uploads, and `--screenshot-dir`.
7. Keep source URLs beside claims and label inferences as inferences.
8. Use `webmesh login "url"` only when the user asks to save a login.
9. If `webmesh` is unavailable, tell the user. Do not silently switch tools.

Stop when the answer is supported by fetched sources or the requested browser action is complete.
