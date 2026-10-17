/**
 * Learning state store: "8 - Learning System/".
 *
 *   Learning Profile.md   user-authored preferences (seeded once, never overwritten)
 *   Mastery Tracker.md    source of truth (Markdown table, hand-editable)
 *   Review Queue.md       generated view of the tracker
 *   Assessments/          one file per assessment: verified evidence (append-only)
 *   Sessions/             session summaries (consolidated, written by the tutor)
 *   Sessions/Transcripts/ raw md-log transcripts
 *   Visuals/              diagrams published by the svg/mermaid makers
 *
 * Proficiency only changes through recordAssessment(), which requires every
 * item to reference verifiable learner output in the current Pi session.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { localDate, localHHmm, localTimestamp } from "./dates.ts";
import { sanitizeFileName, uniquePath, writeFileAtomic } from "./fsutil.ts";
import { parseReference, resolveLink } from "./links.ts";
import { norm } from "./markdown.ts";
import { decide } from "./policy.ts";
import { resolveInVault } from "./paths.ts";
import {
	type AssessmentContext,
	gradeAssessment,
	type ItemOutcome,
	type Level,
	nextState,
	type Outcome,
	type Status,
	type Transition,
} from "./schedule.ts";
import {
	addMisconceptions,
	buildQueue,
	emptyRow,
	parseTracker,
	type Queue,
	renderQueueMarkdown,
	serializeTracker,
	slugify,
	type TrackerDoc,
	type TrackerRow,
} from "./tracker.ts";
import type { Vault } from "./vault.ts";

export class LearningError extends Error {}

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const TRACKER_PREAMBLE = `---
type: learning-state
tags:
  - learning-system
---
# Mastery Tracker

> [!info] Fonte di verità dello stato di apprendimento
> Puoi correggere a mano qualsiasi cella. **Status**: \`unassessed\`, \`learning\`, \`practicing\`, \`demonstrated\`, \`needs_review\`.
> **Stage** = ripassi ritardati superati di fila (0–3). Date nel formato \`YYYY-MM-DD\`.
> Un concetto diventa \`demonstrated\` solo con evidenza verificata (risposte tue in una verifica ritardata o in un problema svolto da solo) — mai perché esiste una nota o perché una lezione è finita. Le prove sono nella cartella Assessments.
`;

// ── Evidence ────────────────────────────────────────────────────────────────

export type EvidenceRef =
	| { type: "quiz"; toolCallId: string }
	| { type: "ask_user_question"; toolCallId: string }
	| { type: "chat"; quote: string };

export interface ItemInput {
	question?: string;
	level: Level;
	hints?: number;
	evidence: EvidenceRef;
	/** Required for ask_user_question/chat (tutor's grading). Ignored for quiz (taken from the real result). */
	outcome?: ItemOutcome;
	misconceptions?: string[];
	note?: string;
}

export interface VerifiedItem {
	question: string;
	level: Level;
	hints: number;
	outcome: ItemOutcome;
	learnerAnswer: string;
	correctAnswer?: string;
	learnerNote?: string;
	evidence: EvidenceRef;
	evidenceLabel: string;
	gradedBy: "quiz-tool" | "tutor";
	misconceptions: string[];
	note?: string;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
	return "";
}

function squash(s: string): string {
	return norm(s).replace(/\s+/g, " ").trim();
}

/** Verify one item against the session branch entries. Throws LearningError with a precise reason. */
export function verifyItem(entries: any[], item: ItemInput, index: number): { item: VerifiedItem; warnings: string[] } {
	const warnings: string[] = [];
	const n = index + 1;
	const ev = item.evidence as any;
	if (!ev || typeof ev.type !== "string") throw new LearningError(`item ${n}: missing evidence`);
	let level = item.level;
	const hints = Math.max(0, Math.min(4, Math.floor(item.hints ?? 0)));
	const base = { level, hints, misconceptions: (item.misconceptions ?? []).filter(Boolean), note: item.note, evidence: ev as EvidenceRef };

	if (ev.type === "quiz" || ev.type === "ask_user_question") {
		const id = String(ev.toolCallId ?? "");
		const msg = entries
			.filter((e) => e?.type === "message" && e.message?.role === "toolResult")
			.map((e) => e.message)
			.find((m) => m.toolCallId === id);
		if (!msg) throw new LearningError(`item ${n}: no ${ev.type} result with toolCallId "${id}" in this session`);
		if (msg.toolName !== ev.type) throw new LearningError(`item ${n}: toolCallId "${id}" belongs to ${msg.toolName}, not ${ev.type}`);
		const d = msg.details ?? {};
		if (d.status !== "answered") throw new LearningError(`item ${n}: ${ev.type} "${id}" was not answered (status: ${d.status ?? "unknown"})`);
		const answers: any[] = Array.isArray(d.answers) ? d.answers : [];
		if (ev.type === "quiz") {
			if (level === "application") {
				level = "understanding";
				warnings.push(`item ${n}: multiple-choice evidence capped at "understanding"`);
			}
			const outcome: ItemOutcome = d.dontKnow ? "dont_know" : d.correct ? "correct" : "incorrect";
			if (item.outcome && item.outcome !== outcome) warnings.push(`item ${n}: claimed outcome "${item.outcome}" replaced by the quiz result "${outcome}"`);
			const opts: any[] = Array.isArray(d.options) ? d.options : [];
			const correctAnswer = (d.correctIndices ?? [])
				.map((i: number) => opts.find((o) => o.index === i)?.label)
				.filter(Boolean)
				.join("; ");
			return {
				item: {
					...base,
					level,
					question: String(d.question ?? item.question ?? ""),
					outcome,
					learnerAnswer: d.dontKnow ? "I don't know" : answers.map((a) => a.label).join("; "),
					correctAnswer: correctAnswer || undefined,
					learnerNote: d.note || undefined,
					evidenceLabel: `quiz \`${id}\` (verified)`,
					gradedBy: "quiz-tool",
				},
				warnings,
			};
		}
		if (!item.outcome) throw new LearningError(`item ${n}: outcome is required for ask_user_question evidence`);
		return {
			item: {
				...base,
				question: String(d.question ?? item.question ?? ""),
				outcome: item.outcome,
				learnerAnswer: answers.map((a) => a.label).join("; "),
				evidenceLabel: `ask_user_question \`${id}\` (verified)`,
				gradedBy: "tutor",
			},
			warnings,
		};
	}

	if (ev.type === "chat") {
		const quote = String(ev.quote ?? "");
		if (!quote.trim()) throw new LearningError(`item ${n}: chat evidence needs the learner's verbatim quote`);
		const userTexts = entries
			.filter((e) => e?.type === "message" && e.message?.role === "user")
			.map((e) => messageText(e.message.content));
		if (!userTexts.some((t) => t.includes(quote))) {
			throw new LearningError(`item ${n}: quote not found in the learner's messages in this session — quote the learner verbatim`);
		}
		if (!item.outcome) throw new LearningError(`item ${n}: outcome is required for chat evidence`);
		if (!item.question?.trim()) throw new LearningError(`item ${n}: question is required for chat evidence`);
		return {
			item: {
				...base,
				question: item.question,
				outcome: item.outcome,
				learnerAnswer: quote.trim(),
				evidenceLabel: "learner message (verbatim quote verified)",
				gradedBy: "tutor",
			},
			warnings,
		};
	}
	throw new LearningError(`item ${n}: unknown evidence type "${ev.type}"`);
}

// ── Store ───────────────────────────────────────────────────────────────────

export interface AssessmentInput {
	concept: string;
	title?: string;
	notes?: string[];
	context: AssessmentContext;
	items: ItemInput[];
	misconceptions?: string[];
	tutorNotes?: string;
	sessionRef?: string;
}

export interface AssessmentResult {
	concept: string;
	outcome: Outcome;
	reason: string;
	before: { status: Status; stage: number; nextReview: string | null };
	after: Transition;
	file: string;
	warnings: string[];
	items: VerifiedItem[];
}

export interface SessionSummaryInput {
	topic: string;
	sourceNotes?: string[];
	exchanges?: Array<{ question: string; learnerAnswer: string; outcome?: string; firstAttempt?: string }>;
	misconceptions?: string[];
	independentEvidence?: string[];
	followUps?: string[];
	proposedChanges?: Array<{ path: string; summary: string; status: string; proposalId?: string }>;
	notes?: string;
}

export class LearningStore {
	readonly vault: Vault;
	readonly dir: string;

	constructor(vault: Vault) {
		this.vault = vault;
		this.dir = vault.cfg.learningDir;
	}

	rel(...parts: string[]): string {
		return [this.dir, ...parts].join("/");
	}

	get trackerRel() {
		return this.rel("Mastery Tracker.md");
	}
	get queueRel() {
		return this.rel("Review Queue.md");
	}
	get profileRel() {
		return this.rel("Learning Profile.md");
	}

	/** Absolute path for a learning-dir file, enforcing vault containment + learning policy. */
	private safeAbs(rel: string): string {
		const r = resolveInVault(this.vault.root, rel, this.vault.rootRaw);
		const d = decide(this.vault.cfg, r.rel, this.vault.grants);
		if (d.access !== "learning") throw new LearningError(`Refusing to write outside the learning directory: ${rel}`);
		return r.abs;
	}

	write(rel: string, content: string): string {
		const abs = this.safeAbs(rel);
		writeFileAtomic(abs, content);
		return rel;
	}

	/** Create the directory skeleton and seed files. Never overwrites. */
	init(profileTemplate?: string): string[] {
		const created: string[] = [];
		for (const d of ["", "Sessions", "Sessions/Transcripts", "Assessments", "Visuals"]) {
			const rel = d ? this.rel(d) : this.dir;
			const abs = this.safeAbs(rel);
			if (!fs.existsSync(abs)) {
				fs.mkdirSync(abs, { recursive: true });
				created.push(`${rel}/`);
			}
		}
		const seed = (rel: string, content: () => string) => {
			const abs = this.safeAbs(rel);
			if (fs.existsSync(abs)) return;
			writeFileAtomic(abs, content());
			created.push(rel);
		};
		seed(this.profileRel, () => profileTemplate ?? fs.readFileSync(path.join(PKG_DIR, "templates", "Learning Profile.md"), "utf8"));
		seed(this.trackerRel, () => serializeTracker({ ...parseTracker(TRACKER_PREAMBLE), warnings: [] }));
		if (!fs.existsSync(this.safeAbs(this.queueRel))) {
			this.regenerateQueue(new Date());
			created.push(this.queueRel);
		}
		this.vault.refresh(true);
		return created;
	}

	isInitialized(): boolean {
		return fs.existsSync(this.vault.absPath(this.trackerRel));
	}

	loadTracker(): TrackerDoc {
		const abs = this.vault.absPath(this.trackerRel);
		if (!fs.existsSync(abs)) return parseTracker(TRACKER_PREAMBLE);
		return parseTracker(fs.readFileSync(abs, "utf8"));
	}

	saveTracker(doc: TrackerDoc): void {
		this.write(this.trackerRel, serializeTracker(doc));
	}

	today(now = new Date()): string {
		return localDate(now, this.vault.cfg.timezone);
	}

	queue(now = new Date()): { queue: Queue; warnings: string[] } {
		const doc = this.loadTracker();
		return { queue: buildQueue(doc.rows, this.today(now)), warnings: doc.warnings };
	}

	/** Rewrite Review Queue.md only when its content changed (avoids sync churn). */
	regenerateQueue(now = new Date()): Queue {
		const { queue } = this.queue(now);
		const md = renderQueueMarkdown(queue);
		const abs = this.vault.absPath(this.queueRel);
		const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
		if (current !== md) this.write(this.queueRel, md);
		return queue;
	}

	readProfile(maxChars = 4000): string | null {
		const abs = this.vault.absPath(this.profileRel);
		if (!fs.existsSync(abs)) return null;
		const t = fs.readFileSync(abs, "utf8");
		return t.length > maxChars ? `${t.slice(0, maxChars)}\n…(truncated)` : t;
	}

	/** Normalize note references to Obsidian link targets; returns unresolved ones as warnings. */
	resolveNoteRefs(refs: string[]): { targets: string[]; warnings: string[] } {
		this.vault.refresh();
		const targets: string[] = [];
		const warnings: string[] = [];
		for (const ref of refs) {
			const r = resolveLink(this.vault, this.trackerRel, parseReference(ref));
			if ((r.status === "resolved" || r.status === "ambiguous") && r.path) {
				const base = path.posix.basename(r.path, ".md");
				const unique = (this.vault.byName.get(base.toLowerCase()) ?? []).length === 1;
				const target = unique ? base : r.path.slice(0, -3);
				if (!targets.includes(target)) targets.push(target);
				if (r.status === "ambiguous") warnings.push(`"${ref}" is ambiguous; linked to ${r.path}`);
			} else warnings.push(`"${ref}" does not resolve to a readable note (${r.status}); not linked`);
		}
		return { targets, warnings };
	}

	findRow(doc: TrackerDoc, concept: string): TrackerRow | undefined {
		const id = slugify(concept);
		return doc.rows.find((r) => r.concept === concept || slugify(r.concept) === id);
	}

	recordAssessment(input: AssessmentInput, entries: any[], opts: { now?: Date; piSessionId?: string } = {}): AssessmentResult {
		const now = opts.now ?? new Date();
		const tz = this.vault.cfg.timezone;
		const concept = slugify(input.concept);
		if (!concept) throw new LearningError("concept must contain letters or digits");
		if (!["in-lesson", "review", "independent"].includes(input.context)) throw new LearningError(`invalid context "${input.context}"`);
		if (!Array.isArray(input.items) || input.items.length === 0) {
			throw new LearningError("No learner responses: a lesson or explanation alone is not assessment evidence. Ask the learner (quiz, ask_user_question, or a problem) first.");
		}
		const seenIds = new Set<string>();
		const warnings: string[] = [];
		const items: VerifiedItem[] = input.items.map((it, i) => {
			const key = JSON.stringify(it.evidence);
			if (seenIds.has(key)) throw new LearningError(`item ${i + 1}: the same evidence is used twice`);
			seenIds.add(key);
			const v = verifyItem(entries, it, i);
			warnings.push(...v.warnings);
			return v.item;
		});
		const { outcome, reason } = gradeAssessment(items);

		const doc = this.loadTracker();
		warnings.push(...doc.warnings);
		let row = this.findRow(doc, concept);
		if (!row) {
			row = emptyRow(concept);
			doc.rows.push(row);
		}
		const before = { status: row.status, stage: row.stage, nextReview: row.nextReview };
		const date = localDate(now, tz);
		const after = nextState(before, outcome, input.context, date, this.vault.cfg.schedule);

		const { targets, warnings: refWarnings } = this.resolveNoteRefs(input.notes ?? []);
		warnings.push(...refWarnings);
		for (const t of targets) if (!row.notes.includes(t)) row.notes.push(t);
		const misconceptions = [...(input.misconceptions ?? []), ...items.flatMap((i) => i.misconceptions)];
		addMisconceptions(row, [...new Set(misconceptions.map((m) => m.trim()).filter(Boolean))]);
		if (input.sessionRef && !row.sessions.includes(input.sessionRef)) row.sessions.push(input.sessionRef);
		row.status = after.status;
		row.stage = after.stage;
		row.nextReview = after.nextReview;
		row.lastAssessed = date;

		const fileRel = this.uniqueRel(`Assessments/${date} ${localHHmm(now, tz)} ${concept}.md`);
		const md = renderAssessment({
			concept,
			title: input.title,
			timestamp: localTimestamp(now, tz),
			context: input.context,
			outcome,
			reason,
			before,
			after,
			notes: row.notes,
			items,
			misconceptions,
			tutorNotes: input.tutorNotes,
			sessionRef: input.sessionRef,
			piSessionId: opts.piSessionId,
			warnings,
		});
		this.write(fileRel, md);
		this.saveTracker(doc);
		this.regenerateQueue(now);
		this.vault.refresh(true);
		return { concept, outcome, reason, before, after, file: fileRel, warnings, items };
	}

	private uniqueRel(sub: string): string {
		const abs = uniquePath(this.safeAbs(this.rel(sub)));
		return this.vault.relFromAbs(abs);
	}

	createTranscript(topic: string, now = new Date()): string {
		const tz = this.vault.cfg.timezone;
		const name = `${localDate(now, tz)} ${localHHmm(now, tz)} - ${sanitizeFileName(topic, 60)} (transcript).md`;
		const rel = this.uniqueRel(`Sessions/Transcripts/${name}`);
		this.write(
			rel,
			`---\ntype: learning-transcript\ndate: ${localTimestamp(now, tz)}\ntopic: ${JSON.stringify(topic)}\ntags:\n  - learning-system/transcript\n---\n`,
		);
		return rel;
	}

	writeSessionSummary(
		input: SessionSummaryInput,
		ctx: { entries: any[]; piSessionId?: string; transcript?: string; assessments: string[]; existing?: string; now?: Date },
	): string {
		const now = ctx.now ?? new Date();
		const tz = this.vault.cfg.timezone;
		if (!input.topic?.trim()) throw new LearningError("topic is required");
		const { targets, warnings } = this.resolveNoteRefs(input.sourceNotes ?? []);
		const userTexts = ctx.entries
			.filter((e) => e?.type === "message" && e.message?.role === "user")
			.map((e) => squash(messageText(e.message.content)));
		const toolAnswers = ctx.entries
			.filter((e) => e?.type === "message" && e.message?.role === "toolResult" && ["quiz", "ask_user_question"].includes(e.message.toolName))
			.map((e) => squash(((e.message.details?.answers ?? []) as any[]).map((a) => a.label).join("; ")));
		const verified = (s: string) => {
			const q = squash(s);
			return !!q && (userTexts.some((t) => t.includes(q)) || toolAnswers.some((t) => t.includes(q)));
		};
		const link = (rel: string) => `[[${rel.replace(/\.md$/, "")}]]`;
		const lines: string[] = [
			"---",
			"type: learning-session",
			`date: ${localTimestamp(now, tz)}`,
			`topic: ${JSON.stringify(input.topic)}`,
			...(ctx.piSessionId ? [`pi_session: ${ctx.piSessionId}`] : []),
			"tags:",
			"  - learning-system/session",
			"---",
			`# Sessione — ${input.topic}`,
			"",
			"> [!info] Riepilogo della sessione (log grezzo, non conoscenza consolidata)",
			"> Le risposte segnate ✓ sono state verificate nel log della sessione. Le note atomiche si aggiornano solo tramite diff approvati.",
			"",
			`- **Data:** ${localDate(now, tz)}`,
			`- **Argomento:** ${input.topic}`,
			`- **Trascrizione:** ${ctx.transcript ? link(ctx.transcript) : "_nessuna (md-log non collegato)_"}`,
			"",
			"## Note di riferimento",
			...(targets.length ? targets.map((t) => `- [[${t}]]`) : ["_Nessuna._"]),
			"",
			"## Domande e risposte",
		];
		for (const ex of input.exchanges ?? []) {
			const mark = verified(ex.learnerAnswer) ? "✓" : "(non verificata)";
			lines.push(`### ${ex.question.replace(/\n/g, " ")}`);
			if (ex.firstAttempt) lines.push(`- **Primo tentativo:** ${ex.firstAttempt} ${verified(ex.firstAttempt) ? "✓" : "(non verificata)"}`);
			lines.push(`- **Risposta:** ${ex.learnerAnswer} ${mark}`);
			if (ex.outcome) lines.push(`- **Esito:** ${ex.outcome}`);
			lines.push("");
		}
		if (!(input.exchanges ?? []).length) lines.push("_Nessuna registrata._", "");
		const list = (title: string, items?: string[]) => [`## ${title}`, ...(items?.length ? items.map((i) => `- ${i}`) : ["_Nessuno._"]), ""];
		lines.push(...list("Misconcezioni individuate", input.misconceptions));
		lines.push(
			...list("Evidenza di comprensione indipendente", [
				...(ctx.assessments.map((a) => `${link(a)} (verifica registrata)`) ?? []),
				...(input.independentEvidence ?? []),
			]),
		);
		lines.push(...list("Concetti da approfondire", input.followUps));
		lines.push(
			...list(
				"Modifiche proposte alle note",
				(input.proposedChanges ?? []).map((c) => `\`${c.status}\` ${link(c.path)} — ${c.summary}${c.proposalId ? ` (proposta \`${c.proposalId}\`)` : ""}`),
			),
		);
		if (input.notes) lines.push("## Note del tutor", input.notes, "");
		if (warnings.length) lines.push("## Avvisi", ...warnings.map((w) => `- ${w}`), "");

		let rel = ctx.existing;
		if (rel) {
			// Only overwrite a summary this tool wrote for the same Pi session.
			const abs = this.vault.absPath(rel);
			const cur = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
			if (!cur.includes("type: learning-session") || (ctx.piSessionId && !cur.includes(`pi_session: ${ctx.piSessionId}`))) rel = undefined;
		}
		if (!rel) rel = this.uniqueRel(`Sessions/${localDate(now, tz)} ${localHHmm(now, tz)} - ${sanitizeFileName(input.topic, 60)}.md`);
		this.write(rel, lines.join("\n"));
		this.vault.refresh(true);
		return rel;
	}
}

function renderAssessment(a: {
	concept: string;
	title?: string;
	timestamp: string;
	context: AssessmentContext;
	outcome: Outcome;
	reason: string;
	before: { status: Status; stage: number; nextReview: string | null };
	after: Transition;
	notes: string[];
	items: VerifiedItem[];
	misconceptions: string[];
	tutorNotes?: string;
	sessionRef?: string;
	piSessionId?: string;
	warnings: string[];
}): string {
	const yamlList = (xs: string[]) => xs.map((x) => `  - ${JSON.stringify(x)}`).join("\n");
	const mark: Record<ItemOutcome, string> = { correct: "✓ corretta", partial: "◐ parziale", incorrect: "✗ errata", dont_know: "? non so" };
	const out: string[] = [
		"---",
		"type: learning-assessment",
		`concept: ${a.concept}`,
		`date: ${a.timestamp}`,
		`context: ${a.context}`,
		`outcome: ${a.outcome}`,
		`status_before: ${a.before.status}`,
		`status_after: ${a.after.status}`,
		`stage_after: ${a.after.stage}`,
		`next_review: ${a.after.nextReview ?? ""}`,
		...(a.notes.length ? ["notes:", yamlList(a.notes.map((n) => `[[${n}]]`))] : []),
		...(a.sessionRef ? [`session: ${JSON.stringify(`[[${a.sessionRef}]]`)}`] : []),
		...(a.piSessionId ? [`pi_session: ${a.piSessionId}`] : []),
		"tags:",
		"  - learning-system/assessment",
		"---",
		`# Verifica — ${a.title ?? a.concept}`,
		"",
		`- **Esito:** \`${a.outcome}\` — ${a.reason}`,
		`- **Contesto:** ${a.context}`,
		`- **Stato:** ${a.before.status} → **${a.after.status}** (stage ${a.before.stage} → ${a.after.stage})`,
		`- **Prossimo ripasso:** ${a.after.nextReview ?? "—"} (${a.after.rule})`,
		...(a.notes.length ? [`- **Note:** ${a.notes.map((n) => `[[${n}]]`).join(", ")}`] : []),
		"",
		"## Risposte",
	];
	a.items.forEach((it, i) => {
		out.push(`### ${i + 1}. ${mark[it.outcome]} · ${it.level} · suggerimenti: ${it.hints}`);
		out.push(`**Domanda:** ${it.question || "—"}`, "");
		out.push(`**Risposta dello studente:** ${it.learnerAnswer || "—"}`, "");
		if (it.correctAnswer) out.push(`**Risposta corretta:** ${it.correctAnswer}`, "");
		if (it.learnerNote) out.push(`**Nota dello studente:** ${it.learnerNote}`, "");
		out.push(`**Evidenza:** ${it.evidenceLabel} · valutata da: ${it.gradedBy}`);
		if (it.misconceptions.length) out.push(`**Misconcezioni:** ${it.misconceptions.join("; ")}`);
		if (it.note) out.push(`**Nota del tutor:** ${it.note}`);
		out.push("");
	});
	if (a.misconceptions.length) out.push("## Misconcezioni", ...[...new Set(a.misconceptions)].map((m) => `- ${m}`), "");
	if (a.tutorNotes) out.push("## Note del tutor", a.tutorNotes, "");
	if (a.warnings.length) out.push("## Avvisi", ...a.warnings.map((w) => `- ${w}`), "");
	return out.join("\n");
}
