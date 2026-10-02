/**
 * Host half: the long-term memory bank — durable storage, HTTP API, prompt injection.
 *
 * Storage is SQLite (`<DSH_HOME>/destinywind-memory/memory.sqlite`), reached through Node's
 * builtin `node:sqlite`. The bank used to be a Markdown file whose `##` headings delimited
 * entries, which meant a memory body containing a line starting with `## ` was silently split in
 * two, and a body containing an HTML comment shaped like `<!-- tags: ... -->` had its tags
 * overwritten. Rows have no such syntax: a body is an opaque value, so it round-trips exactly.
 *
 * On first start after this change, an existing `memory.md` (or a v1 `memory.json`, from either
 * `destinywind-memory/` or the pre-rename `hindsight-memory/`) is imported once, then renamed to
 * `*.v1.bak` so an interrupted migration stays recoverable by hand. The Markdown parser exists
 * only for that one-time import and is never the live store again.
 *
 * The database file is an ordinary SQLite file: readable with any SQLite client, and copyable
 * while the harness runs (WAL keeps the writer from blocking a reader).
 *
 * Injection happens in three places, because one soft paragraph in the middle of the system
 * prompt is what models skip:
 *  - a section early in the system prompt (after the harness identity and deployment persona,
 *    before the tool sections) carrying the whole bank, split into hard constraints and
 *    background knowledge so an instruction is never read as a fact;
 *  - a runtime-context snapshot of the hard constraints alone — a user-role contribution, which
 *    models follow far more reliably than a long system-prompt passage;
 *  - a one-line self-check reminder among the trailing sections, the position a model attends to
 *    most reliably.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectLegacyJson, markMigrated, openDatabase, retireLegacyFile } from './src/store-sqlite.js';

export const inject = ['webServer', 'systemPrompt'];

/** Placed after the deployment persona (0) and before the first tool section (1000). */
const SECTION_ORDER = 216;
/** Placed before the sandbox (110) and approval (115) runtime contexts. */
const CONTEXT_ORDER = 100;
/** Placed after structured output (9900) and before the trailing harness sections (10000+). */
const REMINDER_ORDER = 9999;

const MAX_TEXT_LENGTH = 8000;
const MAX_TITLE_LENGTH = 120;
const MAX_TAGS = 12;
const MAX_ENTRIES = 1000;
const BODY_LIMIT = 128 * 1024;
const TITLE_FALLBACK_LENGTH = 40;

/** A memory whose text reads as an instruction. Tags are the explicit override. */
const CONSTRAINT_PATTERN = /(必须|禁止|不要|不得|务必|一定要|只能|只用|都要|偏好|约束|规则|规范)/;
const CONSTRAINT_TAGS = new Set(['约束', '规则', '偏好', '规范', '要求', 'constraint']);

function memoryDir() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'destinywind-memory');
}

/** The SQLite bank — the store itself. */
function databaseFile() {
  return path.join(memoryDir(), 'memory.sqlite');
}

/** Marks the one-time legacy import, so an emptied bank is never refilled from a stale file. */
function migrationMarkerFile() {
  return path.join(memoryDir(), '.migrated-to-sqlite');
}

/** The retired Markdown bank, read once for migration and never written again. */
function legacyMarkdownFile() {
  return path.join(memoryDir(), 'memory.md');
}

/** v1 JSON bank in the current directory. */
function legacyJsonFile() {
  return path.join(memoryDir(), 'memory.json');
}

/** Pre-rename installs kept the bank under `<home>/hindsight-memory`. */
function hindsightJsonFile() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'hindsight-memory', 'memory.json');
}

/** Collapse all whitespace: every entry renders as one prompt bullet. */
function flatten(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function splitTags(value) {
  return String(value ?? '')
    .split(/[,，;；\s]+/)
    .map(tag => tag.trim())
    .filter(Boolean);
}

function deriveTitle(text) {
  const flat = flatten(text);
  return flat.length <= TITLE_FALLBACK_LENGTH ? flat : `${flat.slice(0, TITLE_FALLBACK_LENGTH)}…`;
}

/** One entry as the rest of the plugin sees it: `{ id, title, text, tags }`. */
function makeEntry(text, title, tags) {
  const body = String(text ?? '').trim();
  if (!body) return null;
  return {
    title: flatten(title).slice(0, MAX_TITLE_LENGTH) || deriveTitle(body),
    text: body.slice(0, MAX_TEXT_LENGTH),
    tags: (Array.isArray(tags) ? tags : splitTags(tags)).map(tag => flatten(tag)).filter(Boolean).slice(0, MAX_TAGS),
  };
}

// --- legacy Markdown parsing, used only by the one-time import -------------------------------

/**
 * Parse a pre-SQLite Markdown bank. `##` sections were the canonical form; a file written by hand
 * without any `##` heading fell back to one memory per bullet / blank-line paragraph.
 */
function parseLegacyMarkdown(raw) {
  const lines = String(raw).replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries = [];
  let current = null;

  const flush = () => {
    if (current === null) return;
    const body = current.lines.join('\n').trim();
    const entry = makeEntry(body, current.title, current.tags);
    if (entry !== null) entries.push(entry);
    current = null;
  };

  for (const line of lines) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading !== null) {
      flush();
      current = { title: heading[1], lines: [], tags: [] };
      continue;
    }
    if (current === null) continue;
    const meta = /^<!--\s*([A-Za-z]+)\s*:\s*([\s\S]*?)\s*-->$/.exec(line.trim());
    if (meta !== null) {
      if (meta[1].toLowerCase() === 'tags' || meta[1].toLowerCase() === 'tag') {
        current.tags = current.tags.concat(splitTags(meta[2]));
        continue;
      }
      if (meta[1].toLowerCase() === 'created') continue;
    }
    current.lines.push(line);
  }
  flush();
  return entries.length > 0 ? entries : parseLooseEntries(lines);
}

/** Heading-less fallback: bullets are entries, other blank-line paragraphs are entries. */
function parseLooseEntries(lines) {
  const entries = [];
  let buffer = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    buffer = [];
    const entry = makeEntry(body);
    if (entry !== null) entries.push(entry);
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      flush();
      continue;
    }
    // Structural Markdown (file header, blockquote, HTML comment) is document furniture, not a memory.
    if (/^#{1,6}\s/.test(line) || line.startsWith('>') || line.startsWith('<!--')) {
      flush();
      continue;
    }
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet !== null) {
      flush();
      const entry = makeEntry(bullet[1]);
      if (entry !== null) entries.push(entry);
      continue;
    }
    buffer.push(raw);
  }
  flush();
  return entries;
}

/** A memory reads as a hard constraint when its tags say so or its text reads as an instruction. */
function isConstraint(entry) {
  if (entry.tags.some(tag => CONSTRAINT_TAGS.has(tag))) return true;
  return CONSTRAINT_PATTERN.test(entry.text) || CONSTRAINT_PATTERN.test(entry.title);
}

function createMemoryStore() {
  let db = null;

  /** Open lazily so a fresh install creates no file until the first write. */
  function connection() {
    if (db === null) {
      db = openDatabase(databaseFile(), { maxTextLength: MAX_TEXT_LENGTH });
      migrateOnce(db);
    }
    return db;
  }

  /**
   * Import a legacy bank exactly once. The marker is written last — after the rows are committed
   * and the legacy files are retired — so a crash in between leaves no marker and the next start
   * retries rather than losing memories.
   */
  function migrateOnce(opened) {
    const marker = migrationMarkerFile();
    if (existsSync(marker)) return;

    // A database with rows is already the authority. Record that no legacy file may be merged in,
    // so a stale file left on disk can never reintroduce deleted memories.
    if (opened.count() > 0) {
      markMigrated(marker);
      return;
    }

    const markdownFile = legacyMarkdownFile();
    if (existsSync(markdownFile)) {
      let entries = [];
      try {
        entries = parseLegacyMarkdown(readFileSync(markdownFile, 'utf8'));
      } catch (error) {
        console.warn('[dsh-destinywind-memory] 读取旧 Markdown 记忆库失败：', error);
      }
      if (entries.length > 0) {
        opened.replaceAll(entries);
        retireLegacyFile(markdownFile);
        markMigrated(marker);
      }
      // Nothing usable in the file: leave it in place, and without a marker so a later fix retries.
      return;
    }

    const jsonEntries = collectLegacyJson([legacyJsonFile(), hindsightJsonFile()], marker);
    if (jsonEntries.length > 0) {
      const entries = jsonEntries
        .map(item => makeEntry(item?.text, item?.title, item?.tags))
        .filter(entry => entry !== null);
      if (entries.length > 0) {
        opened.replaceAll(entries);
        for (const file of [legacyJsonFile(), hindsightJsonFile()]) {
          if (existsSync(file)) retireLegacyFile(file);
        }
        markMigrated(marker);
      }
      return;
    }

    // No legacy file anywhere. Deliberately no marker: a fresh install must not create any file
    // before its first write, and there is nothing to protect against.
  }

  /** @returns the store, migrated if this is the first call after an upgrade. */
  function store() {
    return connection();
  }

  function renderPrompt() {
    const items = store().list();
    if (items.length === 0) return '';
    const constraints = items.filter(isConstraint);
    const knowledge = items.filter(entry => !isConstraint(entry));
    const lines = [
      '## 长期记忆库',
      '以下条目跨会话持久有效，是用户已确认的既定事实与明确要求：',
      '1. 它们的优先级高于你的默认习惯、通用最佳实践与推理偏好，仅次于用户当前指令。',
      '2. 动手前先核对有无适用条目；有就必须照做，不要重新征询用户，也不要擅自变通。',
      '3. 仅当当前指令与某条记忆直接冲突时，才以当前指令为准，并在回复中说明该冲突。',
    ];
    const pushGroup = (title, group) => {
      if (group.length === 0) return;
      lines.push('', `### ${title}`);
      for (const entry of group) {
        const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
        lines.push(`- ${flatten(entry.text)}${tags}`);
      }
    };
    pushGroup('硬性约束（必须遵守）', constraints);
    pushGroup('背景知识（相关时参考）', knowledge);
    return lines.join('\n');
  }

  /**
   * The hard constraints alone, as a user-role runtime-context snapshot. Empty when the bank has
   * no constraint, so an empty bank contributes nothing to the snapshot.
   */
  function renderConstraintContext() {
    const constraints = store().list().filter(isConstraint);
    if (constraints.length === 0) return '';
    const lines = ['用户长期记忆库中的硬性约束（用户明确设定，必须遵守；优先级仅次于当前指令）：'];
    for (const entry of constraints) lines.push(`- ${flatten(entry.text)}`);
    return lines.join('\n');
  }

  return {
    list() {
      return store().list();
    },
    file() {
      return databaseFile();
    },
    add(input) {
      const entry = makeEntry(input?.text, input?.title, input?.tags);
      if (entry === null) throw new Error('记忆内容不能为空');
      if (store().count() >= MAX_ENTRIES) throw new Error(`记忆条目已达上限（${MAX_ENTRIES} 条）`);
      const id = store().add(entry);
      return { id, ...entry };
    },
    remove(id) {
      return store().remove(id);
    },
    renderPrompt,
    renderConstraintContext,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function makeHandler(store) {
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'dsh-destinywind-memory') parts.shift();
    try {
      if (req.method === 'GET' && parts[0] === 'memories') {
        return json(res, 200, { ok: true, memories: store.list(), file: store.file() });
      }
      if (req.method === 'POST' && parts[0] === 'memories') {
        const body = JSON.parse((await readBody(req)) || '{}');
        return json(res, 200, { ok: true, entry: store.add(body) });
      }
      if (req.method === 'DELETE' && parts[0] === 'memories' && typeof parts[1] === 'string' && parts[1] !== '') {
        return json(res, 200, { ok: store.remove(parts[1]) });
      }
      return json(res, 404, { ok: false, error: '未知接口' });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };
}

export function apply(ctx, config = {}) {
  const store = createMemoryStore();
  const tailReminder = config?.tailReminder !== false;

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/dsh-destinywind-memory', handler: makeHandler(store) }),
    'dsh-destinywind-memory: routes',
  );

  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'plugin:destinywind-memory',
      order: SECTION_ORDER,
      text: () => store.renderPrompt(),
    }),
    'dsh-destinywind-memory: prompt section',
  );

  ctx.effect(
    () => ctx.systemPrompt.context({
      name: 'plugin:destinywind-memory:constraints',
      order: CONTEXT_ORDER,
      text: () => store.renderConstraintContext(),
    }),
    'dsh-destinywind-memory: constraint context',
  );

  if (tailReminder) {
    ctx.effect(
      () => ctx.systemPrompt.section({
        name: 'plugin:destinywind-memory:reminder',
        order: REMINDER_ORDER,
        text: () => (store.list().length === 0
          ? ''
          : '## 记忆核对\n上文「长期记忆库」中适用于当前任务的条目必须执行，硬性约束不得违反；动手前先自检一次。'),
      }),
      'dsh-destinywind-memory: prompt reminder',
    );
  }
}
