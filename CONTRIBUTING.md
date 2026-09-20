# Contributing

## Setup

Bun 1.4.1 or newer, plus Go.

```sh
bun install
bun run build:binaries
```

How the code is laid out, what CI checks, and how to add a provider: see [AGENTS.md](AGENTS.md).

## What gets merged

Small, focused bug fixes. Reliability and performance fixes. Maintenance that doesn't change
the product's direction.

What doesn't: large PRs, drive-by features, rewrites, anything that expands scope without an
issue first.

## Before you start

Open an issue for anything bigger than a bug fix. It's cheaper than a rejected PR.

## Pull requests

- Conventional title: `fix(core): ...`
- Problem first, then the fix
- One concern per PR, rebased on `main`
- Add a line naming the model and harness that did the work

CI runs on every PR, and `main` requires it to pass.

## License

MIT, same as the project.
