# my-pi-config

Personal configuration for the [pi coding agent](https://pi.dev), focused on coding, defensive cybersecurity study, and terminal-friendly IT learning.

## Included

- Dracula theme and preferred model/settings defaults
- Coding and security-focused global instructions
- Reusable prompts for explanations, labs, crypto, and security review
- Skills for background terminals, subagents, crypto CTFs, cybersecurity study, and IT concepts
- Extensions for user questions, background terminals, file search, git/model information, subagents, summaries, UI customization, and workflows

## Extension attribution

The extensions in this repository are from **[davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup)**. This repository packages those extensions with my own pi settings, instructions, prompts, skills, and theme selection.

## Install

Back up your existing pi configuration first, then clone and copy the configuration:

```sh
git clone https://github.com/colbdavis/my-pi-config.git
cd my-pi-config
cp -a agent/. ~/.pi/agent/
cd ~/.pi/agent
npm install
for directory in extensions/*; do
  [ ! -f "$directory/package.json" ] || npm install --prefix "$directory"
done
```

You can use the Codeberg mirror instead:

```sh
git clone https://codeberg.org/colbdavis/my-pi-config.git
```

Pi loads the extensions, skills, prompts, theme, and `AGENTS.md` on its next start.

## Privacy

This repository intentionally excludes authentication data, API keys, session transcripts, workflow runs, trust state, downloaded binaries, model caches, private extension configuration, and installed dependencies. Supply authentication locally with pi's `/login` command or environment variables; never commit credentials.
