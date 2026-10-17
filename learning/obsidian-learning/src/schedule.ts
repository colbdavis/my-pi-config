/**
 * Assessment model and spaced-repetition schedule. Pure functions: every rule
 * is listed here, documented in the README, and covered by tests.
 *
 * Evidence levels (what the item *demanded* of the learner):
 *   recognition   — pick/recognize the right statement
 *   understanding — explain why, predict, discriminate between close ideas
 *   application   — solve a problem / produce a result independently
 * A multiple-choice quiz item can be at most "understanding" (choosing an
 * option is not independent application).
 *
 * Grading an assessment (≥1 verified item required):
 *   fail    — any incorrect/"don't know" item at understanding/application level,
 *             or at least half of the items incorrect/"don't know"
 *   pass    — no incorrect/partial items, ≥1 item correct at understanding or
 *             application level with 0 hints, and no item needing a level-3+ hint
 *   partial — everything else (e.g. recognition only, hints needed, partial answers)
 *
 * Contexts:
 *   in-lesson   — checked right after being taught in the same session
 *   review      — delayed retrieval (scheduled review)
 *   independent — learner-initiated problem solving without prior teaching in the session
 *
 * Status transitions:
 *   fail:    practicing/demonstrated/needs_review → needs_review; otherwise → learning
 *   partial: demonstrated → needs_review; otherwise → practicing
 *   pass:    in-lesson → practicing (an existing "demonstrated" is kept);
 *            review/independent → demonstrated
 *
 * Schedule (intervals I = [3, 10, 30] days by default; stage = number of
 * successful delayed retrievals since the last failure, capped at I.length):
 *   first evidence for a concept (status unassessed): stage 0, next = date + I[0]
 *     (fail on first evidence: next = date + relearnDays)
 *   fail:              stage 0, next = date + relearnDays (default 1)
 *   partial:           stage unchanged, step back one interval:
 *                      next = date + I[max(min(stage, I.length-1) - 1, 0)]  (3, 3, 10, 10 days for stages 0..3)
 *   pass, in-lesson:   stage unchanged; next kept if already scheduled, else date + I[0]
 *   pass, delayed:     stage = min(stage+1, I.length), next = date + I[min(stage, I.length-1)]
 * So a concept is reviewed after 3, then 10, then 30 days; after the third
 * successful review it keeps a 30-day maintenance interval. A schedule is a
 * reminder to retrieve, not a guarantee of retention.
 */

import { addDays } from "./dates.ts";

export const STATUSES = ["unassessed", "learning", "practicing", "demonstrated", "needs_review"] as const;
export type Status = (typeof STATUSES)[number];
export const LEVELS = ["recognition", "understanding", "application"] as const;
export type Level = (typeof LEVELS)[number];
export const ITEM_OUTCOMES = ["correct", "partial", "incorrect", "dont_know"] as const;
export type ItemOutcome = (typeof ITEM_OUTCOMES)[number];
export const CONTEXTS = ["in-lesson", "review", "independent"] as const;
export type AssessmentContext = (typeof CONTEXTS)[number];
export type Outcome = "pass" | "partial" | "fail";

export interface GradedItem {
	level: Level;
	outcome: ItemOutcome;
	/** Highest hint level given before the answer (0 = none). Ladder: 1 nudge, 2 strategy, 3 key step, 4 worked solution. */
	hints: number;
}

export interface ScheduleConfig {
	intervals: number[];
	relearnDays: number;
}

export function gradeAssessment(items: GradedItem[]): { outcome: Outcome; reason: string } {
	if (items.length === 0) throw new Error("An assessment needs at least one verified learner response.");
	const wrong = items.filter((i) => i.outcome === "incorrect" || i.outcome === "dont_know");
	const deepWrong = wrong.filter((i) => i.level !== "recognition");
	if (deepWrong.length > 0) return { outcome: "fail", reason: "incorrect or unknown answer at understanding/application level" };
	if (wrong.length * 2 >= items.length) return { outcome: "fail", reason: "at least half of the answers were incorrect or unknown" };
	const partialItems = items.filter((i) => i.outcome === "partial");
	const strong = items.filter((i) => i.outcome === "correct" && i.hints === 0 && i.level !== "recognition");
	const heavyHints = items.filter((i) => i.hints >= 3);
	if (wrong.length === 0 && partialItems.length === 0 && strong.length > 0 && heavyHints.length === 0) {
		return { outcome: "pass", reason: "all answers correct, with independent understanding/application evidence" };
	}
	const why: string[] = [];
	if (wrong.length) why.push("some recognition-level answers were wrong");
	if (partialItems.length) why.push("some answers were only partially correct");
	if (!strong.length) why.push("no independent (hint-free) understanding/application evidence");
	if (heavyHints.length) why.push("key-step or solution hints were needed");
	return { outcome: "partial", reason: why.join("; ") };
}

export interface ConceptState {
	status: Status;
	stage: number;
	nextReview: string | null;
}

export interface Transition extends ConceptState {
	rule: string;
}

export function nextState(
	prev: ConceptState,
	outcome: Outcome,
	context: AssessmentContext,
	date: string,
	cfg: ScheduleConfig,
): Transition {
	const I = cfg.intervals;
	const maxStage = I.length;
	const stage = Math.max(0, Math.min(prev.stage, maxStage));
	const first = prev.status === "unassessed";
	const delayed = context !== "in-lesson";

	let status: Status;
	if (outcome === "fail") {
		status = ["practicing", "demonstrated", "needs_review"].includes(prev.status) ? "needs_review" : "learning";
	} else if (outcome === "partial") {
		status = prev.status === "demonstrated" ? "needs_review" : "practicing";
	} else {
		status = delayed ? "demonstrated" : prev.status === "demonstrated" ? "demonstrated" : "practicing";
	}

	if (outcome === "fail") {
		return { status, stage: 0, nextReview: addDays(date, cfg.relearnDays), rule: `fail → relearn in ${cfg.relearnDays} day(s), stage reset to 0` };
	}
	if (first) {
		return { status, stage: 0, nextReview: addDays(date, I[0]), rule: `first evidence → first review in ${I[0]} days` };
	}
	if (outcome === "partial") {
		const d = I[Math.max(Math.min(stage, maxStage - 1) - 1, 0)];
		return { status, stage, nextReview: addDays(date, d), rule: `partial → repeat in ${d} days, stage stays ${stage}` };
	}
	if (!delayed) {
		if (prev.nextReview) return { status, stage, nextReview: prev.nextReview, rule: "in-lesson pass → existing schedule kept" };
		return { status, stage, nextReview: addDays(date, I[0]), rule: `in-lesson pass → first review in ${I[0]} days` };
	}
	const newStage = Math.min(stage + 1, maxStage);
	const d = I[Math.min(newStage, maxStage - 1)];
	return { status, stage: newStage, nextReview: addDays(date, d), rule: `delayed pass → stage ${newStage}, next review in ${d} days` };
}

export function isStatus(s: string): s is Status {
	return (STATUSES as readonly string[]).includes(s);
}
