# Obsidian learning for Pi

A local Pi package connecting Eero Alvar's `teach`, `quiz`, `ask-user-question`,
`md-log` and `visualize` to an existing Obsidian vault. Knowledge stays in its
original folders; learning state lives in `8 - Learning System/`.

## Installed layout

Teaching components are by **[Eero Alvar (`amosblomqvist`)](https://github.com/amosblomqvist/learn)**.
See [third-party attribution](../../THIRD_PARTY.md).

The learning integration is loaded globally through `~/.pi/agent/settings.json`:
- `packages` loads `~/.pi/learning/obsidian-learning`.
- `extensions` loads quiz, ask-user-question, md-log and visual-tools from the
  sibling `.pi/extensions/` checkout.
- `skills` loads teach and visualize from that checkout.

Start `pi` from any directory. Existing global model, theme and extensions are
retained. The sibling project settings support loading from `learning/` too;
Pi resolves the same paths without loading them twice.
Global settings use paths relative to `~/.pi/agent/`; keep the sibling layout intact.

Verified on Node 26.10.0 and Pi 0.82.0. The package adds no runtime dependencies:
Pi supplies its own extension SDK, TUI and TypeBox. Native Node TypeScript support
is required for tests. The type-check script finds your installed Pi and `tsc`.

```sh
pi
```

On another machine, retain the sibling layout (`.pi/` and `obsidian-learning/`),
install Pi, add the package and upstream extension/skill paths to your global
`~/.pi/agent/settings.json`, retain your existing subagents extension, and configure:

```json
{
  "vaultPath": "/absolute/path/to/your/vault",
  "timezone": "America/Detroit",
  "strictBash": true,
  "extraRules": [
    { "prefix": "2 - Source Material/Chats/Lifestyle", "access": "excluded" }
  ]
}
```

Save that as `~/.config/obsidian-learning/config.json` (or under
`$XDG_CONFIG_HOME`). `OBSIDIAN_LEARNING_CONFIG` selects another file;
`OBSIDIAN_LEARNING_VAULT` overrides the vault path. `OBSIDIAN_LEARNING_TZ` selects
a timezone when the file does not specify one. No vault location is hardcoded in
package source. Create this local configuration before using the vault tools.

In Pi, run `/learn-status`, then `/learn-init`. Initialization seeds the profile,
tracker and queue once and creates Sessions, Assessments and Visuals. It does not
replace existing files. `/learn-init` also links each maker workspace's `viz/`
directory to learning Visuals; existing `viz/` directories are retained.

## Use

| Command / prompt | Behavior |
|---|---|
| `/learn-status` | Reload configuration; report coverage and reviews |
| `/learn-init` | Initialize learning state without replacing existing files |
| `/learn-session Aritmetica modulare` | Create a raw transcript and prefill `/md-log …`; press Enter to link |
| `/learn-review` | Select due or overdue concepts and start assessment |
| `/learn-mode direct` | Explicit direct explanation mode |
| `/learn-mode socratic` | Restore hints-first tutoring |
| `/learn-allow-daily` | Unlock daily notes for this Pi session |
| `/learn-rollback` | Select an approved edit to undo |
| `Insegnami aritmetica modulare usando il mio vault.` | Navigate the index, probe knowledge, adapt teaching |
| `Interrogami sul principio della piccionaia.` | Assess the learner's formulation before proposing a correction |
| `Cosa devo ripassare oggi?` | Query the tracker and assess due concepts |
| `Facciamo una sessione di preparazione CCIT.` | Use roadmap notes and weak patterns with hints first |
| `Aggiorna i miei appunti con quello che ho imparato.` | Find existing notes, propose precise diffs, obtain approval |

For a note edit, the dialog shows the diff: **a** applies all; **c** chooses
individual edits; **r** or Escape rejects. A changed source invalidates the
proposal. Backups go outside the vault, by default to
`~/.local/state/obsidian-learning/backups` (`$XDG_STATE_HOME` respected).
`/learn-rollback <backup-id>` restores the earlier version; if the note changed
again, a separate confirmation is required and newer content is preserved too.

The Learning Profile is editable in Obsidian. It records your 15-question,
62-minute pretest preference and marks the four-problem programming duration as
**unverified**. Those are preparation settings, not a claim about published 2027
rules.

## State and review rules

`Mastery Tracker.md` is a hand-editable Markdown table with linked notes, status,
stage, assessment dates, next review, evidence links, misconceptions and sessions.
`Review Queue.md` is regenerated from it on demand. Assessments preserve actual
learner answers; transcripts and session summaries are distinct from knowledge.

Answers must reference an answered upstream quiz/question call or an exact quote
from a learner message in the active branch. Quiz results supply their own grade;
multiple choice counts at most as understanding. Free answers are graded by the
tutor. A lesson alone cannot update proficiency. In-lesson success reaches
`practicing`; independent or delayed success can reach `demonstrated`.

An assessment passes when all items are correct, at least one understanding or
application item used no hints, and no item needed a key-step or solution hint.
Any wrong understanding/application answer, or at least half wrong, fails;
other outcomes are partial. Recognition alone never suffices to pass.

First evidence schedules +3 days. Successful delayed reviews schedule +10, then
+30 days, then 30-day maintenance. Failure resets the stage and schedules +1 day;
partial results use the previous interval. In-lesson success retains an existing
review date. Dates use the configured local timezone and calendar arithmetic.
No daemon is installed and no retention guarantee is implied.

## Boundaries and tradeoffs

- Retrieval is deterministic lexical search (names, aliases, headings, tags,
  body), with index-link boosts and bounded excerpts. Headings are navigation,
  not prerequisite or mastery claims. AI conversations are labeled unverified.
- Source material, rough notes and templates are read-only; indexes and atomic
  notes require approved proposals. Daily notes are gated. Hidden/plugin data,
  private rough notes, root notes and Excalidraw are excluded by default.
  `extraRules` allows narrowly scoped exceptions; the longest prefix wins.
- Traversal and symlink escapes are rejected. General tools cannot directly read
  Markdown or write files in the vault; allowed attachments can be viewed.
  Backups must be outside the vault. Approved writes recheck policy and source
  hashes, preserve unrelated bytes, then write atomically.
- Coding is enabled by default. Use `/coding off` for learning mode,
  `/coding on` for coding, or `/coding` to toggle. The switch lasts until restart
  or reload. Tutoring instructions apply only in learning mode; vault access
  checks remain active in both modes. Coding allows general shell execution
  (the shell marker guard is best effort, not a sandbox).
  In learning mode, `strictBash: true` disables model-driven bash, background shell launches, workflows
  and external child harnesses. Pi children are limited to maker workspaces with
  restricted role tools. The global `ask_user` remains installed but is inactive
  in learning sessions so upstream question/quiz/approval popups share one lock.
- Within learning mode, set `strictBash: false` only for trusted execution when you need program runs
  or external researcher harnesses. The existing Codex child backend explicitly
  uses `danger-full-access` and `approvalPolicy: never`; its calls bypass this
  vault guard. The shell marker guard in this mode is best effort, not a sandbox.
- Pi extensions, slash commands, renderers and manually launched programs are
  trusted code running with your OS permissions. This package does not provide
  OS isolation or prevent hostile code from reading private files. Use an OS
  sandbox for that requirement. Renderer source should come from a trusted brief.
- SVG authoring/rendering is verified with installed `rsvg-convert` (fallback:
  `magick`). Mermaid needs `@mermaid-js/mermaid-cli` plus a usable Chrome; these
  are not installed/verified here and upstream Chrome discovery targets macOS.
  Prefer SVG on this Arch installation. Research with paid models was not run.
- PDFs/images are not text-indexed; `.ajson` embeddings and Obsidian's own spaced
  repetition markers are untouched. Frontmatter parsing supports common note
  fields and lists, not all YAML constructs. Concurrent Syncthing changes can
  race a final hash check; atomic writes protect file integrity, not distributed
  locking. Assessment/tracker/queue updates are not one filesystem transaction.
- Scripted SDK tests verify integration, not the teaching quality or fact accuracy
  of a live model. Evidence authenticates the answer; interpretation of hints,
  independence and free-answer correctness still depends on the tutor.

## Verify

```sh
cd obsidian-learning
npm test
npm run check
npm run smoke
# Also verify global loading outside this project:
npm run smoke -- --global
```

Tests use disposable synthetic vaults with privacy, symlink and traversal traps.
SDK tests load the real installed Pi and upstream quiz/approval components and
use a local scripted provider, with no model API calls. `smoke` loads your global
and project extensions and performs read-only retrieval in the configured real
vault. `PI_PACKAGE_DIR` and `TSC` can select an installation/compiler explicitly.

See [UPSTREAM-PATCHES.md](docs/UPSTREAM-PATCHES.md) for maintained upstream changes.
Personal audit reports and vault inventories are intentionally not distributed.

## Update and uninstall

Vendored upstream files are pinned to `amosblomqvist/learn` commit `7cfd894`.
Keep local patches before pulling, then reapply and rerun tests as explained in
[UPSTREAM-PATCHES.md](docs/UPSTREAM-PATCHES.md). No second subagent system or
memory implementation is installed.

To disable just the vault integration, remove its entry from `packages`
in `~/.pi/agent/settings.json` and restart Pi. To disable the global upstream
learning components too, remove their paths from `extensions` and `skills`.
Inside this project the sibling `.pi/` checkout still supplies upstream components
through project discovery. Back up settings before changing the installation.
Keep `8 - Learning System/` for history, or archive it manually. Remove only the
`viz` symlinks pointing there if you uninstall. Configuration and external backups
may also be archived. Existing knowledge notes are changed only through approved
edits; use `/learn-rollback` before disabling the package if those edits should
be undone.
