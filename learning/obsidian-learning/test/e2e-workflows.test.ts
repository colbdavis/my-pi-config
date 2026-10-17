import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { makeVault, read, userMsg } from './helpers/vault.ts';
import { lastResult, openSession, tc } from './helpers/session.mjs';
import { addDays } from '../src/dates.ts';

const PIGEON = '6 - Atomic Notes/Combinatoria - Pigeonhole Principle.md';
const OLD = 'Se metti n oggetti in n contenitori';
const NEW = 'Se metti n oggetti in m contenitori';
const quiz = { question: '52 persone in 12 mesi: quante almeno nello stesso mese?', options: [{ label: '5', value: '5' }, { label: '4', value: '4' }], correctAnswer: '5', explanation: 'Il limite garantito è il soffitto di 52/12.', shuffle: false };
const item = { level: 'understanding', hints: 0, evidence: { type: 'quiz', toolCallId: 'q' } };

test('A: real Pi loads skills, navigates index, reads bounded notes and probes via upstream quiz', async () => {
  const tv = makeVault(); tv.store.init();
  const h = await openSession(tv);
  try {
    const skills = h.loader.getSkills().skills.map(s => s.name);
    for (const name of ['teach', 'visualize', 'obsidian-learning']) assert.ok(skills.includes(name), name);
    const results = await h.run('Insegnami aritmetica modulare usando il mio vault.', [
      (ctx) => { assert.match(ctx.systemPrompt, /never give the complete solution first/); return tc('vault_index', { index: 'Aritmetica Modulare' }); },
      tc('vault_read', { note: 'Congruenza Modulare' }),
      tc('quiz', quiz, 'q'),
      tc('learning_record_assessment', { concept: 'modular-arithmetic', context: 'in-lesson', notes: ['Congruenza Modulare'], items: [item] }),
    ]);
    assert.ok(results.every(r => !r.isError), JSON.stringify(results));
    assert.match(results[0].content[0].text, /Congruenza Modulare/);
    assert.match(results[1].content[0].text, /untrusted DATA/);
    assert.equal(results[2].details.correct, true);
    assert.equal(results[3].details.status, 'practicing');
    assert.equal(h.errors.length, 0);
  } finally { await h.close(); tv.cleanup(); }
});

test('B/E: quiz evidence precedes correction; real approval dialog applies only approved edits and preserves reasoning', async () => {
  const tv = makeVault(); tv.store.init();
  const before = read(tv.root, PIGEON);
  const h = await openSession(tv, { inputs: [['\r', '\r'], ['a']] });
  try {
    const results = await h.run('Interrogami sul principio della piccionaia.', [
      tc('vault_search', { query: 'piccionaia pigeonhole' }), tc('vault_read', { note: PIGEON }), tc('quiz', quiz, 'q'),
      tc('learning_record_assessment', { concept: 'pigeonhole-principle', context: 'independent', notes: [PIGEON], items: [item] }),
      tc('vault_propose_edit', { path: PIGEON, edits: [{ oldText: OLD, newText: NEW }], rationale: 'Distinguere oggetti e contenitori.' }),
      (ctx) => { assert.equal(read(tv.root, PIGEON), before); return tc('vault_apply_edit', { proposalId: lastResult(ctx).details.proposalId }); },
    ]);
    assert.ok(results.every(r => !r.isError), JSON.stringify(results));
    assert.equal(results.at(-1).details.status, 'applied');
    assert.equal(read(tv.root, PIGEON), before.replace(OLD, NEW));
    assert.ok(h.screens.some(s => s.includes('-') && s.includes('Proposed change:')));
    assert.ok(fs.existsSync(path.join(tv.cfg.backupDir, results.at(-1).details.backup, 'before.md')));
  } finally { await h.close(); tv.cleanup(); }
});

test('E: rejection, no UI and a file changed during approval never apply a proposal', async () => {
  for (const scenario of ['reject', 'headless', 'stale']) {
    const tv = makeVault(); tv.store.init();
    const before = read(tv.root, PIGEON);
    const h = await openSession(tv, { inputs: [['r']], hasUI: scenario !== 'headless' });
    try {
      const results = await h.run('Aggiorna i miei appunti.', [
        tc('vault_propose_edit', { path: PIGEON, edits: [{ oldText: OLD, newText: NEW }], rationale: 'Precisare le variabili.' }),
        (ctx) => {
          const id = lastResult(ctx).details.proposalId;
          if (scenario === 'stale') {
            fs.appendFileSync(path.join(tv.root, PIGEON), '\nModifica manuale.\n');
            // Change the UI's decision to apply for this case.
            h.session.extensionRunner.getUIContext().custom = factory => new Promise(resolve => {
              const component = factory({ requestRender() {} }, { fg: (_c, s) => s }, {}, resolve);
              component.handleInput('a');
            });
          }
          return tc('vault_apply_edit', { proposalId: id });
        },
      ]);
      if (scenario === 'stale') assert.match(results.at(-1).content[0].text, /STALE/);
      else assert.equal(results.at(-1).details.status, 'rejected');
      assert.equal(read(tv.root, PIGEON), before + (scenario === 'stale' ? '\nModifica manuale.\n' : ''));
    } finally { await h.close(); tv.cleanup(); }
  }
});

test('C: persisted due review loads in a fresh session and success reschedules by ten days', async () => {
  const tv = makeVault(); tv.store.init();
  const today = tv.store.today();
  tv.store.recordAssessment({ concept: 'pigeonhole-principle', context: 'independent', notes: [PIGEON], items: [{ question: 'Spiega', level: 'understanding', outcome: 'correct', evidence: { type: 'chat', quote: 'Almeno cinque.' } }] }, [userMsg('Almeno cinque.')]);
  const doc = tv.store.loadTracker(); doc.rows[0].nextReview = addDays(today, -1); tv.store.saveTracker(doc);
  const h = await openSession(tv);
  try {
    const results = await h.run('Cosa devo ripassare oggi?', [tc('learning_state', { action: 'due' }), tc('learning_state', { action: 'get', concept: 'pigeonhole-principle' }), tc('quiz', quiz, 'q'), tc('learning_record_assessment', { concept: 'pigeonhole-principle', context: 'review', items: [item] })]);
    assert.ok(results.every(r => !r.isError), JSON.stringify(results));
    assert.equal(results[0].details.overdue, 1);
    assert.equal(results.at(-1).details.nextReview, addDays(today, 10));
    assert.equal(tv.store.loadTracker().rows[0].stage, 1);
  } finally { await h.close(); tv.cleanup(); }
});

test('D: CCIT profile/roadmap and weak patterns inform tutoring; fabricated evidence cannot update progress', async () => {
  const tv = makeVault(); tv.store.init();
  const h = await openSession(tv);
  try {
    const results = await h.run('Facciamo una sessione di preparazione CCIT.', [
      ctx => { assert.match(ctx.systemPrompt, /62/); assert.match(ctx.systemPrompt, /da verificare/i); assert.match(ctx.systemPrompt, /first ask what the learner already tried/); return tc('vault_search', { query: 'CCIT piano' }); },
      tc('learning_state', { action: 'list' }),
      tc('learning_record_assessment', { concept: 'programming', context: 'independent', items: [{ level: 'application', outcome: 'correct', evidence: { type: 'chat', quote: 'A fabricated solution.' } }] }),
    ]);
    assert.match(results[0].content[0].text, /Piano CCIT/);
    assert.equal(results.at(-1).isError, true);
    assert.equal(tv.store.loadTracker().rows.length, 0);
  } finally { await h.close(); tv.cleanup(); }
});

test('runtime guard blocks direct writes and strict shell/harness execution; session summary uses verified answers', async () => {
  const tv = makeVault(); tv.store.init();
  const h = await openSession(tv);
  try {
    assert.ok(!h.session.getActiveToolNames().includes('bash'));
    const before = read(tv.root, PIGEON);
    const results = await h.run('La mia risposta è cinque.', [
      tc('write', { path: path.join(tv.root, PIGEON), content: 'destroy' }),
      tc('learning_write_session', { topic: 'Piccionaia', exchanges: [{ question: 'Quante?', learnerAnswer: 'cinque' }], followUps: ['Residui modulari'] }),
    ]);
    assert.equal(results[0].isError, true);
    assert.equal(read(tv.root, PIGEON), before);
    assert.ok(read(tv.root, results[1].details.path).includes('cinque'));
  } finally { await h.close(); tv.cleanup(); }
});

test('md-log command logs actual quiz and answers with frontmatter intact and refuses existing knowledge notes', async () => {
  const tv = makeVault(); tv.store.init();
  const h = await openSession(tv);
  try {
    await h.session.prompt('/learn-session Piccionaia');
    const editor = h.screens.find(s => s.startsWith('/md-log '));
    assert.ok(editor);
    const target = editor.slice('/md-log '.length);
    await h.session.prompt(editor);
    await h.run('La mia prima idea era quattro.', [tc('quiz', quiz, 'q')]);
    const transcript = fs.readFileSync(target, 'utf8');
    assert.match(transcript, /^---\ntype: learning-transcript/);
    assert.match(transcript, /La mia prima idea era quattro/);
    assert.match(transcript, /52 persone/);
    assert.match(transcript, /5/);
    const before = read(tv.root, PIGEON);
    await h.session.prompt(`/md-log ${path.join(tv.root, PIGEON)}`);
    assert.equal(read(tv.root, PIGEON), before);
  } finally { await h.close(); tv.cleanup(); }
});
