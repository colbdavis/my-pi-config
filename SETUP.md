# Setup

See [README.md](README.md) for installation and attribution.

Copy both `agent/` to `~/.pi/agent` and `learning/` to `~/.pi/learning` as
shown in the README, then install dependencies:

```sh
cd ~/.pi/agent
npm install
for directory in extensions/*; do
  [ ! -f "$directory/package.json" ] || npm install --prefix "$directory"
done
```

The `file-search` extension uses system `fd`/`fdfind` and `rg` when available. Otherwise, on supported macOS/Linux architectures it downloads official fallback binaries into the ignored `~/.pi/agent/bin/` directory.

Authenticate locally using `/login` or provider environment variables. Authentication files, sessions, workflow runs, and other private runtime state are excluded from this repository.

Configure the vault in `~/.config/obsidian-learning/config.json`; see the
[learning guide](learning/obsidian-learning/README.md). Optional Mermaid rendering
requires dependencies in `~/.pi/learning/.pi/extensions/visual-tools/` and Chrome.
SVG rendering uses system `rsvg-convert` or ImageMagick.
