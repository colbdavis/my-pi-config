# Upstream changes

The sibling `.pi/` directory contains vendored files from Eero Alvar
(`amosblomqvist`), `amosblomqvist/learn` commit `7cfd894`.
`teach`, `visualize`, quiz, question dialogs and agent prompts remain upstream.
Global `agent/settings.json` loads the learning package and upstream components
using relative paths. The sibling project settings also support local tests. Existing global subagents are reused instead of pi-interactive-subagents.

Two small tracked patches are required:

1. `patches/md-log-safe-link.patch`: refuse an existing non-empty knowledge note
   as a log target; retain transcript YAML during backfill. Explicitly linking an
   existing raw transcript still rewrites its history, as upstream md-log does.
2. `patches/visual-tools-cwd.patch`: publishing accepts a cwd and both render tools
   pass the Pi extension context's cwd. The installed subagent harness creates
   child Pi sessions in-process, so `process.cwd()` belongs to the parent and is
   unreliable for locating the child's `viz` directory.

For updates, use a separate clone of upstream at the desired revision. Apply
these patches from the clone root, then copy the updated components into the
vendored `.pi/` directory (the vendored files already contain these patches):

```sh
git apply ../obsidian-learning/patches/md-log-safe-link.patch
git apply ../obsidian-learning/patches/visual-tools-cwd.patch
```

Resolve any patch
conflicts against the new upstream API; do not silently discard the safeguards.
Then run `npm test`, `npm run check` and `npm run smoke` from the package.

The maker role workspaces, learning bridge and tutoring overlay live in the new
package. They adapt the original agent definitions without rewriting them. Model
hints in upstream agent metadata are not forced: the existing child harness
inherits the parent's configured model.
