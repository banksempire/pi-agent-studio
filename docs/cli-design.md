# `studio` CLI — Design

A CLI to manage pi-agent-studio service stacks (pi-nest, gateway, web): start,
stop, inspect, and isolate multiple instances on one machine — for production
(`main`), test, and per-agent dev work driven by git branches/worktrees.

Design doc only; implementation notes in §12.

---

## 1. Goals / Non-goals

**Goals**
- One command to start/stop/inspect the three services in dependency order.
- Safe process control: PID-based, never pattern-based `pkill`.
- Multiple isolated instances on one machine, one per git worktree pair.
- Encode the pi-nest covenant (restart only when its code changed; restart kills live agents).
- First-class orphan/stale-process detection and attribution.
- Machine-readable output (`--json`, ndjson events).
- Container-friendly: services configurable purely via ENV vars, no CLI required.

**Non-goals**
- Not a process supervisor (no auto-restart-on-crash, no systemd replacement).
- No changes to service behavior beyond the ENV hooks in §10.
- Not managing StudioFramework's test servers (`SF_TEST_PORT` on non-7492 ports).

## 2. Service model

| Service | Process | Port | Health probe | Restart safety |
|:--|:--|:--|:--|:--|
| `nest` | `node src/pi-nest/src/index.mjs` | ephemeral, loopback | gRPC `Ping` (via `src/pi-nest/src/client.mjs`) | **Destructive** — kills live agents |
| `gateway` | `node --heapsnapshot-near-heap-limit=2 src/pi-studio/server/index.mjs` | ephemeral, loopback | `GET /api/health` → `ok:true` + `nest:true` | Free — agents survive in nest |
| `web` | vite dev server | **fixed per instance** (user-facing URL) | HTTP 200 on `/` | Free |

Dependency: `nest → gateway → web`. `up` honors it; `down`/`kill` reverse it.

Service state model reported by `status`:

```
stopped | starting | up | degraded¹ | orphan² | foreign³
```
¹ process alive, health probe failing
² process matches a service signature but isn't the tracked PID
³ port occupied by an unrelated process

## 3. Port model

**Only the web port is stable** — it is the URL a human bookmarks and reviews.
Internal ports (nest gRPC, gateway HTTP) are uninteresting to users: the CLI
picks any free port at stack start and wires the services together via ENV.

| Port | Persistence | Rules |
|:--|:--|:--|
| `web` | Persisted in instance config; stable across restarts | Unique across instances; `main` = 7492; never 7493/7494/7495; no other instance may use 7492 |
| `gateway` | Ephemeral; recorded in runtime state for the stack's lifetime | Chosen at `up` from free ports, loopback bind |
| `nest` | Ephemeral; recorded in runtime state for the stack's lifetime | Chosen at `up` from free ports, loopback bind |

Wiring per launch (CLI composes child ENV):
- gateway ← `PI_NEST_HOST/PI_NEST_PORT` of this stack's nest
- web ← `PI_API_PROXY=http://127.0.0.1:<gatewayPort>`

Partial restarts (`restart gateway`) **reuse the recorded internal port** (the
stop writes a tombstone pidfile keeping the last port; start prefers it if
still free) so a still-running dependent (web → gateway proxy) keeps working.
If that port was taken by a foreign process meanwhile: the port falls back to
a fresh ephemeral pick, and `restart web` (re-wire) or `down && up` are the
suggested remedies.

Reserved ports: 7492 (product web), 7493 (gateway), 7494 (framework tests),
7495 (nest gRPC) — the ephemeral picker skips them; only `main` uses 7492–7495.

Hosts: `web` binds `0.0.0.0` (or instance `host`); `nest` and `gateway` bind
`127.0.0.1` always (loopback-only by design; gateway proxying happens
server-side in vite).

## 4. Instance model — one git worktree pair = one instance

```
~/wt/test/                          ← pair root (instance home)
├── pi-agent-studio/     worktree of pi-agent-studio  (branch: test)
└── StudioFramework/     worktree of StudioFramework  (branch: main|test)
```

- **Tiers live in git**, not the CLI: `main` branch = stable = the product
  checkout at `/workspace/sf` (instance `main`, implicit); `test` branch = a
  pair for human verification; `dev-*` branches = one pair per dev/agent line.
- The `@sf` vite alias is relative (`../StudioFramework/src`), so a
  pi-agent-studio worktree only builds with a sibling StudioFramework checkout —
  the pair is the unit, created together by `studio worktree add`.
- An instance record binds `pairRoot` → `{ id, webPort, host, sessionsDir,
  createdAt, branch }`. `branch` is informational (recorded at `init`);
- `studio` commands run inside a pair auto-select that instance. Outside any
  pair: `-i <id>` or default `main`.
- Dev → test → main merging, review, and pushing stay **git's job**. The CLI's
  role: give every worktree an isolated, restartable stack and a stable URL to
  verify, and tear it down with the worktree.

Instance record layout:

```jsonc
// ~/.config/pi-agent-studio/instances/test.json
{
  "id": "test",
  "pairRoot": "/home/user/wt/test",
  "branch": "test",                  // recorded at init; warn on mismatch
  "webPort": 7512,
  "host": "0.0.0.0",                 // web bind host
  "sessionsDir": "/home/user/wt/test/.studio/sessions"
}
```

Runtime state (per instance):

```
~/.local/state/pi-agent-studio/instances/<id>/
  pids/{nest,gateway,web}.json       → { pid, pgid, port, startedAt, argv }
  logs/{nest,gateway,web}.log[.1…]
  lock                                → single-writer lock for mutating commands
```

## 5. Sessions isolation

**Rule: one sessions dir per instance, never shared across instances.**

| Instance | Sessions dir | Why |
|:--|:--|:--|
| `main` (product) | `~/.pi/agent/sessions` (default) | **Shared with the pi TUI on purpose** — TUI is the fallback UI if the web stack is down; web UI can prompt TUI sessions as today |
| `test`, `dev-*` | `<pairRoot>/.studio/sessions` | Isolated from `main` and from each other; gitignored; disposable with the worktree |

- Nest gets `PI_NEST_SESSIONS`, gateway gets `PI_STUDIO_SESSIONS`, both set to
  the instance's dir by the CLI.
- `PI_STUDIO_STATES_PATH` is always set per instance
  (`<pairRoot>/.studio/states.json`) — two gateways sharing the default
  `~/.pi/agent/studio-session-states.json` would clobber each other.
- Guard: starting an instance whose sessions dir equals another live
  instance's → **hard error**. This is what enforces "main / test / dev
  sessions never mix".
- Isolation is keyed by **worktree**, not branch. `git switch`-ing a live
  worktree between branches does not switch sessions. `up` warns when the
  checked-out branch differs from the recorded `branch`.
- `worktree rm <id> --purge` is the only sanctioned sessions deletion — a dev
  branch's agent history dies with its worktree.

## 6. Config resolution — args > ENV > defaults

Every tunable resolves through four layers, first hit wins:

| Layer | Example | Who sets it |
|:--|:--|:--|
| 1. CLI args | `studio up --port web=7601 --sessions /tmp/s` | Ad-hoc override; never persisted |
| 2. Environment | `PI_STUDIO_PORT`, `PI_NEST_PORT`, `PI_NEST_SESSIONS`, … | Shell / container |
| 3. Instance config | `~/.config/pi-agent-studio/instances/<id>.json` | `studio init` / `instance set` |
| 4. Built-in defaults | see §10 table | The services themselves |

- The **services themselves** implement layers 2→4 (ENV ?? default). This
  keeps the container story pure: run nest/gateway/web directly with just ENV
  vars — no CLI — with identical precedence inside each service.
- The CLI is a layer-3 manager that materializes instance config into
  **child-process ENV** at spawn time. It never configures services any other
  way; one mechanism, no duplicated knobs.
- Ephemeral internal ports (§3) are also injected this way — the CLI resolves
  free ports at start and passes them as ENV to the children.
- In a container with ENV pinned, the CLI's port-picking is skipped entirely
  (layer 2 wins).

## 7. Command tree

```
studio [-i <instance>] <command> …        # auto-detects instance from CWD's pair

  up [service]                idempotent start, dependency order, health-gated;
                              `up gateway` ensures its nest pair first
  down [service]              graceful stop, reverse order.
                              Default (no args): the full stack — web, gateway
                              and the nest pair. `down gateway` also stops its
                              nest pair; any nest-stopping path passes the
                              covenant guard (§8)
  restart <service>           stop + up; restart gateway leaves its nest pair
                              alive (agents keep streaming); restart nest goes
                              through the guard
  kill <service> [--force]    SIGTERM → grace (web 5s, gateway 8s, nest 10s) → SIGKILL;
                              killing gateway stops its nest pair too; any
                              nest-stopping path goes through the guard
  status [service]            per-instance table + all-instances view; --json
  logs [service] [-f] [-n N]        tail managed logs (services log without timestamps,
                                    so no --since filtering; -f follows)
  agents                      live agents via nest ListStates: id, state, queue, activity
  abort <agent-id>            wraps gRPC Abort
  doctor [--fix]              diagnostics per §11; --fix auto-applies safe fixes
  clean [--logs] [--snapshots] [--pidfiles] [--instances]
  open [--path /]             open the instance's web URL (human review step)
  help | --version

  init                        inside a pair root / repo worktree: register instance,
                              allocate web port (--port auto|N), create .studio/ + gitignore,
                              verify sibling StudioFramework, npm install if node_modules missing
  worktree add <id> [--from <branch>]   git worktree add BOTH repos under ~/wt/<id>/, then init
  worktree rm <id> [--purge]            down (nest guard) + git worktree remove + rm instance;
                                        --purge deletes .studio/sessions too
  instance ls | show | set | rm
```

- `status` (no args) shows **all** instances: id, branch, pairRoot, webPort,
  stack state; `-i` filters.
- `main` is never stopped or started implicitly by instance-scoped commands.

## 8. The pi-nest covenant (safety guards)

`nest` restart/kill is a two-gate check:

**Gate 1 — live agents.** Query `ListStates`. Any agent running or with queued
messages → interactive confirm listing them (id, elapsed runtime, queue depth)
plus the "restart kills these agents" warning. Non-interactive without `--yes`
→ refuse, exit 5.

**Gate 2 — stale-code check.** Compare the newest mtime under `src/pi-nest/**`
against the nest process start time. If nothing changed since it started,
print e.g. `no changes under src/pi-nest since nest started (started 14:02,
last edit 13:47) — restart anyway?` and default to **No**. Mechanizes the
AGENTS.md rule (restart only when its own code changed; cosmetic edits count
as no-change), including the cosmetic-edit case.

Gateway ⇄ nest pairing: the two services start and stop as a pair
(`up gateway` starts its nest first; `down`, `down gateway`, `kill gateway`
stop the nest too), but `restart gateway` never touches the nest — that is
the whole point of keeping pi-nest a standalone process. The asymmetry is
visible in `status` (nest row shows `⚠ N live agents`).

Gate 2 (stale code) applies to `restart nest` only — a deliberate stop
(`down`/`kill`) reflects intent, not a recycle, so only the live-agent gate
fires there.

## 9. Process control

**Daemonization.** `up` spawns each service detached (own process group,
stdio → managed log file). The CLI exits; services keep running. No
long-lived supervisor.

**PID registry.** Per-service pidfiles (§4) validated against
`/proc/<pid>/cmdline` before trust (guards against PID reuse).

**Discovery & attribution.** argv is identical across instances, so:
1. Match anchored argv signature (e.g. cmdline ending in
   `pi-agent-studio/src/pi-nest/src/index.mjs`).
2. Read `/proc/<pid>/environ` → recover `PI_NEST_PORT` / `PI_STUDIO_PORT` /
   `PI_API_PROXY` → map to an instance via runtime state / ports.
3. Unattributable matches (pre-CLI era processes) → listed as `unattributed`;
   `doctor --fix` adopts them only via port match, else reports.

**Orphan handling.** On any mutating command and in `status`/`doctor`:
- orphan found, no pidfile → adopt (write pidfile, report);
- orphan besides the tracked PID → report both; `doctor --fix` kills orphans
  after SIGTERM grace.

This replaces every hand-rolled `pgrep`/`pkill` pattern.

**Start gating in `up`:**
```
start nest → poll Ping (10s, 250ms interval)
start gateway → poll /api/health (10s) — ok:true AND nest:true
start web → poll HTTP 200 (15s, vite cold start)
```
On failure: dump the service's last 30 log lines; roll back only what this
invocation started (never kill pre-existing healthy services).

**Port conflicts (web port):** owner is our service → adopt/keep; owner is an
orphan of ours → offer kill (`--fix`); foreign process → exit 4 with owner
PID/cmdline. The web port is fixed per instance by design (stable URL);
there is no auto-relocate.

## 10. Service-side ENV surface (approved changes)

| Change | File | Behavior |
|:--|:--|:--|
| **new** `PI_NEST_SESSIONS` | `src/pi-nest/src/sdk-bridge.mjs` | `SESSIONS_ROOT = env ?? ~/.pi/agent/sessions` (today hardcoded). **pi-nest code change ⇒ covenant restart applies when shipped** |
| **new** `PI_STUDIO_HOST` | `src/pi-studio/server/index.mjs` | bind host: `env ?? '0.0.0.0'` (today hardcoded `0.0.0.0`) |
| existing `PI_NEST_HOST/PORT` | nest, gateway (client.mjs ctor) | already supported; CLI sets per stack |
| existing `PI_STUDIO_PORT/SESSIONS/STATES_PATH/CWD` | gateway | already supported |
| existing `PI_API_PROXY` | vite.config.ts proxy target | CLI sets at web spawn |
| **new** `PI_STUDIO_WORKTREES` | CLI only | worktree pair root (`~/wt` default; keep it on the same filesystem as the repos so `node_modules` can be hardlink-copied) |
| **new** `PI_STUDIO_WEB_HOST` / `PI_STUDIO_WEB_PORT` | CLI only | web bind host / port fallbacks below args and above instance config |

Container usage: each service reads `ENV ?? default` directly — the CLI is not
required in a container; pinning ENV there yields deterministic ports.

## 11. `doctor` checks

| Check | Err/Warn |
|:--|:--|
| Node version ≥ expected major | err |
| Web port free or owned by us | err (foreign), warn (orphan) |
| Tracked PIDs alive & cmdline matches pidfile | warn if mismatch |
| Orphan scan + attribution per instance | warn, list |
| Stale pidfiles (dead PID) | warn, auto-fixable |
| Gateway `/api/health` (nest:true, heap %, RSS %) | err unreachable; warn heap ≥85% / RSS ≥80% |
| Nest gRPC Ping | err unreachable |
| Live agent count on nest | info (context for restarts) |
| Heap snapshot files present | warn, auto-fixable via `clean` |
| Per-worktree: `../StudioFramework/src` resolvable, `node_modules` present in this worktree | err |
| Checked-out branch ≠ recorded branch | warn |
| Instance whose pairRoot no longer exists | warn → `clean --instances` |
| Cross-instance: duplicate sessions roots, duplicate web ports | err |

## 12. UX & implementation status

**Implemented** (this doc now describes the shipped CLI):

- `bin/studio.mjs` (entry + dispatch) + `bin/lib/{instances,proc,stack,manage,ui}.mjs`;
  npm script `npm run studio -- …`.
- Zero new runtime deps: `node:child_process` + `/proc` + the repo's own
  `src/pi-nest/src/client.mjs` (which gained a `close()` so callers can release
  the gRPC handle).
- State: `~/.config/pi-agent-studio/instances/*.json` (configs) and
  `~/.local/state/pi-agent-studio/instances/<id>/` (pidfiles, logs, lock) —
  both relocatable via `PI_STUDIO_CONFIG_DIR` / `PI_STUDIO_STATE_DIR` for tests
  and containers.
- Regression: `npm run check:cli` (`scripts/check-cli.cjs`) — 21 assertions
  covering worktree pair creation, up with ENV-pinned ports, sessions
  isolation, the covenant guard (exit 5), port reuse on restart, partial down,
  and full teardown. It hosts nothing on 7492–7495.
- CLI-spawned gateways bind `127.0.0.1` (override with `PI_STUDIO_HOST`);
  main's web stays `0.0.0.0:7492`.

- Human tables by default; `--json` everywhere; `up` emits ndjson events
  `{"event":"starting","instance":"test","service":"nest"}` …
- `--quiet` for scripts; colors auto-off when not a TTY or `NO_COLOR`.
- Prompts default to the safe answer; `--yes` bypasses prompts (non-TTY
  guard refusals still require explicit `--yes`).
- Exit codes: `0` ok · `1` failure · `2` usage · `3` health timeout ·
  `4` port conflict · `5` guard refusal · `130` interrupted.
- Single-writer lock per instance state dir for mutating commands.
- Logs: per-service file, rotate at 5 MB keep 3; `status` surfaces the
  gateway's latest `[mem:…]` line; `clean --snapshots` removes
  `Heap-*.heapsnapshot` leftovers.
- Shape: ESM bin `bin/studio.mjs` + modules (`args`, `state`, `procs`,
  `health`, `nest-client`, `ui`), npm script `"studio": "node bin/studio.mjs"`.
  Zero new runtime deps (`node:child_process` + `/proc` + existing
  `src/pi-nest/src/client.mjs`). No comments in source, per workspace rules.
- Regression: committed check script (pattern of `check:*`), testing against
  fake processes / a throwaway pair — never hosting test services on 7492–7495.

## 13. Example sessions

```
$ studio worktree add test --from test
  created pair ~/wt/test (pi-agent-studio@test, StudioFramework@main)
  instance test: web 7512 · sessions ~/wt/test/.studio/sessions

$ studio -i test up
  test/nest     pid 51017  :34191  ping ok
  test/gateway  pid 51044  :34195  /api/health ok, nest:true
  test/web      pid 51082  :7512   http://127.0.0.1:7512

$ studio status
  INSTANCE  SERVICE   PID     STATE  PORT    DETAIL
  main      nest      14353   up     7495    2 agents (1 running) ⚠ destructive
  main      gateway   27859   up     7493    rss 412 MB · 3 sse
  main      web       42416   up     7492
  test      nest      51017   up     34191   0 agents
  test      gateway   51044   up     34195   rss 88 MB
  test      web       51082   up     7512    branch test · ~/wt/test
  —         orphans   4 (3 gateway · 1 vite) → studio doctor --fix

$ studio -i test open          # human verification of the test branch
$ studio -i test restart gateway   # internal port reused; main untouched
$ studio -i test down          # full stack teardown — nest guard applies
$ studio worktree rm test --purge # full teardown incl. its sessions

$ studio -i main restart nest
  ⚠ 1 running agent (…/session-x.jsonl, running 4m) — restart kills it. Continue? [y/N] n
  Aborted (exit 5)
```

Pipeline mapping: `main` = product (TUI-shared sessions, fallback UI intact);
`test` = stable-URL stack a human reviews before pushing test → main;
`dev-*` = one pair per agent/dev branch, sessions isolated under the pair.
