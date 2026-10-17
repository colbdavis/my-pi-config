/**
 * Role extension for maker subagent workspaces.
 *
 * Your `subagents` extension starts a child pi session with working_dir set to
 * agent-workspaces/<agent>/, and pi loads that directory's .pi/extensions/role.ts.
 * The role:
 *   1. registers the maker's authoring tools (from Eero's visual-tools, unmodified),
 *   2. restricts active tools to the `tools:` list in .pi/agents/<agent>.md,
 *   3. appends the agent definition body to the system prompt (`system-prompt: append`),
 *   4. installs the vault guard so the child cannot reach the vault either.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultAgentsDir, loadAgent } from "../src/agents.ts";
import { loadConfig } from "../src/config.ts";
import { checkToolCall } from "../src/guard.ts";
import { emptyGrants } from "../src/policy.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export function createRole(agent: string, toolFactories: Array<(pi: ExtensionAPI) => void>) {
	return function role(pi: ExtensionAPI) {
		for (const register of toolFactories) register(pi);
		let cfg: ReturnType<typeof loadConfig> | null = null;
		try {
			cfg = loadConfig();
		} catch {
			cfg = null;
		}
		const def = loadAgent(cfg?.agents.agentsDir ?? defaultAgentsDir(), agent);

		pi.on("session_start", async () => {
			const available = new Set(pi.getAllTools().map((t) => t.name));
			const wanted = def.tools.filter((t) => available.has(t));
			pi.setActiveTools(wanted);
		});

		pi.on("before_agent_start", async (event) => ({
			systemPrompt: `${event.systemPrompt}\n\n${def.body}`,
		}));

		pi.on("tool_call", async (event, ctx) => {
			if (!cfg?.vaultPath || !fs.existsSync(cfg.vaultPath)) return;
			const root = fs.realpathSync(cfg.vaultPath);
			const d = checkToolCall(
				{ cfg, vaultRoot: root, vaultRootRaw: path.resolve(cfg.vaultPath), cwd: ctx.cwd, grants: emptyGrants() },
				event.toolName,
				event.input,
			);
			if (d.block) return { block: true, reason: d.reason };
		});
	};
}
