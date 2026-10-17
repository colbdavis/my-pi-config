/**
 * Bridge from Eero's agent definitions (.pi/agents/*.md, written for
 * pi-interactive-subagents) to the user's existing `subagents` extension
 * (`subagent_spawn`). No second subagent implementation is installed.
 *
 *  - svg-maker / mermaid-maker: harness "pi", working_dir = a workspace under
 *    agent-workspaces/<agent>/ whose project extension (role.ts) loads the
 *    maker's tools from visual-tools, restricts active tools to the agent's
 *    `tools:` list, appends the agent body to the system prompt, and installs
 *    the vault guard.
 *  - researcher: harness from config (default "codex", which has built-in web
 *    search); the agent body is prepended to the task because non-pi harnesses
 *    don't load pi extensions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./markdown.ts";

export const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export interface AgentDefinition {
	name: string;
	description: string;
	tools: string[];
	model?: string;
	body: string;
	file: string;
}

export function defaultAgentsDir(): string {
	// <project>/obsidian-learning (this package) → <project>/.pi/agents (Eero's learn checkout)
	return path.join(path.dirname(PKG_DIR), ".pi", "agents");
}

export function loadAgent(agentsDir: string, name: string): AgentDefinition {
	if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid agent name: ${name}`);
	const file = path.join(agentsDir, `${name}.md`);
	if (!fs.existsSync(file)) throw new Error(`Agent definition not found: ${file}`);
	const text = fs.readFileSync(file, "utf8");
	const fm = parseFrontmatter(text);
	const toolsRaw = fm.data.tools;
	const tools = (Array.isArray(toolsRaw) ? toolsRaw : String(toolsRaw ?? "").split(","))
		.map((t) => t.trim())
		.filter(Boolean);
	return {
		name: String(fm.data.name ?? name),
		description: String(fm.data.description ?? ""),
		tools,
		model: fm.data.model ? String(fm.data.model) : undefined,
		body: text.slice(fm.bodyOffset).trim(),
		file,
	};
}

export const MAKERS = ["svg-maker", "mermaid-maker"] as const;

export interface SpawnBrief {
	tool: "subagent_spawn";
	args: { name: string; harness: "pi" | "codex" | "claude"; prompt: string; working_dir?: string };
	notes: string[];
}

export function buildBrief(opts: {
	agent: string;
	task: string;
	cwd: string;
	agentsDir: string;
	researcherHarness: "pi" | "codex" | "claude";
}): SpawnBrief {
	const def = loadAgent(opts.agentsDir, opts.agent);
	const notes: string[] = [];
	if ((MAKERS as readonly string[]).includes(opts.agent)) {
		const ws = path.join(PKG_DIR, "agent-workspaces", opts.agent);
		if (!fs.existsSync(ws)) throw new Error(`Workspace missing for ${opts.agent}: ${ws}`);
		if (opts.agent === "mermaid-maker") {
			notes.push(
				"mermaid-maker needs @mermaid-js/mermaid-cli in .pi/extensions/visual-tools (npm install) and a Chrome that visual-tools can find (its candidate list is macOS-only). Prefer svg-maker on this machine unless that has been set up.",
			);
		}
		notes.push("The maker publishes into its workspace's viz directory (a symlink into the vault's learning Visuals folder created by /learn-init). Embed the returned filename as ![[filename|500]].");
		return {
			tool: "subagent_spawn",
			args: { name: opts.agent, harness: "pi", working_dir: path.relative(opts.cwd, ws) || ".", prompt: opts.task },
			notes,
		};
	}
	const harness = opts.researcherHarness;
	if (harness === "pi") notes.push("The pi harness has no web_search/web_fetch in this configuration; the researcher can only reason from what it can read. Prefer harness codex or claude for web research.");
	if (def.tools.includes("safe_bash")) notes.push("safe_bash (pi-interactive-subagents) is unavailable. The installed external child harnesses have full filesystem access and do not run the learning vault guard; strictBash must be explicitly disabled to use them.");
	return {
		tool: "subagent_spawn",
		args: {
			name: opts.agent,
			harness,
			prompt: `${def.body}\n\n---\n\nTASK (self-contained; you have no access to the conversation or to the learner's notes):\n${opts.task}`,
		},
		notes,
	};
}
