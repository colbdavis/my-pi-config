/**
 * Configuration for obsidian-learning.
 *
 * Resolution order (first hit wins for each field):
 *   1. Environment: OBSIDIAN_LEARNING_VAULT (vault path), OBSIDIAN_LEARNING_CONFIG (config file path)
 *   2. Config file: $OBSIDIAN_LEARNING_CONFIG or ${XDG_CONFIG_HOME:-~/.config}/obsidian-learning/config.json
 *   3. Built-in defaults (folder layout of the user's vault; never a vault *path*)
 *
 * The vault path is never hardcoded: without env or config the tools report
 * "vault not configured" and do nothing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Access levels, from most to least restrictive:
 *  - excluded:  invisible to search/read/link-following (hard; only config can change it)
 *  - gated:     excluded unless the user grants access for the current session (e.g. 3 - Daily)
 *  - read-only: searchable/readable, never edited
 *  - propose:   readable; edits only through a diff proposal + explicit user approval
 *  - learning:  the learning-state directory; tool-controlled writes, user files editable via proposals
 */
export type Access = "excluded" | "gated" | "read-only" | "propose" | "learning";

export interface FolderRule {
	/** Vault-relative folder prefix ("" = default for everything not matched). Segment-aware. */
	prefix: string;
	access: Access;
	/** Ranking multiplier for search results in this folder (default 1). */
	weight?: number;
}

export interface FolderNames {
	rough: string;
	sources: string;
	daily: string;
	indexes: string;
	templates: string;
	atomic: string;
	excalidraw: string;
}

export interface LearningConfig {
	vaultPath: string | null;
	learningDir: string;
	folders: FolderNames;
	rules: FolderRule[];
	/** Substrings of file names that are always excluded (sync conflicts, drawings). */
	excludeNamePatterns: string[];
	timezone: string;
	schedule: { intervals: number[]; relearnDays: number };
	backupDir: string;
	limits: {
		maxReadChars: number;
		maxIndexBytes: number;
		maxResults: number;
		excerptChars: number;
	};
	agents: {
		/** Directory with Eero's agent definitions (researcher.md, svg-maker.md, ...). */
		agentsDir: string | null;
		researcherHarness: "pi" | "codex" | "claude";
	};
	/** Disable the built-in bash tool in learning sessions (strongest local protection). */
	strictBash: boolean;
	/** Where the config was loaded from (for /learn-status). */
	source: string[];
}

export const DEFAULT_FOLDERS: FolderNames = {
	rough: "1 - Rough Notes",
	sources: "2 - Source Material",
	daily: "3 - Daily",
	indexes: "4 - Indexes",
	templates: "5 - Template",
	atomic: "6 - Atomic Notes",
	excalidraw: "7 - Excalidraw",
};

export function defaultRules(folders: FolderNames, learningDir: string): FolderRule[] {
	return [
		// Root-level notes and unknown folders: personal by default, opt in via config.
		{ prefix: "", access: "excluded" },
		{ prefix: folders.rough, access: "read-only", weight: 0.8 },
		{ prefix: `${folders.rough}/Private`, access: "excluded" },
		{ prefix: folders.sources, access: "read-only" },
		{ prefix: folders.daily, access: "gated" },
		{ prefix: folders.indexes, access: "propose", weight: 1.15 },
		{ prefix: folders.templates, access: "read-only", weight: 0.3 },
		{ prefix: folders.atomic, access: "propose", weight: 1.2 },
		{ prefix: folders.excalidraw, access: "excluded" },
		{ prefix: learningDir, access: "learning", weight: 0.9 },
	];
}

export function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function systemTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	if (env.OBSIDIAN_LEARNING_CONFIG) return expandHome(env.OBSIDIAN_LEARNING_CONFIG);
	const base = env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME) : path.join(os.homedir(), ".config");
	return path.join(base, "obsidian-learning", "config.json");
}

function defaultBackupDir(env: NodeJS.ProcessEnv): string {
	const base = env.XDG_STATE_HOME ? expandHome(env.XDG_STATE_HOME) : path.join(os.homedir(), ".local", "state");
	return path.join(base, "obsidian-learning", "backups");
}

export class ConfigError extends Error {}

/** Load configuration. `overrides` is used by tests; env is injectable for the same reason. */
export function loadConfig(
	options: { env?: NodeJS.ProcessEnv; overrides?: Partial<LearningConfig> & { configFile?: string | null } } = {},
): LearningConfig {
	const env = options.env ?? process.env;
	const source: string[] = [];
	let file: any = {};
	const configFile = options.overrides?.configFile === undefined ? defaultConfigPath(env) : options.overrides.configFile;
	if (configFile && fs.existsSync(configFile)) {
		try {
			file = JSON.parse(fs.readFileSync(configFile, "utf8"));
			source.push(configFile);
		} catch (e) {
			throw new ConfigError(`Invalid JSON in ${configFile}: ${(e as Error).message}`);
		}
	}

	const learningDir: string = file.learningDir ?? "8 - Learning System";
	const folders: FolderNames = { ...DEFAULT_FOLDERS, ...(file.folders ?? {}) };
	let rules: FolderRule[] = Array.isArray(file.rules) ? file.rules : defaultRules(folders, learningDir);
	if (Array.isArray(file.extraRules)) rules = [...rules, ...file.extraRules];
	for (const r of rules) {
		if (typeof r.prefix !== "string" || !["excluded", "gated", "read-only", "propose", "learning"].includes(r.access)) {
			throw new ConfigError(`Invalid folder rule: ${JSON.stringify(r)}`);
		}
		r.prefix = r.prefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	}

	let vaultPath: string | null = file.vaultPath ? expandHome(String(file.vaultPath)) : null;
	if (env.OBSIDIAN_LEARNING_VAULT) {
		vaultPath = expandHome(env.OBSIDIAN_LEARNING_VAULT);
		source.push("env:OBSIDIAN_LEARNING_VAULT");
	}

	const intervals: number[] = file.schedule?.intervals ?? [3, 10, 30];
	if (!intervals.length || intervals.some((n) => !Number.isInteger(n) || n < 1)) {
		throw new ConfigError("schedule.intervals must be positive integers");
	}

	const cfg: LearningConfig = {
		vaultPath,
		learningDir,
		folders,
		rules,
		excludeNamePatterns: file.excludeNamePatterns ?? [".sync-conflict-", ".excalidraw.md"],
		timezone: file.timezone ?? env.OBSIDIAN_LEARNING_TZ ?? systemTimezone(),
		schedule: { intervals, relearnDays: file.schedule?.relearnDays ?? 1 },
		backupDir: expandHome(file.backupDir ?? defaultBackupDir(env)),
		limits: {
			maxReadChars: file.limits?.maxReadChars ?? 12000,
			maxIndexBytes: file.limits?.maxIndexBytes ?? 1_000_000,
			maxResults: file.limits?.maxResults ?? 25,
			excerptChars: file.limits?.excerptChars ?? 280,
		},
		agents: {
			agentsDir: file.agents?.agentsDir ? expandHome(file.agents.agentsDir) : null,
			researcherHarness: file.agents?.researcherHarness ?? "codex",
		},
		strictBash: file.strictBash !== false,
		source,
		...stripUndefined(options.overrides ?? {}),
	};
	delete (cfg as any).configFile;
	if (!Number.isInteger(cfg.schedule.relearnDays) || cfg.schedule.relearnDays < 1) {
		throw new ConfigError("schedule.relearnDays must be a positive integer");
	}
	for (const [name, value] of Object.entries(cfg.limits)) {
		if (!Number.isInteger(value) || value < 1) throw new ConfigError(`limits.${name} must be a positive integer`);
	}
	for (const value of [cfg.learningDir, ...Object.values(cfg.folders)]) {
		if (typeof value !== "string" || !value.trim() || path.isAbsolute(value) || value.split(/[\\/]/).some(s => !s || s === "." || s === "..")) {
			throw new ConfigError("Folder names must be non-empty vault-relative paths without traversal");
		}
	}
	try {
		new Intl.DateTimeFormat("en-CA", { timeZone: cfg.timezone });
	} catch {
		throw new ConfigError(`Unknown timezone: ${cfg.timezone}`);
	}
	return cfg;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
	const out: any = {};
	for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
	return out;
}
