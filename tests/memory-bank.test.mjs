/**
 * Store + injection test for dsh-destinywind-memory (SQLite edition).
 *
 * Covers the SQLite bank (write/read round-trip, id stability, the hostile bodies that used to be
 * split by the Markdown parser), the one-time legacy import from `memory.md` and from a v1 JSON
 * bank in both the current and the pre-rename directory, the HTTP API, and the three
 * prompt-injection contributions.
 *
 * Run: node tests/memory-bank.test.mjs
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mod = await import(`file://${pkgRoot.replaceAll('\\', '/')}/index.js`);
assert.equal(typeof mod.apply, 'function', 'index.js must export apply');

const SECTION = 'plugin:destinywind-memory';
const REMINDER = 'plugin:destinywind-memory:reminder';
const CONTEXT = 'plugin:destinywind-memory:constraints';

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dwm-test-'));
}

/** Mount the plugin against a fake host context and return its registered contributions. */
function mount(home) {
  process.env.DSH_HOME = home;
  const sections = new Map();
  const contexts = new Map();
  const registrations = [];
  const effects = [];
  mod.apply({
    effect: fn => effects.push(fn),
    webServer: { register: registration => { registrations.push(registration); return registration; } },
    systemPrompt: {
      section: spec => { sections.set(spec.name, spec); return () => {}; },
      context: spec => { contexts.set(spec.name, spec); return () => {}; },
    },
  });
  for (const effect of effects) effect();
  return {
    sections,
    contexts,
    registrations,
    section: name => sections.get(name).text(),
    context: name => contexts.get(name).text(),
  };
}

/** Drive the registered prefix handler with a synthetic node request. */
function call(harness, method, url, body) {
  const registration = harness.registrations[0];
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.destroy = () => {};
    const res = {
      statusCode: 0,
      payload: '',
      writeHead(status) { this.statusCode = status; return this; },
      end(chunk) { this.payload = String(chunk ?? ''); resolve(this); },
    };
    Promise.resolve(registration.handler(req, res)).catch(reject);
    // The handler registers its listeners synchronously; feed the body afterwards.
    queueMicrotask(() => {
      if (body !== undefined) req.emit('data', Buffer.from(body, 'utf8'));
      req.emit('end');
    });
  });
}

const HOME = tempHome();
const storeDir = join(HOME, 'destinywind-memory');
const dbFile = join(storeDir, 'memory.sqlite');

// --- Scenario 1: a fresh install renders nothing and creates no file --------------------------
{
  const home = tempHome();
  const fresh = mount(home);
  assert.equal(fresh.section(SECTION), '', 'a fresh install renders an empty section');
  assert.equal(fresh.context(CONTEXT), '', 'a fresh install renders an empty runtime context');
  assert.equal(fresh.section(REMINDER), '', 'a fresh install renders no reminder');
  const listed = JSON.parse((await call(fresh, 'GET', '/dsh-destinywind-memory/memories')).payload);
  assert.deepEqual(listed.memories, [], 'a fresh install lists no memories');
  assert.ok(
    !existsSync(join(home, 'destinywind-memory', '.migrated-to-sqlite')),
    'a fresh install must not create a migration marker out of nothing',
  );
}

// --- Scenario 2: the bodies that used to break the Markdown parser survive intact -------------
const bank = mount(HOME);
const HOSTILE = [
  '## 这是一个二级标题\n正文第一行\n正文第二行',
  '<!-- tags: 假的标签 -->\n正文',
  '### 三级标题\n- 列表项 A\n- 列表项 B',
  '> 引用行\n---\n普通行',
];
for (const body of HOSTILE) {
  const posted = JSON.parse((await call(bank, 'POST', '/dsh-destinywind-memory/memories', JSON.stringify({ text: body, tags: ['测试'] }))).payload);
  assert.equal(posted.ok, true, `POST must succeed for ${JSON.stringify(body.slice(0, 12))}`);
}

const stored = JSON.parse((await call(bank, 'GET', '/dsh-destinywind-memory/memories')).payload);
assert.equal(stored.memories.length, HOSTILE.length, 'each hostile body stays exactly one memory');
for (let i = 0; i < HOSTILE.length; i += 1) {
  assert.equal(stored.memories[i].text, HOSTILE[i], `body ${i} must round-trip byte-for-byte`);
}
assert.deepEqual(stored.memories[1].tags, ['测试'], 'a body shaped like tag metadata must not set tags');

// --- Scenario 3: hard constraints are injected, background knowledge is not -------------------
{
  const constraint = '禁止使用 powershell 5.1，必须使用 pwsh 7';
  await call(bank, 'POST', '/dsh-destinywind-memory/memories', JSON.stringify({ text: constraint, tags: ['终端'] }));
  await call(bank, 'POST', '/dsh-destinywind-memory/memories', JSON.stringify({ text: '这台机器的显示器是 4K 分辨率', tags: [] }));

  const rendered = bank.section(SECTION);
  assert.ok(rendered.includes(constraint), 'the constraint renders into the prompt');
  assert.ok(rendered.includes('### 硬性约束（必须遵守）'), 'instructions and facts render in separate groups');
  assert.ok(rendered.includes('### 背景知识（相关时参考）'), 'background knowledge group renders');
  assert.ok(bank.section(REMINDER).includes('记忆核对'), 'the trailing self-check reminder renders');

  const constraintContext = bank.context(CONTEXT);
  assert.ok(constraintContext.includes(constraint), 'constraints reach the runtime context');
  assert.ok(!constraintContext.includes('这台机器的显示器是 4K 分辨率'), 'background knowledge stays out of the runtime context');
}

// --- Scenario 4: HTTP API round-trip, with stable ids for existing entries ---------------------
{
  const before = JSON.parse((await call(bank, 'GET', '/dsh-destinywind-memory/memories')).payload);
  const stableIds = before.memories.map(entry => entry.id);
  assert.equal(typeof before.file, 'string', 'GET reports the SQLite file path');
  assert.ok(before.file.endsWith('memory.sqlite'), 'the reported file is the SQLite bank');

  const posted = JSON.parse((await call(bank, 'POST', '/dsh-destinywind-memory/memories', JSON.stringify({ text: '经 API 新增的条目C', tags: ['api'] }))).payload);
  assert.equal(posted.ok, true, 'POST must succeed');
  assert.equal(posted.entry.text, '经 API 新增的条目C');
  assert.equal(typeof posted.entry.id, 'string', 'the created entry carries its id');

  const after = JSON.parse((await call(bank, 'GET', '/dsh-destinywind-memory/memories')).payload);
  assert.deepEqual(after.memories.slice(0, stableIds.length).map(entry => entry.id), stableIds, 'appending must not renumber existing ids');
  assert.equal(after.memories.at(-1).text, '经 API 新增的条目C', 'new memories append at the end');

  const removed = JSON.parse((await call(bank, 'DELETE', `/dsh-destinywind-memory/memories/${stableIds[0]}`)).payload);
  assert.equal(removed.ok, true, 'DELETE must succeed');
  const remaining = JSON.parse((await call(bank, 'GET', '/dsh-destinywind-memory/memories')).payload);
  assert.ok(!remaining.memories.some(entry => entry.id === stableIds[0]), 'the deleted memory is gone');
  assert.equal(JSON.parse((await call(bank, 'DELETE', '/dsh-destinywind-memory/memories/999999')).payload).ok, false, 'deleting an unknown id reports false');
  const rejected = JSON.parse((await call(bank, 'POST', '/dsh-destinywind-memory/memories', JSON.stringify({ text: '   ' }))).payload);
  assert.equal(rejected.ok, false, 'an empty body is rejected');
}

// --- Scenario 5: an existing memory.md is imported once, then retired -------------------------
{
  const home = tempHome();
  const dir = join(home, 'destinywind-memory');
  mkdirSync(dir, { recursive: true });
  const mdFile = join(dir, 'memory.md');
  writeFileSync(mdFile, [
    '# 长期记忆库',
    '',
    '## 旧约束一',
    '<!-- tags: 约束 -->',
    '',
    '禁止使用英文回复。',
    '',
    '## 旧约束二',
    '',
    '必须用中文思考。',
    '',
  ].join('\n'), 'utf8');

  const migrated = mount(home);
  const rendered = migrated.section(SECTION);
  assert.ok(rendered.includes('禁止使用英文回复。'), 'the Markdown bank is imported');
  assert.ok(rendered.includes('必须用中文思考。'), 'every section is imported');
  assert.ok(existsSync(join(dir, 'memory.sqlite')), 'the import creates the SQLite bank');
  assert.ok(existsSync(`${mdFile}.v1.bak`), 'the Markdown bank is kept as a backup');
  assert.ok(!existsSync(mdFile), 'the Markdown bank is renamed, not left active');
  assert.ok(existsSync(join(dir, '.migrated-to-sqlite')), 'the one-time import leaves a marker');

  // A second mount must not re-import the retired file.
  const again = mount(home);
  assert.equal(
    JSON.parse((await call(again, 'GET', '/dsh-destinywind-memory/memories')).payload).memories.length,
    2,
    'the import is not repeated on the next start',
  );
}

// --- Scenario 6: a legacy Markdown file is adopted into an empty database ---------------------
{
  const home = tempHome();
  const dir = join(home, 'destinywind-memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'memory.md'), [
    '# 我的记忆',
    '',
    '> 这份文件是随手写的，没有二级标题。',
    '',
    '- 禁止使用英文回复',
    '- 默认用中文',
    '',
    '这是一段普通段落，也要被当成一条记忆。',
    '',
  ].join('\n'), 'utf8');
  const notes = mount(home);
  const prompt = notes.section(SECTION);
  assert.ok(prompt.includes('禁止使用英文回复'), 'bullets become memories');
  assert.ok(prompt.includes('默认用中文'), 'each bullet is its own memory');
  assert.ok(prompt.includes('这是一段普通段落'), 'a plain paragraph becomes a memory');
  assert.ok(!prompt.includes('随手写的'), 'blockquote furniture is not a memory');
}

// --- Scenario 7: a v1 JSON bank is imported and renamed as a backup ---------------------------
{
  const home = tempHome();
  const dir = join(home, 'destinywind-memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'memory.json'), JSON.stringify({
    memories: [
      { id: 'v1-a', text: '禁止使用 powershell 5.1', tags: ['终端'], createdAt: 1 },
      { id: 'v1-b', text: '后台知识条目B', tags: [], createdAt: 2 },
    ],
  }), 'utf8');

  const jsonBank = mount(home);
  const rendered = jsonBank.section(SECTION);
  assert.ok(rendered.includes('禁止使用 powershell 5.1'), 'adopted entry must render into the prompt');
  assert.ok(existsSync(`${join(dir, 'memory.json')}.v1.bak`), 'the v1 JSON file must be kept as a backup');
  assert.ok(!existsSync(join(dir, 'memory.json')), 'the v1 JSON file must be renamed, not left active');
  assert.ok(existsSync(join(dir, '.migrated-to-sqlite')), 'the JSON import leaves a marker');
}

// --- Scenario 8: a corrupt v1 bank is left where it is, and never renamed ---------------------
{
  const home = tempHome();
  const dir = join(home, 'destinywind-memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'memory.json'), '{ this is not json', 'utf8');
  const broken = mount(home);
  assert.equal(broken.section(SECTION), '', 'a corrupt v1 bank renders nothing');
  assert.ok(existsSync(join(dir, 'memory.json')), 'a corrupt v1 bank must be left in place');
  assert.ok(!existsSync(`${join(dir, 'memory.json')}.v1.bak`), 'a corrupt v1 bank must not be renamed away');
}

// --- Scenario 9: the pre-rename `hindsight-memory/memory.json` is adopted too -----------------
{
  const home = tempHome();
  mkdirSync(join(home, 'hindsight-memory'), { recursive: true });
  writeFileSync(join(home, 'hindsight-memory', 'memory.json'), JSON.stringify({
    memories: [{ id: 'h1', text: '旧目录收养条目', tags: [] }],
  }), 'utf8');
  const legacy = mount(home);
  assert.ok(legacy.section(SECTION).includes('旧目录收养条目'), 'the pre-rename bank is adopted');
  assert.ok(existsSync(join(home, 'hindsight-memory', 'memory.json.v1.bak')), 'the pre-rename file is kept as a backup');
}

// --- Scenario 10: the marker stops a stale legacy file from refilling an emptied bank ----------
{
  const home = tempHome();
  const dir = join(home, 'destinywind-memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'memory.json'), JSON.stringify({
    memories: [{ id: 'old', text: '迁移前的老条目', tags: [] }],
  }), 'utf8');

  const first = mount(home);
  assert.ok(first.section(SECTION).includes('迁移前的老条目'), 'the JSON bank is adopted');
  assert.ok(existsSync(join(dir, '.migrated-to-sqlite')), 'the import leaves a marker');

  // Simulate a user who deletes every memory, plus a stale legacy file that reappears.
  const ids = JSON.parse((await call(first, 'GET', '/dsh-destinywind-memory/memories')).payload).memories.map(e => e.id);
  for (const id of ids) await call(first, 'DELETE', `/dsh-destinywind-memory/memories/${id}`);
  assert.equal(JSON.parse((await call(first, 'GET', '/dsh-destinywind-memory/memories')).payload).memories.length, 0, 'the bank is emptied');
  writeFileSync(join(dir, 'memory.json'), JSON.stringify({
    memories: [{ id: 'stale', text: '不该被重新灌入的旧条目', tags: [] }],
  }), 'utf8');

  const second = mount(home);
  assert.ok(!second.section(SECTION).includes('不该被重新灌入的旧条目'), 'a stale legacy file must not refill an emptied bank');
  assert.ok(existsSync(join(dir, 'memory.json')), 'the stale file is left untouched when it is not imported');
}

assert.ok(existsSync(dbFile), 'the bank database exists on disk');
console.log('PASS: SQLite bank, legacy import, HTTP API, and prompt injection verified');
