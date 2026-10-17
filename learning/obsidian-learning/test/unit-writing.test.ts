import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { unifiedDiff } from "../src/diff.ts";
import { applyProposal, contentForSelection, createProposal, EditError, listBackups, rollback, StaleError } from "../src/edits.ts";
import { checkToolCall } from "../src/guard.ts";
import { emptyGrants } from "../src/policy.ts";
import { makeVault, read } from "./helpers/vault.ts";

const PIGEON = "6 - Atomic Notes/Combinatoria - Pigeonhole Principle.md";
const AMBIG = "> Se metti n oggetti in n contenitori almeno un contenitore avrà [n/m] oggetti al suo interno";
const FIXED = "> Se metti $n$ oggetti in $m$ contenitori, almeno un contenitore avrà $\\lceil n/m \\rceil$ oggetti al suo interno";

function snapshot(root: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isSymbolicLink()) continue;
			if (e.isDirectory()) walk(p);
			else out.set(path.relative(root, p), fs.readFileSync(p, "utf8"));
		}
	};
	walk(root);
	return out;
}

test("diff: unified format with hunks and context", () => {
	const d = unifiedDiff("a\nb\nc\nd\n", "a\nB\nc\nd\n", "a/x", "b/x");
	assert.equal(d, "--- a/x\n+++ b/x\n@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n d\n ");
	assert.equal(unifiedDiff("same", "same", "a", "b"), "");
});

test("proposal: diff only, nothing written; preserves everything outside the edit byte-for-byte", () => {
	const tv = makeVault();
	try {
		const before = snapshot(tv.root);
		const p = createProposal(tv.vault, { path: PIGEON, edits: [{ oldText: AMBIG, newText: FIXED }], rationale: "n vs m e soffitto" });
		assert.deepEqual(snapshot(tv.root), before, "proposal writes nothing");
		assert.match(p.diff, /^-> Se metti n oggetti in n contenitori/m);
		assert.match(p.diff, /^\+> Se metti \$n\$ oggetti in \$m\$ contenitori/m);
		const orig = read(tv.root, PIGEON);
		const i = orig.indexOf(AMBIG);
		assert.equal(p.newContent.slice(0, i), orig.slice(0, i), "prefix (frontmatter, tags, text) untouched");
		assert.equal(p.newContent.slice(i + FIXED.length), orig.slice(i + AMBIG.length), "suffix (LaTeX, wikilinks) untouched");
		assert.deepEqual(p.warnings, [], "no frontmatter/link/LaTeX loss");
	} finally {
		tv.cleanup();
	}
});

test("proposal: approved edit applied atomically with backup; rejected leaves file untouched", () => {
	const tv = makeVault();
	try {
		const orig = read(tv.root, PIGEON);
		// Rejected: the caller never calls applyProposal → file untouched.
		createProposal(tv.vault, { path: PIGEON, edits: [{ oldText: AMBIG, newText: FIXED }], rationale: "r" });
		assert.equal(read(tv.root, PIGEON), orig);
		// Approved:
		const p = createProposal(tv.vault, { path: PIGEON, edits: [{ oldText: AMBIG, newText: FIXED }], rationale: "r" });
		const rec = applyProposal(tv.vault, p, [0]);
		assert.equal(read(tv.root, PIGEON), p.newContent);
		assert.equal(p.status, "applied");
		assert.equal(fs.readFileSync(path.join(tv.cfg.backupDir, rec.id, "before.md"), "utf8"), orig);
		assert.ok(!fs.readdirSync(path.join(tv.root, "6 - Atomic Notes")).some((f) => f.endsWith(".tmp")), "no temp files left");
		assert.throws(() => applyProposal(tv.vault, p, [0]), /already|applied/);
	} finally {
		tv.cleanup();
	}
});

test("proposal: only the approved subset of edits is applied", () => {
	const tv = makeVault();
	try {
		const p = createProposal(tv.vault, {
			path: PIGEON,
			edits: [
				{ oldText: AMBIG, newText: FIXED },
				{ oldText: "# Combinatoria - Pigeonhole Principle", newText: "# Combinatoria - Pigeonhole Principle (Dirichlet)" },
			],
			rationale: "r",
		});
		applyProposal(tv.vault, p, [1]);
		const now = read(tv.root, PIGEON);
		assert.ok(now.includes("(Dirichlet)"));
		assert.ok(now.includes(AMBIG), "unapproved edit not applied");
		assert.equal(now, contentForSelection(p, [1]));
	} finally {
		tv.cleanup();
	}
});

test("proposal: stale edit rejected when the note changed after the diff", () => {
	const tv = makeVault();
	try {
		const p = createProposal(tv.vault, { path: PIGEON, edits: [{ oldText: AMBIG, newText: FIXED }], rationale: "r" });
		fs.appendFileSync(path.join(tv.root, PIGEON), "\nNuova riga scritta in Obsidian\n");
		const edited = read(tv.root, PIGEON);
		assert.throws(() => applyProposal(tv.vault, p, [0]), StaleError);
		assert.equal(p.status, "stale");
		assert.equal(read(tv.root, PIGEON), edited, "user's concurrent edit preserved");
	} finally {
		tv.cleanup();
	}
});

test("proposal: read-only, gated, excluded and outside paths cannot be edited", () => {
	const tv = makeVault();
	try {
		const before = snapshot(tv.root);
		const bad = [
			"2 - Source Material/Chats/Math/Congruenza Modulare.md",
			"5 - Template/CBC math atomic.md",
			"1 - Rough Notes/Mate - Cosa ho sbagliato.md",
			"3 - Daily/2026_10_01.md",
			"1 - Rough Notes/Private/Diario segreto.md",
			"Idee casa.md",
			"6 - Atomic Notes/Diario link.md",
			"6 - Atomic Notes/Escape.md",
			"../outside/secret.md",
		];
		for (const p of bad) assert.throws(() => createProposal(tv.vault, { path: p, edits: [{ oldText: "#", newText: "##" }], rationale: "r" }), EditError, p);
		assert.deepEqual(snapshot(tv.root), before);
		assert.equal(fs.readFileSync(path.join(tv.outside, "secret.md"), "utf8"), "# Outside\nOUTSIDE-SECRET piccionaia\n");
	} finally {
		tv.cleanup();
	}
});

test("proposal: oldText must match exactly once; overlaps rejected", () => {
	const tv = makeVault();
	try {
		const mk = (edits: any) => () => createProposal(tv.vault, { path: PIGEON, edits, rationale: "r" });
		assert.throws(mk([{ oldText: "non presente", newText: "x" }]), /not found/);
		assert.throws(mk([{ oldText: "oggetti", newText: "x" }]), /occurs/);
		assert.throws(mk([{ oldText: AMBIG, newText: "x" }, { oldText: "Se metti n", newText: "y" }]), /overlap/);
		assert.throws(() => createProposal(tv.vault, { path: PIGEON, edits: [{ oldText: AMBIG, newText: FIXED }], rationale: " " }), /rationale/);
	} finally {
		tv.cleanup();
	}
});

test("proposal: preservation warnings when links, LaTeX or frontmatter would be lost", () => {
	const tv = makeVault();
	try {
		const p = createProposal(tv.vault, {
			path: PIGEON,
			edits: [
				{ oldText: "Vedi [[Principio della Piccionaia applicato ai Residui Modulari]].", newText: "Vedi la nota sui residui." },
				{ oldText: "$\\lceil n/m \\rceil$", newText: "ceil(n/m)" },
				{ oldText: "  - cybchall\n", newText: "" },
			],
			rationale: "r",
		});
		assert.ok(p.warnings.some((w) => w.startsWith("links removed")));
		assert.ok(p.warnings.some((w) => w.startsWith("LaTeX changed")));
		assert.ok(p.warnings.some((w) => w.includes("frontmatter")));
	} finally {
		tv.cleanup();
	}
});

test("proposal: new note creation — no duplicates, valid names, template warning", () => {
	const tv = makeVault();
	try {
		assert.throws(
			() => createProposal(tv.vault, { path: "6 - Atomic Notes/Congruenza Modulare.md", create: true, content: "---\ntags: []\n---\n# x", rationale: "r" }),
			/already exists/,
		);
		assert.throws(() => createProposal(tv.vault, { path: "6 - Atomic Notes/Bad#Name.md", create: true, content: "x", rationale: "r" }), /characters/);
		assert.throws(() => createProposal(tv.vault, { path: PIGEON, create: true, content: "x", rationale: "r" }), /already exists/);
		const p = createProposal(tv.vault, { path: "6 - Atomic Notes/Combinatoria - Inclusione-Esclusione.md", create: true, content: "# Inclusione-Esclusione\n", rationale: "r" });
		assert.ok(p.warnings.some((w) => w.includes("frontmatter")));
		const rec = applyProposal(tv.vault, p, [0]);
		assert.equal(read(tv.root, p.path), "# Inclusione-Esclusione\n");
		rollback(tv.vault, rec.id);
		assert.ok(!fs.existsSync(path.join(tv.root, p.path)), "rollback removes created note");
	} finally {
		tv.cleanup();
	}
});

test("rollback: restores the original; refuses if changed since, unless forced (newer content kept)", () => {
	const tv = makeVault();
	try {
		const orig = read(tv.root, PIGEON);
		const p1 = createProposal(tv.vault, { path: PIGEON, edits: [{ oldText: AMBIG, newText: FIXED }], rationale: "r" });
		const r1 = applyProposal(tv.vault, p1, [0]);
		assert.equal(listBackups(tv.cfg.backupDir, tv.vault.root)[0].id, r1.id);
		rollback(tv.vault, r1.id);
		assert.equal(read(tv.root, PIGEON), orig);
		assert.throws(() => rollback(tv.vault, r1.id), /already rolled back/);

		const p2 = createProposal(tv.vault, { path: PIGEON, edits: [{ oldText: AMBIG, newText: FIXED }], rationale: "r" });
		const r2 = applyProposal(tv.vault, p2, [0]);
		fs.appendFileSync(path.join(tv.root, PIGEON), "edit successivo\n");
		assert.throws(() => rollback(tv.vault, r2.id), StaleError);
		rollback(tv.vault, r2.id, { force: true });
		assert.equal(read(tv.root, PIGEON), orig);
		assert.ok(fs.readdirSync(path.join(tv.cfg.backupDir, r2.id)).some((f) => f.startsWith("overwritten-")));
		assert.throws(() => rollback(tv.vault, "../../etc"), /Invalid backup id/);
	} finally {
		tv.cleanup();
	}
});

// ── guard ───────────────────────────────────────────────────────────────────

test("guard: blocks general tools from the vault, allows everything else", () => {
	const tv = makeVault({ strictBash: false });
	try {
		const ctx = { cfg: tv.cfg, vaultRoot: tv.vault.root, vaultRootRaw: tv.vault.rootRaw, cwd: os.tmpdir(), grants: emptyGrants() };
		const blocked = (tool: string, input: any) => checkToolCall(ctx, tool, input).block;
		const abs = (rel: string) => path.join(tv.root, rel);
		assert.ok(blocked("write", { path: abs(PIGEON), content: "x" }));
		assert.ok(blocked("edit", { path: abs(PIGEON), edits: [] }));
		assert.ok(blocked("write", { path: abs("8 - Learning System/Mastery Tracker.md"), content: "x" }), "learning state only via learning tools");
		assert.ok(blocked("write", { path: abs("6 - Atomic Notes/New.md"), content: "x" }), "new files too");
		assert.ok(blocked("read", { path: abs(PIGEON) }), "markdown reads go through vault_read");
		assert.ok(blocked("read", { path: abs("1 - Rough Notes/Private/Diario segreto.md") }));
		assert.ok(!blocked("read", { path: abs("2 - Source Material/attachments/figura-piccionaia.png") }), "images may be viewed");
		assert.ok(blocked("rg", { pattern: "x", path: abs("") }));
		assert.ok(blocked("bash", { command: `cat "${tv.root}/3 - Daily/2026_10_01.md"` }));
		assert.ok(blocked("bash", { command: "grep -r piccionaia ~/whatever/My\\ Vault" }), "vault folder name is a marker");
		assert.ok(blocked("bg_start", { command: `ls ${tv.root}` }));
		assert.ok(blocked("subagent_spawn", { name: "x", harness: "pi", prompt: "p", working_dir: abs("") }));
		// Relative path resolving into the vault from a cwd inside it:
		assert.ok(checkToolCall({ ...ctx, cwd: abs("6 - Atomic Notes") }, "edit", { path: "Combinatoria - Pigeonhole Principle.md" }).block);
		// Symlink from outside into the vault is resolved:
		const link = path.join(tv.tmp, "shortcut");
		fs.symlinkSync(tv.root, link);
		assert.ok(blocked("write", { path: path.join(link, "6 - Atomic Notes", "x.md"), content: "x" }));
		// Unrelated work is untouched:
		assert.ok(!blocked("bash", { command: "python3 sol.py < input.txt" }));
		assert.ok(!blocked("write", { path: path.join(tv.tmp, "scratch.py"), content: "print(1)" }));
		assert.ok(!blocked("vault_read", { note: PIGEON }), "learning tools enforce policy themselves");
		assert.ok(!blocked("learning_state", { action: "due" }));
	} finally {
		tv.cleanup();
	}
});

// ── md-log patch (Eero's extension, patched) ────────────────────────────────

test("md-log patch: refuses to link existing notes, links empty/transcript notes, keeps frontmatter on backfill", async () => {
	const mdLogPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../.pi/extensions/md-log.ts");
	const mod = await import(mdLogPath);
	const commands = new Map<string, any>();
	const fakePi: any = { on() {}, registerCommand: (n: string, c: any) => commands.set(n, c), appendEntry() {} };
	mod.default(fakePi);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdlog-"));
	try {
		const notes: string[] = [];
		const ctx: any = {
			cwd: dir,
			isIdle: () => true,
			ui: { notify: (m: string) => notes.push(m), setStatus() {}, theme: { fg: (_: string, s: string) => s } },
			sessionManager: {
				getEntries: () => [
					{ type: "message", id: "1", parentId: null, message: { role: "user", content: "ciao" } },
					{ type: "message", id: "2", parentId: "1", message: { role: "assistant", content: [{ type: "text", text: "risposta" }] } },
				],
			},
		};
		const atomic = path.join(dir, "atomic.md");
		fs.writeFileSync(atomic, "---\ntags: [x]\n---\n# My precious note\n");
		await commands.get("md-log").handler(atomic, ctx);
		assert.equal(fs.readFileSync(atomic, "utf8"), "---\ntags: [x]\n---\n# My precious note\n", "existing note untouched");
		assert.match(notes.pop()!, /Refusing to link/);

		const tr = path.join(dir, "t.md");
		fs.writeFileSync(tr, "---\ntype: learning-transcript\n---\n");
		await commands.get("md-log").handler(tr, ctx);
		const out = fs.readFileSync(tr, "utf8");
		assert.match(out, /^---\ntype: learning-transcript\n---\n/);
		assert.match(out, /> \[!quote\] YOU\n\nciao/);
		assert.match(out, /> \[!abstract\] PI\n\nrisposta/);
		// Re-linking an existing transcript is allowed.
		await commands.get("md-log").handler(tr, ctx);
		assert.match(notes.pop()!, /Linked/);

		const empty = path.join(dir, "empty.md");
		fs.writeFileSync(empty, "");
		await commands.get("md-log").handler(empty, ctx);
		assert.match(notes.pop()!, /Linked/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
