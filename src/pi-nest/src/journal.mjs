import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;
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
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
    uiClearAll: db.prepare('UPDATE sessions SET ui_state = NULL, ui_error = ?'),
    uiUpsert: db.prepare(
      'INSERT INTO sessions (file, ui_state, ui_error) VALUES (?, ?, ?) ON CONFLICT(file) DO UPDATE SET ui_state = excluded.ui_state, ui_error = excluded.ui_error',
    ),
    loadUi: db.prepare(
      "SELECT file, ui_state, ui_error FROM sessions WHERE ui_state IN ('working','unread','error')",
    ),
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
        stmt.removeSessionRow.run(sessionFile);
        db.exec('COMMIT');
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch {}
        warn('removeSession', e);
      }
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
    loadUiStates() {
      try {
        return stmt.loadUi.all().map((r) => ({ file: r.file, state: r.ui_state, error: r.ui_error }));
      } catch (e) {
        warn('loadUiStates', e);
        return [];
      }
    },
    saveUiStates,
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
