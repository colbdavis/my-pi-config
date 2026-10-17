/**
 * Minimal, dependency-free Markdown/Obsidian parsing: frontmatter (the YAML
 * subset Obsidian properties use), headings, tags, wikilinks, Markdown links,
 * and math spans. Parsing is read-only: we never re-serialize user notes, so
 * edits preserve original bytes outside the changed regions.
 */

export interface Frontmatter {
	/** Raw text including the --- fences, or "" when absent. */
	raw: string;
	data: Record<string, string | string[] | null>;
	/** Offset where the body starts. */
	bodyOffset: number;
}

export interface Heading {
	level: number;
	text: string;
	/** 1-based line number. */
	line: number;
}

export interface ParsedLink {
	kind: "wiki" | "markdown";
	embed: boolean;
	raw: string;
	/** Target note/file (without #subpath); "" for same-note links like [[#Heading]]. */
	target: string;
	heading?: string;
	blockId?: string;
	alias?: string;
	/** 1-based line number. */
	line: number;
}

function unquote(v: string): string {
	const t = v.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
	return t;
}

export function parseFrontmatter(text: string): Frontmatter {
	const m = /^---\r?\n/.exec(text);
	if (!m) return { raw: "", data: {}, bodyOffset: 0 };
	const lines = text.split(/\n/);
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		const l = lines[i].replace(/\r$/, "");
		if (l === "---" || l === "...") {
			end = i;
			break;
		}
	}
	if (end === -1) return { raw: "", data: {}, bodyOffset: 0 };
	const rawLines = lines.slice(0, end + 1);
	const raw = rawLines.join("\n") + (end + 1 < lines.length ? "\n" : "");
	const data: Record<string, string | string[] | null> = {};
	let currentKey: string | null = null;
	for (const lineRaw of lines.slice(1, end)) {
		const line = lineRaw.replace(/\r$/, "");
		const item = /^\s+-\s*(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
		if (item && currentKey) {
			const prev = data[currentKey];
			const arr = Array.isArray(prev) ? prev : prev ? [prev] : [];
			const v = unquote(item[1]);
			if (v !== "") arr.push(v);
			data[currentKey] = arr;
			continue;
		}
		const kv = /^([A-Za-z0-9_\-. ]+?)\s*:\s*(.*)$/.exec(line);
		if (kv) {
			currentKey = kv[1].trim();
			const value = kv[2].trim();
			if (value === "") data[currentKey] = null;
			else if (value.startsWith("[") && value.endsWith("]") && !value.startsWith("[[")) {
				data[currentKey] = value
					.slice(1, -1)
					.split(",")
					.map((s) => unquote(s))
					.filter(Boolean);
			} else data[currentKey] = unquote(value);
		}
	}
	return { raw, data, bodyOffset: raw.length };
}

export function asList(v: string | string[] | null | undefined): string[] {
	if (v == null) return [];
	if (Array.isArray(v)) return v;
	return v
		.split(/[,\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Replace fenced code blocks and inline code spans with spaces (same length,
 * newlines kept) so offsets/line numbers stay valid while links/tags inside
 * code are ignored.
 */
export function maskCode(text: string): string {
	const out = text.split("");
	const lines = text.split("\n");
	let offset = 0;
	let fence: string | null = null;
	for (const line of lines) {
		const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
		if (fence) {
			for (let i = 0; i < line.length; i++) out[offset + i] = " ";
			if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
		} else if (f) {
			fence = f[1];
			for (let i = 0; i < line.length; i++) out[offset + i] = " ";
		}
		offset += line.length + 1;
	}
	const masked = out.join("");
	return masked.replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1/g, (m) => m.replace(/[^\n]/g, " "));
}

export function lineAt(text: string, index: number): number {
	let n = 1;
	for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}

export function parseHeadings(text: string): Heading[] {
	const masked = maskCode(text);
	const fm = parseFrontmatter(text);
	const headings: Heading[] = [];
	const lines = masked.split("\n");
	const fmLines = fm.raw ? fm.raw.split("\n").length - 1 : 0;
	for (let i = fmLines; i < lines.length; i++) {
		const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
		if (m) headings.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
	}
	return headings;
}

export function parseTags(text: string, fm: Frontmatter): string[] {
	const tags = new Set<string>();
	for (const t of asList(fm.data.tags ?? fm.data.tag)) tags.add(t.replace(/^#/, ""));
	const body = maskCode(text.slice(fm.bodyOffset));
	const re = /(^|[\s(])#([\p{L}\p{N}_\/-]*[\p{L}_\/-][\p{L}\p{N}_\/-]*)/gu;
	for (const m of body.matchAll(re)) tags.add(m[2]);
	return [...tags];
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function parseLinks(text: string): ParsedLink[] {
	const masked = maskCode(text);
	const links: ParsedLink[] = [];
	for (const m of masked.matchAll(/(!?)\[\[([^\[\]\n]+?)\]\]/g)) {
		const inner = text.slice(m.index! + m[1].length + 2, m.index! + m[0].length - 2);
		let targetPart = inner;
		let alias: string | undefined;
		const pipe = inner.indexOf("|");
		if (pipe !== -1) {
			targetPart = inner.slice(0, pipe);
			alias = inner.slice(pipe + 1).trim() || undefined;
		}
		// Tables escape the alias pipe as "\|".
		targetPart = targetPart.replace(/\\$/, "");
		let target = targetPart;
		let heading: string | undefined;
		let blockId: string | undefined;
		const hash = targetPart.indexOf("#");
		if (hash !== -1) {
			target = targetPart.slice(0, hash);
			const sub = targetPart.slice(hash + 1);
			if (sub.startsWith("^")) blockId = sub.slice(1);
			else heading = sub.split("#").filter(Boolean).pop();
		}
		links.push({
			kind: "wiki",
			embed: m[1] === "!",
			raw: m[0],
			target: target.trim(),
			heading: heading?.trim() || undefined,
			blockId,
			alias,
			line: lineAt(text, m.index!),
		});
	}
	for (const m of masked.matchAll(/(!?)\[([^\]\n]*)\]\(([^)\n]+)\)/g)) {
		let href = text.slice(m.index! + m[0].length - m[3].length - 1, m.index! + m[0].length - 1).trim();
		if (href.startsWith("<") && href.includes(">")) href = href.slice(1, href.indexOf(">"));
		else href = href.split(/\s+"/)[0];
		if (SCHEME.test(href) && !/^[a-z]:[\\/]/i.test(href)) continue; // http:, mailto:, obsidian: ...
		let decoded = href;
		try {
			decoded = decodeURI(href);
		} catch {
			/* keep raw */
		}
		let target = decoded;
		let heading: string | undefined;
		let blockId: string | undefined;
		const hash = decoded.indexOf("#");
		if (hash !== -1) {
			target = decoded.slice(0, hash);
			const sub = decoded.slice(hash + 1);
			if (sub.startsWith("^")) blockId = sub.slice(1);
			else heading = sub;
		}
		links.push({
			kind: "markdown",
			embed: m[1] === "!",
			raw: m[0],
			target: target.trim(),
			heading,
			blockId,
			alias: m[2] || undefined,
			line: lineAt(text, m.index!),
		});
	}
	return links.sort((a, b) => a.line - b.line);
}

/** Math spans ($...$ and $$...$$) outside code — used to verify LaTeX preservation. */
export function mathSpans(text: string): string[] {
	const masked = maskCode(text);
	const spans: string[] = [];
	const re = /\$\$[\s\S]+?\$\$|(?<![\\$])\$(?!\s)[^$\n]+?(?<!\s)\$(?!\$)/g;
	for (const m of masked.matchAll(re)) spans.push(text.slice(m.index!, m.index! + m[0].length));
	return spans;
}

/** Accent/case-insensitive normalization used by search and heading matching. */
export function norm(s: string): string {
	return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function normHeading(s: string): string {
	return norm(s)
		.replace(/[*_`~=[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Extract the section under a heading (up to the next heading of same or higher level). */
export function sectionFor(text: string, headings: Heading[], heading: Heading): { start: number; end: number; text: string } {
	const lines = text.split("\n");
	const idx = headings.indexOf(heading);
	let endLine = lines.length;
	for (let i = idx + 1; i < headings.length; i++) {
		if (headings[i].level <= heading.level) {
			endLine = headings[i].line - 1;
			break;
		}
	}
	return { start: heading.line, end: endLine, text: lines.slice(heading.line - 1, endLine).join("\n") };
}
