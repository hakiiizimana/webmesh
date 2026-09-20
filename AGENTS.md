# webmesh

Search, read, and browse the web from a terminal or an agent.

- `packages/core` — providers, router, fetch chain, browser, settings, state
- `apps/cli` — the `webmesh` command and `webmesh mcp`
- `skills/` — the skill files `webmesh setup` installs
- `tools/html-to-markdown` — Go binary, built by `bun run build:binaries`

## Rules

1. Local state belongs to the user. `~/.config/webmesh/config.json` holds keys,
   `~/.cache/webmesh/webmesh.db` holds health and cache. Read them, never rewrite them.
   Tests use `memoryStore()` / `memoryCache()`.
2. A key never reaches output. Keys arrive through `mergeEnv(settings.keys, process.env)`.
   `maskProxy` exists for the same reason. Check what a new failure path prints.
3. Private network blocking is a boundary, not a default. `blockedUrl()` in `network.ts`.
   `allowPrivateNetworks` is opt-in. Never skip it.
4. The router already retries, hedges, benches, and cools down. A second retry loop
   double-counts failures and makes a flaky provider look worse than it is.

## Work

Bun 1.4.1 or newer, plus Go.

```sh
bun install
bun run build:binaries             # Go binary, needed before build or smoke

bun run search "sqlite wal mode"   # run from source, no build step
bun run mcp

bun run check-types                # these five are CI's `check` job, in order
bun run check-slop
bun run test
bun run build
tools/html-to-markdown/smoke.sh
```

`main` requires that job to pass. `check-slop` is `oxlint --deny-warnings`, so a warning fails.
Run the file you touched first: `bun test packages/core/test/search.test.ts`.

## Adding a search provider

Keyless, or keyed with a free tier a user reaches without a credit card. Paid-only is out.
Keyed providers run only when every keyless one came back empty, so they have to cover a gap,
not duplicate the free pool. `exa`/`exa-mcp` is the shape to copy: keyless sibling, keyed twin.

The mechanics are in the registry — spec in `search/providers/<name>.ts`, registered in
`providers/index.ts` and `search/index.ts`, filters declared with `onlyFilters`/`noFilters`.
Test the parser against a real captured response, not a mock.

## Adding a fetcher

Same bar: keyless, or keyed with a free tier. `jina-reader` is the free path to `jina`.

Register in `read/index.ts` with `kind` and `formats`, plus `accepts`, `available`, or `manual`
where they apply. Declare only the formats you return.

## How it works

- Search races every keyless provider, then falls back to the keyed ones. Results fuse by
  reciprocal rank, dedupe on normalized URL, cap at 2 per domain, then cache.
- Fetch races the fetcher pool under a 30s budget.
- `router.ts` scores on success and latency and benches failures. `TargetError` means the
  provider worked and the page didn't, so nothing is penalized.

## Style

- TypeScript, Bun APIs, zod at every boundary. `satisfies` over casts, so a registry that
  disagrees with a spec is a type error. Comments say why.
- Tests cover parsing, routing, and filtering — the logic that breaks quietly. Every user
  carries a new dependency, so reach for the standard library first.

## Shipping

`webmesh.js` on npm is the product. `apps/cli` builds one bundle with `wreq-js` external, plus
`dist/bin` and `dist/skills`. A new runtime import is bundled or declared in
`apps/cli/package.json`. Publishing is manual, never from CI.

## Pull requests

`main` is protected: PR required, CI `check` green, no bypass.

- Conventional titles: `fix(core): ...`
- Problem first, then the fix. One concern per PR, rebased on `main`
- End with the model and harness that did the work

Report:

    Goal:      <one line>
    Changed:   <file>: <why>
    Checks:    <command>  <ok|fail>
    Left out:  <what you did not do>
