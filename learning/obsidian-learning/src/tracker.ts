/**
 * Mastery Tracker: a Markdown table in "8 - Learning System/Mastery Tracker.md".
 * It is the single source of truth for concept status and schedule, and it is
 * meant to be read and corrected by hand in Obsidian.
 *
 *  - Columns are matched by header name (case-insensitive), so the user may
 *    reorder columns or add extra ones; extra columns are preserved.
 *  - Text before/after the table is preserved verbatim.
 *  - Invalid cells never crash parsing; they produce warnings shown to the user.
 *
 * "Review Queue.md" is a generated view of this table (never edited by hand).
 */

import { addDays, diffDays, isIsoDate } from "./dates.ts";
import { isStatus, type Status } from "./schedule.ts";

export const TRACKER_COLUMNS = ["Concept", "Notes", "Status", "Stage", "Last assessed", "Next review", "Misconceptions", "Sessions"] as const;

export interface Misconception {
	label: string;
	count: number;
}

export interface TrackerRow {
	concept: string;
	notes: string[];
	status: Status;
	stage: number;
	lastAssessed: string | null;
	nextReview: string | null;
	misconceptions: Misconception[];
	sessions: string[];
	/** Unknown columns, preserved verbatim by header. */
	extra: Record<string, string>;
}

export interface TrackerDoc {
	before: string[];
	after: string[];
	headers: string[];
	rows: TrackerRow[];
	warnings: string[];
}

export function slugify(s: string): string {
	return s
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

export function splitRow(line: string): string[] {
	let t = line.trim();
	if (t.startsWith("|")) t = t.slice(1);
	if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
	const cells: string[] = [];
	let cur = "";
	let inLink = 0;
	for (let i = 0; i < t.length; i++) {
		const c = t[i];
		if (c === "\\" && t[i + 1] === "|") {
			cur += "\\|";
			i++;
			continue;
		}
		if (c === "[" && t[i + 1] === "[") inLink++;
		if (c === "]" && t[i + 1] === "]" && inLink > 0) inLink--;
		if (c === "|" && inLink === 0) {
			cells.push(cur.trim());
			cur = "";
			continue;
		}
		cur += c;
	}
	cells.push(cur.trim());
	return cells;
}

function escapeCell(s: string): string {
	return s.replace(/\r?\n/g, " ").replace(/(?<!\\)\|/g, "\\|");
}

export function wikiTargets(cell: string): string[] {
	const out: string[] = [];
	for (const m of cell.matchAll(/\[\[([^\]]+?)\]\]/g)) {
		out.push(m[1].replace(/\\\|.*$/, "").replace(/\|.*$/, "").trim());
	}
	return out;
}

export function parseMisconceptions(cell: string): Misconception[] {
	return cell
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s && s !== "—" && s !== "-")
		.map((s) => {
			const m = /^(.*?)\s*\((?:×|x)\s*(\d+)\)\s*$/i.exec(s);
			return m ? { label: m[1].trim(), count: Number(m[2]) } : { label: s, count: 1 };
		});
}

function formatMisconceptions(ms: Misconception[]): string {
	return ms.map((m) => (m.count > 1 ? `${m.label} (×${m.count})` : m.label)).join("; ");
}

const isSeparator = (l: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);

export function parseTracker(md: string): TrackerDoc {
	const lines = md.split("\n");
	const warnings: string[] = [];
	let start = -1;
	for (let i = 0; i < lines.length - 1; i++) {
		if (!lines[i].trim().startsWith("|")) continue;
		const headers = splitRow(lines[i]).map((h) => h.toLowerCase());
		if (headers.includes("concept") && headers.includes("status") && isSeparator(lines[i + 1])) {
			start = i;
			break;
		}
	}
	if (start === -1) {
		return { before: lines, after: [], headers: [...TRACKER_COLUMNS], rows: [], warnings: md.trim() ? ["No tracker table found; a new one will be appended."] : [] };
	}
	const headers = splitRow(lines[start]);
	const idx = (name: string) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
	let end = start + 2;
	while (end < lines.length && lines[end].trim().startsWith("|")) end++;
	const rows: TrackerRow[] = [];
	const seen = new Set<string>();
	for (let i = start + 2; i < end; i++) {
		const cells = splitRow(lines[i]);
		const get = (name: string) => {
			const j = idx(name);
			return j === -1 ? "" : (cells[j] ?? "").trim();
		};
		const concept = get("Concept");
		if (!concept) continue;
		const lineNo = i + 1;
		const statusRaw = get("Status").toLowerCase().replace(/\s+/g, "_");
		let status: Status = "unassessed";
		if (isStatus(statusRaw)) status = statusRaw;
		else warnings.push(`line ${lineNo}: unknown status "${get("Status")}" for ${concept} (treated as unassessed)`);
		const stageRaw = get("Stage");
		let stage = 0;
		if (stageRaw) {
			stage = Number(stageRaw);
			if (!Number.isInteger(stage) || stage < 0) {
				warnings.push(`line ${lineNo}: invalid stage "${stageRaw}" for ${concept} (treated as 0)`);
				stage = 0;
			}
		}
		const dateCell = (name: string): string | null => {
			const v = get(name);
			if (!v || v === "—" || v === "-") return null;
			if (!isIsoDate(v)) {
				warnings.push(`line ${lineNo}: "${name}" is not an ISO date (YYYY-MM-DD): "${v}" for ${concept}`);
				return null;
			}
			return v;
		};
		if (seen.has(concept)) warnings.push(`line ${lineNo}: duplicate concept "${concept}" (first row wins)`);
		seen.add(concept);
		const extra: Record<string, string> = {};
		headers.forEach((h, j) => {
			if (!TRACKER_COLUMNS.some((c) => c.toLowerCase() === h.toLowerCase())) extra[h] = cells[j] ?? "";
		});
		rows.push({
			concept,
			notes: wikiTargets(get("Notes")),
			status,
			stage,
			lastAssessed: dateCell("Last assessed"),
			nextReview: dateCell("Next review"),
			misconceptions: parseMisconceptions(get("Misconceptions")),
			sessions: wikiTargets(get("Sessions")),
			extra,
		});
	}
	return { before: lines.slice(0, start), after: lines.slice(end), headers, rows, warnings };
}

export function serializeTracker(doc: TrackerDoc): string {
	const headers = doc.headers.length ? doc.headers : [...TRACKER_COLUMNS];
	for (const c of TRACKER_COLUMNS) if (!headers.some((h) => h.toLowerCase() === c.toLowerCase())) headers.push(c);
	const cellFor = (row: TrackerRow, h: string): string => {
		switch (h.toLowerCase()) {
			case "concept":
				return row.concept;
			case "notes":
				return row.notes.map((n) => `[[${n}]]`).join(", ");
			case "status":
				return row.status;
			case "stage":
				return String(row.stage);
			case "last assessed":
				return row.lastAssessed ?? "";
			case "next review":
				return row.nextReview ?? "";
			case "misconceptions":
				return formatMisconceptions(row.misconceptions);
			case "sessions":
				return row.sessions.map((s) => `[[${s}]]`).join(", ");
			default:
				return row.extra[h] ?? "";
		}
	};
	const table = [
		`| ${headers.join(" | ")} |`,
		`| ${headers.map(() => "---").join(" | ")} |`,
		...doc.rows.map((r) => `| ${headers.map((h) => escapeCell(cellFor(r, h))).join(" | ")} |`),
	];
	const before = doc.before.length && doc.before[doc.before.length - 1].trim() !== "" ? [...doc.before, ""] : doc.before;
	return [...before, ...table, ...doc.after].join("\n").replace(/\n*$/, "\n");
}

export function emptyRow(concept: string): TrackerRow {
	return { concept, notes: [], status: "unassessed", stage: 0, lastAssessed: null, nextReview: null, misconceptions: [], sessions: [], extra: {} };
}

export function addMisconceptions(row: TrackerRow, labels: string[]): void {
	for (const raw of labels) {
		const label = raw.trim().replace(/[;|]/g, ",");
		if (!label) continue;
		const existing = row.misconceptions.find((m) => m.label.toLowerCase() === label.toLowerCase());
		if (existing) existing.count++;
		else row.misconceptions.push({ label, count: 1 });
	}
}

export interface QueueItem {
	concept: string;
	notes: string[];
	status: Status;
	stage: number;
	nextReview: string;
	daysOverdue: number;
	recurringMisconceptions: string[];
}

export interface Queue {
	today: string;
	overdue: QueueItem[];
	dueToday: QueueItem[];
	upcoming: QueueItem[];
	/** Concepts needing attention without a date (needs_review/learning with no next review). */
	unscheduled: QueueItem[];
}

export function buildQueue(rows: TrackerRow[], today: string, horizonDays = 14): Queue {
	const q: Queue = { today, overdue: [], dueToday: [], upcoming: [], unscheduled: [] };
	const horizon = addDays(today, horizonDays);
	for (const r of rows) {
		const item = (next: string): QueueItem => ({
			concept: r.concept,
			notes: r.notes,
			status: r.status,
			stage: r.stage,
			nextReview: next,
			daysOverdue: next ? Math.max(0, diffDays(next, today)) : 0,
			recurringMisconceptions: r.misconceptions.filter((m) => m.count >= 2).map((m) => m.label),
		});
		if (!r.nextReview) {
			if (r.status === "needs_review" || r.status === "learning") q.unscheduled.push(item(""));
			continue;
		}
		if (r.nextReview < today) q.overdue.push(item(r.nextReview));
		else if (r.nextReview === today) q.dueToday.push(item(r.nextReview));
		else if (r.nextReview <= horizon) q.upcoming.push(item(r.nextReview));
	}
	q.overdue.sort((a, b) => b.daysOverdue - a.daysOverdue || a.concept.localeCompare(b.concept));
	q.dueToday.sort((a, b) => a.concept.localeCompare(b.concept));
	q.upcoming.sort((a, b) => a.nextReview.localeCompare(b.nextReview) || a.concept.localeCompare(b.concept));
	return q;
}

export function renderQueueMarkdown(q: Queue, trackerName = "Mastery Tracker"): string {
	const line = (i: QueueItem, extra = "") => {
		const notes = i.notes.length ? ` — ${i.notes.map((n) => `[[${n}]]`).join(", ")}` : "";
		const mis = i.recurringMisconceptions.length ? ` · recurring: ${i.recurringMisconceptions.join("; ")}` : "";
		return `- \`${i.concept}\`${notes} · ${i.status} · stage ${i.stage}${extra}${mis}`;
	};
	const section = (title: string, items: QueueItem[], fmt: (i: QueueItem) => string) =>
		[`## ${title}`, "", ...(items.length ? items.map(fmt) : ["_Nothing._"]), ""].join("\n");
	return [
		"---",
		"type: learning-review-queue",
		"tags:",
		"  - learning-system",
		"---",
		"# Review Queue",
		"",
		`> [!info] Generated view — do not edit`,
		`> Rebuilt by obsidian-learning from [[${trackerName}]] (edit dates/status there). Today: ${q.today}.`,
		"> A review date is a reminder to retrieve, not a guarantee of retention.",
		"",
		section("Overdue", q.overdue, (i) => line(i, ` · due ${i.nextReview} (${i.daysOverdue} day${i.daysOverdue === 1 ? "" : "s"} overdue)`)),
		section(`Due today (${q.today})`, q.dueToday, (i) => line(i)),
		section("Needs attention (no date set)", q.unscheduled, (i) => line(i)),
		section("Upcoming (next 14 days)", q.upcoming, (i) => line(i, ` · ${i.nextReview}`)),
	].join("\n");
}
