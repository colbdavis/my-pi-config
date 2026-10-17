// Locate the installed pi package without hardcoding a path.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export function piPackageDir() {
  if (process.env.PI_PACKAGE_DIR) return process.env.PI_PACKAGE_DIR;
  const bin = execFileSync("which", ["pi"]).toString().trim();
  let dir = path.dirname(fs.realpathSync(bin));
  for (let i = 0; i < 5; i++) {
    const pj = path.join(dir, "package.json");
    if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, "utf8")).name === "@earendil-works/pi-coding-agent") return dir;
    dir = path.dirname(dir);
  }
  throw new Error("Could not locate the installed @earendil-works/pi-coding-agent; set PI_PACKAGE_DIR");
}
