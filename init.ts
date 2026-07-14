// fresh startup script — "claude" profile IDE layout.
// Only active when launched via the fresh-claude wrapper (FRESH_PROFILE=claude);
// plain `fresh` is untouched. Installed to ~/.config/fresh/init.ts.
//
// Layout: file explorer | editor (+ shell below) | Claude Code right, full height.
// Changed files anywhere in the workspace open as tabs in the top editor split.

(async () => {
	if (editor.getEnv("FRESH_PROFILE") !== "claude") return;

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
	if (editorSplitId !== undefined) editor.focusSplit(editorSplitId);

	// ── Diff highlights ──────────────────────────────────────────────────
	// Paint a background on every line that differs from git HEAD, so a tab
	// that pops open makes it obvious WHAT changed, not just that it did.
	// Untracked files are all-new → whole file painted. Non-git workspaces
	// get no highlights (there is no baseline to diff against).
	const DIFF_NS = "fresh-claude-diff";
	const DIFF_BG: [number, number, number] = [22, 68, 38];

	const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
	// "./name" pathspec keeps git happy with cwd-relative paths from any
	// subdirectory, and handles nested repos via cwd resolution.
	const specOf = (p: string) => "./" + p.slice(p.lastIndexOf("/") + 1);

	// [startLine, endLine] pairs (1-indexed, inclusive) of added/modified
	// lines; "all" for untracked files; null when not in a git repo.
	async function changedLineRanges(
		path: string,
	): Promise<Array<[number, number]> | "all" | null> {
		const dir = dirOf(path);
		const spec = specOf(path);
		let res = await editor.spawnProcess(
			"git",
			["diff", "-U0", "--no-color", "HEAD", "--", spec],
			dir,
		);
		if (res.exit_code !== 0) {
			// Unborn HEAD (repo with no commits) — diff against the index.
			res = await editor.spawnProcess(
				"git",
				["diff", "-U0", "--no-color", "--", spec],
				dir,
			);
			if (res.exit_code !== 0) return null;
		}
		const ranges: Array<[number, number]> = [];
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
		let m: RegExpExecArray | null;
		while ((m = hunk.exec(res.stdout)) !== null) {
			const start = parseInt(m[1], 10);
			const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
			if (count > 0) ranges.push([start, start + count - 1]);
		}
		if (ranges.length === 0 && res.stdout === "") {
			const tracked = await editor.spawnProcess(
				"git",
				["ls-files", "--error-unmatch", spec],
				dir,
			);
			if (tracked.exit_code !== 0) return "all";
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

	// Manually opened files get highlights too, and revisiting a tab after a
	// commit re-diffs it so stale highlights clear.
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
	editor.sendTerminalInput(
		shell.terminalId,
		`fresh-watch-open ${JSON.stringify(editor.getCwd())} ${JSON.stringify(queue)}\n`,
	);
	let seen = 0;
	let lastOpened = "";
	// Open only when the file actually differs from HEAD — git churn
	// (checkout/merge rewriting files back to committed content) produces
	// watcher events with an empty diff, and opening those is pure clutter.
	// "all" (untracked) and null (no git baseline) both still open.
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
