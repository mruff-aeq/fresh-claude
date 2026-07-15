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
watch what Claude is doing while it works. The dozens of temp files a test
run drops mid-execution are filtered out: while a test runner is alive in the
editor's process subtree, files appearing in the tree are treated as churn
and skipped, so the tab bar stays about the code, not the test output. Files
whose content ends up identical to git HEAD (e.g. rewritten by `git checkout`
or a merge) are skipped too — no diff, no tab. Lines that differ from git HEAD
get a green background, so it's obvious *what* changed in each file, not
just that it did — untracked files are painted whole (everything is new).
When a file is deleted (say, a temp script Claude cleaned up), its tab
closes automatically instead of lingering.

## Requirements

- [fresh](https://getfresh.dev) 0.4.x (`brew install sinelaw/fresh/fresh`)
- [fswatch](https://github.com/emcrisostomo/fswatch) (`brew install fswatch` / `apt install fswatch`)
- Python 3 (ships with macOS Command Line Tools; `apt install python3` on Linux)
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
  a shell below the editor, then starts the watcher and opens each queued
  file that differs from git HEAD in the top editor split via
  `openFileInSplit`. For each opened or
  changed file it runs `git diff -U0 HEAD -- <file>` and paints the
  added/modified lines with a buffer overlay (namespace `fresh-claude-diff`);
  highlights refresh on every watcher event, file open, and tab switch, so
  they clear the next time you look at a file after committing.
- **`bin/fresh-watch-open`** (Python 3) — fswatch on the workspace feeds changed
  paths, which the watcher appends to a per-launch queue file in `/tmp`; init.ts
  watches that single file. (fresh's own recursive `watchPath` runs out of file
  descriptors on big trees; fswatch uses FSEvents/inotify and doesn't.) Between
  fswatch and the queue sits the test-churn filter. fswatch reports *what*
  changed but not *who* changed it, and there is no unprivileged way to
  attribute a write to a PID (that needs `eslogger`/`fs_usage`/DTrace on macOS or
  `fanotify`/`auditd` on Linux — all root), so the watcher correlates instead: it
  finds the `fresh` editor process by walking its own parent-PID chain, and a
  250 ms sampler tracks whether a test runner (`pytest`, `jest`, `vitest`,
  `go test`, `cargo test`, …) is alive anywhere in that process's subtree. A
  created/modified file is held in a 1.5 s per-path debounce, then dropped if a
  runner was active around the time it appeared — the debounce lets each burst
  settle so fswatch's latency doesn't race the process check. Files edited while
  no runner is up pass straight through. If no `fresh` ancestor is found (e.g.
  the watcher is run standalone), suppression is disabled and everything opens.
  Deleted and renamed-away paths are always forwarded, never suppressed; init.ts
  closes their tabs, first switching the editor split to another file tab (or an
  empty buffer) if the doomed one is showing — otherwise fresh promotes a
  terminal buffer into the pane.

## Tuning

- **Explorer width**: `.fresh/config.json` in the workspace —
  `"width": "28"` (columns) or `"15%"`. Must live in a config file; the
  `setSetting` plugin API doesn't re-layout the explorer (fresh 0.4.x).
- **Hidden files**: the wrapper seeds `"show_hidden": true` into each
  workspace's `.fresh/config.json` (dotfiles visible in the explorer). Set
  it to `false` there to hide them again — the wrapper won't override an
  existing value. `"respect_gitignore": false` also shows gitignored files.
- **Pane sizes**: `ratio` values in `~/.config/fresh/init.ts` — `0.5` for the
  Claude split, `0.25` for the shell.
- **Watcher ignore list**: `--exclude` patterns in `bin/fresh-watch-open`
  (extended regex — keep the `-E` flag, without it the alternations silently
  match nothing). These are a cheap first-pass filter; the test-churn
  suppression runs on top of them.
- **Test-churn suppression**: env vars read by `bin/fresh-watch-open` —
  `FRESH_WATCH_DEBOUNCE` (per-path settle time, default `1.5` s),
  `FRESH_WATCH_GRACE` (how far back a runner counts as "active around the
  write", default `3.0` s), `FRESH_WATCH_SAMPLE` (process-poll period, default
  `0.25` s). The runner patterns live in `TEST_RE` at the top of the script.
  Editing a real source file *while* a watch-mode runner is up gets suppressed
  (a known trade-off of the unprivileged approach); the file still opens once
  you touch it after the runner idles.
- **Changed-line color**: `DIFF_BG` in `~/.config/fresh/init.ts` — an
  `[r, g, b]` background, default `[22, 68, 38]` (dim green, tuned for dark
  themes).

## Known quirks (fresh 0.4.x)

- Without `--no-restore`, fresh restores the previous workspace layout over
  the one init.ts builds — the wrapper always passes it.
- Hot-exit buffers (unsaved files) survive `--no-restore` by design; close
  stray tabs once and they stay gone.
- Bulk file churn in a non-ignored path opens one tab per file — but only
  for files that actually differ from HEAD afterwards, so `git checkout` /
  merge rewrites no longer open anything, and files written while a test
  runner is alive are suppressed. In a non-git workspace there is no baseline,
  so HEAD-identical files still open (test-churn suppression is independent of
  git and works either way).
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
