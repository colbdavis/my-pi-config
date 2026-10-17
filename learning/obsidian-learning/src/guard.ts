/**
 * tool_call guard: technical (not prompt-based) protection of the vault from
 * Pi's general-purpose tools.
 *
 *  - The learning tools (vault_*, learning_*) enforce policy themselves → allowed.
 *  - Any other tool whose path-like argument resolves into the vault:
 *      writes (write/edit/apply_patch/...) → blocked
 *      reads of Markdown (read/grep/find/ls/fd/rg/...) → blocked, use vault_read/vault_search
 *      `read` of an image/attachment in a readable folder → allowed (lets the model view figures)
 *  - Any tool whose string arguments mention the vault location (bash/bg_start
 *    commands, subagent prompts, patches) → blocked.
 *
 * Trust boundary (documented): string inspection of shell commands is
 * best-effort. A determined process can reach the vault without naming it
 * (e.g. `cd ..` chains, variables). Set strictBash=true to remove the bash
 * tool from learning sessions, or run Pi in an OS sandbox for hard isolation.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LearningConfig } from "./config.ts";
import { MAKERS, PKG_DIR } from "./agents.ts";
import { canRead, decide, type SessionGrants } from "./policy.ts";
import { isInside, toPosix } from "./paths.ts";

export const LEARNING_TOOL_PREFIXES = ["vault_", "learning_"];
const PATH_KEYS = ["path", "file_path", "filePath", "file", "files", "paths", "cwd", "working_dir", "workingDir", "dir", "directory", "target", "destination", "source"];
const WRITE_TOOL = /(^|_)(write|edit|patch|apply|delete|remove|rm|move|mv|rename|create|mkdir|replace)(_|$)/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

export interface GuardContext {
	cfg: LearningConfig;
	vaultRoot: string; // realpath
	vaultRootRaw: string;
	cwd: string;
	grants: SessionGrants;
}

export interface GuardDecision {
	block: boolean;
	reason?: string;
}

function realish(p: string): string {
	// realpath of the path or of its nearest existing ancestor (for new files).
	let cur = p;
	const tail: string[] = [];
	for (let i = 0; i < 64; i++) {
		try {
			return path.join(fs.realpathSync(cur), ...tail);
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return p;
			tail.unshift(path.basename(cur));
			cur = parent;
		}
	}
	return p;
}

function expand(p: string, cwd: string): string {
	let s = p.trim();
	if (s === "~" || s.startsWith("~/")) s = path.join(os.homedir(), s.slice(1));
	return path.isAbsolute(s) ? s : path.resolve(cwd, s);
}

function collectPaths(input: any): string[] {
	const out: string[] = [];
	if (!input || typeof input !== "object") return out;
	for (const key of PATH_KEYS) {
		const v = input[key];
		if (typeof v === "string" && v.trim()) out.push(v);
		else if (Array.isArray(v)) for (const x of v) if (typeof x === "string" && x.trim()) out.push(x);
	}
	return out;
}

function collectStrings(v: any, out: string[] = [], depth = 0): string[] {
	if (depth > 6) return out;
	if (typeof v === "string") out.push(v);
	else if (Array.isArray(v)) for (const x of v) collectStrings(x, out, depth + 1);
	else if (v && typeof v === "object") for (const x of Object.values(v)) collectStrings(x, out, depth + 1);
	return out;
}

/** Strings that identify the vault location inside free text (commands, prompts). */
export function vaultMarkers(ctx: GuardContext): string[] {
	const home = os.homedir();
	const markers = new Set<string>();
	for (const root of [ctx.vaultRoot, ctx.vaultRootRaw]) {
		markers.add(root);
		if (root.startsWith(home + path.sep)) markers.add("~" + root.slice(home.length));
		markers.add(root.replace(/ /g, "\\ "));
	}
	markers.add("OBSIDIAN_LEARNING_VAULT");
	const base = path.basename(ctx.vaultRoot);
	if (base.length >= 6) {
		markers.add(base); // e.g. "Markdown Notes"
		markers.add(base.replace(/ /g, "\\ "));
	}
	return [...markers];
}

export function checkToolCall(ctx: GuardContext, toolName: string, input: any): GuardDecision {
	if (LEARNING_TOOL_PREFIXES.some((p) => toolName.startsWith(p))) return { block: false };
	if (ctx.cfg.strictBash && (toolName === "bash" || toolName === "bg_start" || toolName === "workflow" ||
		(toolName === "subagent_spawn" && input?.harness !== "pi"))) {
		return { block: true, reason: "Shell execution and non-Pi child harnesses are disabled in strict learning sessions. Use vault tools, or explicitly configure strictBash=false for trusted code execution." };
	}
	if (ctx.cfg.strictBash && toolName === "subagent_spawn") {
		const cwd = realish(expand(input?.working_dir ?? ".", ctx.cwd));
		const allowed = MAKERS.some(m => cwd === realish(path.join(PKG_DIR, "agent-workspaces", m)));
		if (!allowed) return { block: true, reason: "Strict learning sessions allow Pi children only in the restricted svg-maker and mermaid-maker workspaces." };
	}

	for (const raw of collectPaths(input)) {
		const abs = realish(expand(raw, ctx.cwd));
		if (!isInside(ctx.vaultRoot, abs) && !isInside(ctx.vaultRootRaw, expand(raw, ctx.cwd))) continue;
		const rel = toPosix(path.relative(ctx.vaultRoot, abs));
		if (WRITE_TOOL.test(toolName)) {
			return {
				block: true,
				reason:
					"Direct writes to the Obsidian vault are blocked. Use vault_propose_edit + vault_apply_edit for notes (diff + user approval) or the learning_* tools for learning state.",
			};
		}
		if (toolName === "read" && rel && IMAGE_EXT.test(rel) && canRead(decide(ctx.cfg, rel, ctx.grants))) return { block: false };
		return {
			block: true,
			reason:
				"Direct file access to the Obsidian vault is blocked for general tools. Use vault_search / vault_read / vault_index / vault_links (policy-checked, bounded, untrusted-content framing).",
		};
	}

	const markers = vaultMarkers(ctx);
	const strings = collectStrings(input);
	for (const s of strings) {
		const hit = markers.find((m) => s.includes(m));
		if (hit) {
			return {
				block: true,
				reason: `This ${toolName} call references the Obsidian vault location. Shell/subagent access to the vault is blocked; use the vault_* tools instead.`,
			};
		}
	}
	return { block: false };
}
