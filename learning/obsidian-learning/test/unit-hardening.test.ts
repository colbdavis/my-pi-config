import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { checkToolCall } from '../src/guard.ts';
import { PKG_DIR } from '../src/agents.ts';
import { applyProposal, createProposal, rollback } from '../src/edits.ts';
import { emptyGrants } from '../src/policy.ts';
import { verifyItem } from '../src/learning.ts';
import { makeVault, userMsg } from './helpers/vault.ts';

test('strict defaults block shell execution, workflows and children without the restricted maker role', () => {
  const tv = makeVault();
  try {
    assert.equal(tv.cfg.strictBash, true);
    const ctx = { cfg: tv.cfg, vaultRoot: tv.root, vaultRootRaw: tv.root, cwd: tv.tmp, grants: emptyGrants() };
    for (const tool of ['bash', 'bg_start', 'workflow']) assert.ok(checkToolCall(ctx, tool, { command: 'python script.py' }).block);
    assert.ok(checkToolCall(ctx, 'subagent_spawn', { harness: 'codex' }).block);
    assert.ok(checkToolCall(ctx, 'subagent_spawn', { harness: 'pi', working_dir: tv.tmp }).block);
    assert.ok(!checkToolCall(ctx, 'subagent_spawn', { harness: 'pi', working_dir: path.join(PKG_DIR, 'agent-workspaces/svg-maker') }).block);
  } finally { tv.cleanup(); }
});

test('invalid write directories, review delays and retrieval limits fail configuration', () => {
  for (const extra of [{ learningDir: '../outside' }, { learningDir: '/' }, { schedule: { relearnDays: 0 } }, { limits: { maxIndexBytes: -1 } }]) {
    assert.throws(() => loadConfig({ env: {}, overrides: { configFile: null, ...extra } as any }));
  }
});

test('rollback checks vault identity and current write policy even when forced', () => {
  const tv = makeVault();
  const rel = '6 - Atomic Notes/Combinatoria - Pigeonhole Principle.md';
  try {
    const p = createProposal(tv.vault, { path: rel, edits: [{ oldText: 'Se metti n oggetti in n contenitori', newText: 'Se metti n oggetti in m contenitori' }], rationale: 'Distinct variables' });
    const rec = applyProposal(tv.vault, p, [0]);
    tv.cfg.rules.push({ prefix: rel, access: 'read-only' });
    assert.throws(() => rollback(tv.vault, rec.id, { force: true }), /no longer allowed/);
    tv.cfg.rules.pop();
    const manifest = path.join(tv.cfg.backupDir, rec.id, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ ...rec, vaultRoot: tv.outside }));
    assert.throws(() => rollback(tv.vault, rec.id, { force: true }), /different vault/);
  } finally { tv.cleanup(); }
});

test('chat evidence must preserve the actual answer, including accents and capitalization', () => {
  const entries = [userMsg('Sì, almeno cinque.')];
  const item = { question: 'Quante?', level: 'understanding' as const, outcome: 'correct' as const, evidence: { type: 'chat' as const, quote: 'Sì, almeno cinque.' } };
  assert.equal(verifyItem(entries, item, 0).item.learnerAnswer, item.evidence.quote);
  assert.throws(() => verifyItem(entries, { ...item, evidence: { type: 'chat', quote: 'si, almeno cinque.' } }, 0), /quote not found/);
});
