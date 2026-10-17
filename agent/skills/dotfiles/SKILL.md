---
name: dotfiles
description: Manage Tod's dotfiles using the bare Git repository ~/.dotfiles and the home directory as its worktree. Use for personal configuration changes (Waybar, Hyprland, shell), status/diff checks, commits, and pushes to GitHub and Codeberg, even when working from another directory.
---

# Tod's dotfiles

## Verified setup

- **Bare repository**: `/home/tod/.dotfiles`; worktree: `/home/tod` (`$HOME`). This is not a checkout inside the current project directory and does not use Stow.
- Edit configurations directly at their actual locations, such as `~/.config/waybar/` and `~/.zshrc`.
- Zsh aliases `dotf` and `dotfiles`: `/usr/bin/git --git-dir=$HOME/.dotfiles/ --work-tree=$HOME`. Use the explicit command in tools: aliases may not be loaded.
- Current branch when this skill was created: `main`. Recheck before Git operations.
- `status.showUntrackedFiles=no`: a clean status does NOT guarantee that new files are tracked. Explicitly check relevant new files.
- `origin`: fetches from `https://github.com/colbdavis/dotfiles.git`, with two push URLs:
  - `https://github.com/colbdavis/dotfiles.git`
  - `git@codeberg.org:colbdavis/dotfiles.git`
- A separate `codeberg` remote also exists with the same SSH URL. Pushing to `origin` already publishes to both destinations; a second push to `codeberg` is unnecessary.
- These details describe the verified configuration, not permission to restore it if it changes. Recheck the branch and remotes before publishing.

## Workflow

1. Distinguish the current project's repository from the dotfiles repository. Do not use `git` without `--git-dir` and `--work-tree` to manage the home directory. Do not initialize a repository in the home directory.
2. Before editing, inspect status and diffs; preserve existing changes and staged files:
   ```bash
   /usr/bin/git --git-dir="$HOME/.dotfiles" --work-tree="$HOME" -C "$HOME" status --short
   /usr/bin/git --git-dir="$HOME/.dotfiles" --work-tree="$HOME" -C "$HOME" diff
   /usr/bin/git --git-dir="$HOME/.dotfiles" --work-tree="$HOME" -C "$HOME" diff --cached
   /usr/bin/git --git-dir="$HOME/.dotfiles" --work-tree="$HOME" -C "$HOME" branch --show-current
   /usr/bin/git --git-dir="$HOME/.dotfiles" --work-tree="$HOME" -C "$HOME" remote get-url --push --all origin
   ```
3. Read the affected files and make minimal changes at their actual locations. Run focused checks (syntax, configuration, scripts, SVGs, etc.). Reload services only when relevant and safe; avoid unnecessary restarts.
4. Do not commit or push unless the user requests it. When requested, stage **only relevant files using explicit paths**, relative to the home directory through `-C "$HOME"`. Never use `add .`, `add -A`, or indiscriminate staging of the home directory.
   ```bash
   /usr/bin/git --git-dir="$HOME/.dotfiles" --work-tree="$HOME" -C "$HOME" add -- .config/waybar/config.jsonc .config/waybar/scripts/dock-apps.py
   /usr/bin/git --git-dir="$HOME/.dotfiles" --work-tree="$HOME" -C "$HOME" diff --cached --check
   /usr/bin/git --git-dir="$HOME/.dotfiles" --work-tree="$HOME" -C "$HOME" diff --cached --stat
   /usr/bin/git --git-dir="$HOME/.dotfiles" --work-tree="$HOME" -C "$HOME" diff --cached
   ```
   The paths above are examples: replace them with the files actually changed, including any new files. If existing staging includes unrelated work, stop and ask how to separate it; neither commit nor unstage it without consent.
5. Before publishing, inspect staged contents for secrets and private data. Do not add credentials, `.env` files, cookies, history, logs, or Pi sessions. Respect `~/.gitignore`; do not bypass it with `add -f` without an explicit request. If a secret scanner is unavailable, report the manual review without guaranteeing the absence of secrets.
6. For commit messages, load the `caveman-commit` skill if available; use concise Conventional Commits, such as `feat(waybar): add Obsidian launcher`.
7. If the verified branch is `main`, perform requested commits and pushes as follows:
   ```bash
   /usr/bin/git --git-dir="$HOME/.dotfiles" --work-tree="$HOME" -C "$HOME" commit -m 'type(scope): description'
   /usr/bin/git --git-dir="$HOME/.dotfiles" --work-tree="$HOME" -C "$HOME" push origin main
   ```
   If the branch differs, do not assume it should be published to `main`: verify the user's intent. Push only after a successful commit (or when the user requests publishing existing commits). Never force-push, perform destructive resets or cleans, or rewrite history without explicit authorization.
8. Check the outcome for **both push URLs**: one may succeed while the other fails. Do not report complete success if only one mirror is updated; report partial success and do not rewrite remotes to work around errors.
9. Verify the final status and latest commit. Respond in the user's preferred language with the commit hash, mirror outcomes, checks performed, and any remaining changes. Do not claim a clean worktree without verification, and remember that ordinary status output hides new files.
