/**
 * Folder policy. The longest matching rule prefix wins. Hidden path segments
 * (.obsidian, .trash, .smart-env, .git, .stfolder, ...) and configured name
 * patterns (sync conflicts, Excalidraw drawings) are always excluded.
 */

import type { Access, LearningConfig } from "./config.ts";
import { hasPrefix } from "./paths.ts";

export interface PolicyDecision {
	access: Access;
	weight: number;
	/** Human-readable reason, safe to show to the model. */
	reason: string;
}

export interface SessionGrants {
	/** Gated prefixes the user explicitly unlocked for this session. */
	gated: Set<string>;
}

export function emptyGrants(): SessionGrants {
	return { gated: new Set() };
}

export function decide(cfg: LearningConfig, rel: string, grants?: SessionGrants): PolicyDecision {
	const segments = rel.split("/");
	if (segments.some((s) => s.startsWith("."))) {
		return { access: "excluded", weight: 0, reason: "hidden/system path" };
	}
	const name = segments[segments.length - 1];
	for (const pat of cfg.excludeNamePatterns) {
		if (name.includes(pat)) return { access: "excluded", weight: 0, reason: `excluded file pattern "${pat}"` };
	}
	let best: { prefix: string; access: Access; weight?: number } | undefined;
	for (const rule of cfg.rules) {
		if (hasPrefix(rel, rule.prefix) && (!best || rule.prefix.length >= best.prefix.length)) best = rule;
	}
	if (!best) return { access: "excluded", weight: 0, reason: "no matching folder rule" };
	if (best.access === "gated") {
		if (grants?.gated.has(best.prefix)) {
			return { access: "read-only", weight: best.weight ?? 1, reason: `"${best.prefix}" unlocked by the user for this session` };
		}
		return { access: "gated", weight: 0, reason: `"${best.prefix}" is excluded unless the user explicitly unlocks it` };
	}
	return {
		access: best.access,
		weight: best.weight ?? 1,
		reason: best.prefix === "" ? "vault default rule" : `folder rule "${best.prefix}"`,
	};
}

export function canRead(d: PolicyDecision): boolean {
	return d.access === "read-only" || d.access === "propose" || d.access === "learning";
}

export function canPropose(d: PolicyDecision): boolean {
	return d.access === "propose" || d.access === "learning";
}

/** Find the gated rule prefix that covers rel (used to ask the user for a grant). */
export function gatedPrefixFor(cfg: LearningConfig, rel: string): string | undefined {
	let best: string | undefined;
	for (const rule of cfg.rules) {
		if (rule.access === "gated" && hasPrefix(rel, rule.prefix) && (best === undefined || rule.prefix.length > best.length)) {
			best = rule.prefix;
		}
	}
	return best;
}
