/**
 * Focused test for the SQLite storage layer.
 *
 * The bug this layer exists to fix: a Markdown bank split any entry whose body contained a line
 * starting with `## ` into two entries, and treated an HTML comment shaped like the tag metadata
 * as real tags. These tests write exactly those bodies and assert they round-trip unchanged.
 *
 * Run: node tests/store-sqlite.test.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store-sqlite.js';

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    console.log(`  FAIL ${label}`);
    console.log(`       ${error.message}`);
    process.exitCode = 1;
  }
}

console.log('store-sqlite');

// ---------------------------------------------------------------- round-trip of hostile bodies
const HOSTILE = [
  '## 这是一个二级标题\n正文第一行\n正文第二行',
  '<!-- tags: 假的标签 -->\n正文',
  '### 三级标题\n- 列表项 A\n- 列表项 B',
  '> 引用行\n---\n普通行',
  '```\n代码块里有 ## 井号\n<!-- tags: x -->\n```',
  '$$\\int_0^1 x^2 dx$$\n| 表格 | 列 |\n| --- | --- |\n| a | b |',
  '## 开头\n## 又一条\n## 第三条',
  '结尾没有换行',
  'HTML <div class="x">内容</div> & 转义符 \\n \\t',
  'emoji 🎯 和全角　空格\t制表符',
];

const dir = mkdtempSync(join(tmpdir(), 'dwm-sqlite-'));
const dbFile = join(dir, 'memory.sqlite');
const db = openDatabase(dbFile);

for (const body of HOSTILE) {
  db.add({ title: '测试', text: body, tags: ['测试'] });
}

const listed = db.list();

check('条目数等于写入数（没有被拆碎）', () => {
  assert.equal(listed.length, HOSTILE.length);
});

check('每条正文逐字节原样返回', () => {
  for (let i = 0; i < HOSTILE.length; i += 1) {
    assert.equal(listed[i].text, HOSTILE[i], `第 ${i} 条正文被改写`);
  }
});

check('含多个 ## 的正文仍是一条', () => {
  const entry = listed.find(e => e.text.startsWith('## 开头'));
  assert.ok(entry, '应当存在该条目');
  assert.equal(entry.text.split('\n').length, 3);
});

check('形如标签的 HTML 注释没有被当成标签', () => {
  const entry = listed.find(e => e.text.includes('假的标签'));
  assert.ok(entry, '应当存在该条目');
  assert.deepEqual(entry.tags, ['测试']);
});

// ------------------------------------------------------------------------------ id semantics
check('id 为自增主键且删除后不复用', () => {
  const lastId = Number(db.list().at(-1).id);
  db.remove(String(lastId));
  const added = db.add({ title: 't', text: '新条目' });
  assert.equal(Number(added), lastId + 1, 'AUTOINCREMENT 不应复用已删除的 id');
});

check('删除中间条目不影响其余 id', () => {
  const fresh = openDatabase(':memory:');
  const a = fresh.add({ text: 'A' });
  const b = fresh.add({ text: 'B' });
  const c = fresh.add({ text: 'C' });
  fresh.remove(b);
  assert.deepEqual(fresh.list().map(e => e.id), [a, c]);
  fresh.close();
});

check('remove 不存在的 id 返回 false', () => {
  assert.equal(db.remove('999999'), false);
  assert.equal(db.remove('abc'), false);
});

// ------------------------------------------------------------------------------ tags and order
check('标签按写入顺序返回', () => {
  const fresh = openDatabase(':memory:');
  fresh.add({ text: 'x', tags: ['丙', '甲', '乙'] });
  assert.deepEqual(fresh.list()[0].tags, ['丙', '甲', '乙']);
  fresh.close();
});

check('重复标签只存一次', () => {
  const fresh = openDatabase(':memory:');
  fresh.add({ text: 'x', tags: ['a', 'a', 'b'] });
  assert.deepEqual(fresh.list()[0].tags, ['a', 'b']);
  fresh.close();
});

// ---------------------------------------------------------------------------- persistence
check('关闭再打开后数据仍在', () => {
  db.close();
  const reopened = openDatabase(dbFile);
  assert.equal(reopened.list().length, listed.length);
  assert.equal(reopened.list()[0].text, HOSTILE[0]);
  reopened.close();
});

check('replaceAll 覆盖并保留顺序', () => {
  const fresh = openDatabase(':memory:');
  fresh.add({ text: '旧' });
  fresh.replaceAll([{ title: 't1', text: '新1' }, { title: 't2', text: '新2', tags: ['z'] }]);
  const rows = fresh.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, '新1');
  assert.deepEqual(rows[1].tags, ['z']);
  fresh.close();
});

check('超长正文被截断到上限', () => {
  const small = openDatabase(':memory:', { maxTextLength: 10 });
  small.replaceAll([{ text: 'x'.repeat(100) }]);
  assert.equal(small.list()[0].text.length, 10);
  small.close();
});

check('空正文在 replaceAll 中被跳过', () => {
  const fresh = openDatabase(':memory:');
  fresh.replaceAll([{ text: '   ' }, { text: '有效' }]);
  assert.equal(fresh.list().length, 1);
  fresh.close();
});

rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed${process.exitCode === 1 ? '，存在失败项' : ''}`);
