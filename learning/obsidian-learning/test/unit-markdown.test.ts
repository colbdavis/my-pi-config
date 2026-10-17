import assert from "node:assert/strict";
import { test } from "node:test";
import { mathSpans, maskCode, parseFrontmatter, parseHeadings, parseLinks, parseTags } from "../src/markdown.ts";

test("frontmatter: block lists, inline lists, quoted values, empty values", () => {
	const t = `---\ndate: 2026-04-13\ntags:\n  - school/math\n  - "cybchall"\naliases: [Regola, 'Prodotto']\nsources: Gemini\nempty:\n---\n# Title\nbody`;
	const fm = parseFrontmatter(t);
	assert.deepEqual(fm.data.tags, ["school/math", "cybchall"]);
	assert.deepEqual(fm.data.aliases, ["Regola", "Prodotto"]);
	assert.equal(fm.data.sources, "Gemini");
	assert.equal(fm.data.empty, null);
	assert.equal(t.slice(fm.bodyOffset), "# Title\nbody");
});

test("frontmatter: absent or unterminated → empty", () => {
	assert.equal(parseFrontmatter("# no fm").raw, "");
	assert.equal(parseFrontmatter("---\ntags: x\nno end").raw, "");
});

test("headings ignore fenced code and frontmatter", () => {
	const t = "---\ntitle: x\n---\n# A\n```\n# not heading\n```\n## B ##\n";
	assert.deepEqual(
		parseHeadings(t).map((h) => [h.level, h.text, h.line]),
		[
			[1, "A", 4],
			[2, "B", 8],
		],
	);
});

test("tags from frontmatter and body, not from code or headings", () => {
	const t = "---\ntags:\n  - school/math\n---\n# Heading\nText #cybchall and `#nottag` #2026 #it/cysec";
	assert.deepEqual(parseTags(t, parseFrontmatter(t)).sort(), ["cybchall", "it/cysec", "school/math"]);
});

test("wikilinks: alias, heading, nested heading, block, embed, same-note, escaped table pipe", () => {
	const t = "[[Note]] [[Note|Alias]] [[Note#Head]] [[Note#H1#H2]] [[Note#^abc]] ![[img.png|500]] [[#Local]] | [[Tab\\|alias]] |";
	const ls = parseLinks(t);
	assert.deepEqual(
		ls.map((l) => [l.target, l.heading ?? null, l.blockId ?? null, l.alias ?? null, l.embed]),
		[
			["Note", null, null, null, false],
			["Note", null, null, "Alias", false],
			["Note", "Head", null, null, false],
			["Note", "H2", null, null, false],
			["Note", null, "abc", null, false],
			["img.png", null, null, "500", true],
			["", "Local", null, null, false],
			["Tab", null, null, "alias", false],
		],
	);
});

test("markdown links: %20, <angle>, heading, skips URLs, keeps absolute paths (resolver marks external)", () => {
	const t = "[a](../4%20-%20Indexes/X.md) [b](<../A B.md#Sec>) [c](https://x.org) [d](/abs/p.md) [e](mailto:x@y)";
	const ls = parseLinks(t);
	assert.deepEqual(
		ls.map((l) => [l.target, l.heading ?? null]),
		[
			["../4 - Indexes/X.md", null],
			["../A B.md", "Sec"],
			["/abs/p.md", null],
		],
	);
});

test("links inside inline code and fenced code are ignored", () => {
	const t = "`[[No]]`\n```\n[[NoEither]]\n```\n[[Yes]]";
	assert.deepEqual(
		parseLinks(t).map((l) => l.target),
		["Yes"],
	);
	assert.equal(maskCode(t).length, t.length);
});

test("math spans: inline and display, not prices in code", () => {
	const t = "Formula $\\lceil n/m \\rceil$ and\n$$\n\\frac{52}{12}\n$$\n`$5 $6`";
	assert.deepEqual(mathSpans(t), ["$\\lceil n/m \\rceil$", "$$\n\\frac{52}{12}\n$$"]);
});
