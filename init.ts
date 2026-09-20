// fresh startup script — "claude" profile IDE layout.
// Only active when launched via the fresh-claude wrapper (FRESH_PROFILE=claude);
// plain `fresh` is untouched. Installed to ~/.config/fresh/init.ts.
//
// Layout: [explorer + Artifacts sidebar] | editor (+ shell below) | Claude Code right.
// The left column is fresh's own sidebar: the built-in file explorer on top
// and an "Artifacts" section below it (mountSidebarSection, fresh ≥ 0.5.0 —
// sinelaw/fresh#3045) listing every file changed since launch. Changed files
// are BROADCAST to the Artifacts section (and badged ● in the explorer)
// instead of auto-opening as tabs; clicking (or pressing Enter on) an entry
// opens the file in the editor pane with changed lines highlighted green.

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

	// ── Pane ratios ──────────────────────────────────────────────────────
	const CLAUDE_RATIO = 0.5;
	const SHELL_RATIO = 0.75;

	// Artifacts state: path → { status: "new" | "modified" | "unknown",
	// added: lines }. Insertion order is oldest-first; rendering reverses it,
	// and updates re-insert, so the newest change sits on top. Deleted files
	// are dropped from the map entirely.
	const artifacts = new Map();

	function relPath(p: string): string {
		return p.startsWith(CWD + "/") ? p.slice(CWD.length + 1) : p;
	}

	// Dir rows and file rows get distinct theme-key colors (resolved against
	// the active theme) in BOTH panels, so the type is readable at a glance:
	// dirs bold keyword-color, files string-color.
	// Dir rows and file rows get distinct theme-key colors (resolved against
	// the active theme), so the type is readable at a glance: dirs bold
	// keyword-color, files string-color.
	const DIR_STYLE = { fg: "syntax.keyword", bold: true };
	const FILE_STYLE = { fg: "syntax.string" };
	// Deletion accents — shared by the in-file red phantom lines and the
	// Artifacts "-N" spans. DEL_BG is DIFF_BG's red twin.
	const DEL_BG: [number, number, number] = [86, 28, 28];
	const DEL_ACCENT: [number, number, number] = [220, 90, 90];
	// Explorer badge for changed files — the scrollbar's add-marker green. It
	// outranks the bundled git badges: "changed since launch" is this
	// layout's own notion of dirty, and the slot holds one glyph.
	const ART_DOT: [number, number, number] = [110, 205, 130];

	// ── Artifacts sidebar section ────────────────────────────────────────
	// One tree widget mounted as a collapsible section UNDER the built-in
	// file explorer. Rows: one header per directory (workspace-relative, "./"
	// for the root), newest-touched group first, newest file first within a
	// group. Group expansion is plugin-owned: the widget's expandedKeys is
	// initial-only, so it is re-pushed (setExpandedKeys) after every content
	// update. The host keys panels per plugin, so a constant id suffices.
	const PANEL_ID = 1;
	const TREE_KEY = "artifacts";
	const ART_ROWS = 0; // 0 = share the column with the explorer
	const ART_NS = "fresh-claude-artifacts"; // explorer decoration namespace
	const artCollapsed = new Set<string>();
	// Node index → what the row stands for, parallel to the spec's nodes
	// (widget_event reports an index over ALL nodes, collapsed ones included).
	let artRows: Array<{ group: string } | { path: string } | null> = [];

	function artifactTag(a: any): string {
		return a.status === "new"
			? a.added
				? `new +${a.added}`
				: "new"
			: a.status === "unknown"
				? "changed"
				: [a.added ? `+${a.added}` : "", a.deleted ? `-${a.deleted}` : ""]
						.filter(Boolean)
						.join(" ");
	}

	function artifactSpec() {
		const nodes: Array<Record<string, unknown>> = [];
		const keys: string[] = [];
		artRows = [];
		if (artifacts.size === 0) {
			nodes.push({ text: { text: "(no changes yet)" }, depth: 0, hasChildren: false });
			keys.push("empty");
			artRows.push(null);
		}
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
		for (const [dir, items] of groups) {
			nodes.push({
				text: { text: `${dir}  (${items.length})`, style: DIR_STYLE },
				depth: 0,
				hasChildren: true,
			});
			keys.push(`g:${dir}`);
			artRows.push({ group: dir });
			for (const { path, a } of items) {
				const name = dir === "./" ? relPath(path) : relPath(path).slice(dir.length);
				const head = `● ${name}  (`;
				const text: Record<string, unknown> = {
					text: `${head}${artifactTag(a)})`,
					style: FILE_STYLE,
				};
				// Red accent on the "-N" span, matching the in-file deletion
				// marker. Offsets in BYTES (the InlineOverlay default unit)
				// via utf8ByteLength — char units miscount the wide ● glyph.
				// The host shifts them past the indent/disclosure prefix.
				if (a.deleted && a.status === "modified") {
					const addPart = a.added ? `+${a.added} ` : "";
					const start = editor.utf8ByteLength(`${head}${addPart}`);
					text.inlineOverlays = [
						{
							start,
							end: start + editor.utf8ByteLength(`-${a.deleted}`),
							style: { fg: DEL_ACCENT },
						},
					];
				}
				nodes.push({ text, depth: 1, hasChildren: false });
				keys.push(`f:${path}`);
				artRows.push({ path });
			}
		}
		return {
			kind: "tree",
			key: TREE_KEY,
			nodes,
			itemKeys: keys,
			selectedIndex: -1,
			expandedKeys: expandedGroupKeys(),
			checkable: false,
			itemHeight: 1,
			cardBorders: false,
			indentCols: 1,
		};
	}

	function expandedGroupKeys(): string[] {
		const out: string[] = [];
		const seen = new Set<string>();
		for (const path of artifacts.keys()) {
			const rel = relPath(path);
			const cut = rel.lastIndexOf("/");
			const dir = cut === -1 ? "./" : rel.slice(0, cut + 1);
			if (seen.has(dir)) continue;
			seen.add(dir);
			if (!artCollapsed.has(dir)) out.push(`g:${dir}`);
		}
		return out;
	}

	let artMounted = false;
	function pushArtExpanded() {
		if (!artMounted) return;
		editor.widgetMutate(PANEL_ID, {
			kind: "setExpandedKeys",
			widgetKey: TREE_KEY,
			keys: expandedGroupKeys(),
		});
	}

	// Re-publish the section and the explorer badges from `artifacts`.
	function renderArtifactsPanel() {
		try {
			editor.setFileExplorerDecorations(
				ART_NS,
				[...artifacts.keys()].map((path) => ({
					path,
					symbol: "●",
					color: ART_DOT,
					priority: 100, // above git_explorer's M/A badges

				})),
			);
		} catch (e) {
			editor.debug(`init.ts: explorer decorations failed: ${e}`);
		}
		if (!artMounted) return;
		editor.updateFloatingWidget(PANEL_ID, artifactSpec());
		pushArtExpanded();
	}

	// The startup split is the editor pane; the sidebar is chrome, not a
	// split, so nothing here changes the split tree.
	const s0 = editor.listSplits()[0];
	// `let`: the editor split DIES when its last tab is closed (fresh
	// collapses an empty split); ensureEditorSplit below rebuilds + reassigns.
	let editorSplitId: number | undefined = s0?.splitId;
	try {
		// A FOCUSED mount reveals the sidebar column (explorer included) even
		// when the last session left it hidden — a blurred mount is silent
		// (Editor::reveal_sidebar). Mount focused, then hand the keyboard
		// straight back to the editor pane.
		artMounted = editor.mountSidebarSection(PANEL_ID, artifactSpec(), "Artifacts", ART_ROWS, {
			closable: false,
			startBlurred: false,
		});
		if (!artMounted) editor.debug("init.ts: mountSidebarSection refused; Artifacts section disabled");
		else {
			pushArtExpanded();
			editor.floatingPanelControl(PANEL_ID, "blur", 0);
		}
	} catch (e) {
		editor.debug(`init.ts: Artifacts section creation failed: ${e}`);
	}
	if (editorSplitId !== undefined) editor.focusSplit(editorSplitId);
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

	// Second terminal as a TAB next to Terminal 1: the watcher occupies
	// Terminal 1's foreground, so this one is for actual shell work. The
	// open_terminal action (what the tab bar "+" runs) creates a terminal
	// tab directly in the FOCUSED split — no throwaway split needed.
	{
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

	// ── Focus indicator: amber active tab ────────────────────────────────
	// The active-tab background is overridden to one loud amber — the tab of
	// the pane you're typing into is unmistakable at a glance. Flat dot-key —
	// the host expects `{"ui.tab_active_bg": [r,g,b]}`, NOT the nested
	// theme-file shape (that variant is silently ignored). Set once; the
	// override survives until an applyTheme call.
	const FOCUS_TAB_BG: [number, number, number] = [122, 62, 8];
	if (!editor.overrideThemeColors({ "ui.tab_active_bg": FOCUS_TAB_BG }))
		editor.debug("init.ts: overrideThemeColors refused tab_active_bg");

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

	// Diff of a file vs the launch snapshot. `adds` holds [startLine, endLine]
	// pairs (1-indexed, inclusive) of surviving lines that differ; `dels`
	// holds pure deletions — `line` is the NEW-file line number preceding the
	// removed block (0 when the file's first lines were deleted), `count` how
	// many lines vanished. "all" = new since launch (no snapshot entry); null
	// = outside the workspace, unreadable, or over the 1 MB cap.
	async function changedLineRanges(
		path: string,
	): Promise<
		| {
				adds: Array<[number, number]>;
				dels: Array<{ line: number; count: number; texts: string[] }>;
		  }
		| "all"
		| null
	> {
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
		if (res.exit_code === 0) return { adds: [], dels: [] };
		if (res.exit_code > 1 && res.stdout === "") return null;
		const adds: Array<[number, number]> = [];
		const dels: Array<{ line: number; count: number; texts: string[] }> = [];
		// Walk the diff line-by-line: a pure-deletion hunk (+n,0) is followed
		// by its removed lines as "-" lines — capture their content so each
		// can be shown as a red phantom line. Mixed hunks (new count > 0) are
		// replacements; the green overlay on the surviving lines covers them.
		const hunkRe = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
		let current: { line: number; count: number; texts: string[] } | null = null;
		for (const ln of res.stdout.split("\n")) {
			const m = hunkRe.exec(ln);
			if (m !== null) {
				const oldCount = m[1] === undefined ? 1 : parseInt(m[1], 10);
				const start = parseInt(m[2], 10);
				const count = m[3] === undefined ? 1 : parseInt(m[3], 10);
				current = null;
				if (count > 0) adds.push([start, start + count - 1]);
				else if (oldCount > 0) {
					current = { line: start, count: oldCount, texts: [] };
					dels.push(current);
				}
			} else if (current !== null && ln.startsWith("-") && !ln.startsWith("---")) {
				current.texts.push(ln.slice(1));
			}
		}
		return { adds, dels };
	}

	// Deletions get a red phantom line (virtual — not in the buffer text) at
	// the removal point, "-" in the gutter, since no surviving line can carry
	// a green background for them. Styled to mirror the green added-line
	// look: dim red BACKGROUND (DIFF_BG's red twin), light red accents.
	const DEL_NS = "fresh-claude-del";

	// Scrollbar diff markers (0.4.6 setScrollbarMarkers): adds as green range
	// marks, deletions as red point marks. Bright twins of the overlay
	// backgrounds — a 1-cell track mark needs accent-strength color. The set
	// is replaced atomically per namespace, so each repaint just resends all.
	const SB_NS = "fresh-claude-diff-sb";
	const SB_ADD: [number, number, number] = [110, 205, 130];

	async function highlightDiff(
		path: string,
		bufferId: number,
		diff?:
			| { adds: Array<[number, number]>; dels: Array<{ line: number; count: number }> }
			| "all"
			| null,
	) {
		if (diff === undefined) diff = await changedLineRanges(path);
		if (diff === null) return;
		editor.clearNamespace(bufferId, DIFF_NS);
		const content = editor.readFile(path);
		if (content === null) {
			editor.clearScrollbarMarkers(bufferId, SB_NS);
			return;
		}
		// Both key spellings — the API docs and OverlayOptions disagree.
		const style = { bg: DIFF_BG, extendToLineEnd: true, extend_to_line_end: true };
		const total = editor.utf8ByteLength(content);
		editor.clearVirtualLinesInRange(bufferId, DEL_NS, 0, total + 1);
		const lines = content.split("\n");
		// starts[i] = byte offset of line i (0-indexed); overlays take bytes.
		const starts: number[] = [0];
		for (const line of lines)
			starts.push(starts[starts.length - 1] + editor.utf8ByteLength(line) + 1);
		// ONE OVERLAY PER LINE, never one per range: fresh renders a multi-line
		// overlay only near its endpoints (roughly a screenful at each end), so
		// the middle of a big added block scrolls by with no green. Verified
		// headless: a 200-line overlay shows on the first/last ~37 rows only;
		// per-line overlays render at every scroll position. An empty line gets
		// its newline byte — that paints the row, and provably does not bleed
		// into the next line.
		const paintLines = (a: number, b: number) => {
			for (let ln = a; ln <= Math.min(b, lines.length); ln++) {
				const s = starts[ln - 1];
				const len = starts[ln] - s - 1;
				const e = len > 0 ? s + len : Math.min(s + 1, total);
				if (e > s) editor.addOverlay(bufferId, DIFF_NS, s, e, style);
			}
		};
		if (diff === "all") {
			if (total > 0) paintLines(1, lines.length);
			editor.setScrollbarMarkers(
				bufferId,
				SB_NS,
				total > 0 ? [{ position: 0, end: total, color: SB_ADD }] : [],
			);
			return;
		}
		const { adds, dels } = diff;
		if (adds.length === 0 && dels.length === 0) {
			editor.setScrollbarMarkers(bufferId, SB_NS, []);
			return;
		}
		const sbMarkers: Array<{
			position: number;
			end?: number;
			color: [number, number, number];
			priority?: number;
		}> = [];
		for (const [a, b] of adds) {
			paintLines(a, b);
			const s = starts[Math.min(a - 1, lines.length - 1)];
			// End of line b: start of line b+1 minus its "\n" (clamped for a
			// missing trailing newline on the last line). A range that is one
			// empty line collapses to s — a point marker still marks the track.
			const e = Math.min(starts[Math.min(b, lines.length)] - 1, total);
			if (e > s) sbMarkers.push({ position: s, end: e, color: SB_ADD });
			else sbMarkers.push({ position: s, color: SB_ADD });
		}
		// One red phantom line PER deleted line, showing its old content —
		// capped per block so a huge deletion can't wallpaper the buffer.
		const MAX_DEL_LINES = 20;
		for (const d of dels) {
			const opts = {
				fg: [235, 200, 200],
				bg: DEL_BG,
				gutterGlyph: "-",
				gutterColor: DEL_ACCENT,
			};
			const shown = d.texts.slice(0, MAX_DEL_LINES);
			if (shown.length === 0)
				shown.push(`── ${d.count} line${d.count === 1 ? "" : "s"} deleted ──`);
			else if (d.texts.length > MAX_DEL_LINES)
				shown.push(`── … ${d.texts.length - MAX_DEL_LINES} more deleted ──`);
			// d.line precedes the removed block: phantom lines ABOVE the next
			// line, or BELOW the last line when the deletion was at EOF.
			const above = d.line < lines.length;
			const anchor = above ? starts[d.line] : starts[Math.max(0, lines.length - 1)];
			for (const text of shown)
				editor.addVirtualLine(bufferId, anchor, text, opts, above, DEL_NS, 0);
			// Point mark on the track; higher priority so a deletion dot
			// isn't swallowed by an adjacent green range sharing its cell.
			sbMarkers.push({ position: anchor, color: DEL_ACCENT, priority: 1 });
		}
		editor.setScrollbarMarkers(bufferId, SB_NS, sbMarkers);
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

	// fresh auto-reloads a buffer whose file changed on disk (its own watcher,
	// ~1s slower than ours), and the reload WIPES the overlays the
	// watcher-driven highlightDiff just painted. Repaint AFTER the reload has
	// landed: two delayed passes per disk event, pure timers hanging off the
	// fswatch queue. Render-side events (lines_changed) are deliberately NOT
	// used for this — they also fire on plain scrolling (new lines into
	// view), and any scroll-triggered clear/re-add pass is visible jitter:
	// green overlays and red phantom lines flap in and out, so the viewport
	// rapidly alternates between two layouts. Nothing in this file is allowed
	// to do work from a scroll; highlight latency is fine, churn is not.
	const repaintPending = new Set<string>();
	function repaintAfterAutoReload(path: string) {
		if (repaintPending.has(path)) return;
		repaintPending.add(path);
		(async () => {
			try {
				// 2s catches the common case (reload trails the watcher by
				// ~1s); the second pass at +3s covers a slow reload, and is a
				// no-op repaint of identical overlays when the first stuck.
				for (const ms of [2000, 3000]) {
					await editor.delay(ms);
					const bid = editor.findBufferByPath(path);
					if (!bid) return;
					if (!editor.isBufferModified(bid)) scheduleHighlight(path);
				}
			} finally {
				repaintPending.delete(path);
			}
		})();
	}

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
	// open another terminal (+ on the tab bar) for shell work. TYPED, not
	// spawned via createTerminal's command: typed input just buffers in the
	// pty until zsh runs it, so racing the shell's startup is fine. The
	// watcher is a plain PTY child — it dies with fresh, so there is no
	// stale-watcher cleanup on relaunch.
	const watchCmd = `fresh-watch-open ${JSON.stringify(editor.getCwd())} ${JSON.stringify(queue)}`;
	editor.sendTerminalInput(shell.terminalId, `${watchCmd}\n`);
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
				const diff = await changedLineRanges(path);
				if (
					diff !== null &&
					diff !== "all" &&
					diff.adds.length === 0 &&
					diff.dels.length === 0
				) {
					if (artifacts.delete(path)) renderArtifactsPanel();
					const bufId = editor.findBufferByPath(path);
					// Empty diff through highlightDiff clears highlights AND
					// any stale red deletion lines.
					if (bufId) {
						if (!editor.isBufferModified(bufId))
							await editor.refreshBufferFromDisk(bufId);
						await highlightDiff(path, bufId, diff);
					}
					return;
				}
				const status =
					diff === "all" ? "new" : diff === null ? "unknown" : "modified";
				// A new file's "added" is its whole line count, so the panel can
				// show "(new +200)" instead of a bare "(new)". Trailing-newline
				// split yields a phantom last "" element — don't count it.
				let added = 0;
				if (diff === "all") {
					const c = editor.readFile(path);
					if (c !== null && c !== "")
						added = c.split("\n").length - (c.endsWith("\n") ? 1 : 0);
				} else if (diff !== null) {
					added = sumAdded(diff.adds);
				}
				const deleted =
					diff !== null && diff !== "all"
						? diff.dels.reduce((n, d) => n + d.count, 0)
						: 0;
				artifacts.delete(path); // re-insert → newest-first render order
				artifacts.set(path, { status, added, deleted });
				renderArtifactsPanel();
				const bufId = editor.findBufferByPath(path);
				if (bufId) {
					// The buffer does NOT auto-reload on external writes — a
					// stale buffer shows old content (and would clobber the
					// disk state if saved). Refresh unless the user has real
					// unsaved edits in it.
					if (!editor.isBufferModified(bufId))
						await editor.refreshBufferFromDisk(bufId);
					await highlightDiff(path, bufId, diff);
					repaintAfterAutoReload(path);
				}
			})
			.catch((e) => editor.debug(`init.ts: artifact update failed: ${e}`));
	}

	// A deleted file's entry is dropped — a dead artifact opens nothing, so
	// listing it is clutter. Its tab (if any) still closes via closeGoneBuffer.
	function dropArtifact(path: string) {
		if (artifacts.delete(path)) renderArtifactsPanel();
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
				const diff = await changedLineRanges(path);
				let firstLine = 0;
				if (diff !== null && diff !== "all") {
					const firstAdd = diff.adds.length > 0 ? diff.adds[0][0] - 1 : Infinity;
					const firstDel = diff.dels.length > 0 ? diff.dels[0].line : Infinity;
					const f = Math.min(firstAdd, firstDel);
					if (f !== Infinity) firstLine = f;
				}
				const target = await ensureEditorSplit();
				if (target === undefined) return;
				editor.openFileInSplit(target, path, firstLine, 0);
				const bufId = editor.findBufferByPath(path);
				if (bufId) {
					if (!editor.isBufferModified(bufId))
						await editor.refreshBufferFromDisk(bufId);
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
					await highlightDiff(path, bufId, diff);
					if (firstLine > 0) editor.scrollToLineCenter(target, bufId, firstLine);
				}
			})
			.catch((e) => editor.debug(`init.ts: open+highlight failed: ${e}`));
	}

	// ── Section activation ───────────────────────────────────────────────
	// The host routes every hit on the Artifacts tree through widget_event:
	// a disclosure-glyph click is `expand`, Up/Down/click on a row is `select`
	// (a click's payload is tagged via: "click"), Enter is `activate`. A row
	// select PREVIEWS the file (keyboard stays in the sidebar, like the
	// explorer's single-click); Enter opens it and moves focus to the editor.
	// Nothing here runs from a scroll — see repaintAfterAutoReload.
	let lastPreview = "";
	// A collapse/expand is re-PUBLISHED (updateFloatingWidget), not just
	// pushed as a setExpandedKeys mutation: fresh 0.5.1 tracks the new state
	// either way (arrow keys skip the hidden rows) but only repaints the
	// section when its spec is replaced, so a bare mutation leaves the
	// collapsed children visible until the next content update.
	function toggleGroup(g: string) {
		if (artCollapsed.has(g)) artCollapsed.delete(g);
		else artCollapsed.add(g);
		renderArtifactsPanel();
	}
	editor.on("widget_event", (e) => {
		if (e.panel_id !== PANEL_ID) return;
		const payload = (e.payload ?? {}) as {
			index?: unknown;
			key?: unknown;
			expanded?: unknown;
			via?: unknown;
		};
		if (e.event_type === "expand") {
			if (typeof payload.key !== "string" || !payload.key.startsWith("g:")) return;
			const g = payload.key.slice(2);
			const open =
				typeof payload.expanded === "boolean" ? payload.expanded : artCollapsed.has(g);
			if (open) artCollapsed.delete(g);
			else artCollapsed.add(g);
			renderArtifactsPanel();
			return;
		}
		if (e.event_type !== "select" && e.event_type !== "activate") return;
		const index = typeof payload.index === "number" ? payload.index : -1;
		const row = artRows[index];
		if (!row) return;
		if ("group" in row) {
			if (e.event_type === "activate") toggleGroup(row.group);
			return;
		}
		const path = row.path;
		if (e.event_type === "activate") {
			lastPreview = path;
			scheduleOpen(path);
			diffChain = diffChain.then(() => {
				editor.floatingPanelControl(PANEL_ID, "blur", 0);
				if (editorSplitId !== undefined) editor.focusSplit(editorSplitId);
			});
		} else if (path !== lastPreview) {
			lastPreview = path;
			scheduleOpen(path);
		}
	});
	// ── Nested-gitignore filter ──────────────────────────────────────────
	// A workspace like ~/Desktop/Work holds many independent git repos, each
	// with its own .gitignore; a test run in one of them sprays ignored churn
	// (coverage output, __pycache__ leftovers, build artifacts) that the
	// watcher's static exclude list can't anticipate — and it all lands in the
	// Artifacts panel. Before a queued path becomes an artifact, ask the repo
	// that CONTAINS it (nearest ancestor dir with a .git, found by walking up
	// — no startup scan, so repos cloned mid-session work too) whether the
	// path is ignored: one batched `git check-ignore` per repo per queue
	// burst, verdicts cached per path (test runs rewrite the same paths over
	// and over). Paths outside any repo, and any git failure, fail OPEN — a
	// wrongly listed artifact beats a silently missing one.
	const hasGitCache = new Map<string, boolean>();
	function dirHasGit(dir: string): boolean {
		let v = hasGitCache.get(dir);
		if (v === undefined) {
			try {
				v = editor.readDir(dir).some((en) => en.name === ".git");
			} catch {
				v = false;
			}
			hasGitCache.set(dir, v);
		}
		return v;
	}
	// Nearest git repo root containing path. Walks all the way up to "/",
	// NOT just to the workspace root: a workspace opened INSIDE a repo
	// (e.g. lear/legal-api, whose .git and .gitignore live one level up in
	// lear/) must still get that repo's verdicts — bounding the walk at CWD
	// silently disabled the filter there and every test-run leftover showed
	// up as "(new)".
	function gitRootOf(path: string): string | null {
		let dir = path.slice(0, path.lastIndexOf("/"));
		while (dir !== "") {
			if (dirHasGit(dir)) return dir;
			dir = dir.slice(0, dir.lastIndexOf("/"));
		}
		return dirHasGit("/") ? "/" : null;
	}
	const ignoredCache = new Map<string, boolean>();
	async function filterIgnored(paths: string[]): Promise<string[]> {
		const toAsk = new Map<string, string[]>(); // repo root → uncached paths
		for (const p of paths) {
			if (ignoredCache.has(p)) continue;
			const root = gitRootOf(p);
			if (root === null) {
				ignoredCache.set(p, false);
				continue;
			}
			let list = toAsk.get(root);
			if (list === undefined) toAsk.set(root, (list = []));
			list.push(p);
		}
		for (const [root, ps] of toAsk) {
			// Chunked: a checkout burst can queue thousands of paths, and one
			// argv must stay under the exec limit.
			for (let i = 0; i < ps.length; i += 500) {
				const chunk = ps.slice(i, i + 500);
				const ignored = new Set<string>();
				try {
					// check-ignore echoes the ignored subset on stdout.
					// Exit 0 = some ignored, 1 = none, >1 = error (fail open).
					const res = await editor.spawnProcess(
						"git",
						["-C", root, "check-ignore", "--", ...chunk],
						CWD,
					);
					if (res.exit_code === 0 || res.exit_code === 1)
						for (const ln of res.stdout.split("\n"))
							if (ln !== "") ignored.add(ln);
				} catch (e) {
					editor.debug(`init.ts: check-ignore failed for ${root}: ${e}`);
				}
				for (const p of chunk) ignoredCache.set(p, ignored.has(p));
			}
		}
		return paths.filter((p) => ignoredCache.get(p) !== true);
	}
	// ── Git-rewrite re-baseline ──────────────────────────────────────────
	// A branch switch, pull, stash or reset rewrites tracked files wholesale,
	// and every one lands in the queue looking like an edit: the baseline is
	// a launch-time mirror, so a checkout five minutes into a session listed
	// the whole branch delta as artifacts ("(+220)" test files nobody
	// touched) and the real edits drowned. fswatch can't say WHO wrote a
	// file, but git can: right after HEAD moves (reflog entry within
	// REBASE_WINDOW seconds — and not a plain commit, which touches no
	// working-tree file, so a clean path in a commit's wake is an agent edit
	// committed inside the debounce, not a git rewrite), any queued path that
	// is CLEAN vs HEAD was written by git. Those get their mirror copy
	// replaced with the post-checkout content (removed where git deleted
	// them), so later edits diff against the new branch and the now-empty
	// diff retires any entry. Dirty paths are left alone: still "changed since
	// launch", and the agent may well be why. Rewrites the reflog does NOT
	// record (`git checkout -- file`, `git restore`) are deliberately not
	// covered — a file dirty at launch and reverted mid-session is exactly the
	// trampling the panel should show.
	const REBASE_WINDOW = 60; // seconds
	// Pairs of <src> <mirror-dst>: copy (size-capped like the launch rsync)
	// or, when src is gone / too big, drop the stale mirror copy.
	const REBASE_SCRIPT = `
while [ $# -ge 2 ]; do
  src=$1; dst=$2; shift 2
  if [ -f "$src" ] && [ "$(wc -c < "$src")" -le 1048576 ]; then
    mkdir -p "$(dirname "$dst")" && cp -p "$src" "$dst"
  else
    rm -f "$dst"
  fi
done
`;
	// True when the repo's HEAD reflog gained a non-commit entry within the
	// window. --date=unix puts the ENTRY time in %gd (%ct would be the
	// commit's own date — ancient for a checkout of an old branch).
	async function headMovedRecently(root: string): Promise<boolean> {
		try {
			const res = await editor.spawnProcess(
				"git",
				["-C", root, "reflog", "-1", "--date=unix", "--format=%gd %gs"],
				CWD,
			);
			if (res.exit_code !== 0) return false;
			const m = /^HEAD@\{(\d+)\} (.*)$/.exec(res.stdout.trim());
			if (m === null) return false;
			if (Date.now() / 1000 - Number(m[1]) > REBASE_WINDOW) return false;
			return !m[2].startsWith("commit");
		} catch (e) {
			editor.debug(`init.ts: reflog probe failed for ${root}: ${e}`);
			return false;
		}
	}
	// Refresh the mirror for every path git just rewrote; returns that subset.
	// Deleted paths belong here too (checkout removed the file → its mirror
	// copy goes; agent deleted it → " D" in status → mirror kept, so a later
	// re-create still diffs against the launch content).
	async function rebaseGitRewrites(paths: string[]): Promise<Set<string>> {
		const byRoot = new Map<string, string[]>();
		for (const p of paths) {
			if (snapPathOf(p) === null) continue;
			const root = gitRootOf(p);
			if (root === null) continue;
			let list = byRoot.get(root);
			if (list === undefined) byRoot.set(root, (list = []));
			list.push(p);
		}
		const rebased = new Set<string>();
		for (const [root, ps] of byRoot) {
			if (!(await headMovedRecently(root))) continue;
			for (let i = 0; i < ps.length; i += 500) {
				const chunk = ps.slice(i, i + 500);
				// Absolute pathspecs are fine inside the worktree; output is
				// root-relative "XY path\0". --no-renames keeps it one token
				// per entry. Untracked ("??") counts as dirty.
				let dirty: Set<string>;
				try {
					const res = await editor.spawnProcess(
						"git",
						[
							"-C", root, "status", "--porcelain", "-z", "--no-renames",
							"--untracked-files=all", "--", ...chunk,
						],
						CWD,
					);
					if (res.exit_code !== 0) continue; // fail open: keep listing
					dirty = new Set(
						res.stdout.split("\0").filter(Boolean).map((e) => `${root}/${e.slice(3)}`),
					);
				} catch (e) {
					editor.debug(`init.ts: status probe failed for ${root}: ${e}`);
					continue;
				}
				const args: string[] = [];
				for (const p of chunk) {
					if (dirty.has(p)) continue;
					rebased.add(p);
					args.push(p, snapPathOf(p) as string);
				}
				if (args.length === 0) continue;
				try {
					const res = await editor.spawnProcess("sh", ["-c", REBASE_SCRIPT, "_", ...args], CWD);
					if (res.exit_code !== 0)
						editor.debug(`init.ts: mirror rebase failed for ${root}: ${res.stderr}`);
				} catch (e) {
					editor.debug(`init.ts: mirror rebase error for ${root}: ${e}`);
				}
				if (rebased.size) editor.debug(`init.ts: re-baselined ${rebased.size} git-rewritten path(s) under ${root}`);
			}
		}
		return rebased;
	}
	// Serialize queue batches so a slow check-ignore can't reorder artifact
	// updates across bursts.
	let ignoreChain: Promise<void> = Promise.resolve();

	try {
		const queueHandle = await editor.watchPath(queue, false);
		editor.on("path_changed", (args) => {
			if (args.handle !== queueHandle) return;
			const text = editor.readFile(queue);
			if (text === null) return;
			const lines = text.split("\n").filter(Boolean);
			const batch = lines.slice(seen);
			seen = lines.length;
			const live: string[] = [];
			const gone: string[] = [];
			for (const p of batch) {
				if (!editor.fileExists(p)) {
					// Deleted or renamed away — close the stale tab so temp
					// files don't linger after Claude cleans them up, and
					// mark the artifact entry.
					closeGoneBuffer(p);
					dropArtifact(p);
					if (p === lastPreview) lastPreview = "";
					gone.push(p);
					continue;
				}
				live.push(p);
			}
			if (live.length === 0 && gone.length === 0) return;
			// An edited .gitignore changes verdicts — drop the cache and let
			// the next burst re-ask git.
			if (live.some((p) => p.endsWith("/.gitignore"))) ignoredCache.clear();
			ignoreChain = ignoreChain
				.then(async () => {
					const kept = new Set(await filterIgnored(live));
					// Mirror refresh must land BEFORE the diffs below are
					// queued: a rebased path then diffs empty and retires.
					await rebaseGitRewrites([...kept, ...gone]);
					for (const p of live) {
						if (kept.has(p)) scheduleArtifact(p);
						// Newly ignored (e.g. the .gitignore just gained a
						// rule): retire any entry it earned earlier.
						else dropArtifact(p);
					}
				})
				.catch((e) => editor.debug(`init.ts: gitignore filter failed: ${e}`));
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
	// Artifact entries get the same sweep — a tool's temp file (atomic-write
	// `.tmp.*`, `.!pid!name`, mkstemp names) that was created and deleted
	// within one coalesced fswatch event can otherwise linger as "(new)".
	(async () => {
		for (;;) {
			await editor.delay(3000);
			for (const b of editor.listBuffers()) {
				if (b.is_virtual || !b.path) continue;
				if (!b.path.startsWith(CWD + "/")) continue;
				if (editor.fileExists(b.path)) continue;
				closeGoneBuffer(b.path);
				dropArtifact(b.path);
				if (b.path === lastPreview) lastPreview = "";
			}
			for (const p of Array.from(artifacts.keys())) {
				if (editor.fileExists(p)) continue;
				dropArtifact(p);
				if (p === lastPreview) lastPreview = "";
			}
		}
	})();
})();
