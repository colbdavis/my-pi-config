/**
 * Vault path safety: every vault access goes through resolveInVault(), which
 * rejects traversal, absolute paths outside the vault, NUL bytes, and symlink
 * escapes. Policy is evaluated on the *real* (symlink-resolved) relative path,
 * so a symlink inside the vault cannot launder access to an excluded folder.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export class PathError extends Error {}

export function toPosix(p: string): string {
	return p.split(path.sep).join("/");
}

export function isInside(rootReal: string, candidate: string): boolean {
	return candidate === rootReal || candidate.startsWith(rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep);
}

/** Normalize user/model input to a clean vault-relative POSIX path (no I/O). */
export function normalizeRel(input: string, rootReal: string, rootRaw?: string): string {
	if (typeof input !== "string" || input.trim() === "") throw new PathError("Empty path");
	if (input.includes("\0")) throw new PathError("Path contains a NUL byte");
	let p = input.trim().replace(/\\/g, "/");
	if (path.isAbsolute(p)) {
		const roots = [rootReal, rootRaw].filter(Boolean) as string[];
		const root = roots.find((r) => isInside(r, p));
		if (!root) throw new PathError("Absolute path outside the vault");
		p = toPosix(path.relative(root, p));
	}
	const parts: string[] = [];
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") throw new PathError("Path traversal ('..') is not allowed");
		parts.push(seg);
	}
	if (parts.length === 0) throw new PathError("Path resolves to the vault root");
	return parts.join("/");
}

export interface ResolvedPath {
	/** Absolute path as requested (inside the vault root). */
	abs: string;
	/** Vault-relative POSIX path after resolving symlinks (what policy is checked against). */
	rel: string;
	exists: boolean;
}

/**
 * Resolve a vault-relative path. For existing paths the realpath must stay
 * inside the vault. For new paths the nearest existing ancestor's realpath
 * must stay inside the vault.
 */
export function resolveInVault(rootReal: string, input: string, rootRaw?: string): ResolvedPath {
	const rel = normalizeRel(input, rootReal, rootRaw);
	const abs = path.join(rootReal, ...rel.split("/"));
	if (!isInside(rootReal, abs)) throw new PathError("Path escapes the vault");

	let exists = false;
	try {
		fs.lstatSync(abs);
		exists = true;
	} catch {
		exists = false;
	}

	if (exists) {
		let real: string;
		try {
			real = fs.realpathSync(abs);
		} catch {
			throw new PathError("Broken symlink");
		}
		if (!isInside(rootReal, real)) throw new PathError("Symlink escapes the vault");
		return { abs, rel: toPosix(path.relative(rootReal, real)), exists: true };
	}

	// New path: walk up to the nearest existing ancestor.
	let ancestor = path.dirname(abs);
	const tail: string[] = [path.basename(abs)];
	while (!fs.existsSync(ancestor)) {
		tail.unshift(path.basename(ancestor));
		const next = path.dirname(ancestor);
		if (next === ancestor) break;
		ancestor = next;
	}
	const realAncestor = fs.realpathSync(ancestor);
	if (!isInside(rootReal, realAncestor)) throw new PathError("Parent directory escapes the vault");
	const relReal = toPosix(path.join(path.relative(rootReal, realAncestor), ...tail));
	return { abs, rel: relReal, exists: false };
}

/** Segment-aware prefix test: "3 - Daily" matches "3 - Daily/x.md" but not "3 - Daily2/x.md". */
export function hasPrefix(rel: string, prefix: string): boolean {
	if (prefix === "") return true;
	return rel === prefix || rel.startsWith(prefix + "/");
}
