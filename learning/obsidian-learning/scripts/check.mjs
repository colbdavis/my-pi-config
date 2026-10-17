// Type-check against the *installed* pi (no dev install of pi packages needed).
// Resolves pi from $PI_PACKAGE_DIR or from the `pi` binary on PATH, and tsc
// from PATH or ~/.pi/agent/node_modules/.bin/tsc (installed by my-pi-config).
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { piPackageDir } from "../test/helpers/pi-runtime.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pi = piPackageDir();
const nm = path.join(pi, "node_modules");
const tscCandidates = [process.env.TSC, path.join(os.homedir(), ".pi/agent/node_modules/.bin/tsc")].filter(Boolean);
let tsc = tscCandidates.find((c) => fs.existsSync(c));
if (!tsc) {
  try { tsc = execFileSync("which", ["tsc"]).toString().trim(); } catch { /* none */ }
}
if (!tsc) { console.error("tsc not found (set TSC=/path/to/tsc)"); process.exit(2); }
const typesNode = [path.join(os.homedir(), ".pi/agent/node_modules/@types"), path.join(nm, "@types")].find((p) => fs.existsSync(path.join(p, "node")));
const tsconfig = {
  compilerOptions: {
    allowImportingTsExtensions: true, module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, skipLibCheck: true,
    strict: true, target: "ES2022", verbatimModuleSyntax: true, types: ["node"], ...(typesNode ? { typeRoots: [typesNode] } : {}),
    paths: {
      "@earendil-works/pi-coding-agent": [path.join(pi, "dist/index.d.ts")],
      "@earendil-works/pi-ai": [path.join(nm, "@earendil-works/pi-ai/dist/index.d.ts")],
      "@earendil-works/pi-tui": [path.join(nm, "@earendil-works/pi-tui/dist/index.d.ts")],
      typebox: [path.join(nm, "typebox/build/index.d.mts")],
    },
  },
  include: [path.join(root, "src/**/*.ts"), path.join(root, "extension/**/*.ts"), path.join(root, "agent-workspaces/role.ts")],
};
const tmp = path.join(os.tmpdir(), `obsidian-learning-tsconfig-${process.pid}.json`);
fs.writeFileSync(tmp, JSON.stringify(tsconfig, null, 2));
const r = spawnSync(tsc, ["-p", tmp], { stdio: "inherit" });
fs.unlinkSync(tmp);
process.exit(r.status ?? 1);
