/**
 * Controlled writing for notes outside the learning-state files.
 *
 *  1. createProposal(): exact-match edits (each oldText must occur exactly once)
 *     or a new-note creation, policy-checked, with a unified diff and
 *     preservation warnings (frontmatter, wikilinks, LaTeX). Nothing is written.
 *  2. applyProposal(): re-reads the file; if its hash differs from the hash the
 *     diff was generated against, the proposal is rejected as stale. Only the
 *     edits the user approved are applied (re-applied on the original base).
 *     The original is backed up outside the vault first; the write is atomic.
 *  3. rollback(): restores a backup if the file still has the content we wrote.
 *
 * Approval itself is obtained by the caller (the extension shows the diff in a
 * dialog). This module never decides that something is approved.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { unifiedDiff } from "./diff.ts";
import { sanitizeFileName, writeFileAtomic } from "./fsutil.ts";
import { mathSpans, parseFrontmatter, parseLinks } from "./markdown.ts";
import { canPropose, decide } from "./policy.ts";
import { resolveInVault } from "./paths.ts";
import { sha256, type Vault } from "./vault.ts";

export class EditError extends Error {}
export class StaleError extends EditError {}

export interface EditInput {
	oldText: string;
	newText: string;
}

export interface Proposal {
	id: string;
	path: string;
	create: boolean;
	/** sha256 of the file bytes when the proposal was made ("absent" for creations). */
	baseHash: string;
	baseContent: string;
	edits: Array<EditInput & { index: number }>;
	newContent: string;
	diff: string;
	rationale: string;
	warnings: string[];
	createdAt: string;
	status: "pending" | "applied" | "rejected" | "stale";
}

export interface BackupRecord {
	id: string;
	proposalId: string;
	path: string;
	created: boolean;
	beforeHash: string;
	afterHash: string;
	appliedEdits: number[];
	rationale: string;
	appliedAt: string;
	vaultRoot: string;
}

function newId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function occurrences(hay: string, needle: string): number[] {
	const out: number[] = [];
	let i = hay.indexOf(needle);
	while (i !== -1) {
		out.push(i);
		i = hay.indexOf(needle, i + 1);
	}
	return out;
}

/** Apply a subset of edits (by original edit order) to base content. */
export function applyEdits(base: string, edits: Array<EditInput & { index: number }>): string {
	let out = "";
	let cursor = 0;
	for (const e of [...edits].sort((a, b) => a.index - b.index)) {
		out += base.slice(cursor, e.index) + e.newText;
		cursor = e.index + e.oldText.length;
	}
	return out + base.slice(cursor);
}

/** Warnings about things that should normally be preserved. */
export function preservationWarnings(before: string, after: string): string[] {
	const w: string[] = [];
	const fb = parseFrontmatter(before).raw;
	const fa = parseFrontmatter(after).raw;
	if (fb !== fa) w.push(fb ? "YAML frontmatter is modified" : "YAML frontmatter is added");
	const linksBefore = new Set(parseLinks(before).map((l) => l.raw));
	const linksAfter = new Set(parseLinks(after).map((l) => l.raw));
	const removed = [...linksBefore].filter((l) => !linksAfter.has(l));
	if (removed.length) w.push(`links removed: ${removed.join(", ")}`);
	const mathBefore = mathSpans(before);
	const mathAfter = new Set(mathSpans(after));
	const mathRemoved = mathBefore.filter((m) => !mathAfter.has(m));
	if (mathRemoved.length) w.push(`LaTeX changed/removed: ${mathRemoved.slice(0, 5).join(" , ")}`);
	return w;
}

export function createProposal(
	vault: Vault,
	input: { path: string; edits?: EditInput[]; create?: boolean; content?: string; rationale: string },
): Proposal {
	if (!input.rationale?.trim()) throw new EditError("A rationale is required (why this change is correct and useful).");
	let r;
	try {
		r = resolveInVault(vault.root, input.path, vault.rootRaw);
	} catch (e) {
		throw new EditError((e as Error).message);
	}
	let rel = r.rel;
	if (!rel.toLowerCase().endsWith(".md")) {
		if (input.create) throw new EditError("New notes must have a .md extension.");
		if (!r.exists && fs.existsSync(`${r.abs}.md`)) rel += ".md";
		else if (!r.exists) throw new EditError(`Note not found: ${rel}`);
	}
	const policy = decide(vault.cfg, rel, vault.grants);
	if (!canPropose(policy)) throw new EditError(`Edits are not allowed here (${policy.access}: ${policy.reason}).`);
	const abs = vault.absPath(rel);

	if (input.create) {
		if (fs.existsSync(abs)) throw new EditError(`Refusing to create: ${rel} already exists. Propose edits to it instead.`);
		const name = path.posix.basename(rel, ".md");
		if (sanitizeFileName(name, 200) !== name) throw new EditError(`File name contains characters Obsidian links cannot handle: ${name}`);
		const dup = vault.byName.get(name.toLowerCase());
		if (dup?.length) throw new EditError(`A note named "${name}" already exists (${dup.join(", ")}); creating another would make links ambiguous.`);
		const content = input.content ?? "";
		if (!content.trim()) throw new EditError("content is required when create=true");
		const warnings: string[] = [];
		if (!parseFrontmatter(content).raw) warnings.push("new note has no YAML frontmatter (templates in 5 - Template use date/tags/sources)");
		return {
			id: newId("prop"),
			path: rel,
			create: true,
			baseHash: "absent",
			baseContent: "",
			edits: [{ oldText: "", newText: content, index: 0 }],
			newContent: content,
			diff: unifiedDiff("", content, "/dev/null", `b/${rel}`),
			rationale: input.rationale.trim(),
			warnings,
			createdAt: new Date().toISOString(),
			status: "pending",
		};
	}

	if (!fs.existsSync(abs)) throw new EditError(`Note not found: ${rel}`);
	const buf = fs.readFileSync(abs);
	const base = buf.toString("utf8");
	const edits = input.edits ?? [];
	if (edits.length === 0) throw new EditError("edits must contain at least one {oldText, newText}");
	const located = edits.map((e, i) => {
		if (!e.oldText) throw new EditError(`edit ${i + 1}: oldText must be non-empty (copy it exactly from vault_read)`);
		if (e.oldText === e.newText) throw new EditError(`edit ${i + 1}: oldText and newText are identical`);
		const occ = occurrences(base, e.oldText);
		if (occ.length === 0) throw new EditError(`edit ${i + 1}: oldText not found — copy it exactly from the current note`);
		if (occ.length > 1) throw new EditError(`edit ${i + 1}: oldText occurs ${occ.length} times — include more surrounding text`);
		return { ...e, index: occ[0] };
	});
	const sorted = [...located].sort((a, b) => a.index - b.index);
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i].index < sorted[i - 1].index + sorted[i - 1].oldText.length) throw new EditError("edits overlap; merge them into one edit");
	}
	const newContent = applyEdits(base, located);
	return {
		id: newId("prop"),
		path: rel,
		create: false,
		baseHash: sha256(buf),
		baseContent: base,
		edits: located,
		newContent,
		diff: unifiedDiff(base, newContent, `a/${rel}`, `b/${rel}`),
		rationale: input.rationale.trim(),
		warnings: preservationWarnings(base, newContent),
		createdAt: new Date().toISOString(),
		status: "pending",
	};
}

/** Content resulting from applying only the selected edits (by position in proposal.edits). */
export function contentForSelection(p: Proposal, selected: number[]): string {
	if (p.create) return p.newContent;
	return applyEdits(
		p.baseContent,
		p.edits.filter((_, i) => selected.includes(i)),
	);
}

/** Throws StaleError if the file changed since the proposal was generated. */
export function assertFresh(vault: Vault, p: Proposal): void {
	const abs = vault.absPath(p.path);
	if (p.create) {
		if (fs.existsSync(abs)) throw new StaleError(`${p.path} was created by someone else after the proposal; regenerate it.`);
		return;
	}
	if (!fs.existsSync(abs)) throw new StaleError(`${p.path} no longer exists.`);
	const now = sha256(fs.readFileSync(abs));
	if (now !== p.baseHash) throw new StaleError(`${p.path} changed after the diff was generated; the proposal is stale. Re-read the note and propose again.`);
}

export function applyProposal(vault: Vault, p: Proposal, selected: number[]): BackupRecord {
	if (p.status !== "pending") throw new EditError(`Proposal ${p.id} is ${p.status}.`);
	if (selected.length === 0) throw new EditError("No edits selected.");
	if (selected.some((i) => !Number.isInteger(i) || i < 0 || i >= p.edits.length)) throw new EditError("Invalid edit selection.");
	// Re-check policy and containment at apply time (config/grants may have changed).
	const r = resolveInVault(vault.root, p.path, vault.rootRaw);
	if (r.rel !== p.path) throw new EditError("Path now resolves elsewhere (symlink changed); refusing.");
	if (!canPropose(decide(vault.cfg, p.path, vault.grants))) throw new EditError("Edits are no longer allowed for this path.");
	try {
		assertFresh(vault, p);
	} catch (e) {
		p.status = "stale";
		throw e;
	}
	const content = contentForSelection(p, selected);
	const id = newId("bk");
	const dir = path.join(vault.cfg.backupDir, id);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const record: BackupRecord = {
		id,
		proposalId: p.id,
		path: p.path,
		created: p.create,
		beforeHash: p.baseHash,
		afterHash: sha256(Buffer.from(content, "utf8")),
		appliedEdits: [...selected].sort((a, b) => a - b),
		rationale: p.rationale,
		appliedAt: new Date().toISOString(),
		vaultRoot: vault.root,
	};
	if (!p.create) fs.writeFileSync(path.join(dir, "before.md"), p.baseContent, { mode: 0o600 });
	fs.writeFileSync(path.join(dir, "after.md"), content, { mode: 0o600 });
	fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(record, null, 2), { mode: 0o600 });
	writeFileAtomic(vault.absPath(p.path), content);
	const written = sha256(fs.readFileSync(vault.absPath(p.path)));
	if (written !== record.afterHash) throw new EditError("Post-write verification failed; restore from backup " + id);
	p.status = "applied";
	vault.refresh(true);
	return record;
}

export function listBackups(backupDir: string, vaultRoot?: string): BackupRecord[] {
	if (!fs.existsSync(backupDir)) return [];
	const out: BackupRecord[] = [];
	for (const d of fs.readdirSync(backupDir)) {
		const mf = path.join(backupDir, d, "manifest.json");
		if (!fs.existsSync(mf)) continue;
		try {
			const r = JSON.parse(fs.readFileSync(mf, "utf8")) as BackupRecord & { rolledBackAt?: string };
			if (vaultRoot && r.vaultRoot !== vaultRoot) continue;
			out.push(r);
		} catch {
			/* skip corrupt manifest */
		}
	}
	return out.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
}

export function rollback(vault: Vault, backupId: string, opts: { force?: boolean } = {}): BackupRecord {
	if (!/^bk-[a-z0-9-]+$/.test(backupId)) throw new EditError("Invalid backup id");
	const dir = path.join(vault.cfg.backupDir, backupId);
	const mf = path.join(dir, "manifest.json");
	if (!fs.existsSync(mf)) throw new EditError(`Backup not found: ${backupId}`);
	const rec = JSON.parse(fs.readFileSync(mf, "utf8")) as BackupRecord & { rolledBackAt?: string };
	if (rec.vaultRoot !== vault.root) throw new EditError("Backup belongs to a different vault.");
	if (rec.rolledBackAt) throw new EditError(`Backup ${backupId} was already rolled back at ${rec.rolledBackAt}`);
	const r = resolveInVault(vault.root, rec.path, vault.rootRaw);
	if (r.rel !== rec.path || !canPropose(decide(vault.cfg, r.rel, vault.grants))) {
		throw new EditError("Rollback path changed or edits are no longer allowed here.");
	}
	const abs = r.abs;
	const current = fs.existsSync(abs) ? sha256(fs.readFileSync(abs)) : "absent";
	if (current !== rec.afterHash && !opts.force) {
		throw new StaleError(`${rec.path} changed after the edit was applied; rollback would discard newer changes. Use force to override.`);
	}
	if (current !== "absent" && current !== rec.afterHash) {
		// Keep the newer content too before overwriting.
		fs.writeFileSync(path.join(dir, `overwritten-${Date.now()}.md`), fs.readFileSync(abs), { mode: 0o600 });
	}
	if (rec.created) {
		if (fs.existsSync(abs)) fs.unlinkSync(abs);
	} else {
		writeFileAtomic(abs, fs.readFileSync(path.join(dir, "before.md")));
	}
	(rec as any).rolledBackAt = new Date().toISOString();
	fs.writeFileSync(mf, JSON.stringify(rec, null, 2), { mode: 0o600 });
	vault.refresh(true);
	return rec;
}
