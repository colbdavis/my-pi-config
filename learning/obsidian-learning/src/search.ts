/**
 * Deterministic lexical search over readable notes.
 *
 * Fields: file name, frontmatter aliases, headings, tags, body. Matching is
 * accent- and case-insensitive (Italian "proprietà" == "proprieta").
 *
 * Scoring (documented and tested; no hidden embedding model):
 *   exact name match +100 · name contains phrase +40 · name token +15 each
 *   alias exact +60 · alias token +12 · heading phrase +20 · heading token +6 (cap 3/token)
 *   tag token +10 · body phrase +4/occurrence (cap 5) · body token +log2(1+tf)*2
 *   all query tokens present +10
 *   linked from a matching index note +25 · linked from any index +3
 *   × folder weight (atomic 1.2, index 1.15, learning 0.9, rough 0.8, templates 0.3)
 *
 * Only bounded excerpts are returned — never whole notes.
 */

import { norm } from "./markdown.ts";
import { resolveLink } from "./links.ts";
import type { NoteEntry, NoteKind, Vault } from "./vault.ts";

const STOPWORDS = new Set(
	(
		"a ad al alla alle allo ai agli e ed i il la le lo gli un una uno di da dei del della delle dello degli in nel nella " +
		"nelle nei con per su sul sulla tra fra che chi come cosa non o se si mi ti ci vi mio mia tuo tua è e' sono " +
		"the of and or to in on for with is are be an as at by it this that from"
	).split(/\s+/),
);

export function tokenize(q: string): string[] {
	return norm(q)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export interface SearchOptions {
	limit?: number;
	kinds?: NoteKind[];
	folder?: string;
}

export interface Excerpt {
	line: number;
	text: string;
}

export interface SearchHit {
	path: string;
	name: string;
	kind: NoteKind;
	sourceType?: string;
	aiGenerated: boolean;
	tags: string[];
	score: number;
	matched: string[];
	linkedFromIndex: string[];
	excerpts: Excerpt[];
}

function countOccurrences(hay: string, needle: string, cap: number): number {
	if (!needle) return 0;
	let n = 0;
	let i = hay.indexOf(needle);
	while (i !== -1 && n < cap) {
		n++;
		i = hay.indexOf(needle, i + needle.length);
	}
	return n;
}

function clip(line: string, tokens: string[], max: number): string {
	const t = line.trim();
	if (t.length <= max) return t;
	const n = norm(t);
	let pos = -1;
	for (const tok of tokens) {
		pos = n.indexOf(tok);
		if (pos !== -1) break;
	}
	const start = Math.max(0, Math.min(pos === -1 ? 0 : pos - Math.floor(max / 3), t.length - max));
	return `${start > 0 ? "…" : ""}${t.slice(start, start + max)}${start + max < t.length ? "…" : ""}`;
}

export function excerptsFor(note: NoteEntry, tokens: string[], max: number, count = 3): Excerpt[] {
	const text = note.parsed!.text;
	const fmRaw = note.parsed!.frontmatter.raw;
	const bodyStart = fmRaw ? fmRaw.split("\n").length - 1 : 0;
	const lines = text.split("\n");
	const scored: Array<{ line: number; score: number; text: string }> = [];
	for (let i = bodyStart; i < lines.length; i++) {
		const nl = norm(lines[i]);
		if (!nl.trim()) continue;
		let s = 0;
		for (const t of tokens) if (nl.includes(t)) s += 1;
		if (s > 0) scored.push({ line: i + 1, score: s + (lines[i].startsWith("#") ? 0.5 : 0), text: lines[i] });
	}
	scored.sort((a, b) => b.score - a.score || a.line - b.line);
	return scored
		.slice(0, count)
		.sort((a, b) => a.line - b.line)
		.map((s) => ({ line: s.line, text: clip(s.text, tokens, max) }));
}

/** Map: note path → names of index notes linking to it. */
export function indexLinkMap(vault: Vault): Map<string, Array<{ index: NoteEntry }>> {
	const map = new Map<string, Array<{ index: NoteEntry }>>();
	for (const n of vault.readableNotes()) {
		if (n.kind !== "index") continue;
		for (const l of n.parsed!.links) {
			const r = resolveLink(vault, n.path, l);
			if (!r.path || (r.status !== "resolved" && r.status !== "ambiguous")) continue;
			const arr = map.get(r.path) ?? [];
			if (!arr.some((x) => x.index.path === n.path)) arr.push({ index: n });
			map.set(r.path, arr);
		}
	}
	return map;
}

export function search(vault: Vault, query: string, opts: SearchOptions = {}): SearchHit[] {
	const tokens = tokenize(query);
	const phrase = norm(query).trim();
	if (tokens.length === 0) return [];
	const limit = Math.min(opts.limit ?? 8, vault.cfg.limits.maxResults);
	const notes = vault.readableNotes().filter((n) => {
		if (opts.kinds?.length && !opts.kinds.includes(n.kind)) return false;
		if (opts.folder && !(n.path === opts.folder || n.path.startsWith(opts.folder.replace(/\/+$/, "") + "/"))) return false;
		return true;
	});
	const idxMap = indexLinkMap(vault);

	// Index notes whose title/headings match the query: their links get a boost.
	const matchingIndexes = new Set(
		vault
			.readableNotes()
			.filter((n) => n.kind === "index")
			.filter((n) => {
				const name = norm(n.name);
				return tokens.some((t) => name.includes(t)) || n.parsed!.headings.some((h) => tokens.some((t) => norm(h.text).includes(t)));
			})
			.map((n) => n.path),
	);

	const hits: SearchHit[] = [];
	for (const note of notes) {
		const p = note.parsed!;
		const matched = new Set<string>();
		let score = 0;
		const name = norm(note.name);
		const present = new Set<string>();

		if (name === phrase) {
			score += 100;
			matched.add("name:exact");
		} else if (phrase.length > 2 && name.includes(phrase)) {
			score += 40;
			matched.add("name:phrase");
		}
		for (const t of tokens) {
			if (name.includes(t)) {
				score += 15;
				present.add(t);
				matched.add("name");
			}
		}
		for (const a of p.aliases.map(norm)) {
			if (a === phrase) {
				score += 60;
				matched.add("alias:exact");
			}
			for (const t of tokens)
				if (a.includes(t)) {
					score += 12;
					present.add(t);
					matched.add("alias");
				}
		}
		for (const h of p.headings) {
			const hn = norm(h.text);
			if (phrase.length > 2 && hn.includes(phrase)) {
				score += 20;
				matched.add("heading:phrase");
			}
		}
		for (const t of tokens) {
			const hc = p.headings.filter((h) => norm(h.text).includes(t)).length;
			if (hc) {
				score += 6 * Math.min(hc, 3);
				present.add(t);
				matched.add("heading");
			}
		}
		const tagNorm = p.tags.map(norm);
		for (const t of tokens) {
			if (tagNorm.some((tag) => tag.split(/[\/_-]/).includes(t) || tag === t)) {
				score += 10;
				present.add(t);
				matched.add("tag");
			}
		}
		const body = norm(p.text.slice(p.frontmatter.bodyOffset));
		if (phrase.length > 2 && tokens.length > 1) {
			const c = countOccurrences(body, phrase, 5);
			if (c) {
				score += 4 * c;
				matched.add("body:phrase");
			}
		}
		for (const t of tokens) {
			const tf = countOccurrences(body, t, 50);
			if (tf) {
				score += Math.log2(1 + tf) * 2;
				present.add(t);
				matched.add("body");
			}
		}
		if (score === 0) continue;
		if (tokens.every((t) => present.has(t))) score += 10;

		const linkedFrom = idxMap.get(note.path) ?? [];
		if (linkedFrom.some((x) => matchingIndexes.has(x.index.path))) {
			score += 25;
			matched.add("index-linked");
		} else if (linkedFrom.length) score += 3;

		score *= note.policy.weight || 1;
		hits.push({
			path: note.path,
			name: note.name,
			kind: note.kind,
			sourceType: note.sourceType,
			aiGenerated: note.aiGenerated,
			tags: p.tags,
			score: Math.round(score * 10) / 10,
			matched: [...matched],
			linkedFromIndex: linkedFrom.map((x) => x.index.name),
			excerpts: [],
		});
	}
	hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	const top = hits.slice(0, limit);
	for (const h of top) h.excerpts = excerptsFor(vault.notes.get(h.path)!, tokens, vault.cfg.limits.excerptChars);
	return top;
}
