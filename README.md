# fresh-claude

A Claude Code IDE layout for the [fresh](https://github.com/sinelaw/fresh) terminal editor.

One command opens:

```
┌──────────┬──────────────────────────┬──────────────────────┐
│ File     │  editor (tabs)           │  Claude Code         │
│ Explorer │                          │  (full height)       │
│          ├──────────────────────────┤                      │
│          │  shell                   │                      │
└──────────┴──────────────────────────┴──────────────────────┘
```

Any file created or modified in the workspace — by Claude Code, git, or
anything else — automatically opens as a tab in the editor pane, so you can
watch what Claude is doing while it works. Lines that differ from git HEAD
get a green background, so it's obvious *what* changed in each file, not
just that it did — untracked files are painted whole (everything is new).

## Requirements

- [fresh](https://getfresh.dev) 0.4.x (`brew install sinelaw/fresh/fresh`)
- [fswatch](https://github.com/emcrisostomo/fswatch) (`brew install fswatch` / `apt install fswatch`)
- [Claude Code](https://claude.com/claude-code)
- macOS or Linux

## Install

```sh
git clone https://github.com/mruff-aeq/fresh-claude.git
cd fresh-claude
./install.sh
```

The installer copies `fresh-claude` and `fresh-watch-open` to `~/.local/bin`,
installs `init.ts` to `~/.config/fresh/` (backing up any existing one), and
optionally saves a default workspace directory.

## Usage

```sh
fresh-claude                # open the default (or current) workspace
fresh-claude ~/src/myrepo   # open a specific workspace
```

macOS, new [Ghostty](https://ghostty.org) window:

```sh
open -na Ghostty --args -e fresh-claude
```

Plain `fresh` is unaffected — the layout only activates when the wrapper sets
`FRESH_PROFILE=claude`.

## How it works

- **`bin/fresh-claude`** — sets `FRESH_PROFILE=claude`, resolves the `claude`
  binary for the PTY, seeds `.fresh/config.json` (explorer width) in the
  workspace, and runs `fresh --no-restore`.
- **`init.ts`** — fresh auto-runs this at startup. When the profile is active
  it opens the explorer, spawns Claude Code in a right-hand vertical split and
  a shell below the editor, then starts the watcher and opens every queued
  file in the top editor split via `openFileInSplit`. For each opened or
  changed file it runs `git diff -U0 HEAD -- <file>` and paints the
  added/modified lines with a buffer overlay (namespace `fresh-claude-diff`);
  highlights refresh on every watcher event, file open, and tab switch, so
  they clear the next time you look at a file after committing.
- **`bin/fresh-watch-open`** — fswatch on the workspace appends changed paths
  to a per-launch queue file in `/tmp`; init.ts watches that single file.
  (fresh's own recursive `watchPath` runs out of file descriptors on big
  trees; fswatch uses FSEvents/inotify and doesn't.)

## Tuning

- **Explorer width**: `.fresh/config.json` in the workspace —
  `"width": "28"` (columns) or `"15%"`. Must live in a config file; the
  `setSetting` plugin API doesn't re-layout the explorer (fresh 0.4.x).
- **Pane sizes**: `ratio` values in `~/.config/fresh/init.ts` — `0.5` for the
  Claude split, `0.25` for the shell.
- **Watcher ignore list**: `--exclude` patterns in `bin/fresh-watch-open`
  (extended regex — keep the `-E` flag, without it the alternations silently
  match nothing).
- **Changed-line color**: `DIFF_BG` in `~/.config/fresh/init.ts` — an
  `[r, g, b]` background, default `[22, 68, 38]` (dim green, tuned for dark
  themes).

## Known quirks (fresh 0.4.x)

- Without `--no-restore`, fresh restores the previous workspace layout over
  the one init.ts builds — the wrapper always passes it.
- Hot-exit buffers (unsaved files) survive `--no-restore` by design; close
  stray tabs once and they stay gone.
- Bulk file churn in a non-ignored path (e.g. `git checkout` across many
  files) opens one tab per file.
- Changed-line highlights need a git repo — the baseline is `HEAD` (or the
  index before the first commit). Non-git workspaces get tabs but no
  highlights. Staged-but-uncommitted files in a repo with no commits yet
  show none either.

## Uninstall

```sh
rm ~/.local/bin/fresh-claude ~/.local/bin/fresh-watch-open
rm ~/.config/fresh/init.ts        # or restore the .bak the installer made
rm -rf ~/.config/fresh-claude
```

## License

MIT
