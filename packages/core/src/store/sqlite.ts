import { DatabaseSync } from 'node:sqlite';
import { ContextError } from '../errors.js';
import { newId } from '../ids.js';
import type {
  BoardChange,
  EmployeeMemory,
  LedgerEntry,
  PendingProposal,
  PlanProposal,
  ProjectBoard,
  Proposal,
  Workspace,
} from '../types.js';
import type { Store } from './store.js';

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger (
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (project_id, seq)
);
CREATE VIRTUAL TABLE IF NOT EXISTS ledger_fts USING fts5(
  project_id UNINDEXED, seq UNINDEXED, text, tokenize='trigram'
);
CREATE TABLE IF NOT EXISTS boards (
  project_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_changes (
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS board_changes_idx ON board_changes (project_id, version);
CREATE TABLE IF NOT EXISTS proposals (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proposals_project_idx ON proposals (project_id);
CREATE TABLE IF NOT EXISTS plan_proposals (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending (
  n INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  created_at REAL NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_project_idx ON pending (project_id, created_at, n);
CREATE TABLE IF NOT EXISTS workspaces (
  project_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (project_id, bot_id)
);
CREATE TABLE IF NOT EXISTS memories (
  bot_id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliverables (
  project_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (project_id, ref)
);
CREATE TABLE IF NOT EXISTS meta (
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);
`;

function searchableText(e: LedgerEntry): string | null {
  if (e.body.type === 'chat') return e.body.text;
  if (e.body.event.kind === 'archived') return e.body.event.ref;
  return null;
}

/** FTS5 string literal: wrap in double quotes, double any embedded quote. */
const ftsQuote = (w: string) => `"${w.replaceAll('"', '""')}"`;
const likeEscape = (w: string) => w.replace(/[\\%_]/g, c => `\\${c}`);

/** node:sqlite-backed Store. Pass ':memory:' for a throwaway database. */
export function sqliteStore(path: string): Store & { close(): void } {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);

  const all = (sql: string, ...params: Array<string | number>) => db.prepare(sql).all(...params) as Row[];
  const get = (sql: string, ...params: Array<string | number>) =>
    db.prepare(sql).get(...params) as Row | undefined;
  const run = (sql: string, ...params: Array<string | number>) => db.prepare(sql).run(...params);
  const parse = <T>(row: Row): T => JSON.parse(row.json as string) as T;

  /** Runs fn inside a write transaction; rolls back if it throws. */
  function tx<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    async append(entry) {
      return tx(() => {
        const row = get('SELECT COALESCE(MAX(seq), 0) AS s FROM ledger WHERE project_id = ?', entry.projectId);
        const stored: LedgerEntry = { ...structuredClone(entry), seq: (row!.s as number) + 1 };
        run('INSERT INTO ledger (project_id, seq, json) VALUES (?, ?, ?)', stored.projectId, stored.seq, JSON.stringify(stored));
        const text = searchableText(stored);
        if (text !== null) {
          run('INSERT INTO ledger_fts (project_id, seq, text) VALUES (?, ?, ?)', stored.projectId, stored.seq, text);
        }
        return JSON.parse(JSON.stringify(stored)) as LedgerEntry;
      });
    },
    async read(projectId, fromSeq, limit) {
      const rows = all(
        'SELECT json FROM ledger WHERE project_id = ? AND seq >= ? ORDER BY seq LIMIT ?',
        projectId,
        fromSeq,
        limit ?? -1,
      );
      return rows.map(r => parse<LedgerEntry>(r));
    },
    async search(projectId, query, limit) {
      const words = query.split(/\s+/).filter(w => w !== '');
      if (words.length === 0) return [];
      // Trigram FTS needs >= 3 characters per word; shorter words fall back to LIKE.
      const long = words.filter(w => [...w].length >= 3);
      const short = words.filter(w => [...w].length < 3);
      const where = ['f.project_id = ?'];
      const params: Array<string | number> = [projectId];
      if (long.length > 0) {
        where.push('ledger_fts MATCH ?');
        params.push(long.map(ftsQuote).join(' AND '));
      }
      for (const w of short) {
        where.push("lower(f.text) LIKE ? ESCAPE '\\'");
        params.push(`%${likeEscape(w.toLowerCase())}%`);
      }
      params.push(limit ?? -1);
      const rows = all(
        `SELECT l.json AS json FROM ledger_fts f
         JOIN ledger l ON l.project_id = f.project_id AND l.seq = f.seq
         WHERE ${where.join(' AND ')}
         ORDER BY l.seq LIMIT ?`,
        ...params,
      );
      return rows.map(r => parse<LedgerEntry>(r));
    },
    async latestSeq(projectId) {
      const row = get('SELECT COALESCE(MAX(seq), 0) AS s FROM ledger WHERE project_id = ?', projectId);
      return row!.s as number;
    },

    async createBoard(board) {
      tx(() => {
        if (get('SELECT 1 AS x FROM boards WHERE project_id = ?', board.projectId)) {
          throw new ContextError('INVALID_OP', `Board for project ${board.projectId} already exists`);
        }
        run('INSERT INTO boards (project_id, version, json) VALUES (?, ?, ?)', board.projectId, board.version, JSON.stringify(board));
      });
    },
    async getBoard(projectId) {
      const row = get('SELECT json FROM boards WHERE project_id = ?', projectId);
      if (!row) throw new ContextError('NOT_FOUND', `No board for project ${projectId}`);
      return parse<ProjectBoard>(row);
    },
    async saveBoard(board, expectedVersion, change) {
      tx(() => {
        const current = get('SELECT version FROM boards WHERE project_id = ?', board.projectId);
        if (!current) throw new ContextError('NOT_FOUND', `No board for project ${board.projectId}`);
        const res = run(
          'UPDATE boards SET version = ?, json = ? WHERE project_id = ? AND version = ?',
          board.version,
          JSON.stringify(board),
          board.projectId,
          expectedVersion,
        );
        if (Number(res.changes) !== 1) {
          throw new ContextError('STALE_VERSION', `Expected board version ${expectedVersion}, found ${current.version as number}`, {
            expected: expectedVersion,
            actual: current.version as number,
          });
        }
        run('INSERT INTO board_changes (project_id, version, json) VALUES (?, ?, ?)', board.projectId, change.version, JSON.stringify(change));
      });
    },
    async getBoardChanges(projectId, sinceVersion) {
      const rows = all(
        'SELECT json FROM board_changes WHERE project_id = ? AND version > ? ORDER BY version, rowid',
        projectId,
        sinceVersion,
      );
      return rows.map(r => parse<BoardChange>(r));
    },

    async enqueueProposal(p) {
      run('INSERT INTO proposals (project_id, json) VALUES (?, ?)', p.projectId, JSON.stringify(p));
    },
    async drainProposals(projectId) {
      return tx(() => {
        const rows = all('SELECT json FROM proposals WHERE project_id = ? ORDER BY n', projectId);
        run('DELETE FROM proposals WHERE project_id = ?', projectId);
        return rows.map(r => parse<Proposal>(r));
      });
    },
    async savePlanProposal(p) {
      run(
        'INSERT INTO plan_proposals (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json',
        p.id,
        JSON.stringify(p),
      );
    },
    async getPlanProposal(id) {
      const row = get('SELECT json FROM plan_proposals WHERE id = ?', id);
      return row ? parse<PlanProposal>(row) : null;
    },
    async savePending(p) {
      // Upsert keeps the original insertion position (column n) when an id is re-saved.
      run(
        `INSERT INTO pending (id, project_id, created_at, json) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, created_at = excluded.created_at, json = excluded.json`,
        p.id,
        p.projectId,
        p.createdAt,
        JSON.stringify(p),
      );
    },
    async listPending(projectId) {
      const rows = all('SELECT json FROM pending WHERE project_id = ? ORDER BY created_at, n', projectId);
      return rows.map(r => parse<PendingProposal>(r));
    },
    async deletePending(id) {
      run('DELETE FROM pending WHERE id = ?', id);
    },

    async getWorkspace(projectId, botId) {
      const row = get('SELECT json FROM workspaces WHERE project_id = ? AND bot_id = ?', projectId, botId);
      return row ? parse<Workspace>(row) : null;
    },
    async saveWorkspace(w) {
      run(
        `INSERT INTO workspaces (project_id, bot_id, json) VALUES (?, ?, ?)
         ON CONFLICT(project_id, bot_id) DO UPDATE SET json = excluded.json`,
        w.projectId,
        w.botId,
        JSON.stringify(w),
      );
    },
    async getMemory(botId) {
      const row = get('SELECT json FROM memories WHERE bot_id = ?', botId);
      return row ? parse<EmployeeMemory>(row) : null;
    },
    async saveMemory(m) {
      run(
        'INSERT INTO memories (bot_id, json) VALUES (?, ?) ON CONFLICT(bot_id) DO UPDATE SET json = excluded.json',
        m.botId,
        JSON.stringify(m),
      );
    },
    async listMemories() {
      return all('SELECT json FROM memories ORDER BY rowid').map(r => parse<EmployeeMemory>(r));
    },

    async putDeliverable(projectId, content) {
      const ref = newId('del');
      run('INSERT INTO deliverables (project_id, ref, content) VALUES (?, ?, ?)', projectId, ref, content);
      return ref;
    },
    async getDeliverable(projectId, ref) {
      const row = get('SELECT content FROM deliverables WHERE project_id = ? AND ref = ?', projectId, ref);
      if (!row) throw new ContextError('NOT_FOUND', `No deliverable ${ref} in project ${projectId}`);
      return row.content as string;
    },

    async getMeta<T>(projectId: string, key: string) {
      const row = get('SELECT json FROM meta WHERE project_id = ? AND key = ?', projectId, key);
      return row ? parse<T | null>(row) : null;
    },
    async setMeta(projectId, key, value) {
      run(
        `INSERT INTO meta (project_id, key, json) VALUES (?, ?, ?)
         ON CONFLICT(project_id, key) DO UPDATE SET json = excluded.json`,
        projectId,
        key,
        JSON.stringify(value) ?? 'null',
      );
    },

    close() {
      db.close();
    },
  };
}
