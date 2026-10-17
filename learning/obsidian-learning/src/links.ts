/**
 * Obsidian-style link resolution.
 *
 *  - [[Note]], [[Note|Alias]], [[Note#Heading]], [[Note#^block]], [[#Heading]], ![[embed]]
 *  - [text](relative/path.md#heading) and [text](<path with spaces.md>)
 *  - Name-only targets resolve vault-wide by basename (case-insensitive), as in Obsidian.
 *    Several matches → status "ambiguous" with a preferred candidate (same folder, then shortest path).
 *  - Absolute filesystem paths and paths escaping the vault → "external" (never followed).
 *  - Targets in excluded/gated folders → "excluded" (path withheld).
 */

import * as path from "node:path";
import { normHeading, type ParsedLink } from "./markdown.ts";
import { canRead, decide } from "./policy.ts";
import type { NoteEntry, Vault } from "./vault.ts";

export type LinkStatus = "resolved" | "ambiguous" | "unresolved" | "external" | "attachment" | "excluded";

export interface LinkResolution {
	link: ParsedLink;
	status: LinkStatus;
	/** Chosen target path (for resolved/ambiguous/attachment). */
	path?: string;
	/** All readable candidates when ambiguous. */
	candidates?: string[];
	heading?: { requested: string; found: boolean; line?: number };
	blockId?: string;
	kind?: NoteEntry["kind"];
}

function pickPreferred(paths: string[], sourcePath: string): string {
	const srcDir = path.posix.dirname(sourcePath);
	return [...paths].sort((a, b) => {
		const sa = path.posix.dirname(a) === srcDir ? 0 : 1;
		const sb = path.posix.dirname(b) === srcDir ? 0 : 1;
		if (sa !== sb) return sa - sb;
		const da = a.split("/").length;
		const db = b.split("/").length;
		if (da !== db) return da - db;
		return a.localeCompare(b);
	})[0];
}

function stripMd(t: string): string {
	return t.toLowerCase().endsWith(".md") ? t.slice(0, -3) : t;
}

/** Candidate note paths for a link target (before policy filtering). */
function candidatesFor(vault: Vault, sourcePath: string, link: ParsedLink): { paths: string[]; external?: boolean } {
	let target = link.target.replace(/\\/g, "/").trim();
	if (target === "") return { paths: [sourcePath] };
	if (path.isAbsolute(target) || /^[a-z]:\//i.test(target)) return { paths: [], external: true };

	const all = [...vault.notes.keys()];
	const lowerMap = new Map(all.map((p) => [p.toLowerCase(), p]));
	const hasExt = /\.[a-z0-9]{1,5}$/i.test(target) && !target.toLowerCase().endsWith(".md");

	if (link.kind === "markdown" || target.includes("/")) {
		const tries: string[] = [];
		const escapes = (p: string) => p === ".." || p.startsWith("../");
		if (link.kind === "markdown") {
			// Markdown links are relative to the source note; a link that climbs out of the vault is external.
			const joined = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), target));
			if (escapes(joined)) return { paths: [], external: true };
			tries.push(joined);
		}
		const fromRoot = path.posix.normalize(target.replace(/^\/+/, ""));
		if (!escapes(fromRoot)) tries.push(fromRoot);
		if (tries.length === 0) return { paths: [], external: true };
		for (const t of tries) {
			if (hasExt) continue;
			const p = lowerMap.get(`${stripMd(t)}.md`.toLowerCase());
			if (p) return { paths: [p] };
		}
		if (!hasExt) {
			const suffix = `/${stripMd(target)}.md`.toLowerCase();
			const matches = all.filter((p) => `/${p.toLowerCase()}`.endsWith(suffix));
			if (matches.length) return { paths: matches };
		}
	}
	if (hasExt) return { paths: [] };
	const base = stripMd(target.split("/").pop() ?? target).toLowerCase();
	return { paths: vault.byName.get(base) ?? [] };
}

function attachmentFor(vault: Vault, link: ParsedLink): string | undefined {
	const name = link.target.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	if (!name) return undefined;
	return vault.attachments.get(name)?.[0];
}

export function resolveLink(vault: Vault, sourcePath: string, link: ParsedLink): LinkResolution {
	const { paths, external } = candidatesFor(vault, sourcePath, link);
	if (external) return { link, status: "external" };
	if (paths.length === 0) {
		const att = attachmentFor(vault, link);
		if (att && canRead(decide(vault.cfg, att, vault.grants))) {
			return { link, status: "attachment", path: att };
		}
		return { link, status: "unresolved" };
	}
	const readable = paths.filter((p) => {
		const n = vault.notes.get(p);
		return n && canRead(n.policy);
	});
	if (readable.length === 0) return { link, status: "excluded" };
	const chosen = readable.length === 1 ? readable[0] : pickPreferred(readable, sourcePath);
	const res: LinkResolution = {
		link,
		status: paths.length > 1 ? "ambiguous" : "resolved",
		path: chosen,
		kind: vault.notes.get(chosen)?.kind,
	};
	if (paths.length > 1) res.candidates = readable;
	if (link.heading) {
		const note = vault.notes.get(chosen);
		const want = normHeading(link.heading);
		const h = note?.parsed?.headings.find((x) => normHeading(x.text) === want);
		res.heading = { requested: link.heading, found: !!h, line: h?.line };
	}
	if (link.blockId) res.blockId = link.blockId;
	return res;
}

/** Resolve a free-form note reference typed by the model/user: "[[X#H]]", "X", or "folder/X.md". */
export function parseReference(ref: string): ParsedLink {
	const t = ref.trim();
	const wiki = /^!?\[\[([\s\S]+)\]\]$/.exec(t);
	const inner = wiki ? wiki[1] : t;
	let targetPart = inner;
	let alias: string | undefined;
	const pipe = inner.indexOf("|");
	if (pipe !== -1) {
		targetPart = inner.slice(0, pipe);
		alias = inner.slice(pipe + 1);
	}
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
	return { kind: "wiki", embed: false, raw: t, target: target.trim(), heading, blockId, alias, line: 0 };
}

/** Backlinks: readable notes whose links resolve to `targetPath`. */
export function backlinks(vault: Vault, targetPath: string): Array<{ path: string; kind: NoteEntry["kind"]; line: number; raw: string }> {
	const out: Array<{ path: string; kind: NoteEntry["kind"]; line: number; raw: string }> = [];
	const targetName = path.posix.basename(targetPath, ".md").toLowerCase();
	for (const note of vault.readableNotes()) {
		if (note.path === targetPath) continue;
		for (const l of note.parsed!.links) {
			const last = l.target.replace(/\\/g, "/").split("/").pop() ?? "";
			if (stripMd(last).toLowerCase() !== targetName) continue;
			const r = resolveLink(vault, note.path, l);
			if (r.path === targetPath) out.push({ path: note.path, kind: note.kind, line: l.line, raw: l.raw });
		}
	}
	return out;
}
