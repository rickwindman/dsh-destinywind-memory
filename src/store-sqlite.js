/**
 * SQLite storage layer for dsh-destinywind-memory.
 *
 * The Markdown bank this replaces used `##` headings as the entry delimiter, so any memory whose
 * body contained a line starting with `## ` (or an HTML comment shaped like the tag metadata)
 * was silently split into two entries or had its tags overwritten. A database removes the
 * ambiguity: entry bodies are opaque TEXT values that no parser reinterprets, so arbitrary
 * Markdown, HTML, code fences and quotes round-trip byte-for-byte.
 *
 * There is no Markdown mirror: `memory.md` is no longer written or read. The database is the only
 * store, so a body can never be misread as document structure again.
 *
 * SQLite comes from Node's builtin `node:sqlite` (stable since Node 24), so the plugin needs no
 * native dependency and stays installable from a plain git URL.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Bumped when the on-disk database layout changes in a way this module must migrate. */
const SCHEMA_VERSION = 1;

/**
 * Create the table set. `STRICT` rejects the type coercion SQLite normally allows, and the
 * `position` column on `tags` keeps the display order stable without an external sort key.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL DEFAULT '',
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS tags (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag       TEXT    NOT NULL,
  position  INTEGER NOT NULL,
  PRIMARY KEY (memory_id, tag)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_tags_memory ON tags(memory_id, position);
`;

/**
 * Open (and initialize) the bank database.
 *
 * @param databaseFile absolute path of the SQLite file, or `:memory:` for tests.
 * @param options.maxTextLength hard cap on a single entry body, matching the plugin's limit.
 */
export function openDatabase(databaseFile, options = {}) {
  const maxTextLength = options.maxTextLength ?? 8000;
  const inMemory = databaseFile === ':memory:';

  if (!inMemory) mkdirSync(path.dirname(databaseFile), { recursive: true });
  const db = new DatabaseSync(databaseFile);

  // WAL keeps a reader (prompt assembly) from blocking the HTTP writer, and survives a crash
  // without losing committed memories. Foreign keys are off by default in SQLite.
  if (!inMemory) {
    try {
      db.exec('PRAGMA journal_mode = WAL;');
    } catch {
      // A filesystem without WAL support still works in the default rollback journal mode.
    }
  }
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  if (versionRow === undefined) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  }

  const statements = {
    list: db.prepare('SELECT id, title, text FROM memories ORDER BY id ASC'),
    listTags: db.prepare('SELECT tag FROM tags WHERE memory_id = ? ORDER BY position ASC'),
    insert: db.prepare('INSERT INTO memories (title, text) VALUES (?, ?)'),
    insertTag: db.prepare('INSERT OR IGNORE INTO tags (memory_id, tag, position) VALUES (?, ?, ?)'),
    delete: db.prepare('DELETE FROM memories WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM memories'),
  };

  function readEntry(row) {
    return {
      id: String(row.id),
      title: row.title,
      text: row.text,
      tags: statements.listTags.all(row.id).map(tagRow => tagRow.tag),
    };
  }

  /**
   * Insert one entry inside a transaction. Tags are written in their supplied order through the
   * `position` column so the display order survives a reload.
   */
  function insertEntry(entry) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const info = statements.insert.run(String(entry.title ?? ''), String(entry.text ?? ''));
      const id = info.lastInsertRowid;
      const tags = Array.isArray(entry.tags) ? entry.tags : [];
      tags.forEach((tag, index) => {
        statements.insertTag.run(id, String(tag), index);
      });
      db.exec('COMMIT');
      return String(id);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    /** @returns every entry, oldest first, in the shape the plugin's `makeEntry` produces. */
    list() {
      return statements.list.all().map(readEntry);
    },

    add(entry) {
      return insertEntry(entry);
    },

    /** @returns true when a row was actually removed. */
    remove(id) {
      const numeric = Number(id);
      if (!Number.isInteger(numeric)) return false;
      return statements.delete.run(numeric).changes > 0;
    },

    count() {
      return statements.count.get().n;
    },

    /** Replace the whole bank — used by the one-time legacy import. */
    replaceAll(entries) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('DELETE FROM memories');
        for (const entry of entries) {
          const text = String(entry.text ?? '').slice(0, maxTextLength);
          if (text.trim() === '') continue;
          const info = statements.insert.run(String(entry.title ?? ''), text);
          const tags = Array.isArray(entry.tags) ? entry.tags : [];
          tags.forEach((tag, index) => {
            statements.insertTag.run(info.lastInsertRowid, String(tag), index);
          });
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    close() {
      db.close();
    },
  };
}

/**
 * Import entries from a v1 JSON bank, exactly once.
 *
 * A marker file records the import so an intentionally emptied database is never repopulated from
 * a stale file on the next start. The legacy file is renamed rather than deleted, so a failed
 * migration is still recoverable by hand.
 *
 * @returns the entries to import, or an empty array when there is nothing (left) to adopt.
 */
export function collectLegacyJson(files, markerFile) {
  if (existsSync(markerFile)) return [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed?.memories)) continue;
      return parsed.memories;
    } catch {
      // A corrupt file is left exactly where it is, never renamed behind the user's back.
    }
  }
  return [];
}

/** Rename a legacy file out of the way, keeping it recoverable. */
export function retireLegacyFile(file) {
  try {
    renameSync(file, `${file}.v1.bak`);
  } catch {
    // A locked file stays in place as its own backup; adoption never runs twice anyway.
  }
}

/**
 * Record that the one-time legacy import is finished.
 *
 * Written after the rows are committed and the legacy files are retired, so a crash in between
 * leaves no marker and the next start retries instead of losing memories. Without this marker an
 * intentionally emptied bank would be refilled from a stale file, and the import would re-run on
 * every start.
 *
 * @returns true when the marker is in place (already present counts as success).
 */
export function markMigrated(markerFile) {
  try {
    writeFileSync(markerFile, `migrated-to-sqlite ${new Date().toISOString()}\n`, 'utf8');
    return true;
  } catch {
    // Failing to write the marker only costs a redundant retry; it never corrupts the bank.
    return false;
  }
}

export { SCHEMA_VERSION };
