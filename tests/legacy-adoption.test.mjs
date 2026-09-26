/**
 * Legacy-adoption test for dsh-destinywind-memory.
 *
 * Simulates a pre-rename install: a `$DSH_HOME/hindsight-memory/memory.json`
 * exists while the renamed store does not. The first load() must adopt the
 * legacy entries, persist them into `<DSH_HOME>/destinywind-memory/`, and the
 * prompt section must render them. Run: node tests/legacy-adoption.test.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const mod = await import(`file://${pkgRoot.replaceAll('\\', '/')}/index.js`);
assert.equal(typeof mod.apply, 'function', 'index.js must export apply');

// Each apply() builds a fresh store (cache lives inside createMemoryStore),
// so one module instance is enough to exercise both scenarios.

// Scenario 1: legacy store present, renamed store absent -> adopt + persist.
const home = mkdtempSync(join(tmpdir(), 'dwm-test-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'hindsight-memory'), { recursive: true });
const legacy = { memories: [{ id: 't1', text: 'adopted-marker-entry', tags: ['测试'], createdAt: 1 }] };
writeFileSync(join(home, 'hindsight-memory', 'memory.json'), JSON.stringify(legacy), 'utf8');

const sections = [];
const effects = [];
mod.apply({
  effect: (fn) => effects.push(fn),
  webServer: { register: registration => registration },
  systemPrompt: { section: spec => sections.push(spec) },
});
for (const effect of effects) effect();
assert.equal(sections.length, 1, 'one systemPrompt section must be registered');

const rendered = sections[0].text();
assert.ok(rendered.includes('adopted-marker-entry'), 'legacy entry must render into the prompt');

const adoptedFile = join(home, 'destinywind-memory', 'memory.json');
assert.ok(existsSync(adoptedFile), 'adopted entries must be persisted into the renamed store');
const persisted = JSON.parse(readFileSync(adoptedFile, 'utf8'));
assert.equal(persisted.memories[0].text, 'adopted-marker-entry');
assert.equal(persisted.memories[0].id, 't1', 'ids must survive adoption');

// Scenario 2: neither store exists -> empty prompt, no crash, no store created.
const emptyHome = mkdtempSync(join(tmpdir(), 'dwm-test-'));
process.env.DSH_HOME = emptyHome;
const freshSections = [];
const freshEffects = [];
mod.apply({
  effect: (fn) => freshEffects.push(fn),
  webServer: { register: registration => registration },
  systemPrompt: { section: spec => freshSections.push(spec) },
});
for (const effect of freshEffects) effect();
assert.equal(freshSections[0].text(), '', 'fresh install renders an empty prompt');
assert.ok(!existsSync(join(emptyHome, 'destinywind-memory')), 'fresh install must not create the store until a write');

console.log('PASS: legacy adoption + fresh-install behavior verified');
