# Configuration

gitpicho keeps its config in `~/.config/gitpicho/config.json` (or `$XDG_CONFIG_HOME/gitpicho/config.json`). Set `GITPICHO_CONFIG=/path/to/config.json` to use another file. Everything below can be edited from the app (⚙ button); editing the JSON by hand also works — the app re-reads it on every refresh.

## Top level

| Key | Default | Description |
| --- | --- | --- |
| `roots` | `[]` | Workspaces (see below). |
| `extra` | `[]` | Single repos outside any workspace: `{ "path": "~/x/repo", "identity": "<workspace name>" }`. |
| `hidden` | `[]` | Absolute paths of repos hidden from the list (toggle from the repo header). |
| `scanDepth` | `3` | How many folder levels to go down looking for repos (worktrees like `wt/feature/repo` need 3). |
| `terminal` | `""` | Terminal used by the Terminal / lazygit / Claude buttons. Empty = `$TERMINAL`, then the first one found of ghostty, kitty, alacritty, wezterm, gnome-terminal, konsole, xfce4-terminal, foot, x-terminal-emulator. macOS uses Terminal.app. |
| `editor` | `"code"` | Command to open repos and files. `code`, `codium`, `cursor` and `windsurf` open files at the right line (`-g file:line`). |
| `reviewModel` | `"sonnet"` | Claude model for reviews, PR descriptions and conflict suggestions. |
| `commitModel` | `"haiku"` | Claude model for commit message suggestions. |
| `port` | `7777` | Port for web mode (`node server.js`). `PORT` env var wins. The desktop app uses 47777 or a free one. |

## Workspace (`roots[]`)

| Key | Required | Description |
| --- | --- | --- |
| `name` | yes | Unique label (`[A-Za-z0-9._-]`). |
| `dir` | yes | Folder with repos. Every subfolder is scanned up to `scanDepth`. If `dir` itself is a repo, only that repo is shown. |
| `color` | no | `mauve`, `blue`, `peach`, `green`, `teal`, `pink`, `yellow`, `red`. |
| `sshHost` | no | Expected `Host` alias from `~/.ssh/config`. Remotes using a different host, plain `github.com` or HTTPS get a warning. |
| `gitconfig` | no | File whose `user.email` is the expected one. Repos committing with another email get a warning. |
| `claudeConfigDir` | no | Sets `CLAUDE_CONFIG_DIR` for every Claude call in this workspace (separate accounts/settings). |
| `vault` | no | Folder of notes (docs, Obsidian vault…) the reviewer may read for business context. |
| `ghConfigDir` | no | Sets `GH_CONFIG_DIR` for the PR view. Workspaces without it share the default `gh` login. |

## Data on disk

| Path | What |
| --- | --- |
| `~/.config/gitpicho/config.json` | Config. |
| `~/.local/share/gitpicho/reviews/` | Saved Claude reviews (one folder per repo). |
| `~/.local/state/gitpicho/gitpicho.log` | Launcher log. |
| Electron `userData` | Window size/position. |
