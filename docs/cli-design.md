# `studio` CLI — Design

A CLI to manage pi-agent-studio service stacks (backend, web): start,
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
| `backend` | `node --heapsnapshot-near-heap-limit=2 src/pi-studio/server/index.mjs` (HTTP+SSE + agent registry in one process) | ephemeral, loopback | `GET /api/health` → `ok:true` | **Graceful** — drains prompts, spills the queue, restores on boot; in-flight prompts abort at the drain deadline |
| `web` | vite dev server | **fixed per instance** (user-facing URL) | HTTP 200 on `/` | Free |

Dependency: `backend → web`. `up` honors it; `down`/`kill` reverse it.

Service state model reported by `status`:

```
stopped | starting | up | degraded¹ | orphan² | foreign³
```
¹ process alive, health probe failing
² process matches a service signature but isn't the tracked PID
³ port occupied by an unrelated process

## 3. Port model

**Only the web port is stable** — it is the URL a human bookmarks and reviews.
The backend port is uninteresting to users: the CLI picks any free port at
stack start (persisting it as a tombstone) and wires web to it via ENV.

| Port | Persistence | Rules |
|:--|:--|:--|
| `web` | Persisted in instance config; stable across restarts | Unique across instances; `main` = 7492; `test` conventionally pins 7493 (the exposed test port); never 7494; no other instance may use 7492 |
| `backend` | Ephemeral; recorded in runtime state for the stack's lifetime | Chosen at `up` from free ports, loopback bind |

Wiring per launch (CLI composes child ENV):
- backend ← `PI_STUDIO_PORT`, `PI_STUDIO_SESSIONS`, `PI_STUDIO_STATES_PATH`, `PI_STUDIO_SPILL_PATH`
- web ← `PI_API_PROXY=http://127.0.0.1:<backendPort>`

Partial restarts (`restart backend`) **reuse the recorded internal port** (the
stop writes a tombstone pidfile keeping the last port; start prefers it if
still free) so a still-running dependent (web → backend proxy) keeps working.
If that port was taken by a foreign process meanwhile: the port falls back to
a fresh ephemeral pick, and `restart web` (re-wire) or `down && up` are the
suggested remedies.

Reserved ports: 7492 (main web — the exposed production port) and 7494
(main backend) — the ephemeral picker skips them. 7493 is the shared test
port — the only other externally reachable port — hosting the `test`
instance web, the StudioFramework check server, or ad-hoc test servers
(first come, first served). 7495 is free since the nest/gateway merge.

Hosts: `web` binds `0.0.0.0` (or instance `host`); `backend` binds
`127.0.0.1` always (loopback-only by design; proxying happens server-side in
vite).

## 3a. Graceful restart (drain → journal → recover)

The backend owns the agents, so its restart is the one destructive path —
made graceful. Durability comes from the SQLite journal
(`<state>/studio.db`, WAL mode): every queue transition is committed
**before** it takes effect in memory, so graceful and ungraceful (SIGKILL,
OOM) exits recover identically on the next boot.

1. **Submit path** — a prompt is INSERTed (`status=queued`) before it joins
   the in-memory queue; the pump UPDATEs it to `inflight` (with `started_at`)
   before calling the SDK, throttled `message_update` deltas are snapshot into
   `partial_text`, and a settled prompt's row is DELETEd. Rows only ever hold
   live work, so the file stays tiny.
2. **SIGTERM** → the backend stops accepting mutations (`503`), then drains:
   per agent it waits for the in-flight prompt to settle (up to
   `PI_STUDIO_DRAIN_MS`, default 45s), aborting still-running prompts at the
   deadline — an abort-at-deadline run keeps its journal row (`inflight` +
   partial text) so it auto-resumes after the restart; its partial transcript
   stays in the session file.
3. **Exit 0**, CLI restarts the process (grace = drain deadline + 20s).
4. **Boot** — `registry.recover()` reads outstanding rows and, per item:
   re-queues `queued` prompts verbatim; for `inflight` prompts it inspects the
   session-file tail — if the conversation advanced while the backend was
   down (e.g. someone prompted via the TUI) the row is skipped, if the user
   message never landed it is replayed verbatim, and if the run was cut off
   mid-reply the agent is nudged to continue (the snapshot of streamed text
   is quoted back when the transcript has no partial on disk). Pending
   model/think-level prefs and per-session UI states are restored too. A
   leftover `backend-spill.json` (pre-journal versions) is imported once and
   consumed.

CLI semantics: `restart backend` is allowed without `--yes` whenever backend
code changed since start (it refuses exit 5 otherwise — `--yes` overrides);
busy agents are drained, never silently discarded. `down`/`kill backend` with
live agents still ask the guard. Every CLI-initiated `terminate()` appends a
line to `<state>/audit.log` (ts, reason, service, pid, caller argv).

## 4. Instance model — one git worktree pair = one instance

```
<workdir>/.branch/<branch>/                ← branch folder (pair root, instance home)
├── pi-agent-studio/     worktree of pi-agent-studio  (branch: <branch>)
├── StudioFramework/     worktree of StudioFramework  (branch: <branch>|main)
└── .studio/             EVERYTHING the branch's agents/services create —
    ├── sessions/          pi agent session files (isolated per branch)
    ├── studio-session-states.json
    └── state/             pidfiles, service logs, lock (instance runtime state)
```

- Default `<workdir>` is the main pair root (e.g. `/workspace/sf`), so branches
  live at `/workspace/sf/.branch/<branch>/` — on the same filesystem as the
  repos by construction (`node_modules` can be hardlink-copied, never a full
  install). `PI_STUDIO_WORKTREES` overrides the root if you want it elsewhere.
- **One branch = one folder = one instance.** Instance id == branch name;
  `worktree rm <id> --purge` deletes the whole folder — worktrees, sessions
  and runtime state included — leaving nothing behind on the machine.

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
// <workdir>/.studio/config/instances/test.json   (restart-persistent)
{
  "id": "test",
  "pairRoot": "/workspace/sf/.branch/test",
  "branch": "test",                  // recorded at init; warn on mismatch
  "webPort": 7512,
  "host": "0.0.0.0",                 // web bind host
  "sessionsDir": "/workspace/sf/.branch/test/.studio/sessions"
}
```

Runtime state: `main` keeps `<workdir>/.studio/state/instances/main/`
(pidfiles, logs, lock); every other instance keeps it inside its branch
folder at `<pairRoot>/.studio/state/` — so a branch folder is fully
self-contained and purge-safe. Only `/workspace/sf` and the pi agent state
folder (`~/.pi`) survive container restarts, so **every persistent store
lives inside the sf folder**: the instance registry at
`<workdir>/.studio/config/`, main's runtime state at `<workdir>/.studio/state/`,
branch folders under `<workdir>/.branch/`. Legacy `~/.config/…` and
`~/.local/state/…` records are migrated into `.studio/` on first use
(one-time; `PI_STUDIO_CONFIG_DIR` / `PI_STUDIO_STATE_DIR` still override,
e.g. for the hermetic check suite).

## 5. Sessions isolation

**Rule: one sessions dir per instance, never shared across instances.**

| Instance | Sessions dir | Why |
|:--|:--|:--|
| `main` (product) | `~/.pi/agent/sessions` (default) | **Shared with the pi TUI on purpose** — TUI is the fallback UI if the web stack is down; web UI can prompt TUI sessions as today |
| `test`, `dev-*` | `<pairRoot>/.studio/sessions` | Isolated from `main` and from each other; gitignored; disposable with the worktree |

- The backend gets `PI_STUDIO_SESSIONS`, set to the instance's dir by the CLI.
- `PI_STUDIO_STATES_PATH` is always set per instance
  (`<pairRoot>/.studio/states.json`) — two backends sharing the default
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
| 3. Instance config | `<workdir>/.studio/config/instances/<id>.json` | `studio init` / `instance set` |
| 4. Built-in defaults | see §10 table | The services themselves |

- The **services themselves** implement layers 2→4 (ENV ?? default). This
  keeps the container story pure: run backend/web directly with just ENV
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
                              default: backend then web
  down [service]              graceful stop, reverse order (web then backend);
                              the backend drains + spills (§3a); deliberate
                              stops pass the live-agent guard (§8);
                              `down backend` cascades to web — the stack is
                              the resource unit (`restart backend` and
                              `kill <svc>` stay single-service)
  restart <service>           stop + up; `restart backend` is graceful (§3a)
                              and refused (exit 5) when no backend code
                              changed since start — `--yes` overrides
  kill <service> [--force]    SIGTERM → grace (web 5s, backend drain+20s) → SIGKILL;
                              guarded while agents are live
  status [service]            per-instance table + all-instances view; --json
  logs [service] [-f] [-n N]        tail managed logs (services log without timestamps,
                                    so no --since filtering; -f follows)
  agents                      live agents via /api/agent-states: id, state, queue, activity
  abort <agent-id>            wraps POST /api/abort
  jobs list                   scheduled jobs (id, schedule, target, next run, last status)
  jobs add <name> …           create a job: --at <time> (once) | --cron <expr> (periodic)
                              | --nonpeak (no fixed time — once a day in the
                              model's off-peak hours; needs --model, no --cron),
                              -m/--message, --session <file> | --cwd <dir> [--mode new|reuse],
                              --model, --think, --missed coalesce|skip, --by, --disabled
  jobs edit <id> …            update (--name/--message/--at/--cron/--nonpeak/--anytime/--session/--cwd/--model/--think/--missed)
  jobs rm <id>                delete job + run history
  jobs run <id>               fire now (manual run; schedule untouched)
  jobs enable|disable <id>    toggle without editing
  jobs runs <id> [-n N]       run history
  peak-hours list [--provider <id>]
                              peak-hour windows (id, model, window, UTC, on, note)
  peak-hours add …            add window(s): --provider <id> (every catalog model)
                              | --model <provider/model>; --start/--end HH:MM on the
                              --offset clock (UTC+8 | +8 | -5:30 | minutes, default UTC);
                              --note <text>, --disabled; --weekdays mon-fri |
                              mon,wed,fri | 1-5 | weekend | all (default all);
                              identical windows are skipped
  peak-hours rm <id> | --key <provider/model> | --provider <id>
                              delete window(s)
  peak-hours enable|disable <id>
                              toggle a window
  doctor [--fix]              diagnostics per §11; --fix auto-applies safe fixes
                              (stale pidfiles, orphans, git guard hooks);
                              orphan sweep also covers reparented browser
                              processes (headless_shell/chromium with a dead
                              parent — check-suite leaks), and a registry
                              without a 'main' instance (a branch CLI's own
                              registry) only sweeps orphans inside its own
                              pair roots — another registry's services are
                              never killed
  guard [install|status]      install/inspect core.hooksPath on both repos
                              (pre-commit: main-branch rule + biome gate;
                              pre-push: typecheck)
  clean [--snapshots] [--pidfiles] [--instances]
  open [--path /]             open the instance's web URL (human review step)
  help | --version

  init                        inside a pair root / repo worktree: register instance,
                              allocate web port (--port auto|N), create .studio/ + gitignore,
                              verify sibling StudioFramework, npm install if node_modules missing
  worktree add <id> [--from <branch>]   git worktree add BOTH repos under <workdir>/.branch/<id>/, then init
  worktree rm <id> [--purge]            down (agent guard) + git worktree remove + rm instance;
                                        --purge deletes .studio/sessions too
  instance ls | show | set | rm
```

- `status` (no args) shows **all** instances: id, branch, pairRoot, webPort,
  stack state; `-i` filters.
- `main` is never stopped or started implicitly by instance-scoped commands.
- **`PI_STUDIO_STRICT=1`** (env): `up`/`down`/`restart`/`kill` refuse to run
  on defaults — cwd auto-detection and the main fallback are disabled until
  an explicit `-i <id>` names the target. Opt-in guard for agent shells /
  dev containers where a bare `studio up` must not be able to touch the
  product stack; instance ids are unique (one registry file per id), so a
  named target is always unambiguous. Read-only commands stay permissive.
- orphan found, no pidfile → adopt (write pidfile, report);
- orphan besides the tracked PID → report both; `doctor --fix` kills orphans
  after SIGTERM grace.

This replaces every hand-rolled `pgrep`/`pkill` pattern.

**Start gating in `up`:**
```
start backend → poll /api/health (15s) — ok:true
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
| `PI_STUDIO_SESSIONS` | `src/pi-nest/src/sdk-bridge.mjs` | `SESSIONS_ROOT = env ?? ~/.pi/agent/sessions` |
| `PI_STUDIO_HOST` | `src/pi-studio/server/index.mjs` | bind host: `env ?? '127.0.0.1'` (loopback-only; the web /api proxy is the only intended entry) |
| existing `PI_STUDIO_PORT/SESSIONS/STATES_PATH/CWD` | backend | already supported |
| existing `PI_API_PROXY` | vite.config.ts proxy target | CLI sets at web spawn |
| `PI_STUDIO_CACHE_MAX_BYTES` | backend | session-parse cache budget (default 128 MB), LRU whole-file eviction; effective ceiling = max(budget, largest session file) |
| **new** `PI_STUDIO_DRAIN_MS` | backend + CLI | SIGTERM drain deadline (default 45s); CLI stop grace = deadline + 20s |
| existing `PI_STUDIO_SPILL_PATH` | backend | legacy: a leftover `backend-spill.json` here is imported into the journal once on boot (CLI pins it inside the instance state dir) |
| **new** `PI_STUDIO_DB_PATH` | backend | SQLite journal location (default `<state>/studio.db`, derived from the spill path's dir; CLI pins it inside the instance state dir) |
| **new** `PI_STUDIO_RESUME` / `PI_STUDIO_RESUME_MODE` | backend | `off` disables interrupted-run resume; mode `nudge` (default) / `replay` / `skip` controls how `inflight` rows are resubmitted on boot |
| **new** `PI_STUDIO_CLIENT_MODULE` | backend | test seam: path to an ESM module exporting `createClient()`; replaces the real agent registry with a stub client (used by the check suites) |
| **new** `PI_STUDIO_WORKTREES` | CLI only | branch-folder root (default `<main pair root>/.branch`; keep it on the same filesystem as the repos so `node_modules` can be hardlink-copied) |
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
| Backend `/api/health` (heap %, RSS %) | err unreachable; warn heap ≥85% / RSS ≥80% |
| Live agent count on the backend | info (context for restarts) |
| Orphan sweep under `--fix` | kills unattributed service processes — but only with the default registry; under `PI_STUDIO_CONFIG_DIR`/`PI_STUDIO_STATE_DIR` (isolated registries, e.g. check runs) it reports them and leaves them alone |
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
- State: `<workdir>/.studio/config/instances/*.json` (registry) and
  `<workdir>/.studio/state/instances/main/` for main's pidfiles/logs/lock
  (branch instances keep state in their branch folder) — all inside the sf
  folder so they survive container restarts;
  both relocatable via `PI_STUDIO_CONFIG_DIR` / `PI_STUDIO_STATE_DIR` for tests
  and containers.
- Regression: `npm run check:cli` (`scripts/check-cli.cjs`) — 21 assertions
  covering worktree pair creation, up with ENV-pinned ports, sessions
  isolation, the backend guard (exit 5), graceful drain/spill/restore, port
  reuse on restart, partial down, and full teardown. It hosts nothing on
  7492/7494.
- CLI-spawned backends bind `127.0.0.1` (override with `PI_STUDIO_HOST`);
  main's web stays `0.0.0.0:7492`.

- Human tables by default; `--json` everywhere; `up` emits ndjson events
  `{"event":"starting","instance":"test","service":"backend"}` …
- `--quiet` for scripts; colors auto-off when not a TTY or `NO_COLOR`.
- Prompts default to the safe answer; `--yes` bypasses prompts (non-TTY
  guard refusals still require explicit `--yes`).
- Exit codes: `0` ok · `1` failure · `2` usage · `3` health timeout ·
  `4` port conflict · `5` guard refusal · `130` interrupted.
- Single-writer lock per instance state dir for mutating commands.
- Logs: per-service append-only file (no rotation — delete via the state dir
  if needed); `status` surfaces the
  backend's latest `[mem:…]` line; `clean --snapshots` removes
  `Heap-*.heapsnapshot` leftovers.
- Shape: ESM bin `bin/studio.mjs` + modules in `bin/lib/`
  (`instances`, `stack`, `manage`, `proc`, `ui`), npm script
  `"studio": "node bin/studio.mjs"`.
  Zero runtime deps beyond Node built-ins + the SDK import in the backend.
  No comments in source, per workspace rules.
- Regression: committed check script (pattern of `check:*`), testing against
  fake processes / a throwaway pair — never hosting test services on 7492–7495.

## 13. Example sessions

```
$ studio worktree add test --from test
  created pair ~/wt/test (pi-agent-studio@test, StudioFramework@main)
  instance test: web 7512 · sessions ~/wt/test/.studio/sessions

$ studio -i test up
  test/backend  pid 51044  :34195  /api/health ok
  test/web      pid 51082  :7512   http://127.0.0.1:7512

$ studio status
  INSTANCE  SERVICE   PID     STATE  PORT    DETAIL
  main      backend  14353   up     7494    2 agents (1 running) · rss 412 MB · 3 sse
  main      web      42416   up     7492
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

## 14. Scheduler (`jobs`)

General-purpose job scheduler, backend-owned. Jobs live in the journal
(`studio.db`: `jobs` + `job_runs` tables), so they survive graceful and
SIGKILL restarts identically — same covenant as the prompt queue.

- **Schedule types**: `once` (absolute `runAt` epoch-ms — e.g. "send this
  off-peak tonight"), `cron` (5-field, server-local time — e.g. nightly
  maintenance) and `nonpeak` (no cron of its own: runs once a day, at the
  first moment the job's model is outside its peak windows — requires a
  `--model`; a new or re-enabled job fires at the next open moment). A due
  occurrence that lands inside a peak window (catalog changed after
  scheduling) defers to the next open moment.
  Hand-rolled parser, no new dependencies.
- **Trigger**: 30s stateless tick + an armed `setTimeout` to the earliest
  `next_due` (`.unref()`'d) + boot catch-up. The tick re-derives everything
  from the clock and the journal, so restarts, clock jumps and lost timers
  self-heal; the timer only adds promptness.
- **Delivery**: a fired job resolves its target session and calls
  `registry.prompt()` — the fired prompt becomes a normal `queue_items` row
  and inherits drain/recover/watchdog semantics. `job_runs.queue_item_id`
  links the history row to the queue item.
- **Targets**: existing session file, fresh session per run (`new`), or one
  session per cwd (`reuse`). `--model/--think` apply prefs to freshly
  created sessions.
- **Concurrency**: simultaneous runs go through a governor — a global cap
  (default 2), a per-provider cap (default 2) and a per-model cap (default 1)
  — so bursty schedules can't hammer one provider or drain the container.
  A due run that can't get a slot stays due and fires when one frees
  (completion-triggered tick); `jobs run` waits for a slot too. Env knobs:
  `PI_STUDIO_SCHED_GLOBAL_MAX`, `PI_STUDIO_SCHED_PROVIDER_MAX`,
  `PI_STUDIO_SCHED_MODEL_MAX` (integers ≥ 1).
- **Missed periodic runs** (backend down across occurrences): per-job
  `--missed coalesce` (run once on catch-up, default) or `skip` (advance to
  the next occurrence, record a `skipped` run).
- **Manual `jobs run <id>`** fires immediately without touching the schedule.
- **Once jobs** auto-disable after firing (kept for history); re-enabling
  recomputes `next_due` (a past `runAt` means "next tick").
- **Boot sweep**: run rows stuck `queued` from a previous boot are marked
  `interrupted` (their prompt may still have been replayed by journal
  recovery via the queue item).
- **Surfaces**: `studio jobs …` CLI (humans + agents), the Scheduler workspace
  tab in the web UI (JobsTab table: enable toggle, run-now, history, edit;
  JobDialog popup for CRUD), SSE
  `job_event` for live updates, REST under `/api/jobs`.

Check suite: `npm run check:scheduler` (cron math, fire/advance, missed
policies, run-now, restart catch-up, boot sweep, timer).

## 15. Peak hours (`peak-hours`)

Rate-limit windows per model, backend-owned (`peak-hours.json` next to the
journal, written through the running backend's `/api/peak-hours`). The UI
surface lives in the Model menu (Model Catalog right panel + the Peak Hours
tab); the CLI is the batch/agent surface.

- **Window model**: `--start/--end` are HH:MM on the `--offset` clock
  (`UTC+8`, `+8`, `-5:30`, or raw minutes; default UTC); the backend stores
  canonical UTC minutes plus the display clock. A window may wrap midnight.
  `--start` must differ from `--end`.
- **Weekdays**: `--weekdays <spec>` scopes the window to specific days —
  `mon-fri` | `mon,wed,fri` | `1-5` | `sun` | `weekend` | `all` (default
  `all`). Days are counted on the window's own clock (the `--offset`
  clock), so a UTC+8 window peaks on Beijing days; a window wrapping
  midnight needs its tail day included too (Mon 22:00–02:00 covering
  Tuesday 01:00 wants `mon,tue`). Weekdays take part in the
  identical-window guard: same clock, different days = distinct rules.
- **Targets**: `--model <provider/model>` (or `--provider <id>` +
  `--model <id>`) for one model, or `--provider <id>` alone to fan out over
  every model of that provider in the live catalog (`GET /api/models`).
  Fan-out is **idempotent**: models that already have an identical window
  are reported as skipped, so re-running converges instead of failing.
- **`list [--provider <id>]`** prints id, model, window (display clock),
  UTC equivalent, days, enabled state, note. `--json` emits the raw entries.
- **`rm`** deletes by entry id, by `--key <provider/model>`, or every window
  of `--provider <id>`; reports how many were removed.
- **`enable|disable <id>`** toggles without editing.
- Errors: exit 2 for usage problems (bad HH:MM, unparseable or ±12h+
  offsets, unknown provider with no catalog models), exit 1 for backend
  failures; the backend re-validates everything (identical-window guard,
  note length, offset range).

Example — rate-limit window for a whole provider, working days only:

```
$ studio -i main peak-hours add --provider zai-coding-cn \
    --start 14:00 --end 18:00 --offset UTC+8 --weekdays mon-fri
created zai-coding-cn/glm-4.7 — (UTC+8) 14:00-18:00 · Mon–Fri
…
10 created, 0 skipped, 0 failed
```

Check suite: `npm run check:cli` (add/list/rm/enable/disable, offset
parsing, canonical UTC round-trip, idempotent fan-out).
