#!/usr/bin/env bash
set -euo pipefail
# Installer for fresh-claude: a Claude Code IDE layout for the fresh editor.
# Copies launcher + watcher to ~/.local/bin and init.ts to ~/.config/fresh/.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="$HOME/.local/bin"
fresh_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/fresh"
own_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/fresh-claude"

# ── dependency checks ────────────────────────────────────────────────────
missing=0
need() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "MISSING: $1 — $2"
		missing=1
	fi
}
need fresh "install from https://getfresh.dev (brew install sinelaw/fresh/fresh)"
need fswatch "brew install fswatch / apt install fswatch"
need claude "install Claude Code: https://claude.com/claude-code"
if [[ "$missing" -eq 1 ]]; then
	echo "Install the missing dependencies and re-run." >&2
	exit 1
fi

fresh_version="$(fresh --version | awk '{print $2}')"
case "$fresh_version" in
	0.4.*) ;;
	*) echo "WARNING: tested against fresh 0.4.x, you have $fresh_version — the plugin API may have changed." ;;
esac

# ── scripts ──────────────────────────────────────────────────────────────
mkdir -p "$bin_dir"
install -m 0755 "$repo_dir/bin/fresh-claude" "$bin_dir/fresh-claude"
install -m 0755 "$repo_dir/bin/fresh-watch-open" "$bin_dir/fresh-watch-open"
echo "Installed fresh-claude and fresh-watch-open to $bin_dir"
case ":$PATH:" in
	*":$bin_dir:"*) ;;
	*) echo "NOTE: $bin_dir is not in your PATH — add it to your shell profile." ;;
esac

# ── init.ts ──────────────────────────────────────────────────────────────
mkdir -p "$fresh_config_dir"
target="$fresh_config_dir/init.ts"
if [[ -f "$target" ]] && ! cmp -s "$repo_dir/init.ts" "$target"; then
	backup="$target.bak.$(date +%Y%m%d%H%M%S)"
	cp "$target" "$backup"
	echo "Existing init.ts backed up to $backup"
	echo "NOTE: if it contained your own startup code, merge it back in manually."
fi
cp "$repo_dir/init.ts" "$target"
fresh --cmd init check
echo "Installed $target"

# ── default workspace (optional) ─────────────────────────────────────────
workspace="${FRESH_CLAUDE_WORKSPACE:-}"
if [[ -z "$workspace" && -t 0 ]]; then
	printf 'Default workspace dir for `fresh-claude` with no argument (empty = current dir at launch): '
	read -r workspace
fi
if [[ -n "$workspace" ]]; then
	mkdir -p "$own_config_dir"
	printf '%s\n' "${workspace/#\~/$HOME}" > "$own_config_dir/workspace"
	echo "Default workspace saved to $own_config_dir/workspace"
fi

echo
echo "Done. Launch with: fresh-claude [workspace-dir]"
echo "macOS new-window:  open -na Ghostty --args -e fresh-claude"
