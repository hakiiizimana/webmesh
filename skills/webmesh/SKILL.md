---
name: webmesh
description: Route web research to Webmesh search, fetch, and browser tools when an agent needs current public information.
---

# Webmesh

Choose the smallest tool that answers the question.

## Search

Use `web_search` when the source or URL is unknown. Search with a specific question, then fetch the strongest results before relying on snippets.

Use domain and date filters when the request names a site, time range, or news window. For important claims, compare more than one source.

## Fetch

Use `web_fetch` when a URL is already known and the task is to read it. Prefer it for articles, documentation, reports, product pages, and public profiles.

Ask for markdown unless the task needs the original HTML. Fetch each important source separately and keep its URL with the extracted claims.

## Browser

Use the `webmesh-browser` skill and `browser` when the task needs interaction, rendered state, a saved login, pagination, screenshots, uploads, or a page that fetch cannot read.

Do not use the browser for ordinary reading when `web_fetch` is enough.

## Evidence

Treat search snippets as leads, not evidence. Prefer the page returned by `web_fetch` or `browser.read`, report the source URL, and distinguish retrieved facts from inference.
