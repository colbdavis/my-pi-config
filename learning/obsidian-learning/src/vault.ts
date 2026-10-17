/**
 * Vault index: a stat-based, incrementally refreshed in-memory index of the
 * vault's Markdown notes. Excluded/gated files are indexed by name only (so
 * links to them can be reported as "excluded") and never parsed or read.
 * Symlinks are never followed during the scan.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LearningConfig } from "./config.ts";
import { asList, type Frontmatter, type Heading, type ParsedLink, parseFrontmatter, parseHeadings, parseLinks, parseTags } from "./markdown.ts";
import { canRead, decide, type PolicyDecision, type SessionGrants } from "./policy.ts";
import { hasPrefix, isInside, PathError, resolveInVault, toPosix } from "./paths.ts";

export type NoteKind =
	| "index"
	| "atomic"
	| "source"
	| "rough"
	| "template"
	| "daily"
	| "excalidraw"
	| "assessment"
	| "session"
	| "transcript"
	| "learning-state"
	| "other";

export interface NoteEntry {
	path: string;
	name: string;
	kind: NoteKind;
	/** Finer source type: conversation, course, book, wiki, handwritten, video, ... */
	sourceType?: string;
	/** Tagged ai-chat: content was produced in an AI conversation (claims are unverified). */
	aiGenerated: boolean;
	policy: PolicyDecision;
	size: number;
	mtimeMs: number;
	/** Parsed content; absent for unreadable (excluded/gated) notes. */
	parsed?: {
		frontmatter: Frontmatter;
		tags: string[];
		aliases: string[];
		headings: Heading[];
		links: ParsedLink[];
		/** Full text if size <= maxIndexBytes, else the first maxIndexBytes characters. */
		text: string;
		truncated: boolean;
	};
}

export class VaultError extends Error {}

export function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

export class Vault {
	readonly cfg: LearningConfig;
	readonly rootRaw: string;
	readonly root: string;
	grants: SessionGrants;
	notes = new Map<string, NoteEntry>();
	/** lower-cased basename (without .md) → paths */
	byName = new Map<string, string[]>();
	/** lower-cased file name (with extension) of non-Markdown files → paths */
	attachments = new Map<string, string[]>();
	skippedSymlinks: string[] = [];
	private lastRefresh = 0;

	constructor(cfg: LearningConfig, grants: SessionGrants) {
		if (!cfg.vaultPath) throw new VaultError("Vault not configured: set OBSIDIAN_LEARNING_VAULT or vaultPath in the config file.");
		if (!fs.existsSync(cfg.vaultPath) || !fs.statSync(cfg.vaultPath).isDirectory()) {
			throw new VaultError(`Vault directory not found: ${cfg.vaultPath}`);
		}
		this.cfg = cfg;
		this.rootRaw = path.resolve(cfg.vaultPath);
		this.root = fs.realpathSync(this.rootRaw);
		let ancestor = path.resolve(cfg.backupDir);
		const tail: string[] = [];
		while (!fs.existsSync(ancestor)) {
			tail.unshift(path.basename(ancestor));
			ancestor = path.dirname(ancestor);
		}
		const backupRoot = path.join(fs.realpathSync(ancestor), ...tail);
		if (isInside(this.root, backupRoot)) throw new VaultError("backupDir must be outside the vault (including symlink targets).");
		this.grants = grants;
	}

	classify(rel: string, tags: string[] = []): { kind: NoteKind; sourceType?: string } {
		const f = this.cfg.folders;
		const L = this.cfg.learningDir;
		if (hasPrefix(rel, `${L}/Assessments`)) return { kind: "assessment" };
		if (hasPrefix(rel, `${L}/Sessions/Transcripts`)) return { kind: "transcript" };
		if (hasPrefix(rel, `${L}/Sessions`)) return { kind: "session" };
		if (hasPrefix(rel, L)) return { kind: "learning-state" };
		if (rel.endsWith(".excalidraw.md") || hasPrefix(rel, f.excalidraw)) return { kind: "excalidraw" };
		if (hasPrefix(rel, f.indexes) || tags.includes("index")) return { kind: "index" };
		if (hasPrefix(rel, f.atomic)) return { kind: "atomic" };
		if (hasPrefix(rel, f.templates)) return { kind: "template" };
		if (hasPrefix(rel, f.daily)) return { kind: "daily" };
		if (hasPrefix(rel, f.rough)) return { kind: "rough" };
		if (hasPrefix(rel, f.sources)) {
			const sub = rel.slice(f.sources.length + 1).split("/")[0]?.toLowerCase() ?? "";
			const map: Record<string, string> = {
				chats: "conversation",
				courses: "course",
				books: "book",
				wikis: "wiki",
				"handwritten notes": "handwritten",
				youtube: "video",
				movies: "video",
				powerpoints: "slides",
			};
			return { kind: "source", sourceType: map[sub] ?? "source" };
		}
		return { kind: "other" };
	}

	/** Re-scan the vault; only changed files are re-parsed. Throttled unless force=true. */
	refresh(force = false): void {
		const now = Date.now();
		if (!force && now - this.lastRefresh < 1500 && this.notes.size > 0) return;
		this.lastRefresh = now;
		const seen = new Set<string>();
		const byName = new Map<string, string[]>();
		const attachments = new Map<string, string[]>();
		this.skippedSymlinks = [];

		const walk = (dirAbs: string, dirRel: string) => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dirAbs, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				if (e.name.startsWith(".")) continue; // .obsidian, .trash, .smart-env, .git, .stfolder, ...
				const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
				const abs = path.join(dirAbs, e.name);
				if (e.isSymbolicLink()) {
					this.skippedSymlinks.push(rel);
					continue;
				}
				if (e.isDirectory()) {
					walk(abs, rel);
					continue;
				}
				if (!e.isFile()) continue;
				if (!e.name.toLowerCase().endsWith(".md")) {
					const key = e.name.toLowerCase();
					attachments.set(key, [...(attachments.get(key) ?? []), rel]);
					continue;
				}
				seen.add(rel);
				const base = e.name.slice(0, -3).toLowerCase();
				byName.set(base, [...(byName.get(base) ?? []), rel]);
				let st: fs.Stats;
				try {
					st = fs.statSync(abs);
				} catch {
					continue;
				}
				const policy = decide(this.cfg, rel, this.grants);
				const prev = this.notes.get(rel);
				if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && prev.policy.access === policy.access) {
					prev.policy = policy;
					continue;
				}
				this.notes.set(rel, this.buildEntry(rel, abs, st, policy));
			}
		};
		walk(this.root, "");
		for (const key of [...this.notes.keys()]) if (!seen.has(key)) this.notes.delete(key);
		this.byName = byName;
		this.attachments = attachments;
	}

	private buildEntry(rel: string, abs: string, st: fs.Stats, policy: PolicyDecision): NoteEntry {
		const name = path.posix.basename(rel, ".md");
		const entry: NoteEntry = {
			path: rel,
			name,
			kind: this.classify(rel).kind,
			aiGenerated: false,
			policy,
			size: st.size,
			mtimeMs: st.mtimeMs,
		};
		if (!canRead(policy)) return entry;
		let text: string;
		let truncated = false;
		try {
			if (st.size > this.cfg.limits.maxIndexBytes) {
				const fd = fs.openSync(abs, "r");
				const buf = Buffer.alloc(this.cfg.limits.maxIndexBytes);
				fs.readSync(fd, buf, 0, buf.length, 0);
				fs.closeSync(fd);
				text = buf.toString("utf8");
				truncated = true;
			} else text = fs.readFileSync(abs, "utf8");
		} catch {
			return entry;
		}
		const frontmatter = parseFrontmatter(text);
		const tags = parseTags(text, frontmatter);
		const cls = this.classify(rel, tags);
		entry.kind = cls.kind;
		entry.sourceType = cls.sourceType;
		entry.aiGenerated = tags.includes("ai-chat");
		entry.parsed = {
			frontmatter,
			tags,
			aliases: asList(frontmatter.data.aliases ?? frontmatter.data.alias),
			headings: parseHeadings(text),
			links: parseLinks(text),
			text,
			truncated,
		};
		return entry;
	}

	/** Get a readable note by path (policy-checked). Throws VaultError with a safe reason otherwise. */
	getReadable(input: string): NoteEntry {
		let resolved;
		try {
			resolved = resolveInVault(this.root, input, this.rootRaw);
		} catch (e) {
			throw new VaultError((e as PathError).message);
		}
		let rel = resolved.rel;
		if (!rel.toLowerCase().endsWith(".md") && !resolved.exists && fs.existsSync(resolved.abs + ".md")) rel += ".md";
		const policy = decide(this.cfg, rel, this.grants);
		if (!canRead(policy)) throw new VaultError(`Access denied (${policy.reason}).`);
		this.refresh();
		const entry = this.notes.get(rel);
		if (!entry) throw new VaultError(`Note not found: ${rel}`);
		if (!entry.parsed) {
			// Policy changed since last scan (e.g. grant) — rebuild this entry.
			const abs = path.join(this.root, ...rel.split("/"));
			const fresh = this.buildEntry(rel, abs, fs.statSync(abs), policy);
			this.notes.set(rel, fresh);
			if (!fresh.parsed) throw new VaultError(`Note could not be read: ${rel}`);
			return fresh;
		}
		return entry;
	}

	/** Read current bytes of a vault file for editing (policy is checked by the caller). */
	readRaw(rel: string): { text: string; hash: string } | null {
		const r = resolveInVault(this.root, rel, this.rootRaw);
		if (!r.exists) return null;
		const buf = fs.readFileSync(r.abs);
		return { text: buf.toString("utf8"), hash: sha256(buf) };
	}

	absPath(rel: string): string {
		return path.join(this.root, ...rel.split("/"));
	}

	readableNotes(): NoteEntry[] {
		this.refresh();
		return [...this.notes.values()].filter((n) => n.parsed);
	}

	relFromAbs(abs: string): string {
		return toPosix(path.relative(this.root, abs));
	}
}
