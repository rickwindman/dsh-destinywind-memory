/** Host half: destinywind memory bank — durable storage, HTTP API, prompt injection. */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const inject = ['webServer', 'systemPrompt'];

const SECTION_ORDER = 216;
const MAX_TEXT_LENGTH = 8000;
const MAX_ENTRIES = 1000;
const BODY_LIMIT = 128 * 1024;

function memoryDir() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'destinywind-memory');
}

function memoryFile() {
  return path.join(memoryDir(), 'memory.json');
}

// Pre-rename installs kept the bank under `<home>/hindsight-memory`; it is
// adopted once when the renamed store does not exist yet, so an upgrade never
// loses memories. The legacy directory is left in place as a backup.
function legacyMemoryFile() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'hindsight-memory', 'memory.json');
}

function normalizeEntry(entry) {
  const text = String(entry?.text ?? '').trim();
  if (!text) return null;
  const tags = Array.isArray(entry?.tags)
    ? entry.tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 12)
    : [];
  return { id: String(entry?.id ?? '') || randomUUID(), text: text.slice(0, MAX_TEXT_LENGTH), tags, createdAt: Number(entry?.createdAt) || Date.now() };
}

function createMemoryStore() {
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(readFileSync(memoryFile(), 'utf8'));
      cache = Array.isArray(parsed?.memories) ? parsed.memories : [];
    } catch {
      cache = [];
      try {
        const legacy = JSON.parse(readFileSync(legacyMemoryFile(), 'utf8'));
        if (Array.isArray(legacy?.memories) && legacy.memories.length > 0) {
          cache = legacy.memories;
          persist();
        }
      } catch {
        // Neither store exists yet; start empty.
      }
    }
    return cache;
  }

  function persist() {
    try {
      mkdirSync(memoryDir(), { recursive: true });
      const tmp = `${memoryFile()}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ memories: load() }, null, 2)}\n`, 'utf8');
      renameSync(tmp, memoryFile());
    } catch (error) {
      console.warn('[dsh-destinywind-memory] persist failed:', error);
    }
  }

  return {
    list() {
      return load();
    },
    add(input) {
      const entry = normalizeEntry(input);
      if (!entry) throw new Error('记忆内容不能为空');
      const items = load();
      items.unshift(entry);
      if (items.length > MAX_ENTRIES) items.length = MAX_ENTRIES;
      persist();
      return entry;
    },
    remove(id) {
      const items = load();
      const index = items.findIndex(entry => entry.id === id);
      if (index === -1) return false;
      items.splice(index, 1);
      persist();
      return true;
    },
    renderPrompt() {
      const items = load();
      if (items.length === 0) return '';
      const lines = [
        '## 长期记忆（destinywind memory bank）',
        '以下是用户长期记忆库中的条目，跨会话持久有效；回答与执行任务时主动参考；与用户当前指令冲突时以当前指令为准：',
      ];
      for (const entry of items) {
        const text = String(entry.text).replace(/\s+/g, ' ').trim();
        const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
        lines.push(`- ${text}${tags}`);
      }
      return lines.join('\n');
    },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'));
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
        return json(res, 200, { ok: true, memories: store.list() });
      }
      if (req.method === 'POST' && parts[0] === 'memories') {
        const body = JSON.parse((await readBody(req)) || '{}');
        return json(res, 200, { ok: true, entry: store.add(body) });
      }
      if (req.method === 'DELETE' && parts[0] === 'memories' && typeof parts[1] === 'string' && parts[1] !== '') {
        return json(res, 200, { ok: store.remove(parts[1]) });
      }
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };
}

export function apply(ctx) {
  const store = createMemoryStore();

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
}
