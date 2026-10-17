import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Atomic write: write a hidden temp file in the same directory (Obsidian and
 * Syncthing ignore dot-files), fsync, then rename over the target. Keeps the
 * original file mode when replacing.
 */
export function writeFileAtomic(abs: string, content: string | Buffer): void {
	const dir = path.dirname(abs);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.obsidian-learning-${randomBytes(6).toString("hex")}.tmp`);
	let mode: number | undefined;
	try {
		mode = fs.statSync(abs).mode;
	} catch {
		mode = undefined;
	}
	const fd = fs.openSync(tmp, "w", mode ?? 0o644);
	try {
		fs.writeFileSync(fd, content);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		if (mode !== undefined) fs.chmodSync(tmp, mode);
		fs.renameSync(tmp, abs);
	} catch (e) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		throw e;
	}
}

/** Characters Obsidian does not allow in file names (plus link-breaking ones). */
export function sanitizeFileName(s: string, max = 80): string {
	const cleaned = s
		.replace(/[*"\\/<>:|?#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "");
	return cleaned.slice(0, max).trim() || "untitled";
}

/** Return `abs` or, if it exists, the first free "name (2).md", "name (3).md", ... */
export function uniquePath(abs: string): string {
	if (!fs.existsSync(abs)) return abs;
	const ext = path.extname(abs);
	const base = abs.slice(0, -ext.length);
	for (let i = 2; i < 1000; i++) {
		const cand = `${base} (${i})${ext}`;
		if (!fs.existsSync(cand)) return cand;
	}
	throw new Error(`Could not find a free file name for ${abs}`);
}
