# pi-agent-studio

Web UI for the **pi agent**, built on the [StudioFramework](../StudioFramework/) UI
framework (Vue 3 + TypeScript, single-JSON layout).

## Status — live

The Chat app is wired to the **real pi agent**:

```
APP: Chat
    Section: Chat
        Subsection: Chat History   → real sessions from ~/.pi/agent/sessions; click opens the window
        Subsection: Sessions       → sessions with an open view or generating in the background
```

- **Real chat history** — session files on disk are parsed and rendered
  (user messages, assistant replies, thinking blocks, tool calls + results,
  compaction summaries).
- **Real agent** — sending a message runs the pi agent in-process (pi SDK),
  the reply streams into the window live; tool executions show up as they
  run. The TUI-live session appears with a 🔒 read-only banner (never
  prompted from two places at once). The lock **follows the TUI lifecycle**:
- **Closing a tab closes only the view** — a running chat keeps generating
  in the backend; the Sessions list shows `running · bg`.
- **Right panel** — live session stats of the activated chat window (like
  `/session`): model, tokens in/out, cost, duration, cwd, message count.

## Running

Two processes, both served from `/workspace/sf`:

```bash
npm run server   # backend: node server/index.mjs → 127.0.0.1:7494
npm run dev      # frontend: vite → 0.0.0.0:7492 (proxies /api → 7494)
```

Open http://localhost:7492. Backend config via env:
`PI_STUDIO_PORT` (7494), `PI_STUDIO_CWD` (new-chat working dir, default
`/workspace/sf`), `PI_SDK_DIR` (default: global pi install), `PI_SESSION_FILE`
(session to mark read-only — auto-set when run under pi), `PI_TUI_PID`
(optional: pin the TUI process; default: scan for a live `pi` process).

TUI lock lifecycle (polled every 3s): TUI running → its session is locked;
TUI exits → lock released; a (new) TUI starts → lock re-engages on that
TUI's session (found via the TUI's cwd-encoded sessions dir, falling back
to the freshest session file; a TUI resuming an existing session is caught
when it first writes to it).

## Architecture

| Path | Role |
|:---|:---|
| `server/index.mjs` | Dependency-free Node HTTP+SSE backend: lists/parses real session files, runs the real agent via the pi SDK (`createAgentSession`), streams events to browsers |
| `src/layout/app.layout.json` | Single JSON: menu, docker (Chat app), left panel (Chat History + Sessions), right panel (Session Stats), workspace, status bar |
| `src/shell/StudioShell.vue` | Root shell: mounts the framework with the app layout, handles actions (New Chat…) |
| `src/store/chat.ts` | Store: real backend client (fetch + EventSource), workspace-API binding, live message merging |
| `src/components/ChatWindow.vue` | Tab content: real messages, thinking/tools rendering, streaming cursor, stop/abort |
| `src/components/ChatHistory.vue` / `ChatSessions.vue` | Custom panel components (click to open) |
| `src/components/SessionStats.vue` | Right-panel live stats (`session-stats`) |

StudioFramework source is consumed via the `@sf` vite alias
(`../StudioFramework/src`) — edits to either repo hot-reload in the same
server. When a framework feature is missing, change it there (the framework
must stay generic; all pi-specific content lives in this repo).
