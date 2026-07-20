// fresh startup script — "claude" profile IDE layout.
// Only active when launched via the fresh-claude wrapper (FRESH_PROFILE=claude);
// plain `fresh` is untouched. Installed to ~/.config/fresh/init.ts.
//
// Layout: file explorer | editor (+ shell below) | Claude Code right, full height.
// Changed files anywhere in the workspace open as tabs in the top editor split.

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

	// Show the file explorer sidebar (hidden by default on a fresh workspace).
	// Width comes from .fresh/config.json in the project dir — setSetting
	// updates the value but the explorer never re-layouts from it.
	await editor.delay(100);
	editor.executeAction("toggle_file_explorer");

	// Only one split exists at startup — that's the editor pane. Remember it
	// so the shell split below can target it instead of Claude's split.
	const editorSplitId = editor.listSplits()[0]?.splitId;

	// Right pane, full height: Claude Code spawned directly in the PTY.
	// Full path via FRESH_CLAUDE_BIN (set by fresh-claude) — the PTY child
	// skips the login shell, so PATH may not contain claude.
	// focus:false keeps focus on the editor split so the next split lands under it.
	const claudeBin = editor.getEnv("FRESH_CLAUDE_BIN") || "claude";
	await editor.createTerminal({
		direction: "vertical",
		ratio: 0.5,
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
		ratio: 0.75,
		focus: false,
	});

	// (The shell is hopped into tmux at the watcher-launch step below — one
	// typed line does both, see the comment there.)

	// Second terminal as a TAB next to Terminal 1: the watcher occupies
	// Terminal 1's foreground, so this one is for actual shell work. There
	// is no create-as-tab API — createTerminal always splits — so: create it
	// in a throwaway split, DISPLAY its buffer in the shell split (which
	// registers it as a tab there), flip the shell split back to Terminal 1,
	// and only then close the throwaway split. Closing first loses the
	// buffer (verified: the tab never appears) — a buffer only survives a
	// split close while some split still owns it. Its own persistent tmux
	// session (fresh-shell) — same leak-eating rationale as below, but a
	// plain `exec` typed line suffices: nothing else types into this pane,
	// so there is no stale-watcher or multi-line race to manage.
	const workShell = await editor.createTerminal({
		direction: "vertical",
		ratio: 0.5,
		focus: false,
	});
	{
		const tmuxBin = editor.getEnv("FRESH_TMUX_BIN");
		if (tmuxBin)
			editor.sendTerminalInput(
				workShell.terminalId,
				`exec ${JSON.stringify(tmuxBin)} new-session -A -s fresh-shell\n`,
			);
	}
	// The tab-registration dance is asynchronous under the hood (split/buffer
	// updates are queued) — without the delays the flip back to Terminal 1
	// can be processed before Terminal 2's display ever registers, and the
	// closeSplit then destroys the buffer (symptom: no Terminal 2 tab).
	if (shell.splitId !== null && workShell.splitId !== null) {
		editor.setSplitBuffer(shell.splitId, workShell.bufferId);
		await editor.delay(250);
		editor.setSplitBuffer(shell.splitId, shell.bufferId);
		await editor.delay(250);
		editor.closeSplit(workShell.splitId);
		await editor.delay(250);
		if (!editor.listBuffers().some((b) => b.id === workShell.bufferId))
			editor.debug("init.ts: Terminal 2 buffer lost after closeSplit");
	}
	if (editorSplitId !== undefined) editor.focusSplit(editorSplitId);

	// ── Diff highlights ──────────────────────────────────────────────────
	// Paint a background on every line that differs from the launch snapshot,
	// so a tab that pops open makes it obvious WHAT changed, not just that it
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
				const other = editor
					.listBuffers()
					.filter((b) => b.id !== gone && !b.is_virtual && b.path && editor.fileExists(b.path))
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

	// Auto-open edited files as tabs in the TOP editor split.
	// fswatch (in the bottom shell — fresh's own recursive watchPath dies
	// with EMFILE on big trees) appends changed paths to a queue file;
	// we watch that single file and open each new entry in editorSplitId.
	// Queue lives OUTSIDE the watched tree (unique per launch) so the
	// watcher can never see its own queue writes and loop.
	const queue = `/tmp/fresh-open-queue-${Date.now()}`;
	editor.writeFile(queue, "");
	// Foreground, output visible — the shell doubles as the watcher log;
	// open another terminal (+ on the tab bar) for shell work.
	//
	// With tmux available, ONE typed line hops the shell into tmux AND
	// launches the watcher inside it:
	//   exec tmux new-session -A -s fresh ';' send-keys -t fresh '<watch>' Enter
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
	// - -A -s fresh: one persistent named session — the shell (and anything
	//   running in it) survives fresh restarts. The wrapper pre-clears a
	//   reattached session's stale watcher server-side (send-keys C-c), so
	//   the prompt is free to take the new watcher command.
	const tmuxBin = editor.getEnv("FRESH_TMUX_BIN");
	const watchCmd = `fresh-watch-open ${JSON.stringify(editor.getCwd())} ${JSON.stringify(queue)}`;
	editor.sendTerminalInput(
		shell.terminalId,
		tmuxBin
			? `exec ${JSON.stringify(tmuxBin)} new-session -A -s fresh ';' send-keys -t fresh '${watchCmd}' Enter\n`
			: `${watchCmd}\n`,
	);
	let seen = 0;
	let lastOpened = "";
	// Open only when the file actually differs from the launch snapshot — a
	// file rewritten back to its baseline (checkout/merge/revert) produces a
	// watcher event with an empty diff, and opening that is pure clutter.
	// "all" (new since launch) and null (over cap / outside workspace) open.
	function scheduleOpenAndHighlight(path: string) {
		diffChain = diffChain
			.then(async () => {
				if (!editor.fileExists(path)) return;
				const ranges = await changedLineRanges(path);
				const changed = ranges === null || ranges === "all" || ranges.length > 0;
				if (changed && editorSplitId !== undefined && path !== lastOpened) {
					lastOpened = path;
					editor.openFileInSplit(editorSplitId, path, 0, 0);
				}
				const bufId = editor.findBufferByPath(path);
				if (bufId) await highlightDiff(path, bufId, ranges);
			})
			.catch((e) => editor.debug(`init.ts: open+highlight failed: ${e}`));
	}
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
					// files don't linger after Claude cleans them up.
					closeGoneBuffer(p);
					if (p === lastOpened) lastOpened = "";
					continue;
				}
				scheduleOpenAndHighlight(p);
			}
			seen = lines.length;
		});
	} catch (e) {
		editor.debug(`init.ts: open-queue watch failed: ${e}`);
	}
})();
