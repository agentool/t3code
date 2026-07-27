# Antigravity bridge end-to-end checks

Live checks that drive the real `agy` CLI through the ACP bridge over stdio. They
exist because the paths they cover are the ones unit tests cannot reach and the
ones that produced every serious defect found while building the provider:
approval, cancellation, process teardown, and decision forgery.

They are not part of `vp test run` — each spawns `agy`, which needs a working
Google sign-in and consumes real model quota. Run them by hand after changing
`agyBridge.ts`, `AntigravityAdapter.ts`, or `AcpSessionRuntime.ts`.

## Running

Build the server bundle first; the scripts launch `dist/bin.mjs` directly.

```sh
cd apps/server
pnpm vp pack
node ../../scripts/antigravity-e2e/allow-e2e.mjs
```

Each prints its own `RESULT: PASS` / `FAIL` line and exits.

## What each one asserts

| Script                    | Asserts                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `allow-e2e.mjs`           | An approved tool runs, and its call is announced, streamed and completed in that order     |
| `approval-e2e.mjs`        | A rejected tool never runs — the target file is unchanged after the turn                   |
| `cancel-e2e.mjs`          | Stop answers the _original_ prompt with `cancelled`, quickly, and emits nothing afterwards |
| `forged-approval-e2e.mjs` | Tens of thousands of forged decision files never authorise a tool                          |
| `orphan-reap-e2e.mjs`     | A grandchild that outlives `agy` is reaped with the process group                          |
| `sigterm-cleanup-e2e.mjs` | SIGTERM mid-turn leaves no temp directories behind                                         |

## Reading a failure

`cancel-e2e.mjs` cancels on a fixed timer, so it only tests anything if the model
is still working when that timer fires. If the turn finishes first the run
reports `FAIL` with `stopReason: "end_turn"` and an `elapsed` equal to the wall
clock — that is the precondition not being met, not a regression. Re-run it
before investigating.

Failures against a real model can also be quota (`RESOURCE_EXHAUSTED`, HTTP 429)
rather than a defect. Check the bridge's stderr before concluding anything.
