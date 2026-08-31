# pi-agent-studio — product manual

Task-specific manual for the pi-agent-studio repo. The workspace-level contract (ground rules, workflow, ports) lives in [`../AGENTS.md`](../AGENTS.md) — it always applies.

## Architecture map

- **Backend** — `src/pi-studio/server/index.mjs`, one process: HTTP/SSE API **and** the agent registry in-process. The agent core lives in `src/pi-nest/src/` (registry, sdk-bridge, slash, journal), imported in-process — no separate daemon, no gRPC. Per-agent FIFO queues, stale-run watchdog, agent event stream, graceful drain/journal/recover machinery (SQLite journal at `<state>/studio.db`, write-ahead committed transitions).
- **Frontend** — `src/pi-studio/`: the Vue app. `store/chat.ts` is the fat client (fetch + EventSource against the backend; drafts, prefs, the message queue). `layout/app.layout.json` drives the whole UI via StudioFramework. `components/` holds the widgets (ChatWindow, ImageReview, …). The web dev server (vite) proxies API/SSE to the backend's loopback port (main: 7492 → 7494).
- **Test seams** — `PI_STUDIO_CLIENT_MODULE` swaps the agent client for a stub (all check suites; no real model calls); `scripts/lib/stub-backend.cjs` writes it. The stub reads a JSONL control file (`STUB_CONTROL_FILE`) to emit agent events / set live states, and logs every prompt/abort as JSONL to `STUB_PROMPT_LOG` / `STUB_ABORT_LOG` — extend it there when a suite must assert backend delivery (entries include `message`, `interrupt`, `images`). `check:backend-restart` uses the `PI_SDK_DIR` stub-SDK seam in `scripts/lib/stub-sdk`.
- Full CLI design doc: `docs/cli-design.md`.

## The studio CLI (`bin/studio.mjs`)

Run as `npm run studio -- …` from this repo or `node pi-agent-studio/bin/studio.mjs …` from the pair root. Prefer it over manual starts — it owns pidfiles, ports, wiring and logs.

- **Lifecycle**: `up` (adopts already-running services, idempotent; health-gates starts; wires web→backend via ENV) / `down` / `restart <svc>` / `kill <svc>`.
- **Observation**: `status` / `logs [svc] [-f]` / `agents` / `abort <agent-id>`. Logs: `<state>/instances/main/logs/` (main) or `<branch>/.studio/state/logs/` (branches).
- **Hygiene**: `doctor [--fix]` / `clean [--snapshots]`.
- **Branches**: `worktree add <branch> [--from <ref>|--new]` / `worktree rm <branch> [--purge]` (there is no `worktree ls`). One branch = one folder = one instance (id = branch name): pair, sessions (`<branch>/.studio/sessions`), states file, and all runtime state live inside the branch folder — nothing leaks to `~/.local/state` or `~/.config`. Default workdir is the main pair root; override with `PI_STUDIO_WORKTREES`. `worktree rm --purge` leaves the git branch ref — delete it manually.
- **Scheduler**: `jobs list|add|edit|rm|run|enable|disable|runs`. Durable jobs in the journal (`jobs`/`job_runs`); delivery is a scheduled message to a session; one-time (`--at`) and periodic (`--cron`, server-local time); per-job `--missed coalesce|skip`. Survives graceful+SIGKILL restarts; 30s stateless tick + armed timer + boot catch-up. Also the ⏰ Scheduler docker app in the web UI.
- **Config precedence**: CLI args > ENV (`PI_STUDIO_*`) > instance config (`.studio/config/instances/`) > defaults — the same ENV vars run the services containerized without the CLI.

### Graceful backend lifecycle

- `restart backend` stops accepting mutations, drains in-flight prompts (aborting at the `PI_STUDIO_DRAIN_MS` deadline, default 45s), exits 0; the next boot recovers from the journal. Every queue transition is committed before it happens, so graceful and ungraceful (SIGKILL/OOM) restarts recover identically: queued prompts re-queue verbatim; a prompt aborted at the deadline (or killed by a crash) is resumed via the journal — nudged to continue from its throttled partial-text snapshot when the transcript has no partial on disk, replayed verbatim when its user message never landed, skipped when the conversation advanced while the backend was down. A legacy `backend-spill.json` is imported once on boot.
- It reuses the recorded backend port (tombstone pidfile) so the still-running web proxy keeps working. Refused (exit 5) when nothing under the backend watch paths (`src/pi-nest/**`, `src/pi-studio/server/**`) changed — `--yes` overrides.
- `down`/`kill backend` with live agents refuse (exit 5) without `--yes`. `down backend` cascades to web (the stack is the resource unit — don't orphan the web's ~150MB). `restart backend` and `kill <svc>` stay single-service.
- Adoption (`up`) never crosses instances: a healthy backend is adopted only if its `PI_STUDIO_DB_PATH` points into the adopting instance's state dir.
- `restart backend` survives its caller's death: a detached `__finish-restart` helper completes the up under the instance lock if the CLI dies mid-drain (an agent session living inside the backend it restarts is aborted by the drain; the finisher then brings it back). Guarded by `check:restart-selfkill`.

### Operational notes

- **`doctor` orphan sweep is registry-scoped**: a branch CLI's registry only kills orphans inside its own pair roots — `doctor --fix` from a branch folder can never touch main's/review's/other branches' services. It also sweeps reparented browser processes (PPID-1 `headless_shell`/chromium — check-suite leaks). Always run it from `/workspace/sf` for a global sweep. It never kills unattributed processes when running with an isolated `PI_STUDIO_CONFIG_DIR`/`PI_STUDIO_STATE_DIR`. Some PPID-1 suite orphans survive doctor — kill them by PID.
- **Every CLI-initiated terminate is audited**: `<state>/audit.log` records ts, reason (stop/kill/doctor-sweep/up-failure), service, pid, caller argv. Check it first when a process died unexpectedly.
- **OOM forensics**: the backend runs with `--heapsnapshot-near-heap-limit=2` — V8 writes up to 2 `Heap-*.heapsnapshot` files (up to ~1–2 GB) into the start CWD; the `[mem:...]` log line + `/api/health` `mem`/`cache` fields cover the rest; `studio clean --snapshots` deletes them after analysis. Container limit is 4 GiB cgroup.
- **Manual starts** (fallback only, when the CLI itself is broken; `studio up` adopts them afterwards): backend `setsid nohup node --heapsnapshot-near-heap-limit=2 pi-agent-studio/src/pi-studio/server/index.mjs > /tmp/pi-studio-backend.log 2>&1 < /dev/null &` (defaults `127.0.0.1:7494`; `PI_STUDIO_PORT`/`PI_STUDIO_HOST` override); web `setsid nohup node pi-agent-studio/node_modules/.bin/vite pi-agent-studio --config pi-agent-studio/vite.config.ts --host 0.0.0.0 --port 7492 > /tmp/pi-agent-studio-vite.log 2>&1 < /dev/null &`.
- Main's pidfiles: `/workspace/sf/.studio/state/instances/main/pids/`.

## Testing

### Area → suite map (`npm run <script>`, in this repo)

| Area | Suites |
|---|---|
| studio CLI itself | `check:cli` |
| chat composer: send/stop/queue buttons, drafts | `check:queue`, `check:send-stop`, `check:drafts` |
| chat windows, tabs, cross-window behavior | `check:crosswin` |
| session list, sync, states | `check:sync`, `check:states` |
| streaming + scroll behavior | `check:stream-scroll` |
| mobile shell | `check:mobile` |
| SSE robustness | `check:sse` |
| model picker / models API | `check:modelapi` |
| model catalog peak hours (unit + CRUD UI + persistence) | `check:peakhours` |
| scheduler (unit: cron math, fire, missed policy, catch-up) | `check:scheduler` |
| job editor UI | `check:jobeditor` |
| journal drain/recover (unit) | `check:registry` |
| real-process restart recovery (SIGTERM/SIGKILL mid-generation → boot auto-resume) | `check:backend-restart`, `check:restart-selfkill` |
| docker icon geometry | `check:dockericons` |
| types | `typecheck` (`vue-tsc --noEmit`; plain `tsc` does NOT check `.vue`) |
| prod build | `build` |

`dev` / `server` are raw single-service entry points — prefer `studio up`. When in doubt, the full list lives in `package.json`.

### Suite conventions

- Suites boot a private stub stack (backend + vite on free loopback ports, real browser). Browser suites run ~2–6 minutes each; unit-style suites (`check:registry`, `check:scheduler` cron math) are fast. Plan accordingly — one suite per command, never piped through `head`.
- Suites that boot stub stacks **must** use `scripts/lib/suite-stack.cjs` (`spawnStackProc` + `installStackCleanup` + `sweepStaleStackProcesses` + `assertMemoryHeadroom`): stable `SF_SUITE_STACK_STAMP`, startup sweep of previous-run strays, signal/exit cleanup, cgroup memory guard refusing >75%.
- Reporter pattern: a local `report(name, ok, extra)` that logs ✓/✗ and flips a failure flag; exit 1 on any failure. `waitHttp`-style polling helpers for service readiness; poll-don't-sleep for UI state.
- Suite logs land in `/tmp/<suite>-backend.log` and `/tmp/<suite>-vite.log` — read them when a suite fails mysteriously.
- The container has a 4 GiB cgroup limit; an OOM kill takes down the fattest processes. Don't leave strays.

## Pinned product behaviors (the suites are the spec)

- **Composer action button is tri-state**: Send (idle), Queue (session running + text and/or image attachments), Stop (running + empty input) — one button, fixed size, no reserved space; no dedicated queue button. **Typed text never interrupts a running session** (Enter/click queues); the Stop button is the only interrupt path in the UI. (`check:queue`, `check:send-stop`)
- **The message queue** holds text + images (≤4 per message; image-only allowed): FIFO boxes above the input; image boxes show a 🖼 indicator and open the image+text viewer on click; flush on session-idle with wait semantics (`interrupt: false`), delivered exactly once across tabs via the localStorage claim guard; persisted at `sf-chat:queues` keyed by `encodeURIComponent(session file)`; stored entries are re-validated on load (bad mime dropped, >4 images sliced). (`check:queue`)
- **No TUI lock**: the web UI can prompt any session, including one live in the pi TUI; two clients prompting the same session at once is the user's call.
- `store/chat.ts` binds to the framework's workspace API (tracked: activated chat window, open views).

## Repo-specific Biome overrides

`suspicious/noExplicitAny` and `suspicious/noConfusingVoidType` are off for `store/chat.ts` + `slash/commands.ts` — `any` at the backend-JSON boundary; picker callbacks may resolve to nothing or to a slash result. All other biome rules/conventions: see the workspace guide.
