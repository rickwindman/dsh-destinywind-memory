/**
 * Store + injection test for dsh-destinywind-memory.
 *
 * Covers the Markdown bank (parse/serialize round-trip, external edits picked up by the
 * mtime+size stamp), the v1 JSON adoption path (both the current and the pre-rename
 * directory), the HTTP API, and the three prompt-injection contributions.
 * Run: node tests/memory-bank.test.mjs
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// --- Scenario 1: a v1 JSON bank is adopted into Markdown and renamed as a backup ---------------
const homeJson = tempHome();
const storeDir = join(homeJson, 'destinywind-memory');
mkdirSync(storeDir, { recursive: true });
writeFileSync(join(storeDir, 'memory.json'), JSON.stringify({
  memories: [
    { id: 'v1-a', text: '禁止使用 powershell 5.1', tags: ['终端'], createdAt: 1 },
    { id: 'v1-b', text: '后台知识条目B', tags: [], createdAt: 2 },
  ],
}), 'utf8');

const bank = mount(homeJson);
const rendered = bank.section(SECTION);
const markdownFile = join(storeDir, 'memory.md');

assert.ok(rendered.includes('禁止使用 powershell 5.1'), 'adopted entry must render into the prompt');
assert.ok(rendered.includes('### 硬性约束（必须遵守）'), 'instructions and facts must render in separate groups');
assert.ok(rendered.includes('### 背景知识（相关时参考）'), 'background knowledge group must render');
assert.ok(existsSync(markdownFile), 'adoption must write the Markdown bank');
assert.ok(existsSync(join(storeDir, 'memory.json.v1.bak')), 'the v1 JSON file must be kept as a backup');
assert.ok(!existsSync(join(storeDir, 'memory.json')), 'the v1 JSON file must be renamed, not left active');

const markdown = readFileSync(markdownFile, 'utf8');
assert.ok(markdown.includes('## 禁止使用 powershell 5.1'), 'each memory is a `##` section');
assert.ok(markdown.includes('<!-- tags: 终端 -->'), 'tags round-trip through a comment');

// --- Scenario 2: the hard constraints are also injected as a user-role runtime context ---------
const constraintContext = bank.context(CONTEXT);
assert.ok(constraintContext.includes('禁止使用 powershell 5.1'), 'constraints reach the runtime context');
assert.ok(!constraintContext.includes('后台知识条目B'), 'background knowledge stays out of the runtime context');
assert.ok(bank.section(REMINDER).includes('记忆核对'), 'the trailing self-check reminder renders');

// --- Scenario 3: an external editor rewrites the file and the next assembly sees it ------------
writeFileSync(markdownFile, `${markdown}\n## 新增约束\n\n必须用中文回复，并用中文思考。\n`, 'utf8');
const afterEdit = bank.section(SECTION);
assert.ok(afterEdit.includes('必须用中文回复，并用中文思考。'), 'an external edit must be picked up without a restart');
assert.ok(readFileSync(markdownFile, 'utf8').includes('## 新增约束'), 'a hand-written section keeps its own heading');

// --- Scenario 4: HTTP API round-trip, with stable ids for existing entries ---------------------
const before = JSON.parse((await call(bank, 'GET', '/dsh-destinywind-memory/memories')).payload);
assert.equal(before.ok, true, 'GET must succeed');
assert.equal(before.memories.length, 3, 'three memories after the edit');
assert.equal(typeof before.file, 'string', 'GET reports the Markdown file path');
const stableIds = before.memories.map(entry => entry.id);

const posted = JSON.parse((await call(bank, 'POST', '/dsh-destinywind-memory/memories', JSON.stringify({ text: '经 API 新增的条目C', tags: ['api'] }))).payload);
assert.equal(posted.ok, true, 'POST must succeed');
assert.equal(posted.entry.text, '经 API 新增的条目C');

const after = JSON.parse((await call(bank, 'GET', '/dsh-destinywind-memory/memories')).payload);
assert.deepEqual(after.memories.slice(0, stableIds.length).map(entry => entry.id), stableIds, 'appending must not renumber existing ids');
assert.equal(after.memories[after.memories.length - 1].text, '经 API 新增的条目C', 'new memories append at the end');

const removed = JSON.parse((await call(bank, 'DELETE', `/dsh-destinywind-memory/memories/${stableIds[0]}`)).payload);
assert.equal(removed.ok, true, 'DELETE must succeed');
const remaining = JSON.parse((await call(bank, 'GET', '/dsh-destinywind-memory/memories')).payload);
assert.ok(!remaining.memories.some(entry => entry.text === '禁止使用 powershell 5.1'), 'the deleted memory is gone');
assert.equal(remaining.memories.length, 3, 'three memories remain');
assert.ok(!bank.context(CONTEXT).includes('禁止使用 powershell 5.1'), 'the runtime context follows the deletion');
assert.equal(JSON.parse((await call(bank, 'DELETE', '/dsh-destinywind-memory/memories/999')).payload).ok, false, 'deleting an unknown id reports false');

// --- Scenario 5: a fresh install renders nothing and creates no file ---------------------------
const homeFresh = tempHome();
const fresh = mount(homeFresh);
assert.equal(fresh.section(SECTION), '', 'a fresh install renders an empty section');
assert.equal(fresh.context(CONTEXT), '', 'a fresh install renders an empty runtime context');
assert.equal(fresh.section(REMINDER), '', 'a fresh install renders no reminder');
assert.ok(!existsSync(join(homeFresh, 'destinywind-memory')), 'a fresh install must not create the store until a write');
assert.deepEqual(
  JSON.parse((await call(fresh, 'GET', '/dsh-destinywind-memory/memories')).payload).memories,
  [],
  'a fresh install lists no memories',
);

// --- Scenario 6: pre-rename `hindsight-memory/memory.json` is adopted too ----------------------
const homeLegacy = tempHome();
mkdirSync(join(homeLegacy, 'hindsight-memory'), { recursive: true });
writeFileSync(join(homeLegacy, 'hindsight-memory', 'memory.json'), JSON.stringify({
  memories: [{ id: 'h1', text: '旧目录收养条目', tags: [] }],
}), 'utf8');
const legacy = mount(homeLegacy);
assert.ok(legacy.section(SECTION).includes('旧目录收养条目'), 'the pre-rename bank is adopted');
assert.ok(existsSync(join(homeLegacy, 'destinywind-memory', 'memory.md')), 'adoption writes the Markdown bank');
assert.ok(existsSync(join(homeLegacy, 'hindsight-memory', 'memory.json.v1.bak')), 'the pre-rename file is kept as a backup');

// --- Scenario 7: a hand-written Markdown note file without `##` headings still works -----------
const homeNotes = tempHome();
const notesDir = join(homeNotes, 'destinywind-memory');
mkdirSync(notesDir, { recursive: true });
writeFileSync(join(notesDir, 'memory.md'), [
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
const notes = mount(homeNotes);
const notesPrompt = notes.section(SECTION);
assert.ok(notesPrompt.includes('禁止使用英文回复'), 'bullets become memories');
assert.ok(notesPrompt.includes('默认用中文'), 'each bullet is its own memory');
assert.ok(notesPrompt.includes('这是一段普通段落'), 'a plain paragraph becomes a memory');
assert.ok(!notesPrompt.includes('随手写的'), 'blockquote furniture is not a memory');

// --- Scenario 8: a corrupt v1 bank is never renamed behind the user's back ---------------------
const homeBroken = tempHome();
const brokenDir = join(homeBroken, 'destinywind-memory');
mkdirSync(brokenDir, { recursive: true });
writeFileSync(join(brokenDir, 'memory.json'), '{ this is not json', 'utf8');
const broken = mount(homeBroken);
assert.equal(broken.section(SECTION), '', 'a corrupt v1 bank renders nothing');
assert.ok(existsSync(join(brokenDir, 'memory.json')), 'a corrupt v1 bank must be left in place');
assert.ok(!existsSync(join(brokenDir, 'memory.json.v1.bak')), 'a corrupt v1 bank must not be renamed away');

console.log('PASS: Markdown bank, JSON adoption, HTTP API, and prompt injection verified');
