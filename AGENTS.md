# pi-agent-studio — product manual

Task-specific manual. The workspace contract (ground rules, workflow, ports) lives in [`../agents.md`](../agents.md) and always applies. When this manual disagrees with the code, the code wins.

## Setup

- Run the stack via the CLI, never by hand: `npm run studio -- …` from this repo, or `node pi-agent-studio/bin/studio.mjs …` from the pair root (`up` / `down` / `restart <svc>` / `kill <svc>` / `status` / `logs [svc] [-f]` / `agents` / `abort <id>` / `doctor [--fix]` / `clean [--snapshots]`). The CLI owns pidfiles, ports, wiring and logs.
- One process: `src/pi-studio/server/index.mjs` serves the HTTP/SSE API and owns the agent registry in-process; the agent core lives in `src/pi-nest/src/` (registry, sdk-bridge, slash, journal). No separate daemon. The journal is SQLite at `<state>/studio.db`; every queue transition is committed before it happens, so graceful and SIGKILL restarts recover identically.
- Frontend: `src/pi-studio/` (Vue). The whole UI is declarative JSON — `layout/app.layout.json` (panels bound to data providers) + `layout/panelData.ts` (viewmodels, action handlers, dialogs); `components/` holds workspace-tab widgets and the backend status component only. Product-specific UI never touches `StudioFramework`; framework gaps are fixed there (keep its demo + suites green).
- Vite proxies `/api` (incl. SSE) to the backend — main: 17000 → 7494.

## studio CLI notes

- Config precedence: CLI args > `PI_STUDIO_*` env > instance config (`.studio/config/instances/`) > defaults. Services are wired via argv only — the CLI injects no env; env remains the manual/container channel (and the reason for the workspace strip ritual).
- Sub-command groups: `worktree add|rm` (no `ls`; `--purge` leaves the git ref), `jobs list|add|edit|rm|run|enable|disable|runs`, `subagents ls|gc`, `guard install`. Full design doc: `docs/cli-design.md`.
- `restart backend` refuses (exit 5) when nothing under `src/pi-nest/**` / `src/pi-studio/server/**` changed since it started (`--yes` overrides); it reuses the recorded backend port so the running web proxy keeps working, and completes via a detached `__finish-restart` helper even if its caller dies. `down backend` cascades to web; `down`/`kill backend` with live agents refuse without `--yes`. Adoption never crosses instances (backend identity = its `PI_STUDIO_DB_PATH` pointing into the instance's state dir).
- Main pidfiles/logs: `/workspace/sf/.studio/state/instances/main/{pids,logs}/`.
- Manual starts (fallback only, when the CLI itself is broken; `studio up` adopts them afterwards): backend `setsid nohup node pi-agent-studio/src/pi-studio/server/index.mjs > /tmp/pi-studio-backend.log 2>&1 < /dev/null &` (defaults `127.0.0.1:7494`); web `setsid nohup node pi-agent-studio/node_modules/.bin/vite pi-agent-studio --config pi-agent-studio/vite.config.ts --host 0.0.0.0 --port 17000 > /tmp/pi-agent-studio-vite.log 2>&1 < /dev/null &`.

## Testing

Area → suite (`npm run <script>`; full list in `package.json`):

| Area | Suites |
|---|---|
| studio CLI | `check:cli`, `check:worktree-nm` |
| composer send/stop/queue/retry, drafts, grip reorder | `check:queue`, `check:send-stop`, `check:drafts` |
| context reload button | `check:reload` |
| image attachments | `check:image-attach` |
| new chat creation | `check:newchat` |
| gateway message queue | `check:msgqueue` |
| chat windows / tabs / cross-window | `check:crosswin` |
| session list / sync / states | `check:sync`, `check:states` |
| pinned sessions | `check:pinned` |
| transcript rows, streaming + scroll | `check:transcript`, `check:stream-scroll`, `check:bubble-anchor` |
| message pagination | `check:pagination` |
| mobile shell | `check:mobile` |
| SSE robustness | `check:sse` |
| model picker / models API | `check:modelapi` |
| model catalog peak hours | `check:peakhours` |
| scheduler + job dialog UI | `check:scheduler`, `check:jobeditor` |
| sub-agents + workflow engine | `check:subagents` |
| journal drain/recover | `check:registry` |
| restart recovery (SIGTERM/SIGKILL mid-generation) | `check:backend-restart`, `check:restart`, `check:restart-selfkill` |
| docker icon geometry | `check:dockericons` |
| types / prod build | `typecheck` (vue-tsc — plain `tsc` does NOT check `.vue`), `build` |

Conventions:

- Suites boot a private stub stack and must use `scripts/lib/suite-stack.cjs` (`spawnStackProc` + `installStackCleanup` + `sweepStaleStackProcesses` + `assertMemoryHeadroom` — startup sweep of previous-run strays, signal/exit cleanup, cgroup memory guard). Browser suites run minutes; unit-style suites are fast. Plan accordingly — one suite per command, never piped through `head`.
- Suite logs land in `/tmp/<suite>-backend.log` and `/tmp/<suite>-vite.log` — read them when a suite fails mysteriously.
- Model seams: `PI_STUDIO_CLIENT_MODULE` swaps the agent client for the stub (`scripts/lib/stub-backend.cjs`; controlled by `STUB_CONTROL_FILE`, prompts/aborts logged to `STUB_PROMPT_LOG`/`STUB_ABORT_LOG` — extend there when a suite must assert backend delivery). `check:backend-restart` / `check:restart*` use the `PI_SDK_DIR` stub SDK (`scripts/lib/stub-sdk`): real registry + real journal, prompts hang until `STUB_STATE_DIR/release` appears.

## Product behaviors (the suites are the spec — read the `check:*` sources for exact semantics)

- Composer action button is four-state (Send / Queue / Stop / Retry); typed text never interrupts a running session — Stop is the only UI interrupt path.
- The message queue is gateway-side and durable: FIFO flushed on session-idle, edit-hold gate, drag reorder, queued compact and model changes, error pause cleared by retry.
- Sub-agents: read-only child sessions spawned in-process (no recursion); `subagent` (parallel tasks) and `workflow` (deterministic JSON DAG — every node requires `model` + `thinking`, validated before any child spawns; no runtime replanning). Child artifacts land under `<SESSIONS_ROOT>/_subagents/`, hidden from the chat list, cleanable via `studio subagents ls|gc`.
- No TUI lock: the web UI can prompt any session, including one live in the pi TUI.

## Operational notes

- `doctor` orphan sweeps are registry-scoped to the instance's own pair roots — run from `/workspace/sf` for a global sweep. It also sweeps PPID-1 browser strays; some survive doctor — kill them by PID. Every CLI-initiated terminate is audited in `<state>/audit.log` (ts, reason, service, pid, caller) — check it first when a process died unexpectedly.
- OOM: the backend runs with `--heapsnapshot-near-heap-limit=2` (snapshots land in the start CWD; `studio clean --snapshots` deletes them after analysis). Container cgroup limit is 16 GiB. Forensics + checklist: `.memory/oom.md`.

## Repo-specific Biome overrides

`suspicious/noExplicitAny` and `suspicious/noConfusingVoidType` are off for `store/chat.ts` + `slash/commands.ts` — `any` at the backend-JSON boundary; picker callbacks may resolve to nothing or to a slash result. All other biome rules/conventions: see the workspace guide.
