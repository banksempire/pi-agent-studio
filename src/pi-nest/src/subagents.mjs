import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SlotGovernor } from './governor.mjs';
import { sdk, supportedThinkingLevels, textOf, typebox } from './sdk-bridge.mjs';
import {
  applyItem,
  interpolatePrompt,
  MAX_TASKS,
  splitForEachEntries,
  THINKING_LEVELS,
  validateSpec,
  wavesFor,
} from './workflow-engine.mjs';

export const SUBAGENTS_DIRNAME = '_subagents';
const CHILD_TOOLS = ['read', 'grep', 'find', 'ls'];
const CHILD_TIMEOUT_MS = Number(process.env.PI_STUDIO_SUBAGENT_TIMEOUT_MS ?? 15 * 60_000);
const REPAIR_PROMPT =
  'You used tools but never produced a final answer. Respond now with a concise, self-contained summary of your findings. Do not use tools.';
const RESULT_PREVIEW_CHARS = 400;
const TOOL_RESULT_CAP = 4000;

const SUBAGENT_CONTRACT = [
  'You are a focused sub-agent spawned by a coordinator.',
  'Your final message is the only thing the coordinator receives - end with a concise, self-contained answer.',
  'You are read-only: gather and report; do not attempt changes.',
  'Do not spawn further agents. Do not prefix shell paths with cd - work from your current directory.',
].join(' ');

function nowLabel() {
  return new Date().toISOString();
}

function parentFolderId(agentId) {
  const base = path.basename(String(agentId)).replace(/\.jsonl$/, '');
  return base || `sess-${randomUUID().slice(0, 8)}`;
}

function modelKeyOf(model) {
  const provider = String(model?.provider ?? 'unknown');
  const id = String(model?.id ?? 'unknown');
  return { provider, model: `${provider}/${id}`.toLowerCase() };
}

function resolveModel(parentSession, wanted) {
  if (!wanted) return parentSession?.model ?? null;
  const wantedLow = String(wanted).toLowerCase();
  const available = parentSession?.modelRuntime?.getAvailableSnapshot?.() ?? [];
  for (const m of available) {
    if (String(m.id).toLowerCase() === wantedLow) return m;
    if (`${String(m.provider)}/${String(m.id)}`.toLowerCase() === wantedLow) return m;
  }
  return undefined;
}

export function finalAnswerFromTurns(turns) {
  let lastToolCall = -1;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].hasToolCalls) lastToolCall = i;
  }
  return turns
    .slice(lastToolCall + 1)
    .map((t) => t.text)
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function createAnswerCollector() {
  let parts = [];
  return {
    push(message) {
      if (message?.role !== 'assistant') return;
      const hasToolCalls =
        Array.isArray(message.content) && message.content.some((b) => b?.type === 'toolCall');
      if (hasToolCalls) {
        parts = [];
        return;
      }
      const text = textOf(message.content);
      if (text) parts.push(text);
    },
    answer() {
      return parts.join('\n').trim();
    },
  };
}

function truncate(text, cap = TOOL_RESULT_CAP) {
  const t = String(text ?? '');
  return t.length <= cap ? t : `${t.slice(0, cap)}\n… [truncated, full result on disk]`;
}

export function createSubagentManager({ sessionsRoot, getSession = () => null, limits = {} } = {}) {
  const governor = new SlotGovernor(limits);
  const runs = new Map();
  const byParent = new Map();

  function track(run) {
    runs.set(run.id, run);
    if (!byParent.has(run.parent)) byParent.set(run.parent, new Set());
    byParent.get(run.parent).add(run.id);
    return run;
  }

  function release(run) {
    runs.delete(run.id);
    const set = byParent.get(run.parent);
    if (!set) return;
    set.delete(run.id);
    if (set.size === 0) byParent.delete(run.parent);
  }

  function report(run, onUpdate) {
    if (!onUpdate) return;
    try {
      onUpdate({
        content: [{ type: 'text', text: `[${run.label}] ${run.status}${run.error ? `: ${run.error}` : ''}` }],
      });
    } catch {}
  }

  function baseDir(parentAgentId) {
    return path.join(sessionsRoot, SUBAGENTS_DIRNAME, parentFolderId(parentAgentId));
  }

  function childSession(run, parentSession, modelRuntime, model, thinkingLevel) {
    const parent = parentSession ?? getSession(run.parent);
    const cwd = run.cwd ?? parent?.sessionManager?.getCwd() ?? process.cwd();
    const dir = path.join(baseDir(run.parent), run.id);
    mkdirSync(dir, { recursive: true });
    const sm = new sdk.SessionManager(cwd, dir, path.join(dir, 'transcript.jsonl'), true);
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: sdk.getAgentDir(),
      appendSystemPromptOverride: (base) => [
        ...base,
        [SUBAGENT_CONTRACT, run.role].filter(Boolean).join(' '),
      ],
    });
    return sdk.createAgentSession({
      cwd,
      sessionManager: sm,
      resourceLoader: loader,
      modelRuntime: modelRuntime ?? parent?.modelRuntime,
      model: model ?? parent?.model ?? undefined,
      thinkingLevel: thinkingLevel ?? undefined,
      tools: CHILD_TOOLS,
      customTools: [],
    });
  }

  function subscribeChild(session, collected) {
    session.subscribe((ev) => {
      if (ev.type !== 'message_end') return;
      collected.push(ev.message);
    });
  }

  async function runOne(run, { parentSession, modelRuntime, model, thinkingLevel, onUpdate }) {
    track(run);
    run.status = 'queued';
    report(run, onUpdate);
    const slot = await governor.waitForSlot(modelKeyOf(model));
    if (run.status === 'aborted') {
      run.error = run.error || 'parent aborted while queued';
      governor.release(slot);
      run.finishedAt = Date.now();
      release(run);
      writeResultFile(run);
      report(run, onUpdate);
      return;
    }
    let child = null;
    try {
      run.status = 'running';
      run.startedAt = Date.now();
      report(run, onUpdate);
      child = await childSession(run, parentSession, modelRuntime, model, thinkingLevel);
      run.childSession = child.session;
      const collected = createAnswerCollector();
      subscribeChild(child.session, collected);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.session.abort().catch(() => {});
      }, CHILD_TIMEOUT_MS);
      timer.unref?.();
      try {
        await child.session.prompt(run.prompt);
        if (run.status === 'aborted') {
          run.error = run.error || 'parent aborted';
        } else if (timedOut) {
          run.status = 'failed';
          run.error = 'timed out';
        } else {
          let answer = collected.answer();
          if (!answer) {
            await child.session.prompt(REPAIR_PROMPT);
            answer = collected.answer();
          }
          if (!answer) {
            run.status = 'failed';
            run.error = 'child produced no final answer';
          } else {
            run.status = 'completed';
            run.result = answer;
          }
        }
      } catch (e) {
        run.status = 'failed';
        run.error = String(e?.message ?? e);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      run.status = 'failed';
      run.error = String(e?.message ?? e);
    } finally {
      governor.release(slot);
      run.finishedAt = Date.now();
      run.childSession = null;
      release(run);
      if (child) {
        try {
          child.session.dispose();
        } catch {}
      }
      writeResultFile(run);
      report(run, onUpdate);
    }
  }

  function writeResultFile(run) {
    try {
      const dir = path.join(baseDir(run.parent), run.id);
      if (!existsSync(dir)) return;
      writeFileSync(
        path.join(dir, 'result.json'),
        `${JSON.stringify(
          {
            id: run.id,
            parent: run.parent,
            label: run.label,
            kind: run.kind,
            role: run.role ?? null,
            status: run.status,
            prompt: run.prompt,
            model: run.model ?? null,
            thinking: run.thinking ?? null,
            cwd: run.cwd ?? null,
            result: run.result ?? '',
            error: run.error ?? '',
            startedAt: run.startedAt ?? null,
            finishedAt: run.finishedAt ?? null,
            updatedAt: nowLabel(),
          },
          null,
          2,
        )}\n`,
      );
    } catch (e) {
      console.error('[subagents] result write failed:', e?.message ?? e);
    }
  }

  async function runTasks(parentAgentId, tasks, { onUpdate } = {}) {
    const parent = getSession(parentAgentId);
    if (!parent) throw new Error('parent session is not live');
    const built = tasks.map((t, i) => ({
      id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      parent: parentAgentId,
      kind: 'subagent',
      label: t.label ?? `task-${i + 1}`,
      role: t.role ?? null,
      prompt: t.prompt,
      model: t.model ?? null,
      thinking: t.thinking ?? null,
      cwd: t.cwd ?? null,
      status: 'queued',
      result: '',
      error: '',
      startedAt: null,
      finishedAt: null,
    }));
    await Promise.all(
      built.map((run) => {
        const model = resolveModel(parent, run.model);
        if (run.model && model === undefined) {
          run.status = 'failed';
          run.error = `unknown model '${run.model}'`;
          return Promise.resolve();
        }
        if (run.thinking && !supportedThinkingLevels(model).includes(run.thinking)) {
          run.status = 'failed';
          run.error = `unsupported thinking level '${run.thinking}' for model ${model?.id ?? 'unknown'}`;
          return Promise.resolve();
        }
        return runOne(run, {
          parentSession: parent,
          modelRuntime: parent.modelRuntime,
          model,
          thinkingLevel: run.thinking ?? undefined,
          onUpdate,
        });
      }),
    );
    return built;
  }

  async function runWorkflow(parentAgentId, spec, { onUpdate } = {}) {
    const parent = getSession(parentAgentId);
    if (!parent) throw new Error('parent session is not live');
    const v = validateSpec(spec);
    if (!v.ok) throw new Error(`invalid workflow spec: ${v.error}`);
    const norm = v.normalized;
    const byId = new Map(norm.nodes.map((n) => [n.id, n]));
    const results = new Map();
    const instances = new Map();
    const waves = wavesFor(norm);
    let abortedByFailure = null;

    for (const wave of waves) {
      const jobs = [];
      for (const nodeId of wave) {
        const node = byId.get(nodeId);
        const model = resolveModel(parent, node.model);
        if (node.model && model === undefined) {
          results.set(nodeId, { status: 'failed', text: '', error: `unknown model '${node.model}'` });
          continue;
        }
        if (node.thinking && !supportedThinkingLevels(model).includes(node.thinking)) {
          results.set(nodeId, {
            status: 'failed',
            text: '',
            error: `unsupported thinking level '${node.thinking}' for model ${model?.id ?? 'unknown'}`,
          });
          continue;
        }
        const launch = (suffix, item) => {
          const prompt = applyItem(interpolatePrompt(node.prompt, results), item ?? '');
          const run = {
            id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
            parent: parentAgentId,
            kind: 'workflow',
            label: `${norm.name}:${nodeId}${suffix}`,
            role: node.role ?? null,
            prompt,
            model: node.model ?? null,
            thinking: node.thinking ?? null,
            cwd: node.cwd ?? null,
            nodeId,
            status: 'queued',
            result: '',
            error: '',
            startedAt: null,
            finishedAt: null,
          };
          const done = runOne(run, {
            parentSession: parent,
            modelRuntime: parent.modelRuntime,
            model,
            thinkingLevel: node.thinking ?? undefined,
            onUpdate,
          }).then(() => {
            if (!instances.has(nodeId)) instances.set(nodeId, []);
            instances.get(nodeId).push(run);
          });
          jobs.push(done);
        };
        if (node.forEach) {
          const upstream = results.get(node.forEach);
          const items = upstream && upstream.status === 'completed' ? splitForEachEntries(upstream.text) : [];
          if (items.length === 0) {
            results.set(nodeId, {
              status: 'failed',
              text: '',
              error: `forEach node '${node.forEach}' produced no entries`,
            });
            continue;
          }
          for (const [i, item] of items.entries()) launch(`#${i + 1}`, item);
        } else {
          launch('', null);
        }
      }
      await Promise.all(jobs);
      for (const nodeId of wave) {
        const list = instances.get(nodeId) ?? [];
        if (list.length === 0) continue;
        const failedRuns = list.filter((r) => r.status !== 'completed');
        results.set(nodeId, {
          status: failedRuns.length === 0 ? 'completed' : 'failed',
          text: list
            .map((r) => r.result ?? '')
            .filter(Boolean)
            .join('\n\n'),
          error: failedRuns.map((r) => `${r.label}: ${r.error}`).join('; '),
        });
      }
      for (const nodeId of wave) {
        const r = results.get(nodeId);
        if (!r) {
          const node = byId.get(nodeId);
          results.set(nodeId, {
            status: 'failed',
            text: '',
            error: node.forEach ? `forEach node '${node.forEach}' produced no entries` : 'unknown model',
          });
        }
      }
      for (const nodeId of wave) {
        const r = results.get(nodeId);
        if (r && r.status !== 'completed' && byId.get(nodeId).onFailure === 'fail') {
          abortedByFailure = `${nodeId}: ${r.error ?? r.status}`;
          break;
        }
      }
      if (abortedByFailure) break;
    }

    const output = results.get(norm.output);
    const nodeLines = norm.nodes.map((n) => {
      const r = results.get(n.id);
      return `${r ? r.status : 'skipped'}\t${n.id}${r?.error ? ` (${r.error})` : ''}`;
    });
    return {
      name: norm.name,
      ok: !abortedByFailure && output?.status === 'completed',
      error:
        abortedByFailure ??
        (output?.status !== 'completed' ? `output node '${norm.output}' did not complete` : ''),
      output: output?.text ?? '',
      nodes: nodeLines,
    };
  }

  function toolsFor(agentId) {
    const subagentTool = sdk.defineTool({
      name: 'subagent',
      label: 'Subagent',
      description: [
        'Spawn one or more read-only sub-agents that work in isolated sessions and wait for their results.',
        'Each task gets a fresh sub-agent with its own context; only its final message is returned.',
        'Use for independent research, review, or exploration that would flood this conversation.',
        'Tasks run in parallel (bounded by the studio concurrency caps).',
      ].join(' '),
      promptSnippet:
        'subagent: delegate read-only tasks to isolated sub-agents and receive their final answers',
      promptGuidelines: [
        'Delegate broad or multi-file exploration and independent reviews to the subagent tool instead of doing them inline.',
        'Write self-contained task prompts: a sub-agent sees none of this conversation.',
      ],
      parameters: typebox.Type.Object({
        tasks: typebox.Type.Array(
          typebox.Type.Object({
            prompt: typebox.Type.String({ description: 'Self-contained task for the sub-agent' }),
            role: typebox.Type.Optional(
              typebox.Type.String({ description: 'Extra role hint appended to the sub-agent system prompt' }),
            ),
            model: typebox.Type.Optional(
              typebox.Type.String({
                description: 'Model id override (e.g. anthropic/claude-haiku). Default: this session model',
              }),
            ),
            thinking: typebox.Type.Optional(
              typebox.Type.String({
                description: `Thinking effort: ${THINKING_LEVELS.join('|')}. Must be supported by the model; default: off`,
              }),
            ),
            cwd: typebox.Type.Optional(
              typebox.Type.String({
                description: 'Working directory for the sub-agent. Default: this session cwd',
              }),
            ),
          }),
          { description: `Up to ${MAX_TASKS} tasks, run in parallel`, minItems: 1, maxItems: MAX_TASKS },
        ),
      }),
      async execute(_id, params, _signal, onUpdate) {
        const runs = await runTasks(agentId, params.tasks ?? [], { onUpdate });
        const done = runs.filter((r) => r.status === 'completed').length;
        const failed = runs.length - done;
        const body = runs
          .map((r) => {
            const head = `[${r.label}] ${r.status}${r.error ? `: ${r.error}` : ''}`;
            return r.result ? `${head}\n${truncate(r.result)}` : head;
          })
          .join('\n\n');
        return {
          content: [{ type: 'text', text: `sub-agents: ${done} completed, ${failed} failed\n\n${body}` }],
        };
      },
    });

    const workflowTool = sdk.defineTool({
      name: 'workflow',
      label: 'Workflow',
      description: [
        'Run a deterministic multi-step workflow of read-only sub-agents from a JSON spec.',
        'Nodes run in dependency order (needs edges); nodes sharing a dependency wave run in parallel.',
        'A node prompt can reference upstream results with {{nodeId}}; a node with forEach splits an upstream result',
        'into entries and runs once per entry with {{item}}. Deterministic: the engine executes the plan, no runtime replanning.',
      ].join(' '),
      promptSnippet:
        'workflow: run a JSON-defined DAG of sub-agents (parallel waves, result references, forEach fan-out)',
      promptGuidelines: [
        'For multi-step plans with dependencies, prefer the workflow tool over ad-hoc subagent calls - it is deterministic and each node result is saved for review.',
        'Validate the plan shape before calling: node ids unique, needs acyclic, references existing nodes.',
      ],
      parameters: typebox.Type.Object({
        spec: typebox.Type.Object(
          {},
          {
            description:
              'Workflow spec: { name?, output?, nodes: [{ id, prompt, needs?: string[], forEach?: nodeId, model?, thinking?, cwd?, role?, onFailure?: "fail"|"continue" }] }',
            additionalProperties: true,
          },
        ),
      }),
      async execute(_id, params, _signal, onUpdate) {
        const r = await runWorkflow(agentId, params.spec, { onUpdate });
        const head = r.ok
          ? `workflow '${r.name}' completed`
          : `workflow '${r.name}' did not complete: ${r.error}`;
        const body = [
          `nodes:`,
          ...r.nodes.map((l) => `  ${l}`),
          '',
          `output (${r.name}/${r.ok ? 'ok' : 'incomplete'}):`,
          truncate(r.output),
        ].join('\n');
        return { content: [{ type: 'text', text: `${head}\n${body}` }] };
      },
    });

    return [subagentTool, workflowTool];
  }

  function readChildRow(parentId, childId) {
    const dir = path.join(sessionsRoot, SUBAGENTS_DIRNAME, parentId, childId);
    const resultPath = path.join(dir, 'result.json');
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(resultPath, 'utf8'));
    } catch {
      meta = null;
    }
    if (!meta) {
      if (!existsSync(path.join(dir, 'transcript.jsonl'))) return null;
      meta = { id: childId, parent: parentId, status: 'running', label: childId, prompt: '' };
    }
    let bytes = 0;
    try {
      for (const f of readdirSync(dir)) bytes += statSync(path.join(dir, f)).size;
    } catch {}
    return {
      parent: parentId,
      id: childId,
      kind: meta.kind ?? 'subagent',
      label: meta.label ?? childId,
      status: runs.get(childId)?.status ?? meta.status ?? 'unknown',
      role: meta.role ?? null,
      model: meta.model ?? null,
      thinking: meta.thinking ?? null,
      prompt: String(meta.prompt ?? '').slice(0, 120),
      error: meta.error ?? '',
      resultPreview: String(meta.result ?? '').slice(0, RESULT_PREVIEW_CHARS),
      startedAt: meta.startedAt ?? null,
      finishedAt: meta.finishedAt ?? null,
      bytes,
    };
  }

  function list({ session = null } = {}) {
    const root = path.join(sessionsRoot, SUBAGENTS_DIRNAME);
    const out = [];
    const parents = session
      ? [parentFolderId(session)]
      : existsSync(root)
        ? readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
        : [];
    for (const p of parents) {
      const pdir = path.join(root, p);
      if (!existsSync(pdir)) continue;
      for (const e of readdirSync(pdir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const row = readChildRow(p, e.name);
        if (!row) continue;
        const live = runs.get(row.id);
        if (live) {
          row.status = live.status;
          row.label = live.label;
          row.kind = live.kind;
        }
        out.push(row);
      }
    }
    const seen = new Set(out.map((r) => r.id));
    for (const run of runs.values()) {
      if (seen.has(run.id)) continue;
      if (session && parentFolderId(run.parent) !== parentFolderId(session)) continue;
      out.push({
        parent: parentFolderId(run.parent),
        id: run.id,
        kind: run.kind,
        label: run.label,
        status: run.status,
        role: run.role ?? null,
        model: run.model ?? null,
        thinking: run.thinking ?? null,
        prompt: String(run.prompt ?? '').slice(0, 120),
        error: run.error ?? '',
        resultPreview: '',
        startedAt: run.startedAt ?? null,
        finishedAt: null,
        bytes: 0,
      });
    }
    out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    return out;
  }

  function gc({ session = null, before = null, all = false, dryRun = false } = {}) {
    if (!session && !before && !all) {
      return { ok: false, error: 'choose a target: --session <id>, --before <duration|ts>, or --all' };
    }
    const root = path.join(sessionsRoot, SUBAGENTS_DIRNAME);
    if (!existsSync(root)) return { ok: true, dryRun, removed: [], bytes: 0 };
    const cutoff = parseBefore(before);
    if (before && cutoff === null) return { ok: false, error: `cannot parse --before '${before}'` };
    const parents = session
      ? [parentFolderId(session)]
      : readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
    const removed = [];
    const touchedParents = new Set();
    let bytes = 0;
    for (const p of parents) {
      const pdir = path.join(root, p);
      if (!existsSync(pdir)) continue;
      touchedParents.add(pdir);
      for (const e of readdirSync(pdir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const dir = path.join(pdir, e.name);
        const row = readChildRow(p, e.name);
        if (!row) continue;
        if (runs.has(row.id)) continue;
        if (row.status === 'running') continue;
        if (cutoff !== null) {
          const ts = row.finishedAt ?? row.startedAt ?? 0;
          if (!ts || ts > cutoff) continue;
        }
        try {
          bytes += row.bytes;
          if (!dryRun) rmSync(dir, { recursive: true, force: true });
          removed.push({ parent: p, id: e.name, label: row.label, status: row.status, bytes: row.bytes });
        } catch (err) {
          console.error('[subagents] gc remove failed:', err?.message ?? err);
        }
      }
    }
    if (!dryRun) {
      for (const pdir of touchedParents) {
        try {
          if (existsSync(pdir) && readdirSync(pdir).length === 0) rmSync(pdir, { recursive: true });
        } catch {}
      }
    }
    return { ok: true, dryRun, removed, bytes };
  }

  function parseBefore(before) {
    if (before === null || before === undefined || before === '') return null;
    const m = /^(\d+)([smhd])$/.exec(String(before).trim());
    if (m) {
      const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
      return Date.now() - Number(m[1]) * unitMs;
    }
    const ts = Date.parse(String(before));
    return Number.isFinite(ts) ? ts : null;
  }

  function abortForParent(parentAgentId) {
    const ids = byParent.get(parentAgentId);
    if (!ids || ids.size === 0) return 0;
    let n = 0;
    for (const id of ids) {
      const run = runs.get(id);
      if (run?.status !== 'running' && run?.status !== 'queued') continue;
      n++;
      run.status = 'aborted';
      run.error = 'parent aborted';
      try {
        run.childSession?.abort?.()?.catch?.(() => {});
      } catch {}
    }
    return n;
  }

  function sweepInterrupted() {
    const root = path.join(sessionsRoot, SUBAGENTS_DIRNAME);
    if (!existsSync(root)) return 0;
    let n = 0;
    for (const p of readdirSync(root, { withFileTypes: true })) {
      if (!p.isDirectory()) continue;
      const pdir = path.join(root, p.name);
      for (const e of readdirSync(pdir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const resultPath = path.join(pdir, e.name, 'result.json');
        if (!existsSync(resultPath)) continue;
        try {
          const meta = JSON.parse(readFileSync(resultPath, 'utf8'));
          if (meta.status !== 'running') continue;
          meta.status = 'interrupted';
          meta.error = 'backend restarted while the sub-agent was running';
          meta.updatedAt = nowLabel();
          writeFileSync(resultPath, `${JSON.stringify(meta, null, 2)}\n`);
          n++;
        } catch {}
      }
    }
    return n;
  }

  function setLimits(next) {
    governor.setLimits(next ?? {});
  }

  return { toolsFor, runTasks, runWorkflow, list, gc, abortForParent, sweepInterrupted, setLimits };
}
