# my-pi-config

Personal configuration for the [pi coding agent](https://pi.dev), focused on coding, defensive cybersecurity study, and terminal-friendly IT learning.

## Included

- Dracula theme and preferred model/settings defaults
- Coding and security-focused global instructions
- Reusable prompts for explanations, labs, crypto, and security review
- Skills for background terminals, subagents, crypto CTFs, cybersecurity study, and IT concepts
- Global teaching, quizzes, visualizations and Obsidian learning/review integration
- Extensions for user questions, background terminals, file search, git/model information, subagents, summaries, UI customization, and workflows

## Extension attribution

The original coding extensions in `agent/extensions/` are from **[davis7dotsh/my-pi-setup](https://github.com/davis7dotsh/my-pi-setup)**. This repository packages those extensions with my own pi settings, instructions, prompts, skills, and theme selection.

The teaching system in `learning/.pi/` is by **[Eero Alvar
(`amosblomqvist`)](https://github.com/amosblomqvist)**, from
**[amosblomqvist/learn](https://github.com/amosblomqvist/learn)** at commit
`7cfd8942f82ab9476e63572387e1fe9bcea5082c`. It supplies the teach/visualize skills,
quiz and question dialogs, Markdown logging, visual tools and agent prompts.
The Obsidian adapter in `learning/obsidian-learning/` adds vault retrieval,
review tracking and approved note edits. See [THIRD_PARTY.md](THIRD_PARTY.md).

## Install

Back up your existing pi configuration first, then clone and copy the configuration:

```sh
git clone https://github.com/colbdavis/my-pi-config.git
cd my-pi-config
mkdir -p ~/.pi/agent ~/.pi/learning
cp -a agent/. ~/.pi/agent/
cp -a learning/. ~/.pi/learning/
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
Learning paths in `agent/settings.json` resolve relative to `~/.pi/agent/`.
Configure your vault separately as described in
[the learning guide](learning/obsidian-learning/README.md); personal vault paths
and contents are not included.

Coding is enabled by default in every session. Use `/coding off` to enable
learning mode, `/coding on` to return to coding, or `/coding` to toggle.
The switch applies to the current session; restarting or reloading defaults to coding.
Learning mode adds tutoring instructions and, with a configured vault and
`strictBash: true`, disables model-driven shell, background launches and workflows.
Coding mode keeps vault access checks but permits general code execution.
See the learning guide for details.

## Privacy

This repository intentionally excludes authentication data, API keys, session transcripts, workflow runs, trust state, downloaded binaries, model caches, private extension configuration, and installed dependencies. Supply authentication locally with pi's `/login` command or environment variables; never commit credentials.
