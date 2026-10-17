// Loaded by the child pi session when subagent_spawn runs with working_dir = this workspace.
import svgTools from "../../../../../.pi/extensions/visual-tools/tools/svg_tools.ts";
import { createRole } from "../../../role.ts";

export default createRole("svg-maker", [svgTools]);
