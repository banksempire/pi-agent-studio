# pi-agent-studio

Web UI for the **pi agent**, built on the [StudioFramework](../StudioFramework/) UI
framework (Vue 3 + TypeScript, single-JSON layout).

## Status

First app: **Chat** — an AI agent chatbot.

```
APP: Chat
    Section: Chat
        Subsection: Chat History   → list of chats; click opens the chat window
        Subsection: Sessions       → list of active chat sessions (open view or running in background)
```

- Chat windows live in the workspace as tabs (drag-to-tile works).
- Closing a chat window **closes only the view** — a running session keeps
  streaming in the background.
- The right panel always shows **live session stats** of the activated chat
  window (like `/session` in the pi-agent TUI): status, model, tokens, cost,
  duration, timestamps, view state.
- Currently backed by a **mock engine** (seeded sessions + simulated token
  streaming); the store API is shaped so a real pi backend can replace it.

## Development

```bash
npm run dev        # Vite dev server on 0.0.0.0:7492
npm run typecheck  # vue-tsc --noEmit
npm run build      # typecheck + vite build
```

StudioFramework source is consumed directly via the `@sf` vite alias
(`../StudioFramework/src`) — edits to either repo hot-reload in the same
server. When a feature is missing in the framework, change it there (the
framework must stay generic; all pi-specific content lives in this repo's
layout JSON + components).

## Architecture

| Path | Role |
|:---|:---|
| `src/layout/app.layout.json` | Single JSON defining menu, docker (Chat app), left panel sections, right panel (Session Stats), workspace, status bar |
| `src/shell/StudioShell.vue` | Root shell: mounts the framework with the app layout, handles actions (New Chat…) |
| `src/store/chat.ts` | Session store + mock streaming engine; binds to the workspace API (tracks activated window + open views) |
| `src/components/ChatWindow.vue` | Tab content renderer (registered as `chat-window`) |
| `src/components/ChatHistory.vue` / `ChatSessions.vue` | Custom panel components (registered as `chat-history` / `chat-sessions`) |
| `src/components/SessionStats.vue` | Right-panel stats (registered as `session-stats`) |
| `src/components/WelcomeContent.vue` | Welcome tab (`welcome`) |
