import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type LearningConfig, loadConfig } from "../../src/config.ts";
import { LearningStore } from "../../src/learning.ts";
import { emptyGrants } from "../../src/policy.ts";
import { Vault } from "../../src/vault.ts";

export const FIXTURE = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "fixtures", "vault");

export interface TestVault {
	tmp: string;
	root: string;
	outside: string;
	configFile: string;
	cfg: LearningConfig;
	vault: Vault;
	store: LearningStore;
	cleanup(): void;
}

/** Fresh copy of the fixture vault in a temp dir, with symlink traps and a config file. */
export function makeVault(extra: Record<string, unknown> = {}): TestVault {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ol-test-"));
	const root = path.join(tmp, "My Vault");
	fs.cpSync(FIXTURE, root, { recursive: true });
	const outside = path.join(tmp, "outside");
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(outside, "secret.md"), "# Outside\nOUTSIDE-SECRET piccionaia\n");
	// Symlink traps: a file and a folder escaping the vault, and a link into Private.
	fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "6 - Atomic Notes", "Escape.md"));
	fs.symlinkSync(outside, path.join(root, "6 - Atomic Notes", "outside-dir"));
	fs.symlinkSync(path.join(root, "1 - Rough Notes", "Private", "Diario segreto.md"), path.join(root, "6 - Atomic Notes", "Diario link.md"));
	const configFile = path.join(tmp, "config.json");
	fs.writeFileSync(
		configFile,
		JSON.stringify(
			{
				vaultPath: root,
				timezone: "Europe/Rome",
				backupDir: path.join(tmp, "backups"),
				extraRules: [{ prefix: "2 - Source Material/Chats/Lifestyle", access: "excluded" }],
				...extra,
			},
			null,
			2,
		),
	);
	const cfg = loadConfig({ env: { OBSIDIAN_LEARNING_CONFIG: configFile } as any });
	const vault = new Vault(cfg, emptyGrants());
	vault.refresh(true);
	const store = new LearningStore(vault);
	return { tmp, root, outside, configFile, cfg, vault, store, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

export function read(root: string, rel: string): string {
	return fs.readFileSync(path.join(root, rel), "utf8");
}

/** Build fake session entries the way pi stores them. */
export function userMsg(text: string) {
	return { type: "message", id: Math.random().toString(36).slice(2), message: { role: "user", content: [{ type: "text", text }] } };
}
export function quizResult(toolCallId: string, opts: { correct?: boolean; dontKnow?: boolean; question?: string; answer?: string; status?: string } = {}) {
	return {
		type: "message",
		id: toolCallId + "-r",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "quiz",
			isError: false,
			content: [{ type: "text", text: "…" }],
			details: {
				status: opts.status ?? "answered",
				question: opts.question ?? "Quante persone almeno nello stesso mese su 52?",
				mode: "single-select",
				answers: opts.dontKnow ? [] : [{ label: opts.answer ?? "5", value: "5", index: 1 }],
				correctIndices: [1],
				options: [
					{ index: 1, label: "5" },
					{ index: 2, label: "4" },
				],
				correct: opts.correct ?? true,
				dontKnow: opts.dontKnow ?? false,
			},
		},
	};
}
export function askResult(toolCallId: string, answer: string) {
	return {
		type: "message",
		id: toolCallId + "-r",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "ask_user_question",
			isError: false,
			content: [{ type: "text", text: `User answered: ${answer}` }],
			details: { status: "answered", question: "Spiega perché", mode: "text", answers: [{ type: "text", label: answer, value: answer }] },
		},
	};
}
