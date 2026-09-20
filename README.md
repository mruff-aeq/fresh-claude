# fresh-claude

Claude Code IDE layout for [fresh](https://getfresh.dev) terminal editor. One command, full cockpit:

![fresh-claude layout](demo_screenshot.png)

```
┌──────────┬──────────────────────────┬──────────────────────┐
│ File     │  editor (tabs)           │  Claude Code         │
│ Explorer │                          │  (full height)       │
├──────────┤                          │                      │
│ Artifacts├──────────────────────────┤                      │
│          │  shell                   │                      │
└──────────┴──────────────────────────┴──────────────────────┘

Left column = fresh's own sidebar: built-in **File Explorer** on top, **Artifacts** section under it (sidebar-sections API, fresh ≥ 0.5.0).
```

## How work

- Claude (or anything) change file → file appear in **Artifacts** panel. Grouped by dir, newest on top. `(new)` = created, `(+12)` = 12 lines changed.
- Click entry → file open in editor, changed lines **green**, jump to first change. Enter = open + focus editor. Scrollbar show green/red marks where changes live. Group header `▼` = fold/unfold.
- Delete file → entry gone, tab gone. Revert file → entry gone. No clutter.
- No tab spam — nothing opens until you click.
- Changed files also get green `●` badge in File Explorer (folders inherit). Open from explorer → same green overlays. Test-runner temp churn filtered out.
- Green baseline = snapshot when fresh-claude start. Works in any dir, git not needed.
- `git checkout` / `pull` / `stash` / `reset` mid-session → rewritten files NOT listed; baseline moves with them, so only edits after the switch show. Needs the repo's reflog (plain dirs unaffected).

## Need

- [fresh](https://getfresh.dev) ≥ 0.5.0 — `brew install fresh-editor`
- [fswatch](https://github.com/emcrisostomo/fswatch) — `brew install fswatch`
- python3, git, rsync
- [Claude Code](https://claude.com/claude-code)
- macOS, Linux, or WSL2

## Install

```sh
git clone https://github.com/mruff-aeq/fresh-claude.git
cd fresh-claude
./install.sh
```

## Run

```sh
fresh-claude                # current or default workspace
fresh-claude ~/src/myrepo   # specific workspace
```

Plain `fresh` untouched — layout only wakes when wrapper sets `FRESH_PROFILE=claude`.

## Tune

Constants at top of `~/.config/fresh/init.ts`: pane ratios (`CLAUDE_RATIO`, `SHELL_RATIO`), Artifacts rows (`ART_ROWS`), colors (`DIFF_BG`, `DIR_STYLE`, `FILE_STYLE`, `ART_DOT`). Explorer width/hidden files in `.fresh/config.json` (`file_explorer`). Snapshot skip-list in `SNAP_SCRIPT`. Watcher knobs in `bin/fresh-watch-open`. Code is law — read the source.

## Uninstall

```sh
rm ~/.local/bin/fresh-claude ~/.local/bin/fresh-watch-open
rm ~/.config/fresh/init.ts
rm -rf ~/.config/fresh-claude
```

## License

MIT
