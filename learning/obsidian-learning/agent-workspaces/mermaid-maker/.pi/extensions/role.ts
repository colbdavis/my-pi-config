// Loaded by the child pi session when subagent_spawn runs with working_dir = this workspace.
import mermaidTools from "../../../../../.pi/extensions/visual-tools/tools/mermaid_tools.ts";
import { createRole } from "../../../role.ts";

export default createRole("mermaid-maker", [mermaidTools]);
