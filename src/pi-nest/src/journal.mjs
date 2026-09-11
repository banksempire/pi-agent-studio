import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 4;
const UI_STATES = new Set(['working', 'unread', 'error']);

function warn(op, e) {
  console.error(`[pi-nest][journal] ${op} failed:`, e?.message ?? e);
}

function parseImages(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function openDatabase(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  let db = null;
  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const check = db.prepare('PRAGMA integrity_check').get();
    if (String(check?.integrity_check ?? '') !== 'ok') throw new Error('integrity_check failed');
    return db;
  } catch (e) {
    try {
      db?.close();
    } catch {}
    try {
      renameSync(dbPath, `${dbPath}.corrupt-${Date.now()}`);
      console.error(`[pi-nest][journal] database unusable, moved aside: ${e?.message ?? e}`);
    } catch {}
    const fresh = new DatabaseSync(dbPath);
    fresh.exec('PRAGMA journal_mode = WAL');
    fresh.exec('PRAGMA synchronous = NORMAL');
    return fresh;
  }
}

function applySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      file TEXT PRIMARY KEY,
      cwd TEXT NOT NULL DEFAULT '',
      model TEXT,
      think_level TEXT,
      ui_state TEXT,
      ui_error TEXT NOT NULL DEFAULT ''
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      message TEXT NOT NULL,
      images TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'queued',
      started_at INTEGER,
      partial_text TEXT NOT NULL DEFAULT ''
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS queue_items_session ON queue_items(session_file, id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ui_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      message TEXT NOT NULL,
      images TEXT NOT NULL DEFAULT '[]'
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS ui_queue_session ON ui_queue(session_file, id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      kind TEXT NOT NULL DEFAULT 'message',
      schedule_type TEXT NOT NULL,
      run_at INTEGER,
      cron TEXT,
      payload TEXT NOT NULL,
      next_due INTEGER NOT NULL,
      missed_policy TEXT NOT NULL DEFAULT 'coalesce',
      created_by TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS jobs_next_due ON jobs(next_due)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      status TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      session_file TEXT NOT NULL DEFAULT '',
      queue_item_id INTEGER
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS job_runs_job ON job_runs(job_id, id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduler_config (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_pins (
      file TEXT PRIMARY KEY,
      pinned_at INTEGER NOT NULL
    );
  `);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

function rowToJob(r) {
  let payload = {};
  try {
    payload = JSON.parse(r.payload ?? '{}');
  } catch {}
  return {
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    kind: r.kind,
    scheduleType: r.schedule_type,
    runAt: r.run_at ?? null,
    cron: r.cron ?? null,
    payload,
    nextDue: r.next_due,
    missedPolicy: r.missed_policy,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToRun(r) {
  return {
    id: Number(r.id),
    jobId: r.job_id,
    queuedAt: r.queued_at,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    status: r.status,
    error: r.error ?? '',
    sessionFile: r.session_file ?? '',
    queueItemId: r.queue_item_id ?? null,
  };
}

export function openJournal(dbPath, { spillPath = null, legacyStatesPath = null } = {}) {
  const db = openDatabase(dbPath);
  applySchema(db);

  const stmt = {
    enqueue: db.prepare(
      'INSERT INTO queue_items (session_file, message, images, status) VALUES (?, ?, ?, ?)',
    ),
    requeue: db.prepare(
      "UPDATE queue_items SET status = 'queued', started_at = NULL, partial_text = '', message = ?, images = ? WHERE id = ?",
    ),
    markInflight: db.prepare("UPDATE queue_items SET status = 'inflight', started_at = ? WHERE id = ?"),
    snapshotPartial: db.prepare('UPDATE queue_items SET partial_text = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM queue_items WHERE id = ?'),
    removeSessionQueue: db.prepare('DELETE FROM queue_items WHERE session_file = ?'),
    uiEnqueue: db.prepare('INSERT INTO ui_queue (session_file, message, images) VALUES (?, ?, ?)'),
    uiList: db.prepare('SELECT id, message, images FROM ui_queue WHERE session_file = ? ORDER BY id'),
    uiAll: db.prepare('SELECT id, session_file, message, images FROM ui_queue ORDER BY session_file, id'),
    uiUpdate: db.prepare('UPDATE ui_queue SET message = ? WHERE id = ? AND session_file = ?'),
    uiDelete: db.prepare('DELETE FROM ui_queue WHERE id = ? AND session_file = ?'),
    uiDeleteSession: db.prepare('DELETE FROM ui_queue WHERE session_file = ?'),
    uiCount: db.prepare('SELECT COUNT(*) AS n FROM ui_queue'),
    pendingBySession: db.prepare(
      "SELECT COUNT(*) AS n FROM queue_items WHERE session_file = ? AND message = ? AND status IN ('queued','inflight')",
    ),
    pending: db.prepare(
      "SELECT id, session_file, message, images, status, started_at, partial_text FROM queue_items WHERE status IN ('queued','inflight') ORDER BY id",
    ),
    pendingCount: db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE status IN ('queued','inflight')"),
    ensureSession: db.prepare('INSERT OR IGNORE INTO sessions (file, cwd) VALUES (?, ?)'),
    setSessionPrefs: db.prepare(
      'INSERT INTO sessions (file, cwd, model, think_level) VALUES (?, ?, ?, ?) ON CONFLICT(file) DO UPDATE SET model = excluded.model, think_level = excluded.think_level',
    ),
    clearSessionPrefs: db.prepare('UPDATE sessions SET model = NULL, think_level = NULL WHERE file = ?'),
    sessionsWithPrefs: db.prepare(
      'SELECT file, cwd, model, think_level FROM sessions WHERE model IS NOT NULL OR think_level IS NOT NULL',
    ),
    removeSessionRow: db.prepare('DELETE FROM sessions WHERE file = ?'),
    pinSet: db.prepare(
      'INSERT INTO session_pins (file, pinned_at) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET pinned_at = excluded.pinned_at',
    ),
    pinClear: db.prepare('DELETE FROM session_pins WHERE file = ?'),
    pinList: db.prepare('SELECT file FROM session_pins ORDER BY pinned_at DESC, file DESC'),
    uiClearAll: db.prepare('UPDATE sessions SET ui_state = NULL, ui_error = ?'),
    uiUpsert: db.prepare(
      'INSERT INTO sessions (file, ui_state, ui_error) VALUES (?, ?, ?) ON CONFLICT(file) DO UPDATE SET ui_state = excluded.ui_state, ui_error = excluded.ui_error',
    ),
    loadUi: db.prepare(
      "SELECT file, ui_state, ui_error FROM sessions WHERE ui_state IN ('working','unread','error')",
    ),
    cfgAll: db.prepare('SELECT key, value FROM scheduler_config'),
    cfgSet: db.prepare(
      'INSERT INTO scheduler_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),
    jobInsert: db.prepare(`
      INSERT INTO jobs (id, name, enabled, kind, schedule_type, run_at, cron, payload, next_due, missed_policy, created_by, created_at, updated_at)
      VALUES (@id, @name, @enabled, @kind, @schedule_type, @run_at, @cron, @payload, @next_due, @missed_policy, @created_by, @created_at, @updated_at)
    `),
    jobUpdate: db.prepare(`
      UPDATE jobs SET name = @name, enabled = @enabled, kind = @kind, schedule_type = @schedule_type,
        run_at = @run_at, cron = @cron, payload = @payload, next_due = @next_due,
        missed_policy = @missed_policy, updated_at = @updated_at
      WHERE id = @id
    `),
    jobDelete: db.prepare('DELETE FROM jobs WHERE id = ?'),
    jobGet: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    jobList: db.prepare('SELECT * FROM jobs ORDER BY next_due'),
    jobDue: db.prepare('SELECT * FROM jobs WHERE enabled = 1 AND next_due <= ? ORDER BY next_due'),
    runInsert: db.prepare(`
      INSERT INTO job_runs (job_id, queued_at, status) VALUES (?, ?, 'queued')
    `),
    runSetStarted: db.prepare(
      'UPDATE job_runs SET started_at = ?, session_file = ?, queue_item_id = ? WHERE id = ?',
    ),
    runFinish: db.prepare('UPDATE job_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?'),
    runSweepQueued: db.prepare(
      "UPDATE job_runs SET status = 'interrupted', error = ?, finished_at = ? WHERE status = 'queued'",
    ),
    runList: db.prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?'),
    runsDeleteJob: db.prepare('DELETE FROM job_runs WHERE job_id = ?'),
    lastRunByJob: db.prepare(
      'SELECT * FROM job_runs WHERE id = (SELECT MAX(id) FROM job_runs WHERE job_id = ?)',
    ),
    lastRunSession: db.prepare(
      "SELECT session_file FROM job_runs WHERE job_id = ? AND session_file <> '' ORDER BY id DESC LIMIT 1",
    ),
    sessionCwd: db.prepare('SELECT cwd FROM sessions WHERE file = ?'),
  };

  function importSpill() {
    if (!spillPath || !existsSync(spillPath)) return;
    try {
      const data = JSON.parse(readFileSync(spillPath, 'utf8'));
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      db.exec('BEGIN IMMEDIATE');
      for (const entry of entries) {
        if (typeof entry?.agentId !== 'string') continue;
        for (const item of entry.items ?? []) {
          if (typeof item?.message !== 'string') continue;
          stmt.enqueue.run(
            entry.agentId,
            item.message,
            JSON.stringify(Array.isArray(item.images) ? item.images : []),
            'queued',
          );
        }
      }
      db.exec('COMMIT');
      unlinkSync(spillPath);
      console.log(`[pi-nest][journal] imported legacy spill file: ${spillPath}`);
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      warn('spill import', e);
    }
  }

  function importLegacyStates() {
    if (!legacyStatesPath || !existsSync(legacyStatesPath)) return;
    try {
      if (stmt.loadUi.all().length > 0) return;
      const raw = JSON.parse(readFileSync(legacyStatesPath, 'utf8'));
      if (raw?.version !== 1 || !Array.isArray(raw.entries)) return;
      const list = raw.entries.filter(
        (e) => typeof e?.file === 'string' && UI_STATES.has(e.state) && existsSync(e.file),
      );
      saveUiStates(list);
      console.log(`[pi-nest][journal] imported ${list.length} legacy ui state(s) from ${legacyStatesPath}`);
    } catch (e) {
      warn('legacy states import', e);
    }
  }

  function saveUiStates(list) {
    const rows = (list ?? []).filter(
      (e) => typeof e?.file === 'string' && UI_STATES.has(e.state) && typeof e.error === 'string',
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      if (rows.length === 0) {
        stmt.uiClearAll.run('');
      } else {
        const placeholders = rows.map(() => '?').join(',');
        const files = rows.map((r) => r.file);
        db.prepare(
          `UPDATE sessions SET ui_state = NULL, ui_error = '' WHERE ui_state IS NOT NULL AND file NOT IN (${placeholders})`,
        ).run(...files);
        for (const r of rows) stmt.uiUpsert.run(r.file, r.state, r.error);
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      warn('saveUiStates', e);
    }
  }

  importSpill();
  importLegacyStates();

  return {
    enqueue(sessionFile, { message, images = [] }) {
      try {
        const r = stmt.enqueue.run(sessionFile, message, JSON.stringify(images), 'queued');
        return Number(r.lastInsertRowid);
      } catch (e) {
        warn('enqueue', e);
        return null;
      }
    },
    requeue(id, { message, images = [] }) {
      try {
        stmt.requeue.run(message, JSON.stringify(images), id);
      } catch (e) {
        warn('requeue', e);
      }
    },
    markInflight(id, startedAt) {
      if (id === null || id === undefined) return;
      try {
        stmt.markInflight.run(startedAt, id);
      } catch (e) {
        warn('markInflight', e);
      }
    },
    snapshotPartial(id, text) {
      if (id === null || id === undefined) return;
      try {
        stmt.snapshotPartial.run(text, id);
      } catch (e) {
        warn('snapshotPartial', e);
      }
    },
    remove(id) {
      if (id === null || id === undefined) return;
      try {
        stmt.remove.run(id);
      } catch (e) {
        warn('remove', e);
      }
    },
    removeSession(sessionFile) {
      try {
        db.exec('BEGIN IMMEDIATE');
        stmt.removeSessionQueue.run(sessionFile);
        stmt.uiDeleteSession.run(sessionFile);
        stmt.removeSessionRow.run(sessionFile);
        stmt.pinClear.run(sessionFile);
        db.exec('COMMIT');
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        warn('removeSession', e);
      }
    },
    addUiQueue(sessionFile, { message, images = [] }) {
      try {
        const r = stmt.uiEnqueue.run(sessionFile, message, JSON.stringify(images ?? []));
        return Number(r.lastInsertRowid);
      } catch (e) {
        warn('addUiQueue', e);
        return null;
      }
    },
    listUiQueue(sessionFile) {
      try {
        return stmt.uiList.all(sessionFile).map((r) => ({
          id: Number(r.id),
          text: r.message,
          images: parseImages(r.images),
        }));
      } catch (e) {
        warn('listUiQueue', e);
        return [];
      }
    },
    listAllUiQueue() {
      try {
        const out = new Map();
        for (const r of stmt.uiAll.all()) {
          const file = r.session_file;
          if (!out.has(file)) out.set(file, []);
          out.get(file).push({ id: Number(r.id), text: r.message, images: parseImages(r.images) });
        }
        return out;
      } catch (e) {
        warn('listAllUiQueue', e);
        return new Map();
      }
    },
    updateUiQueue(id, sessionFile, message) {
      try {
        const r = stmt.uiUpdate.run(message, id, sessionFile);
        return Number(r.changes) > 0;
      } catch (e) {
        warn('updateUiQueue', e);
        return false;
      }
    },
    deleteUiQueue(id, sessionFile) {
      try {
        const r = stmt.uiDelete.run(id, sessionFile);
        return Number(r.changes) > 0;
      } catch (e) {
        warn('deleteUiQueue', e);
        return false;
      }
    },
    deleteUiQueueSession(sessionFile) {
      try {
        stmt.uiDeleteSession.run(sessionFile);
        return true;
      } catch (e) {
        warn('deleteUiQueueSession', e);
        return false;
      }
    },
    uiQueueCount() {
      try {
        return Number(stmt.uiCount.get()?.n ?? 0);
      } catch {
        return 0;
      }
    },
    reconcileUiQueue() {
      const out = new Map();
      try {
        db.exec('BEGIN IMMEDIATE');
        const rows = stmt.uiAll.all();
        const pendingOf = new Map();
        for (const r of rows) {
          const key = `${r.session_file}\u0000${r.message}`;
          if (!pendingOf.has(key)) {
            pendingOf.set(key, Number(stmt.pendingBySession.get(r.session_file, r.message)?.n ?? 0));
          }
          const owned = pendingOf.get(key);
          if (owned > 0) {
            pendingOf.set(key, owned - 1);
            stmt.uiDelete.run(r.id, r.session_file);
            continue;
          }
          if (!out.has(r.session_file)) out.set(r.session_file, []);
          out.get(r.session_file).push({ id: Number(r.id), text: r.message, images: parseImages(r.images) });
        }
        db.exec('COMMIT');
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        warn('reconcileUiQueue', e);
      }
      return out;
    },
    pendingItems() {
      try {
        return stmt.pending.all().map((r) => ({
          id: Number(r.id),
          sessionFile: r.session_file,
          message: r.message,
          images: parseImages(r.images),
          status: r.status,
          startedAt: r.started_at ?? null,
          partialText: r.partial_text ?? '',
        }));
      } catch (e) {
        warn('pendingItems', e);
        return [];
      }
    },
    pendingCount() {
      try {
        return Number(stmt.pendingCount.get()?.n ?? 0);
      } catch {
        return 0;
      }
    },
    ensureSession(file, cwd) {
      try {
        stmt.ensureSession.run(file, cwd ?? '');
      } catch (e) {
        warn('ensureSession', e);
      }
    },
    setSessionPrefs(file, { model = null, thinkLevel = null }) {
      try {
        stmt.setSessionPrefs.run(file, '', model ?? null, thinkLevel ?? null);
      } catch (e) {
        warn('setSessionPrefs', e);
      }
    },
    clearSessionPrefs(file) {
      try {
        stmt.clearSessionPrefs.run(file);
      } catch (e) {
        warn('clearSessionPrefs', e);
      }
    },
    sessionsWithPrefs() {
      try {
        return stmt.sessionsWithPrefs.all().map((r) => ({
          file: r.file,
          cwd: r.cwd ?? '',
          model: r.model ?? null,
          thinkLevel: r.think_level ?? null,
        }));
      } catch (e) {
        warn('sessionsWithPrefs', e);
        return [];
      }
    },
    setPinned(file, pinned) {
      try {
        if (pinned) stmt.pinSet.run(file, Date.now());
        else stmt.pinClear.run(file);
        return true;
      } catch (e) {
        warn('setPinned', e);
        return false;
      }
    },
    listPins() {
      try {
        return stmt.pinList.all().map((r) => r.file);
      } catch (e) {
        warn('listPins', e);
        return [];
      }
    },
    loadUiStates() {
      try {
        return stmt.loadUi.all().map((r) => ({ file: r.file, state: r.ui_state, error: r.ui_error }));
      } catch (e) {
        warn('loadUiStates', e);
        return [];
      }
    },
    insertJob(job) {
      try {
        stmt.jobInsert.run({
          id: job.id,
          name: job.name,
          enabled: job.enabled ? 1 : 0,
          kind: job.kind ?? 'message',
          schedule_type: job.scheduleType,
          run_at: job.runAt ?? null,
          cron: job.cron ?? null,
          payload: JSON.stringify(job.payload ?? {}),
          next_due: job.nextDue,
          missed_policy: job.missedPolicy ?? 'coalesce',
          created_by: job.createdBy ?? '',
          created_at: job.createdAt,
          updated_at: job.updatedAt,
        });
        return this.getJob(job.id);
      } catch (e) {
        warn('insertJob', e);
        return null;
      }
    },
    updateJob(job) {
      try {
        stmt.jobUpdate.run({
          id: job.id,
          name: job.name,
          enabled: job.enabled ? 1 : 0,
          kind: job.kind ?? 'message',
          schedule_type: job.scheduleType,
          run_at: job.runAt ?? null,
          cron: job.cron ?? null,
          payload: JSON.stringify(job.payload ?? {}),
          next_due: job.nextDue,
          missed_policy: job.missedPolicy ?? 'coalesce',
          updated_at: Date.now(),
        });
        return this.getJob(job.id);
      } catch (e) {
        warn('updateJob', e);
        return null;
      }
    },
    deleteJob(id) {
      try {
        db.exec('BEGIN IMMEDIATE');
        stmt.runsDeleteJob.run(id);
        stmt.jobDelete.run(id);
        db.exec('COMMIT');
        return true;
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        warn('deleteJob', e);
        return false;
      }
    },
    getJob(id) {
      try {
        const r = stmt.jobGet.get(id);
        return r ? rowToJob(r) : null;
      } catch (e) {
        warn('getJob', e);
        return null;
      }
    },
    listJobs() {
      try {
        return stmt.jobList.all().map(rowToJob);
      } catch (e) {
        warn('listJobs', e);
        return [];
      }
    },
    dueJobs(now) {
      try {
        return stmt.jobDue.all(now).map(rowToJob);
      } catch (e) {
        warn('dueJobs', e);
        return [];
      }
    },
    insertRun(jobId) {
      try {
        const r = stmt.runInsert.run(jobId, Date.now());
        return Number(r.lastInsertRowid);
      } catch (e) {
        warn('insertRun', e);
        return null;
      }
    },
    markRunStarted(runId, { startedAt, sessionFile, queueItemId }) {
      try {
        stmt.runSetStarted.run(startedAt, sessionFile ?? '', queueItemId ?? null, runId);
      } catch (e) {
        warn('markRunStarted', e);
      }
    },
    finishRun(runId, status, error = '') {
      try {
        stmt.runFinish.run(status, error, Date.now(), runId);
      } catch (e) {
        warn('finishRun', e);
      }
    },
    sweepInterruptedRuns(reason) {
      try {
        const r = stmt.runSweepQueued.run(reason, Date.now());
        return Number(r.changes);
      } catch (e) {
        warn('sweepInterruptedRuns', e);
        return 0;
      }
    },
    listRuns(jobId, limit = 50) {
      try {
        return stmt.runList.all(jobId, limit).map(rowToRun);
      } catch (e) {
        warn('listRuns', e);
        return [];
      }
    },
    lastRun(jobId) {
      try {
        const r = stmt.lastRunByJob.get(jobId);
        return r ? rowToRun(r) : null;
      } catch (e) {
        warn('lastRun', e);
        return null;
      }
    },
    lastRunSessionFor(jobId, cwd) {
      try {
        const run = stmt.lastRunSession.get(jobId);
        if (!run?.session_file) return null;
        const sess = stmt.sessionCwd.get(run.session_file);
        try {
          return sess && path.resolve(sess.cwd ?? '') === path.resolve(cwd) ? run.session_file : null;
        } catch {
          return null;
        }
      } catch (e) {
        warn('lastRunSessionFor', e);
        return null;
      }
    },
    saveUiStates,
    loadSchedulerConfig() {
      try {
        const out = {};
        for (const r of stmt.cfgAll.all()) out[r.key] = Number(r.value);
        return out;
      } catch (e) {
        warn('loadSchedulerConfig', e);
        return {};
      }
    },
    saveSchedulerConfig(config) {
      try {
        for (const [key, value] of Object.entries(config)) {
          stmt.cfgSet.run(key, Math.max(1, Math.floor(Number(value))));
        }
        return true;
      } catch (e) {
        warn('saveSchedulerConfig', e);
        return false;
      }
    },
    checkpoint() {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {}
    },
    close() {
      try {
        db.close();
      } catch {}
    },
  };
}
