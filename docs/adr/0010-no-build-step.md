# ADR 0010: No build step

Status: accepted

## Context

Every Node project has a build step. `tsc` emits to `dist/`, the server runs the emitted JavaScript, and
the browser bundle goes through a bundler. That is the default, and for a product it is usually right.

This repository is a quick-start. Its primary job is to be read. A reader who wants to know what the
retrieval pipeline does should be able to open one file and see the aggregation, without asking which
`dist/` artifact corresponds to it or whether the checked-in bundle matches the source.

A build step also puts a step between a change and seeing it. For code whose purpose is demonstration,
that friction is a real cost paid on every edit.

## Decision

Nothing is compiled.

The server runs the TypeScript sources directly: `tsx src/server/app.ts`, for `pnpm dev` and `pnpm start`
alike. Same command in development and in the container.

The console is vanilla ES modules loaded by the browser from `public/`, with no bundler, no transpile,
and no framework. `index.html` loads the modules with plain `<script type="module">` tags.

TypeScript is still enforced, just not as a build: `pnpm typecheck` runs `tsc --noEmit`. The `outDir` in
`tsconfig.json` exists for tooling, and nothing consumes it.

## Consequences

The file you read is the file that runs. There is no artifact to be stale, no source map to consult, and
no question about whether the deployed bundle matches the commit.

The container image is smaller and the Dockerfile has no build stage. Deploy is a checkout plus
`pnpm install`.

Type errors do not block startup. `tsx` strips types and runs; it does not typecheck. That is the real
cost of this decision, and it is why `pnpm typecheck` is a separate gate that has to actually be run
rather than something a broken build reminds you about. Contributors need to run it, and CI needs to run
it.

Startup pays a transpile cost on every boot rather than once at build time. At this size it is not
noticeable, and it would be for a large codebase.

No bundler means no tree shaking, no minification, and no automatic browser-target transpilation for the
console. The console targets modern browsers and uses no dependency that needs resolving, so there is
nothing to bundle. Adding a front-end dependency would put this decision back on the table.

Vitest runs the same sources with no separate test build. 40 test files, and none of them import from a
compiled output.

This is a trade made for a reference application. A production service with a large front end and a
release pipeline should not copy it unexamined.
