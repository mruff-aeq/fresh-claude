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
	try {
		const queueHandle = await editor.watchPath(queue, false);
		editor.on("path_changed", (args) => {
			if (args.handle !== queueHandle) return;
			const text = editor.readFile(queue);
			if (text === null) return;
			const lines = text.split("\n").filter(Boolean);
			for (const p of lines.slice(seen)) {
				if (p === lastOpened) continue; // don't re-yank the active tab
				lastOpened = p;
				if (editorSplitId !== undefined && editor.fileExists(p)) {
					editor.openFileInSplit(editorSplitId, p, 0, 0);
				}
			}
			seen = lines.length;
		});
	} catch (e) {
		editor.debug(`init.ts: open-queue watch failed: ${e}`);
	}
})();
