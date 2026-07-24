# Setup

See [README.md](README.md) for installation and attribution.

After copying `agent/` to `~/.pi/agent`, install dependencies:

```sh
cd ~/.pi/agent
npm install
for directory in extensions/*; do
  [ ! -f "$directory/package.json" ] || npm install --prefix "$directory"
done
```

The `file-search` extension uses system `fd`/`fdfind` and `rg` when available. Otherwise, on supported macOS/Linux architectures it downloads official fallback binaries into the ignored `~/.pi/agent/bin/` directory.

Authenticate locally using `/login` or provider environment variables. Authentication files, sessions, workflow runs, and other private runtime state are excluded from this repository.
