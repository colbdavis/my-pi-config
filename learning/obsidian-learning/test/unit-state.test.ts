import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { addDays, diffDays, isIsoDate, localDate, localTimestamp } from "../src/dates.ts";
import { gradeAssessment, type GradedItem, nextState } from "../src/schedule.ts";
import { buildQueue, parseTracker, renderQueueMarkdown, serializeTracker } from "../src/tracker.ts";
import { askResult, makeVault, quizResult, read, userMsg } from "./helpers/vault.ts";

const S = { intervals: [3, 10, 30], relearnDays: 1 };
const item = (o: Partial<GradedItem>): GradedItem => ({ level: "understanding", outcome: "correct", hints: 0, ...o });

// ── dates ───────────────────────────────────────────────────────────────────

test("dates: local date depends on the configured timezone, not UTC", () => {
	const t = new Date("2026-10-12T23:30:00Z");
	assert.equal(localDate(t, "Europe/Rome"), "2026-10-13");
	assert.equal(localDate(t, "America/Detroit"), "2026-10-12");
	assert.match(localTimestamp(t, "America/Detroit"), /^2026-10-12T19:30:00-04:00$/);
	assert.match(localTimestamp(t, "Europe/Rome"), /^2026-10-13T01:30:00\+02:00$/);
});

test("dates: calendar arithmetic is DST-proof and validated", () => {
	assert.equal(addDays("2026-10-24", 3), "2026-10-27"); // across EU DST end (Oct 25)
	assert.equal(addDays("2027-03-27", 1), "2027-03-28");
	assert.equal(addDays("2026-12-30", 3), "2027-01-02");
	assert.equal(diffDays("2026-10-10", "2026-10-12"), 2);
	assert.ok(isIsoDate("2028-02-29") && !isIsoDate("2027-02-29") && !isIsoDate("12/10/2026"));
	assert.throws(() => addDays("2026-13-01", 1));
});

// ── grading ─────────────────────────────────────────────────────────────────

test("grading: no evidence → error (a lesson alone cannot be recorded)", () => {
	assert.throws(() => gradeAssessment([]), /at least one/);
});

test("grading: pass requires independent understanding/application", () => {
	assert.equal(gradeAssessment([item({})]).outcome, "pass");
	assert.equal(gradeAssessment([item({ level: "application" })]).outcome, "pass");
	assert.equal(gradeAssessment([item({ level: "recognition" })]).outcome, "partial", "recognition only");
	assert.equal(gradeAssessment([item({ hints: 1 }), item({ level: "recognition" })]).outcome, "partial", "hints needed");
	assert.equal(gradeAssessment([item({}), item({ outcome: "partial" })]).outcome, "partial");
	assert.equal(gradeAssessment([item({}), item({ level: "application", hints: 3 })]).outcome, "partial", "key-step hint");
});

test("grading: fail on deep errors or half wrong; 'don't know' counts as not known", () => {
	assert.equal(gradeAssessment([item({}), item({ outcome: "incorrect" })]).outcome, "fail");
	assert.equal(gradeAssessment([item({ outcome: "dont_know", level: "application" })]).outcome, "fail");
	assert.equal(gradeAssessment([item({ level: "recognition", outcome: "incorrect" }), item({})]).outcome, "fail", "half wrong");
	assert.equal(
		gradeAssessment([item({ level: "recognition", outcome: "incorrect" }), item({}), item({ level: "application" })]).outcome,
		"partial",
		"one shallow slip among strong answers",
	);
});

// ── scheduling ──────────────────────────────────────────────────────────────

test("schedule: preferred recall schedule 3 → 10 → 30 days, then 30-day maintenance", () => {
	let st = { status: "unassessed" as const, stage: 0, nextReview: null as string | null };
	const s1 = nextState(st, "pass", "in-lesson", "2026-10-01", S);
	assert.deepEqual([s1.status, s1.stage, s1.nextReview], ["practicing", 0, "2026-10-04"]);
	const s2 = nextState(s1, "pass", "review", "2026-10-04", S);
	assert.deepEqual([s2.status, s2.stage, s2.nextReview], ["demonstrated", 1, "2026-10-14"]);
	const s3 = nextState(s2, "pass", "review", "2026-10-14", S);
	assert.deepEqual([s3.stage, s3.nextReview], [2, "2026-11-13"]);
	const s4 = nextState(s3, "pass", "review", "2026-11-13", S);
	assert.deepEqual([s4.stage, s4.nextReview], [3, "2026-12-13"]);
	const s5 = nextState(s4, "pass", "review", "2026-12-13", S);
	assert.deepEqual([s5.stage, s5.nextReview], [3, "2027-01-12"]);
});

test("schedule: failed review repeats sooner and resets the stage", () => {
	const st = { status: "demonstrated" as const, stage: 2, nextReview: "2026-11-13" };
	const f = nextState(st, "fail", "review", "2026-11-13", S);
	assert.deepEqual([f.status, f.stage, f.nextReview], ["needs_review", 0, "2026-11-14"]);
	const back = nextState(f, "pass", "review", "2026-11-14", S);
	assert.deepEqual([back.status, back.stage, back.nextReview], ["demonstrated", 1, "2026-11-24"]);
});

test("schedule: partial steps back one interval and keeps the stage", () => {
	const mk = (stage: number) => nextState({ status: "practicing", stage, nextReview: "2026-10-10" }, "partial", "review", "2026-10-10", S);
	assert.deepEqual([0, 1, 2, 3].map((s) => mk(s).nextReview), ["2026-10-13", "2026-10-13", "2026-10-20", "2026-10-20"]);
	assert.equal(mk(2).stage, 2);
	assert.equal(nextState({ status: "demonstrated", stage: 2, nextReview: null }, "partial", "review", "2026-10-10", S).status, "needs_review");
});

test("schedule: in-lesson success never yields 'demonstrated' and keeps an existing schedule", () => {
	const l = nextState({ status: "learning", stage: 0, nextReview: "2026-10-11" }, "pass", "in-lesson", "2026-10-10", S);
	assert.equal(l.status, "practicing");
	assert.equal(l.nextReview, "2026-10-11");
	const first = nextState({ status: "unassessed", stage: 0, nextReview: null }, "fail", "in-lesson", "2026-10-10", S);
	assert.deepEqual([first.status, first.nextReview], ["learning", "2026-10-11"]);
	const indep = nextState({ status: "unassessed", stage: 0, nextReview: null }, "pass", "independent", "2026-10-10", S);
	assert.deepEqual([indep.status, indep.nextReview], ["demonstrated", "2026-10-13"]);
});

// ── tracker ─────────────────────────────────────────────────────────────────

const TRACKER = `---
type: learning-state
---
# Mastery Tracker

My own note above the table.

| Concept | Notes | Status | Stage | Last assessed | Next review | Misconceptions | Sessions | My column |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pigeonhole-principle | [[Combinatoria - Pigeonhole Principle]] | practicing | 1 | 2026-10-01 | 2026-10-11 | floor vs ceiling (×2); n vs m | [[2026-10-01 Sessione]] | keep me |
| congruenza | [[Congruenza Modulare]], [[Divisione Euclidea e Resto]] | Needs Review | x | 2026-10-02 | 12/10/2026 |  |  |  |
| xor | [[X\\|alias]] | demonstrated | 2 | 2026-10-05 | 2026-10-12 |  |  |  |
| ccit-pretest | | learning | 0 | | | | | |

Footer text.
`;

test("tracker: parse is tolerant, reports bad cells, keeps extra columns", () => {
	const doc = parseTracker(TRACKER);
	assert.equal(doc.rows.length, 4);
	const p = doc.rows[0];
	assert.deepEqual(p.misconceptions, [
		{ label: "floor vs ceiling", count: 2 },
		{ label: "n vs m", count: 1 },
	]);
	assert.equal(p.extra["My column"], "keep me");
	assert.equal(doc.rows[1].status, "needs_review", "manual 'Needs Review' is normalized");
	assert.equal(doc.rows[1].stage, 0);
	assert.equal(doc.rows[1].nextReview, null);
	assert.ok(doc.warnings.some((w) => w.includes("invalid stage")));
	assert.ok(doc.warnings.some((w) => w.includes("not an ISO date")));
	assert.deepEqual(doc.rows[2].notes, ["X"]);
});

test("tracker: serialize preserves surrounding text and extra columns", () => {
	const out = serializeTracker(parseTracker(TRACKER));
	assert.ok(out.includes("My own note above the table."));
	assert.ok(out.includes("Footer text."));
	assert.ok(out.includes("| keep me |"));
	const again = parseTracker(out);
	assert.deepEqual(
		again.rows.map((r) => [r.concept, r.status, r.stage]),
		parseTracker(TRACKER).rows.map((r) => [r.concept, r.status, r.stage]),
	);
});

test("queue: overdue, due today, unscheduled, upcoming; recurring misconceptions", () => {
	const q = buildQueue(parseTracker(TRACKER).rows, "2026-10-12");
	assert.deepEqual(q.overdue.map((i) => [i.concept, i.daysOverdue]), [["pigeonhole-principle", 1]]);
	assert.deepEqual(q.overdue[0].recurringMisconceptions, ["floor vs ceiling"]);
	assert.deepEqual(q.dueToday.map((i) => i.concept), ["xor"]);
	assert.deepEqual(q.unscheduled.map((i) => i.concept).sort(), ["ccit-pretest", "congruenza"]);
	const md = renderQueueMarkdown(q);
	assert.ok(md.includes("Generated view") && md.includes("not a guarantee of retention"));
	assert.ok(!/#review|#flashcards|sr-due/.test(md), "never emits spaced-repetition plugin markers");
});

// ── assessments with evidence verification ──────────────────────────────────

function setup() {
	const tv = makeVault();
	tv.store.init();
	return tv;
}

test("init: creates the skeleton once and never overwrites", () => {
	const tv = setup();
	try {
		for (const f of ["Learning Profile.md", "Mastery Tracker.md", "Review Queue.md"]) assert.ok(fs.existsSync(path.join(tv.root, "8 - Learning System", f)));
		for (const d of ["Sessions/Transcripts", "Assessments", "Visuals"]) assert.ok(fs.statSync(path.join(tv.root, "8 - Learning System", d)).isDirectory());
		fs.writeFileSync(path.join(tv.root, "8 - Learning System", "Learning Profile.md"), "MY EDITS");
		assert.deepEqual(tv.store.init(), []);
		assert.equal(read(tv.root, "8 - Learning System/Learning Profile.md"), "MY EDITS");
	} finally {
		tv.cleanup();
	}
});

test("assessment: lesson without learner answers is rejected", () => {
	const tv = setup();
	try {
		assert.throws(() => tv.store.recordAssessment({ concept: "x", context: "in-lesson", items: [] }, []), /not assessment evidence/);
	} finally {
		tv.cleanup();
	}
});

test("assessment: fabricated evidence is rejected (unknown toolCallId, wrong tool, unanswered, unquoted chat)", () => {
	const tv = setup();
	try {
		const entries = [userMsg("Secondo me sono almeno 5 persone"), quizResult("q1"), quizResult("q2", { status: "cancelled" }), askResult("a1", "perché 52 = 4·12 + 4")];
		const rec = (evidence: any, extra: any = {}) =>
			tv.store.recordAssessment({ concept: "pigeonhole", context: "review", items: [{ level: "understanding", evidence, outcome: "correct", question: "q", ...extra }] }, entries);
		assert.throws(() => rec({ type: "quiz", toolCallId: "nope" }), /no quiz result/);
		assert.throws(() => rec({ type: "quiz", toolCallId: "a1" }), /belongs to ask_user_question/);
		assert.throws(() => rec({ type: "quiz", toolCallId: "q2" }), /not answered/);
		assert.throws(() => rec({ type: "chat", quote: "sono almeno 6 persone" }), /quote not found/);
		assert.throws(() => rec({ type: "ask_user_question", toolCallId: "a1" }, { outcome: undefined }), /outcome is required/);
		assert.equal(fs.readdirSync(path.join(tv.root, "8 - Learning System/Assessments")).length, 0, "nothing written on rejection");
	} finally {
		tv.cleanup();
	}
});

test("assessment: quiz outcome comes from the quiz result, MCQ capped at understanding", () => {
	const tv = setup();
	try {
		const entries = [quizResult("q1", { correct: false, answer: "4" })];
		const r = tv.store.recordAssessment(
			{ concept: "Pigeonhole Principle", context: "review", items: [{ level: "application", evidence: { type: "quiz", toolCallId: "q1" }, outcome: "correct" }] },
			entries,
			{ now: new Date("2026-10-12T10:00:00Z") },
		);
		assert.equal(r.items[0].outcome, "incorrect");
		assert.equal(r.items[0].level, "understanding");
		assert.ok(r.warnings.some((w) => w.includes("replaced by the quiz result")));
		assert.ok(r.warnings.some((w) => w.includes("capped")));
		assert.equal(r.outcome, "fail");
		assert.equal(r.after.status, "learning");
		assert.equal(r.after.nextReview, "2026-10-13");
	} finally {
		tv.cleanup();
	}
});

test("assessment: verified evidence updates tracker, writes evidence file and review queue", () => {
	const tv = setup();
	try {
		const entries = [userMsg("Sono 5: 52 = 4·12 + 4, quindi almeno un mese ne ha 5"), quizResult("q1"), askResult("a1", "uso il soffitto di n/m")];
		const now = new Date("2026-10-12T08:00:00Z");
		const r = tv.store.recordAssessment(
			{
				concept: "pigeonhole-principle",
				title: "Principio della piccionaia",
				notes: ["Combinatoria - Pigeonhole Principle", "[[Untitled]]", "Nota inesistente"],
				context: "independent",
				items: [
					{ level: "recognition", evidence: { type: "quiz", toolCallId: "q1" } },
					{ level: "understanding", evidence: { type: "ask_user_question", toolCallId: "a1" }, outcome: "correct" },
					{ level: "application", question: "52 persone in 12 mesi?", evidence: { type: "chat", quote: "52 = 4·12 + 4, quindi almeno un mese ne ha 5" }, outcome: "correct", misconceptions: ["floor vs ceiling"] },
				],
			},
			entries,
			{ now, piSessionId: "sess-1" },
		);
		assert.equal(r.outcome, "pass");
		assert.equal(r.after.status, "demonstrated");
		assert.equal(r.after.nextReview, "2026-10-15");
		assert.ok(r.warnings.some((w) => w.includes("Nota inesistente")));
		assert.ok(r.warnings.some((w) => w.includes("ambiguous")));
		const row = parseTracker(read(tv.root, "8 - Learning System/Mastery Tracker.md")).rows[0];
		assert.deepEqual([row.concept, row.status, row.stage, row.lastAssessed, row.nextReview], ["pigeonhole-principle", "demonstrated", 0, "2026-10-12", "2026-10-15"]);
		assert.ok(row.notes.includes("Combinatoria - Pigeonhole Principle"));
		assert.ok(row.notes.some((n) => n.endsWith("Untitled") && n.includes("/")), "ambiguous note linked by path");
		const ev = read(tv.root, r.file);
		assert.match(ev, /type: learning-assessment/);
		assert.match(ev, /quiz `q1` \(verified\)/);
		assert.match(ev, /verbatim quote verified/);
		assert.match(ev, /pi_session: sess-1/);
		const queueMd = read(tv.root, "8 - Learning System/Review Queue.md");
		const dueToday = queueMd.split("## Due today")[1].split("## ")[0];
		const upcoming = queueMd.split("## Upcoming")[1];
		assert.ok(!dueToday.includes("pigeonhole-principle"), "not due today");
		assert.ok(upcoming.includes("`pigeonhole-principle`") && upcoming.includes("2026-10-15"), "listed as upcoming");
		// A later failed review: misconception becomes recurring, schedule shrinks.
		const r2 = tv.store.recordAssessment(
			{ concept: "pigeonhole-principle", context: "review", items: [{ level: "application", question: "q", evidence: { type: "chat", quote: "Sono 5" }, outcome: "incorrect", misconceptions: ["floor vs ceiling"] }] },
			entries,
			{ now: new Date("2026-10-15T08:00:00Z") },
		);
		assert.equal(r2.after.status, "needs_review");
		assert.equal(r2.after.nextReview, "2026-10-16");
		const row2 = parseTracker(read(tv.root, "8 - Learning System/Mastery Tracker.md")).rows[0];
		assert.deepEqual(row2.misconceptions, [{ label: "floor vs ceiling", count: 2 }]);
	} finally {
		tv.cleanup();
	}
});

test("assessment: manual tracker corrections are respected as the previous state", () => {
	const tv = setup();
	try {
		const trackerPath = path.join(tv.root, "8 - Learning System/Mastery Tracker.md");
		const doc = parseTracker(fs.readFileSync(trackerPath, "utf8"));
		doc.rows.push({ concept: "xor", notes: [], status: "demonstrated", stage: 2, lastAssessed: "2026-09-01", nextReview: "2026-10-01", misconceptions: [], sessions: [], extra: {} });
		fs.writeFileSync(trackerPath, serializeTracker(doc));
		const r = tv.store.recordAssessment(
			{ concept: "xor", context: "review", items: [{ level: "understanding", evidence: { type: "quiz", toolCallId: "q1" } }] },
			[quizResult("q1")],
			{ now: new Date("2026-10-12T08:00:00Z") },
		);
		assert.deepEqual([r.before.status, r.before.stage], ["demonstrated", 2]);
		assert.deepEqual([r.after.stage, r.after.nextReview], [3, "2026-11-11"]);
	} finally {
		tv.cleanup();
	}
});

test("session summary: written in Sessions/, links assessments, marks verified answers, never touches atomic notes", () => {
	const tv = setup();
	try {
		const before = read(tv.root, "6 - Atomic Notes/Combinatoria - Pigeonhole Principle.md");
		const entries = [userMsg("Prima ho detto 4 ma poi 5")];
		const t = tv.store.createTranscript("Piccionaia", new Date("2026-10-12T08:00:00Z"));
		const rel = tv.store.writeSessionSummary(
			{
				topic: "Piccionaia",
				sourceNotes: ["Combinatoria - Pigeonhole Principle"],
				exchanges: [{ question: "52/12?", firstAttempt: "Prima ho detto 4", learnerAnswer: "poi 5", outcome: "corretta" }, { question: "x", learnerAnswer: "inventata" }],
				misconceptions: ["floor vs ceiling"],
				followUps: ["inclusione-esclusione"],
				proposedChanges: [{ path: "6 - Atomic Notes/Combinatoria - Pigeonhole Principle.md", summary: "chiarire n/m", status: "pending", proposalId: "prop-1" }],
			},
			{ entries, transcript: t, assessments: ["8 - Learning System/Assessments/2026-10-12 1000 pigeonhole.md"], piSessionId: "s1", now: new Date("2026-10-12T08:00:00Z") },
		);
		assert.match(rel, /^8 - Learning System\/Sessions\/2026-10-12 1000 - Piccionaia\.md$/);
		const md = read(tv.root, rel);
		assert.match(md, /poi 5 ✓/);
		assert.match(md, /inventata \(non verificata\)/);
		assert.match(md, /\*\*Primo tentativo:\*\* Prima ho detto 4 ✓/);
		assert.match(md, /\[\[8 - Learning System\/Assessments\/2026-10-12 1000 pigeonhole\]\]/);
		assert.match(md, /Transcripts\/2026-10-12 1000 - Piccionaia \(transcript\)\]\]/);
		assert.equal(read(tv.root, "6 - Atomic Notes/Combinatoria - Pigeonhole Principle.md"), before);
	} finally {
		tv.cleanup();
	}
});
