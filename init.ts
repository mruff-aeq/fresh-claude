// fresh startup script — "claude" profile IDE layout.
// Only active when launched via the fresh-claude wrapper (FRESH_PROFILE=claude);
// plain `fresh` is untouched. Installed to ~/.config/fresh/init.ts.
//
// Layout: [file tree / Artifacts] | editor (+ shell below) | Claude Code right.
// The left column is two stacked virtual-buffer panels (the built-in file
// explorer cannot host a second panel below it, so it stays hidden and the
// tree is rendered by this script): a lazy file tree on top, and an
// "Artifacts" panel below listing every file changed since launch. Changed
// files are BROADCAST to the Artifacts panel instead of auto-opening as tabs;
// clicking (or pressing Enter on) an entry opens the file in the editor pane
// with changed lines highlighted green.

(async () => {
	if (editor.getEnv("FRESH_PROFILE") !== "claude") return;

	// ── Session snapshot (highlight baseline) ────────────────────────────
	// Green highlights diff each file against a launch-time MIRROR of the
	// workspace, not git HEAD — so highlighting works in any directory, git or
	// not, and shows exactly what changed since fresh-claude started. Captured
	// HERE, before Claude spawns, so the baseline is pristine (the watcher only
	// learns of a write after the fact, so there is no other way to know a
	// file's pre-edit content). The mirror lives in /tmp — fast enough for
	// source text, and a ramdisk buys nothing for KB-sized files. Files >1 MB
	// and the usual heavy dirs are skipped; those simply get no highlights.
	const CWD = editor.getCwd();
	const SNAP_DIR = `/tmp/fresh-snap-${Date.now()}`;
	const MAX_BYTES = 1024 * 1024;
	// rsync (with --max-size) when present, else a tar pipe (cap enforced at
	// diff time instead). $ex is deliberately unquoted for word-splitting into
	// separate --exclude args. Paths arrive as $1/$2, so no shell injection.
	const SNAP_SCRIPT = `
set -e
src=$1; snap=$2
mkdir -p "$snap"
ex="--exclude=.git --exclude=node_modules --exclude=.venv --exclude=venv --exclude=dist --exclude=build --exclude=coverage --exclude=__pycache__ --exclude=.pytest_cache --exclude=.nuxt --exclude=.output --exclude=.fresh"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --max-size=1048576 $ex "$src"/ "$snap"/
else
  tar -cf - -C "$src" $ex . | tar -xf - -C "$snap"
fi
`;
	try {
		const snap = await editor.spawnProcess(
			"sh",
			["-c", SNAP_SCRIPT, "_", CWD, SNAP_DIR],
			CWD,
		);
		if (snap.exit_code !== 0)
			editor.debug(
				`init.ts: workspace snapshot failed (highlights degrade to all-new): ${snap.stderr}`,
			);
	} catch (e) {
		editor.debug(`init.ts: workspace snapshot error: ${e}`);
	}

	// ── Left column: file tree + Artifacts panels ────────────────────────
	// Same dir skip-list as the snapshot — the tree is for source, not vendored
	// churn.
	const EXCLUDE_DIRS = new Set([
		".git",
		"node_modules",
		".venv",
		"venv",
		"dist",
		"build",
		"coverage",
		"__pycache__",
		".pytest_cache",
		".nuxt",
		".output",
		".fresh",
	]);

	// Pane ratios. COLUMN_RATIO is the tree/Artifacts column's share of the
	// width (the editor+Claude region gets the rest) — if a fresh update flips
	// the ratio's meaning, set 0.8. The others match the old layout.
	const COLUMN_RATIO = 0.2;
	const ARTIFACTS_RATIO = 0.5; // tree/artifacts split the column 50/50
	const CLAUDE_RATIO = 0.5;
	const SHELL_RATIO = 0.75;

	// Tree state: which dirs are expanded (root always is). Dirs are read
	// lazily — only expanded ones are listed, so big trees stay cheap.
	const expanded = new Set([CWD]);

	// Artifacts state: path → { status: "new" | "modified" | "unknown" |
	// "deleted", added: lines }. Insertion order is oldest-first; rendering
	// reverses it, and updates re-insert, so the newest change sits on top.
	const artifacts = new Map();

	function relPath(p: string): string {
		return p.startsWith(CWD + "/") ? p.slice(CWD.length + 1) : p;
	}

	function treeEntries() {
		const out: Array<{ text: string; properties: Record<string, unknown> }> = [];
		const walk = (dir: string, depth: number) => {
			let entries;
			try {
				entries = editor.readDir(dir);
			} catch (e) {
				editor.debug(`init.ts: readDir(${dir}) failed: ${e}`);
				return;
			}
			entries = entries.filter((en) => !(en.is_dir && EXCLUDE_DIRS.has(en.name)));
			entries.sort((a, b) =>
				a.is_dir !== b.is_dir
					? a.is_dir
						? -1
						: 1
					: a.name.localeCompare(b.name, undefined, {
							numeric: true,
							sensitivity: "base",
						}),
			);
			for (const en of entries) {
				const full = dir + "/" + en.name;
				const pad = "  ".repeat(depth);
				if (en.is_dir) {
					const open = expanded.has(full);
					// Nerd Font chevrons (as \u escapes so non-NF editors can't
					// mangle the source): U+F078 chevron-down / U+F054 chevron-right.
					out.push({
						text: `${pad}${open ? "\uf078" : "\uf054"} ${en.name}/\n`,
						properties: { path: full, is_dir: true },
					});
					if (open) walk(full, depth + 1);
				} else {
					out.push({
						text: `${pad}  ${en.name}\n`,
						properties: { path: full, is_dir: false },
					});
				}
			}
		};
		walk(CWD, 0);
		if (out.length === 0) out.push({ text: "(empty)\n", properties: {} });
		return out;
	}

	// Artifacts are grouped under one header row per directory (workspace-
	// relative, "./" for the root), newest-touched group first, newest file
	// first within a group. Headers collapse/expand on click or Enter,
	// tracked separately from the file tree's `expanded` set.
	const artCollapsed = new Set<string>();

	function artifactEntries() {
		if (artifacts.size === 0)
			return [{ text: "(no changes yet)\n", properties: {} }];
		// dir → items newest-first; Map keeps first-seen (= newest) group order.
		const groups = new Map<string, Array<{ path: string; a: any }>>();
		for (const [path, a] of [...artifacts.entries()].reverse()) {
			const rel = relPath(path);
			const cut = rel.lastIndexOf("/");
			const dir = cut === -1 ? "./" : rel.slice(0, cut + 1);
			let items = groups.get(dir);
			if (items === undefined) groups.set(dir, (items = []));
			items.push({ path, a });
		}
		const out: Array<{ text: string; properties: Record<string, unknown> }> = [];
		for (const [dir, items] of groups) {
			const open = !artCollapsed.has(dir);
			out.push({
				text: `${open ? "\uf078" : "\uf054"} ${dir}  (${items.length})\n`,
				properties: { group: dir },
			});
			if (!open) continue;
			for (const { path, a } of items) {
				const tag =
					a.status === "deleted"
						? "deleted"
						: a.status === "new"
							? "new"
							: a.status === "unknown"
								? "changed"
								: `+${a.added}`;
				const name = dir === "./" ? relPath(path) : relPath(path).slice(dir.length);
				out.push({
					text: `  ● ${name}  (${tag})\n`,
					properties: { path, is_dir: false },
				});
			}
		}
		return out;
	}

	// Rendered-entry mirrors of what each panel currently displays, indexed by
	// line — mouse_click reports a buffer_row, and this is how a click row is
	// resolved back to a path (text properties are only queryable at the
	// CURSOR, which a click may not have moved yet).
	let treeRendered: ReturnType<typeof treeEntries> = [];
	let artifactsRendered: ReturnType<typeof artifactEntries> = [];
	function renderTreePanel() {
		treeRendered = treeEntries();
		if (treeBufId !== null) editor.setVirtualBufferContent(treeBufId, treeRendered);
		return treeRendered;
	}
	function renderArtifactsPanel() {
		artifactsRendered = artifactEntries();
		if (artifactsBufId !== null)
			editor.setVirtualBufferContent(artifactsBufId, artifactsRendered);
		return artifactsRendered;
	}

	// Modes must exist before the buffers that use them. Both panels share one
	// activate command: Enter toggles a folder or opens a file.
	// inheritNormalBindings: arrows/PageUp/etc must still navigate the panels.
	editor.defineMode("fc-tree", [["Return", "fc_activate"]], true, false, true);
	editor.defineMode("fc-artifacts", [["Return", "fc_activate"]], true, false, true);

	// Build the column off the single startup split. `before: true` places
	// the new pane LEFT of the editor pane directly.
	const s0 = editor.listSplits()[0];
	// `let`: the editor split DIES when its last tab is closed (fresh
	// collapses an empty split); ensureEditorSplit below rebuilds + reassigns.
	let editorSplitId: number | undefined = s0?.splitId;
	let treeSplitId: number | undefined;
	let treeBufId: number | null = null;
	let artifactsBufId: number | null = null;
	try {
		const tree = await editor.createVirtualBufferInSplit({
			name: "*Files*",
			mode: "fc-tree",
			readOnly: true,
			entries: (treeRendered = treeEntries()),
			ratio: COLUMN_RATIO,
			direction: "vertical",
			before: true,
			showLineNumbers: false,
			editingDisabled: true,
		});
		treeBufId = tree.bufferId;
		treeSplitId = tree.splitId ?? undefined;
	} catch (e) {
		editor.debug(`init.ts: tree panel creation failed; left column disabled: ${e}`);
	}

	if (treeSplitId !== undefined) {
		editor.focusSplit(treeSplitId);
		try {
			const art = await editor.createVirtualBufferInSplit({
				name: "*Artifacts*",
				mode: "fc-artifacts",
				readOnly: true,
				entries: (artifactsRendered = artifactEntries()),
				ratio: ARTIFACTS_RATIO,
				direction: "horizontal",
				showLineNumbers: false,
				editingDisabled: true,
			});
			artifactsBufId = art.bufferId;
		} catch (e) {
			editor.debug(`init.ts: artifacts panel creation failed: ${e}`);
		}
	}
	if (editorSplitId !== undefined) editor.focusSplit(editorSplitId);


	// Tree refreshes are debounced — a git checkout can queue hundreds of
	// watcher events, and one re-render after the burst settles is enough.
	let treeRefreshPending = false;
	function scheduleTreeRefresh() {
		if (treeRefreshPending || treeBufId === null) return;
		treeRefreshPending = true;
		(async () => {
			await editor.delay(500);
			treeRefreshPending = false;
			try {
				renderTreePanel();
			} catch (e) {
				editor.debug(`init.ts: tree refresh failed: ${e}`);
			}
		})();
	}

	// Right pane, full height of the editor region: Claude Code spawned
	// directly in the PTY. Full path via FRESH_CLAUDE_BIN (set by
	// fresh-claude) — the PTY child skips the login shell, so PATH may not
	// contain claude. focus:false keeps focus on the editor split so the next
	// split lands under it.
	const claudeBin = editor.getEnv("FRESH_CLAUDE_BIN") || "claude";
	const claudeTerm = await editor.createTerminal({
		direction: "vertical",
		ratio: CLAUDE_RATIO,
		command: [claudeBin],
		title: "Claude Code",
		focus: false,
		persistent: false,
	});

	// Plain shell under the editor (defaults to the user's shell).
	// New terminal splits hang off the most recent split, so refocus the
	// editor pane first to make the horizontal split land under it.
	// ratio applies to the ORIGINAL (top) split: 0.75 = editor keeps 75%,
	// the shell below gets 25%.
	if (editorSplitId !== undefined) editor.focusSplit(editorSplitId);
	const shell = await editor.createTerminal({
		direction: "horizontal",
		ratio: SHELL_RATIO,
		focus: false,
	});

	// (The shell is hopped into tmux at the watcher-launch step below — one
	// typed line does both, see the comment there.)

	// Second terminal as a TAB next to Terminal 1: the watcher occupies
	// Terminal 1's foreground, so this one is for actual shell work. The
	// open_terminal action (what the tab bar "+" runs) creates a terminal
	// tab directly in the FOCUSED split — no throwaway split needed. It
	// returns no terminalId, so catch the new terminal's first
	// terminal_output event (the id not already known) to type the tmux
	// line. Its own persistent per-workspace tmux session — same
	// leak-eating rationale as below, but a plain `exec` typed line
	// suffices: nothing else types into this pane, so there is no
	// stale-watcher or multi-line race to manage. sendTerminalInput just
	// buffers in the pty, so racing zsh's startup is fine.
	// FRESH_TMUX_SESSION comes from the wrapper (workspace-path-derived):
	// fixed names made concurrent fresh-claude instances attach to each
	// other's sessions via -A (mirrored terminals).
	const tmuxSession = editor.getEnv("FRESH_TMUX_SESSION") || "fresh";
	{
		const knownTerms = new Set([claudeTerm.terminalId, shell.terminalId]);
		let term2Seen = false;
		editor.on("terminal_output", (args) => {
			if (term2Seen || knownTerms.has(args.terminal_id)) return;
			term2Seen = true;
			const tmuxBin = editor.getEnv("FRESH_TMUX_BIN");
			if (tmuxBin)
				editor.sendTerminalInput(
					args.terminal_id,
					`exec ${JSON.stringify(tmuxBin)} new-session -A -s ${JSON.stringify(tmuxSession + "-shell")}\n`,
				);
		});
		if (shell.splitId !== null) editor.focusSplit(shell.splitId);
		const bufsBefore = new Set(editor.listBuffers().map((b) => b.id));
		editor.executeAction("open_terminal");
		// The new tab lands foreground; give the (queued) buffer updates a
		// beat, then flip the split back to Terminal 1 for the watcher.
		await editor.delay(250);
		if (!editor.listBuffers().some((b) => !bufsBefore.has(b.id)))
			editor.debug("init.ts: open_terminal produced no Terminal 2 buffer");
		if (shell.splitId !== null) editor.setSplitBuffer(shell.splitId, shell.bufferId);
	}
	if (editorSplitId !== undefined) editor.focusSplit(editorSplitId);

	// ── Diff highlights ──────────────────────────────────────────────────
	// Paint a background on every line that differs from the launch snapshot,
	// so an opened artifact makes it obvious WHAT changed, not just that it
	// did. Files new since launch are painted whole. Baseline is the snapshot
	// mirror captured above — no git required, works in any directory.
	const DIFF_NS = "fresh-claude-diff";
	const DIFF_BG: [number, number, number] = [22, 68, 38];

	// Path to a file's baseline copy inside the launch snapshot mirror. null
	// when the path is outside the workspace — watcher paths never are, but the
	// manual-open / tab-switch handlers can fire for anything.
	function snapPathOf(path: string): string | null {
		if (path.startsWith(CWD + "/")) return SNAP_DIR + "/" + path.slice(CWD.length + 1);
		return null;
	}

	// [startLine, endLine] pairs (1-indexed, inclusive) of lines that differ
	// from the launch snapshot; "all" for files new since launch (no snapshot
	// entry — everything is new); null when outside the workspace, unreadable,
	// or over the 1 MB cap (no highlight either way).
	async function changedLineRanges(
		path: string,
	): Promise<Array<[number, number]> | "all" | null> {
		const snap = snapPathOf(path);
		if (snap === null) return null;
		const content = editor.readFile(path);
		if (content === null) return null;
		// Size cap first, so a >1 MB file (absent from the mirror) is skipped
		// rather than painted whole via the "all" branch below.
		if (editor.utf8ByteLength(content) > MAX_BYTES) return null;
		if (!editor.fileExists(snap)) return "all";
		// git diff --no-index needs no repo. Exit 0 = identical, 1 = differs
		// (parse hunks), >1 = error. Binary diffs print "Binary files … differ"
		// with no @@ hunks, so they fall through to an empty range set.
		const res = await editor.spawnProcess(
			"git",
			["diff", "--no-index", "-U0", "--no-color", "--", snap, path],
			CWD,
		);
		if (res.exit_code === 0) return [];
		if (res.exit_code > 1 && res.stdout === "") return null;
		const ranges: Array<[number, number]> = [];
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
		let m: RegExpExecArray | null;
		while ((m = hunk.exec(res.stdout)) !== null) {
			const start = parseInt(m[1], 10);
			const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
			if (count > 0) ranges.push([start, start + count - 1]);
		}
		return ranges;
	}

	async function highlightDiff(
		path: string,
		bufferId: number,
		ranges?: Array<[number, number]> | "all" | null,
	) {
		if (ranges === undefined) ranges = await changedLineRanges(path);
		if (ranges === null) return;
		editor.clearNamespace(bufferId, DIFF_NS);
		const content = editor.readFile(path);
		if (content === null) return;
		// Both key spellings — the API docs and OverlayOptions disagree.
		const style = { bg: DIFF_BG, extendToLineEnd: true, extend_to_line_end: true };
		const total = editor.utf8ByteLength(content);
		if (ranges === "all") {
			if (total > 0) editor.addOverlay(bufferId, DIFF_NS, 0, total, style);
			return;
		}
		if (ranges.length === 0) return;
		const lines = content.split("\n");
		// starts[i] = byte offset of line i (0-indexed); overlays take bytes.
		const starts: number[] = [0];
		for (const line of lines)
			starts.push(starts[starts.length - 1] + editor.utf8ByteLength(line) + 1);
		for (const [a, b] of ranges) {
			const s = starts[Math.min(a - 1, lines.length - 1)];
			// End of line b: start of line b+1 minus its "\n" (clamped for a
			// missing trailing newline on the last line).
			const e = Math.min(starts[Math.min(b, lines.length)] - 1, total);
			if (e > s) editor.addOverlay(bufferId, DIFF_NS, s, e, style);
		}
	}

	// Serialize refreshes so two rapid events for one file can't interleave
	// their clear/add passes.
	let diffChain: Promise<void> = Promise.resolve();
	function scheduleHighlight(path: string) {
		diffChain = diffChain
			.then(async () => {
				if (!editor.fileExists(path)) return;
				const bufId = editor.findBufferByPath(path);
				if (bufId) await highlightDiff(path, bufId);
			})
			.catch((e) => editor.debug(`init.ts: diff highlight failed: ${e}`));
	}

	// closeBuffer refuses buffers with unsaved changes — and fresh (sometimes,
	// timing-dependent) marks a buffer modified when its file is deleted out
	// from under it, so the deleted-file tab can be exactly the case
	// closeBuffer rejects. Launder it: save the buffer back to disk (clears
	// the modified flag), close, then rm the recreated file. Plain rm beats
	// fswatch's ~1s latency, so the file is gone again before its Created
	// event drains from the queue and the tab can't reopen. (removePath only
	// accepts temp/config paths and renamePath into the temp dir fails
	// silently, so neither works here.)
	function discardGoneBuffer(bufId: number, path: string) {
		if (editor.isBufferModified(bufId)) {
			if (!editor.saveBufferToPath(bufId, path)) {
				editor.debug(`init.ts: could not launder deleted-file buffer for ${path}`);
				return;
			}
			editor.closeBuffer(bufId);
			editor
				.spawnProcess("rm", ["-f", "--", path], editor.getCwd())
				.then((r) => {
					if (r.exit_code !== 0)
						editor.debug(`init.ts: rm of laundered ${path} failed: ${r.stderr}`);
				})
				.catch((e) => editor.debug(`init.ts: rm of laundered ${path} failed: ${e}`));
		} else {
			editor.closeBuffer(bufId);
		}
	}

	// Close the tab of a file that no longer exists on disk. If the editor
	// split is currently SHOWING the doomed buffer, switch it to another file
	// tab first — fresh otherwise promotes a terminal buffer into the pane.
	function closeGoneBuffer(path: string) {
		const gone = editor.findBufferByPath(path);
		if (!gone) return;
		if (editorSplitId !== undefined) {
			const split = editor.listSplits().find((s) => s.splitId === editorSplitId);
			if (split && split.bufferId === gone) {
				// Any other live file tab beats an empty pane. Buffers with a
				// workspace path count even when flagged is_virtual (restored
				// tabs can be lazily materialized); terminal and panel buffers
				// stay excluded because they have no workspace-relative path.
				const other = editor
					.listBuffers()
					.filter(
						(b) =>
							b.id !== gone &&
							b.path &&
							(!b.is_virtual || b.path.startsWith(CWD + "/")) &&
							editor.fileExists(b.path),
					)
					.pop();
				if (other) {
					editor.setSplitBuffer(editorSplitId, other.id);
				} else {
					// No file tab left to show: put an empty buffer in the
					// editor split ("new" acts on the focused split, so hop
					// focus there and back).
					const prevSplit = editor.getActiveSplitId();
					editor.focusSplit(editorSplitId);
					editor.executeAction("new");
					editor.focusSplit(prevSplit);
				}
			}
		}
		discardGoneBuffer(gone, path);
	}

	// Manually opened files get highlights too, and revisiting a tab re-diffs
	// it against the snapshot so highlights clear once a file is reverted to
	// its launch state.
	editor.on("after_file_open", (args) => scheduleHighlight(args.path));
	editor.on("buffer_activated", (args) => {
		const p = editor.getBufferPath(args.buffer_id);
		if (p) scheduleHighlight(p);
	});

	// ── Watcher → Artifacts broadcast ────────────────────────────────────
	// fswatch (in the bottom shell — fresh's own recursive watchPath dies
	// with EMFILE on big trees) appends changed paths to a queue file; we
	// watch that single file and record each entry in the Artifacts panel
	// (no auto-opened tabs — opening is a click away). Queue lives OUTSIDE
	// the watched tree (unique per launch) so the watcher can never see its
	// own queue writes and loop.
	const queue = `/tmp/fresh-open-queue-${Date.now()}`;
	editor.writeFile(queue, "");
	// Foreground, output visible — the shell doubles as the watcher log;
	// open another terminal (+ on the tab bar) for shell work.
	//
	// With tmux available, ONE typed line hops the shell into tmux AND
	// launches the watcher inside it:
	//   exec tmux new-session -A -s <sess> ';' send-keys -t '=<sess>:' '<watch>' Enter
	// Why this shape (each part is load-bearing):
	// - tmux at all: raw-mode TUI that parses all pty input, so the mouse
	//   escape sequences fresh leaks into the focused pane (fresh 0.4.x
	//   parser desync on split sequences) are consumed, not echoed as ^[[M
	//   garbage at the prompt.
	// - TYPED, not spawned via createTerminal's command: a directly-spawned
	//   tmux client dies if any stray byte reaches it before it finishes
	//   attaching; typed input just buffers in the pty until zsh runs it.
	// - ONE line, chained with tmux's ';': a second typed line could be
	//   slurped into zsh's line editor together with the first and lost at
	//   the exec. send-keys is executed by tmux after new-session attaches,
	//   and tmux buffers it into the pane's pty, so the watcher command
	//   waits for the inner shell's prompt instead of racing it.
	// - exec: quitting tmux closes the pane, no leftover outer zsh.
	// - -A -s <sess>: one persistent session PER WORKSPACE (name from the
	//   wrapper via FRESH_TMUX_SESSION) — the shell (and anything running in
	//   it) survives fresh restarts in the same dir, while concurrent
	//   instances in other dirs get their own sessions instead of attaching
	//   to this one. The wrapper pre-clears a reattached session's stale
	//   watcher server-side (send-keys C-c), so the prompt is free to take
	//   the new watcher command. `=` in the send-keys target forces exact
	//   name match (never prefix-matching the "-shell" session).
	const tmuxBin = editor.getEnv("FRESH_TMUX_BIN");
	const watchCmd = `fresh-watch-open ${JSON.stringify(editor.getCwd())} ${JSON.stringify(queue)}`;
	editor.sendTerminalInput(
		shell.terminalId,
		tmuxBin
			? `exec ${JSON.stringify(tmuxBin)} new-session -A -s ${JSON.stringify(tmuxSession)} ';' send-keys -t ${JSON.stringify("=" + tmuxSession + ":")} '${watchCmd}' Enter\n`
			: `${watchCmd}\n`,
	);
	let seen = 0;
	// Closing the last file tab makes fresh collapse the editor split (the
	// shell split expands into its area) — openFileInSplit against the dead
	// id then returns true but shows nothing. Rebuild on demand, hanging a
	// new split off the shell split. There is no create-empty-split API and
	// split_horizontal clones the focused split's ACTIVE view into the new
	// split — so make that view a fresh empty [No Name] buffer first (the
	// "new" action): unlike terminal buffers, which no plugin API can strip
	// from a tab bar (closeBuffer/closeTerminal/close_terminal all leave the
	// tab), an unmodified [No Name] closes cleanly, taking its tab out of
	// BOTH splits once the file tab holds the new split open. No
	// setSplitRatio on the result — it panics fresh 0.4.x ("ContainerId
	// points to a leaf"), so the rebuilt layout stays 50/50.
	async function ensureEditorSplit(): Promise<number | undefined> {
		const alive = editor.listSplits().map((s) => s.splitId);
		if (editorSplitId !== undefined && alive.includes(editorSplitId))
			return editorSplitId;
		if (shell.splitId === null || !alive.includes(shell.splitId)) {
			editor.debug("init.ts: editor split gone and shell split unavailable — cannot rebuild");
			return undefined;
		}
		const prevFocus = editor.getActiveSplitId();
		const bufsBefore = new Set(editor.listBuffers().map((b) => b.id));
		editor.focusSplit(shell.splitId);
		editor.executeAction("new");
		await editor.delay(250);
		const noName = editor.listBuffers().find((b) => !bufsBefore.has(b.id));
		editor.executeAction("split_horizontal");
		await editor.delay(250);
		const born = editor
			.listSplits()
			.map((s) => s.splitId)
			.filter((id) => !alive.includes(id));
		// Put the shell split back on Terminal 1 whatever happened.
		editor.setSplitBuffer(shell.splitId, shell.bufferId);
		if (born.length !== 1 || noName === undefined) {
			editor.focusSplit(prevFocus);
			editor.debug(
				`init.ts: editor-split rebuild failed (new splits: ${born.length}, placeholder: ${noName?.id})`,
			);
			return undefined;
		}
		editorSplitId = born[0];
		placeholderBufferId = noName.id;
		// Focus the reborn editor split — prevFocus is usually the DEAD
		// split (that death is why we're here), and a focusSplit no-op
		// leaves focus on the shell split, where the subsequent file open
		// leaks an extra tab into the terminal strip.
		editor.focusSplit(editorSplitId);
		await editor.delay(100);
		return editorSplitId;
	}
	let placeholderBufferId: number | null = null;

	function sumAdded(ranges: Array<[number, number]>): number {
		return ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
	}

	// Record a changed file in the Artifacts panel. A file rewritten back to
	// its baseline (checkout/merge/revert) produces an empty diff — that
	// DROPS the artifact entry instead of listing noise, and clears any stale
	// highlight if the file happens to be open. "all" (new since launch) and
	// null (over cap / no baseline) are listed.
	function scheduleArtifact(path: string) {
		diffChain = diffChain
			.then(async () => {
				if (!editor.fileExists(path)) return;
				const ranges = await changedLineRanges(path);
				if (ranges !== null && ranges !== "all" && ranges.length === 0) {
					if (artifacts.delete(path)) renderArtifactsPanel();
					const bufId = editor.findBufferByPath(path);
					if (bufId) editor.clearNamespace(bufId, DIFF_NS);
					return;
				}
				const status =
					ranges === "all" ? "new" : ranges === null ? "unknown" : "modified";
				const added = ranges !== null && ranges !== "all" ? sumAdded(ranges) : 0;
				artifacts.delete(path); // re-insert → newest-first render order
				artifacts.set(path, { status, added });
				renderArtifactsPanel();
				scheduleTreeRefresh(); // a created file should appear in the tree
				const bufId = editor.findBufferByPath(path);
				if (bufId) await highlightDiff(path, bufId, ranges);
			})
			.catch((e) => editor.debug(`init.ts: artifact update failed: ${e}`));
	}

	// A deleted file stays listed, marked (deleted) — the panel is a log of
	// what happened since launch, and silently vanishing entries read as a
	// glitch. Its tab (if any) still closes via closeGoneBuffer.
	function markDeleted(path: string) {
		const a = artifacts.get(path);
		if (a === undefined) return;
		artifacts.delete(path);
		artifacts.set(path, { ...a, status: "deleted" });
		renderArtifactsPanel();
	}

	// Open a panel entry in the editor split, landing on the first changed
	// line — in a long file the edit is often far below the top, and opening
	// at line 0 shows no green at all.
	function scheduleOpen(path: string) {
		diffChain = diffChain
			.then(async () => {
				if (!editor.fileExists(path)) {
					editor.debug(`init.ts: open skipped, file gone: ${path}`);
					return;
				}
				const ranges = await changedLineRanges(path);
				const firstLine =
					ranges !== null && ranges !== "all" && ranges.length > 0
						? ranges[0][0] - 1
						: 0;
				const target = await ensureEditorSplit();
				if (target === undefined) return;
				editor.openFileInSplit(target, path, firstLine, 0);
				const bufId = editor.findBufferByPath(path);
				if (bufId) {
					if (placeholderBufferId !== null) {
						// Rebuild placeholder: the file tab holds the split
						// open now, so the [No Name] buffer (and its tab, in
						// both splits) can go.
						const tmp = placeholderBufferId;
						placeholderBufferId = null;
						await editor.delay(250);
						if (!editor.closeBuffer(tmp))
							editor.debug("init.ts: rebuild placeholder buffer refused to close");
						// KNOWN QUIRK: closing the placeholder backfills its
						// slot in the SHELL split's strip with the just-opened
						// file, leaving a duplicate file tab next to the
						// terminals. Cosmetic only — its × closes it — and not
						// fixable from the plugin API: there is no detach-tab
						// primitive, closeOtherBuffersInSplit refuses buffers
						// shown in another split, and recency games don't
						// steer the backfill.
					}
					await highlightDiff(path, bufId, ranges);
					if (firstLine > 0) editor.scrollToLineCenter(target, bufId, firstLine);
				}
			})
			.catch((e) => editor.debug(`init.ts: open+highlight failed: ${e}`));
	}

	// ── Panel activation ─────────────────────────────────────────────────
	// Enter (bound in both panel modes): toggle a folder, open a file.
	globalThis.fcActivate = () => {
		const splitId = editor.getActiveSplitId();
		const split = editor.listSplits().find((s) => s.splitId === splitId);
		if (!split) return;
		const bufId = split.bufferId;
		if (bufId !== treeBufId && bufId !== artifactsBufId) return;
		const props = editor.getTextPropertiesAtCursor(bufId);
		const p = props && props.length > 0 ? props[0] : null;
		if (!p) return;
		if (p.group) {
			const g = String(p.group);
			if (artCollapsed.has(g)) artCollapsed.delete(g);
			else artCollapsed.add(g);
			renderArtifactsPanel();
			return;
		}
		if (!p.path) return;
		const path = String(p.path);
		if (p.is_dir) {
			if (expanded.has(path)) expanded.delete(path);
			else expanded.add(path);
			renderTreePanel();
		} else {
			scheduleOpen(path);
		}
	};
	// No context arg — the command must stay executable from both panel modes.
	editor.registerCommand(
		"fc_activate",
		"Open file / toggle folder (fresh-claude panels)",
		"fcActivate",
	);

	// Click handling: mouse_click reports the clicked buffer_row directly, so
	// a click on a folder line toggles it (Enter works too) — cursor_moved
	// can't do this, since arrow-keying through the tree would flap every
	// folder it passes. Clicked files also open here (dedup via lastPreview:
	// the same click usually fires cursor_moved as well).
	let lastPreview = "";
	editor.on("mouse_click", (args) => {
		if (args?.button !== "left") return;
		const bid = args.buffer_id;
		const row = args.buffer_row;
		if (typeof bid !== "number" || typeof row !== "number") return;
		const rendered =
			bid === treeBufId ? treeRendered : bid === artifactsBufId ? artifactsRendered : null;
		if (rendered === null) return;
		const p = rendered[row]?.properties;
		if (!p) return;
		if (p.group) {
			const g = String(p.group);
			if (artCollapsed.has(g)) artCollapsed.delete(g);
			else artCollapsed.add(g);
			renderArtifactsPanel();
			return;
		}
		if (!p.path) return;
		const path = String(p.path);
		if (p.is_dir) {
			if (expanded.has(path)) expanded.delete(path);
			else expanded.add(path);
			renderTreePanel();
		} else if (path !== lastPreview) {
			lastPreview = path;
			scheduleOpen(path);
		}
	});

	// Arrow-key scan: cursor landing on a file line opens it (same preview
	// feel as the built-in explorer); folders are ignored here — they toggle
	// only via click or Enter.
	editor.on("cursor_moved", (args) => {
		const bid = args?.buffer_id;
		if (typeof bid !== "number") return;
		if (bid !== treeBufId && bid !== artifactsBufId) return;
		const props =
			Array.isArray(args.text_properties) && args.text_properties.length > 0
				? args.text_properties
				: editor.getTextPropertiesAtCursor(bid);
		const p = props && props.length > 0 ? props[0] : null;
		if (!p || !p.path || p.is_dir) return;
		const path = String(p.path);
		if (path === lastPreview) return;
		lastPreview = path;
		scheduleOpen(path);
	});

	try {
		const queueHandle = await editor.watchPath(queue, false);
		editor.on("path_changed", (args) => {
			if (args.handle !== queueHandle) return;
			const text = editor.readFile(queue);
			if (text === null) return;
			const lines = text.split("\n").filter(Boolean);
			for (const p of lines.slice(seen)) {
				if (!editor.fileExists(p)) {
					// Deleted or renamed away — close the stale tab so temp
					// files don't linger after Claude cleans them up, and
					// mark the artifact entry.
					closeGoneBuffer(p);
					markDeleted(p);
					scheduleTreeRefresh();
					if (p === lastPreview) lastPreview = "";
					continue;
				}
				scheduleArtifact(p);
			}
			seen = lines.length;
		});
	} catch (e) {
		editor.debug(`init.ts: open-queue watch failed: ${e}`);
	}

	// ── Stale-tab sweep ──────────────────────────────────────────────────
	// Deletions normally arrive as fswatch Removed events through the queue
	// (closeGoneBuffer above), but a large git checkout/branch switch can
	// coalesce or drop events — and the watcher may be down mid-relaunch —
	// leaving tabs whose files no longer exist. Safety net: stat every open
	// file tab in the workspace every few seconds and close the gone ones.
	(async () => {
		for (;;) {
			await editor.delay(3000);
			for (const b of editor.listBuffers()) {
				if (b.is_virtual || !b.path) continue;
				if (!b.path.startsWith(CWD + "/")) continue;
				if (editor.fileExists(b.path)) continue;
				closeGoneBuffer(b.path);
				markDeleted(b.path);
				if (b.path === lastPreview) lastPreview = "";
			}
		}
	})();
})();
