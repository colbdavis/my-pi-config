import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { backlinks, parseReference, resolveLink } from "../src/links.ts";
import { parseLinks } from "../src/markdown.ts";
import { PathError, resolveInVault } from "../src/paths.ts";
import { decide } from "../src/policy.ts";
import { search } from "../src/search.ts";
import { makeVault } from "./helpers/vault.ts";

const tv = makeVault();
after(() => tv.cleanup());
const { vault, cfg } = tv;

test("policy: folder rules, hidden paths, name patterns, longest prefix wins", () => {
	const a = (rel: string) => decide(cfg, rel).access;
	assert.equal(a("2 - Source Material/Chats/Math/X.md"), "read-only");
	assert.equal(a("4 - Indexes/X.md"), "propose");
	assert.equal(a("6 - Atomic Notes/X.md"), "propose");
	assert.equal(a("5 - Template/X.md"), "read-only");
	assert.equal(a("3 - Daily/2026_10_01.md"), "gated");
	assert.equal(a("1 - Rough Notes/Private/Diario segreto.md"), "excluded");
	assert.equal(a("1 - Rough Notes/Mate.md"), "read-only");
	assert.equal(a("7 - Excalidraw/Drawing.excalidraw.md"), "excluded");
	assert.equal(a("8 - Learning System/Mastery Tracker.md"), "learning");
	assert.equal(a("Idee casa.md"), "excluded");
	assert.equal(a(".smart-env/multi/a.ajson"), "excluded");
	assert.equal(a("2 - Source Material/Chats/Lifestyle/Vacanze.md"), "excluded");
	assert.equal(a("6 - Atomic Notes/x.sync-conflict-20260101.md"), "excluded");
	assert.equal(a("3 - Daily2/x.md"), "excluded", "segment-aware prefix");
});

test("paths: traversal, absolute outside, NUL, and symlink escapes are rejected", () => {
	assert.throws(() => resolveInVault(vault.root, "../outside/secret.md"), PathError);
	assert.throws(() => resolveInVault(vault.root, "6 - Atomic Notes/../../outside/secret.md"), PathError);
	assert.throws(() => resolveInVault(vault.root, tv.outside + "/secret.md"), PathError);
	assert.throws(() => resolveInVault(vault.root, "a\0b.md"), PathError);
	assert.throws(() => resolveInVault(vault.root, "6 - Atomic Notes/Escape.md"), /Symlink escapes/);
	assert.throws(() => resolveInVault(vault.root, "6 - Atomic Notes/outside-dir/secret.md"), /escapes/);
	assert.throws(() => resolveInVault(vault.root, "6 - Atomic Notes/outside-dir/new.md"), /escapes/);
	// Absolute path inside the vault is accepted and normalized.
	assert.equal(resolveInVault(vault.root, path.join(vault.root, "4 - Indexes", "Combinatoria.md")).rel, "4 - Indexes/Combinatoria.md");
});

test("symlink into an excluded folder is checked against its real path", () => {
	assert.throws(() => vault.getReadable("6 - Atomic Notes/Diario link.md"), /Access denied/);
	assert.throws(() => vault.getReadable("6 - Atomic Notes/Escape.md"), /escapes/);
	assert.ok(vault.skippedSymlinks.length >= 3, "symlinks are never followed during scans");
});

test("classification distinguishes source kinds, atomic, index, ai-chat", () => {
	const k = (p: string) => vault.notes.get(p)!;
	assert.equal(k("4 - Indexes/Aritmetica Modulare.md").kind, "index");
	assert.equal(k("6 - Atomic Notes/Combinatoria - Pigeonhole Principle.md").kind, "atomic");
	const chat = k("2 - Source Material/Chats/Math/Congruenza Modulare.md");
	assert.equal(chat.kind, "source");
	assert.equal(chat.sourceType, "conversation");
	assert.equal(chat.aiGenerated, true);
	assert.equal(k("2 - Source Material/Courses/htb/Getting Started.md").sourceType, "course");
	assert.equal(k("4 - Indexes/Progresso combinatoria aprile.md").aiGenerated, true);
	assert.equal(k("1 - Rough Notes/Private/Diario segreto.md").parsed, undefined, "excluded notes are never parsed");
	assert.equal(k("3 - Daily/2026_10_01.md").parsed, undefined, "gated notes are never parsed until unlocked");
});

test("search: exact title outranks body mentions; accent-insensitive; excerpts bounded", () => {
	const hits = search(vault, "Congruenza Modulare");
	assert.equal(hits[0].path, "2 - Source Material/Chats/Math/Congruenza Modulare.md");
	assert.ok(hits[0].matched.includes("name:exact"));
	const accent = search(vault, "proprieta"); // matches "Proprietà"
	assert.ok(accent.some((h) => h.path.endsWith("Congruenza Modulare.md")), JSON.stringify(accent.map((h) => h.path)));
	assert.ok(search(vault, "PICCIONAIA").length > 0, "case-insensitive");
	for (const h of search(vault, "piccionaia")) for (const e of h.excerpts) assert.ok(e.text.length <= cfg.limits.excerptChars + 2);
});

test("search: never returns excluded, private, gated, trash, root, Lifestyle or Excalidraw content", () => {
	const paths = search(vault, "piccionaia", { limit: 25 }).map((h) => h.path);
	assert.ok(paths.includes("6 - Atomic Notes/Combinatoria - Pigeonhole Principle.md"));
	for (const bad of ["Private", "3 - Daily", ".trash", "Idee casa", "Lifestyle", "Excalidraw", "outside"]) {
		assert.ok(!paths.some((p) => p.includes(bad)), `leaked ${bad}: ${paths.join(", ")}`);
	}
	const all = JSON.stringify(search(vault, "segreto privato daily", { limit: 25 }));
	assert.ok(!all.includes("SEGRETO-PRIVATO") && !all.includes("DAILY-PRIVATO"));
});

test("search: gated daily folder becomes searchable only after an explicit grant", () => {
	const local = makeVault();
	try {
		assert.equal(search(local.vault, "DAILY-PRIVATO").length, 0);
		local.vault.grants.gated.add("3 - Daily");
		local.vault.refresh(true);
		assert.equal(search(local.vault, "DAILY-PRIVATO")[0]?.path, "3 - Daily/2026_10_01.md");
	} finally {
		local.cleanup();
	}
});

test("search: index-linked notes get the index boost", () => {
	const hits = search(vault, "aritmetica modulare congruenza");
	const congr = hits.find((h) => h.path.endsWith("Congruenza Modulare.md"))!;
	assert.ok(congr.matched.includes("index-linked"));
	assert.deepEqual(congr.linkedFromIndex, ["Aritmetica Modulare"]);
});

test("search: aliases and tags are searchable", () => {
	assert.equal(search(vault, "Regola del prodotto")[0].path, "6 - Atomic Notes/Combinatoria - Principio della moltiplicazione.md");
	assert.ok(search(vault, "cysec").some((h) => h.path.includes("Getting Started")));
});

test("links: resolved, alias, heading found/missing, unresolved, ambiguous, excluded", () => {
	const idx = vault.notes.get("4 - Indexes/Aritmetica Modulare.md")!;
	const res = idx.parsed!.links.map((l) => resolveLink(vault, idx.path, l));
	const by = (raw: string) => res.find((r) => r.link.raw === raw)!;
	assert.equal(by("[[Congruenza Modulare]]").status, "resolved");
	assert.equal(by("[[Congruenza Modulare]]").path, "2 - Source Material/Chats/Math/Congruenza Modulare.md");
	assert.equal(by("[[Principio della Piccionaia applicato ai Residui Modulari|Piccionaia sui residui]]").status, "resolved");
	assert.equal(by("[[Inverso Moltiplicativo Modulare]]").status, "unresolved");
	assert.equal(by("[[Proprietà della Congruenza Modulare]]").status, "unresolved");
	const h = by("[[Divisione Euclidea e Resto#Teorema]]");
	assert.deepEqual(h.heading, { requested: "Teorema", found: true, line: 7 });
	assert.equal(by("[[Divisione Euclidea e Resto#Sezione che non esiste]]").heading?.found, false);
	const amb = by("[[Untitled]]");
	assert.equal(amb.status, "ambiguous");
	assert.deepEqual(amb.candidates!.sort(), ["1 - Rough Notes/Untitled.md", "2 - Source Material/Chats/Cybersecurity/Untitled.md"]);
	const priv = resolveLink(vault, idx.path, parseReference("[[Diario segreto]]"));
	assert.equal(priv.status, "excluded");
	assert.equal(priv.path, undefined, "excluded paths are not revealed");
});

test("links: relative markdown links, attachments, external absolute paths, code ignored", () => {
	const n = vault.notes.get("6 - Atomic Notes/Combinatoria - Principio della moltiplicazione.md")!;
	const res = n.parsed!.links.map((l) => resolveLink(vault, n.path, l));
	assert.deepEqual(
		res.map((r) => [r.status, r.path ?? null]),
		[
			["resolved", "4 - Indexes/Combinatoria.md"],
			["resolved", "4 - Indexes/Combinatoria.md"],
			["external", null],
		],
	);
	const att = resolveLink(vault, n.path, parseLinks("![[figura-piccionaia.png]]")[0]);
	assert.equal(att.status, "attachment");
	const esc = resolveLink(vault, n.path, parseLinks("[x](../../../etc/passwd.md)")[0]);
	assert.equal(esc.status, "external");
});

test("backlinks", () => {
	const bl = backlinks(vault, "2 - Source Material/Chats/Math/Principio della Piccionaia applicato ai Residui Modulari.md").map((b) => b.path).sort();
	assert.deepEqual(bl, ["4 - Indexes/Aritmetica Modulare.md", "6 - Atomic Notes/Combinatoria - Pigeonhole Principle.md"]);
});

test("large notes: indexed up to maxIndexBytes, flagged truncated", () => {
	const local = makeVault({ limits: { maxIndexBytes: 4096 } });
	try {
		const big = "# Big\n" + "riga di testo lunga ".repeat(2000) + "\nFINE-NASCOSTA\n";
		fs.writeFileSync(path.join(local.root, "2 - Source Material", "Big.md"), big);
		local.vault.refresh(true);
		const n = local.vault.notes.get("2 - Source Material/Big.md")!;
		assert.equal(n.parsed!.truncated, true);
		assert.ok(n.parsed!.text.length <= 4096);
		assert.equal(search(local.vault, "FINE-NASCOSTA").length, 0);
	} finally {
		local.cleanup();
	}
});

test(".ajson embedding files are never indexed or modified", () => {
	const f = path.join(tv.root, ".smart-env/multi/6_Atomic_Notes_Combinatoria.ajson");
	const before = fs.statSync(f).mtimeMs;
	vault.refresh(true);
	search(vault, "pigeonhole");
	assert.equal(fs.statSync(f).mtimeMs, before);
	assert.ok(![...vault.notes.keys()].some((k) => k.includes(".smart-env")));
});
