// fresh startup script — "claude" profile IDE layout.
// Only active when launched via the fresh-claude wrapper (FRESH_PROFILE=claude);
// plain `fresh` is untouched. Installed to ~/.config/fresh/init.ts.
//
// Layout: [Files + Artifacts dock] | editor (+ shell below) | Claude Code right.
// The left column is a plugin dock (mountFloatingWidget asDock, fresh ≥ 0.5.0)
// holding two trees: the workspace file tree (long names wrap) and an
// "Artifacts" list of every file changed since launch. fresh's built-in File
// Explorer is not used. Changed files are BROADCAST to Artifacts (and marked ●
// in the file tree) instead of auto-opening as tabs; clicking (or pressing
// Enter on) an entry opens the file in the editor pane with changed lines
// highlighted green. Right-click on any row opens a context menu (Open, Copy
// path).

(async () => {
	if (editor.getEnv("FRESH_PROFILE") !== "claude") return;

	// ── One source of truth for "what changed" ───────────────────────────
	// The bundled git_gutter plugin paints its own gutter bars and scrollbar
	// marks (namespaces "git-gutter" / "git-gutter-scroll") from a diff
	// against git HEAD, re-applied on every open and tab switch. In this
	// layout the Artifacts entry, the green line overlays and the scrollbar
	// marks all describe the SAME thing — changes since launch — and HEAD is
	// a different baseline: a file listed "(+116)" showed orange "modified"
	// bars and red/orange track marks for hunks nobody touched this session.
	// Unload it for this profile only (plain `fresh` keeps it); the green
	// gutter indicators painted in highlightDiff take over the slot.
	try {
		if (!(await editor.unloadPlugin("git_gutter")))
			editor.debug("init.ts: unloadPlugin(git_gutter) refused — HEAD-based gutter marks will show");
	} catch (e) {
		editor.debug(`init.ts: unloadPlugin(git_gutter) failed: ${e}`);
	}

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
	// the active theme) in both trees, so the type is readable at a glance:
	// dirs bold keyword-color, files string-color.
	const DIR_STYLE = { fg: "syntax.keyword", bold: true };
	const FILE_STYLE = { fg: "syntax.string" };
	// Deletion accents — shared by the in-file red phantom lines and the
	// Artifacts "-N" spans. DEL_BG is DIFF_BG's red twin.
	const DEL_BG: [number, number, number] = [86, 28, 28];
	const DEL_ACCENT: [number, number, number] = [220, 90, 90];
	// Changed-file color in the file tree (● + name) — the scrollbar's
	// add-marker green: "changed since launch" is this layout's own notion of
	// dirty.
	const ART_DOT: [number, number, number] = [110, 205, 130];

	// ── Files + Artifacts dock ───────────────────────────────────────────
	// The left column is a plugin DOCK (mountFloatingWidget asDock, fresh ≥
	// 0.5.0): ONE panel holding two tree widgets — the workspace file tree on
	// top, the Artifacts list under it. fresh's own sidebar (the built-in
	// File Explorer) is not used: in 0.5.1 it cannot be hidden or collapsed
	// on its own (toggle_file_explorer hides the whole column, plugin sections
	// included; the header's collapse toggle is mouse-only and not
	// persisted), and it hard-truncates long names. Both trees here WRAP a
	// long name instead: the tree widget has no per-node wrapping (item
	// height is uniform), so a name wider than its row continues on extra
	// leaf rows that resolve to the same path. Right-click on any row opens
	// a context menu (the host fires widget_event "context" for it). The host
	// keys panels per plugin, so constant ids suffice.
	const PANEL_ID = 1; // the dock
	const MENU_ID = 2; // the right-click menu, mounted on demand
	const FILES_KEY = "files";
	const ART_KEY = "artifacts";
	const FILES_RATIO = 0.5; // the file tree's share of the dock's body rows
	// Dock width: `file_explorer.width` from config when it is an absolute
	// column count (the old explorer setting keeps working), else 28.
	const DOCK_COLS = (() => {
		try {
			const w = (editor.getConfig() as any)?.file_explorer?.width;
			if (typeof w === "string" && /^\d+$/.test(w)) return Math.max(16, parseInt(w, 10));
		} catch (_) {
			/* fall through to the default */
		}
		return 28;
	})();
	// Content columns: the host paints the dock's right border in the last
	// column. A tree row spends 2 columns on the disclosure glyph (or the
	// blank standing in for one) plus its indent; the rest is text.
	const DOCK_INNER = DOCK_COLS - 1;
	const FILES_INDENT = 2;
	const ART_INDENT = 1;
	// Marker at the start of every continuation row of a wrapped name, so a
	// row that belongs to the entry above reads as such at a glance (its
	// hits — click, right-click — still resolve to that entry).
	const WRAP_GLYPH = "↳ ";
	const WRAP_W = editor.stringWidth(WRAP_GLYPH);
	const WRAP_GLYPH_STYLE = { fg: "ui.menu_disabled_fg" };
	// Prefix the continuation chunks (all but the first) with the marker,
	// dimmed via an inline overlay (byte offsets).
	function markContinuations(chunks: string[]): Array<{ text: string; inlineOverlays?: unknown[] }> {
		return chunks.map((c, i) =>
			i === 0
				? { text: c }
				: {
						text: WRAP_GLYPH + c,
						inlineOverlays: [
							{ start: 0, end: editor.utf8ByteLength(WRAP_GLYPH.trimEnd()), style: WRAP_GLYPH_STYLE },
						],
					},
		);
	}
	// Directories the file tree never lists (same set the snapshot skips).
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
	]);
	// Dirs the snapshot mirror skips (SNAP_SCRIPT's --exclude list): files
	// under them have no baseline and get no highlights.
	const SNAP_EXCLUDE = new Set([...EXCLUDE_DIRS, ".fresh"]);

	// Split `text` into chunks no wider than `cols` terminal columns
	// (stringWidth counts wide glyphs like ● correctly). Never empty.
	// `restCols` (default `cols`) is the budget of the continuation rows,
	// for when they sit one indent level deeper than the first.
	function wrapCols(text: string, cols: number, restCols: number = cols): string[] {
		cols = Math.max(4, cols);
		restCols = Math.max(4, restCols);
		if (editor.stringWidth(text) <= cols) return [text];
		const out: string[] = [];
		let cur = "";
		for (const ch of text) {
			const budget = out.length === 0 ? cols : restCols;
			if (cur !== "" && editor.stringWidth(cur + ch) > budget) {
				out.push(cur);
				cur = ch;
			} else cur += ch;
		}
		if (cur !== "") out.push(cur);
		return out;
	}

	// What a tree row stands for. Each tree keeps an array parallel to its
	// nodes (widget_event reports an index over ALL of a tree's nodes,
	// collapsed ones included); continuation rows of a wrapped name map to
	// the same entry as the row they continue.
	type DockRow = { path: string; is_dir: boolean } | { group: string } | null;
	let filesRows: DockRow[] = [];
	let artRows: DockRow[] = [];
	// The entry the user last landed on, per tree, painted with HILITE_BG on
	// EVERY row it spans (a wrapped name is one entry, so the whole name
	// lights up — the host's own bar would mark a single row). The host's
	// selectedIndex is mirrored in `hostSel` so a spec re-publish (which
	// happens on every highlight change) does not reset keyboard navigation;
	// it is -1 after a mouse click (see the select handler).
	// HILITE_BG is the very color the host paints its one-row hover band
	// with, so the plugin's whole-entry band and the host's row band read as
	// one highlight.
	const HILITE_BG = "ui.menu_hover_bg";
	const hilite: Record<string, DockRow> = { [FILES_KEY]: null, [ART_KEY]: null };
	// The entry under the mouse pointer (see the mouse_move handler), painted
	// the same way so hovering a wrapped name lights every row of it.
	const hover: Record<string, DockRow> = { [FILES_KEY]: null, [ART_KEY]: null };
	const hostSel: Record<string, number> = { [FILES_KEY]: -1, [ART_KEY]: -1 };
	// Node indices in display order of the rows the host actually shows
	// (children of a collapsed dir/group are skipped), per tree — what maps a
	// screen row back to an entry while the tree is not scrolled.
	const visible: Record<string, number[]> = { [FILES_KEY]: [], [ART_KEY]: [] };
	const budget: Record<string, number> = { [FILES_KEY]: 0, [ART_KEY]: 0 };
	function sameRow(a: DockRow, b: DockRow): boolean {
		if (a === null || b === null) return false;
		if ("group" in a) return "group" in b && a.group === b.group;
		return "path" in b && a.path === b.path;
	}
	function rowStyle(base: Record<string, unknown>, tree: string, row: DockRow) {
		return sameRow(hilite[tree], row) || sameRow(hover[tree], row) ? { ...base, bg: HILITE_BG } : base;
	}
	// Directory listings are cached across the hover-driven re-renders
	// (pointer crossing rows) and dropped on every content-driven one.
	let dirCache = new Map<string, DirEntry[]>();
	function readDirCached(dir: string): DirEntry[] {
		let entries = dirCache.get(dir);
		if (entries === undefined) {
			entries = editor.readDir(dir);
			dirCache.set(dir, entries);
		}
		return entries;
	}

	// ── File tree ────────────────────────────────────────────────────────
	// Dirs are read lazily — only expanded ones are listed (root always is),
	// so big trees stay cheap. Files changed since launch are painted in the
	// Artifacts green with a ● in front, the dock's equivalent of the old
	// explorer badge.
	const expanded = new Set<string>([CWD]);
	function filesSpec(visibleRows: number) {
		const nodes: Array<Record<string, unknown>> = [];
		const keys: string[] = [];
		filesRows = [];
		const vis: number[] = [];
		const push = (node: Record<string, unknown>, key: string, row: DockRow, shown = true) => {
			if (shown) vis.push(nodes.length);
			nodes.push(node);
			keys.push(key);
			filesRows.push(row);
		};
		const walk = (dir: string, depth: number) => {
			let entries: DirEntry[];
			try {
				entries = readDirCached(dir);
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
					: a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
			);
			const cols = DOCK_INNER - 2 - depth * FILES_INDENT;
			for (const en of entries) {
				const full = `${dir}/${en.name}`;
				const row: DockRow = { path: full, is_dir: en.is_dir };
				const changed = !en.is_dir && artifacts.has(full);
				const style = rowStyle(en.is_dir ? DIR_STYLE : changed ? { fg: ART_DOT } : FILE_STYLE, FILES_KEY, row);
				const open = en.is_dir && expanded.has(full);
				// Dirs draw their own disclosure glyph as part of the text and are
				// plain leaves to the host: the host reserves its glyph column on
				// EVERY row anyway (leaves included), so a host-drawn glyph would
				// push dir names two columns right of file names at the same
				// depth. With the glyph in the text, `▶ docs/` and `.env` start
				// in the same column. Folding needs no host help — a collapsed
				// dir's children are simply not listed.
				const label = en.is_dir
					? `${open ? "▼" : "▶"} ${en.name}/`
					: `${changed ? "● " : ""}${en.name}`;
				const chunks = markContinuations(wrapCols(label, cols, cols - WRAP_W));
				push(
					{ text: { ...chunks[0], style }, depth, hasChildren: false },
					`${en.is_dir ? "d" : "f"}:${full}`,
					row,
				);
				for (let i = 1; i < chunks.length; i++)
					push(
						{ text: { ...chunks[i], style }, depth, hasChildren: false },
						`c:${full}#${i}`,
						row,
					);
				if (open) walk(full, depth + 1);
			}
		};
		walk(CWD, 0);
		if (nodes.length === 0) push({ text: { text: "(empty)" }, depth: 0, hasChildren: false }, "empty", null);
		visible[FILES_KEY] = vis;
		budget[FILES_KEY] = visibleRows;
		return {
			kind: "tree",
			key: FILES_KEY,
			nodes,
			itemKeys: keys,
			selectedIndex: hostSel[FILES_KEY],
			visibleRows,
			expandedKeys: [], // folding is plugin-owned (see the dir rows above)
			checkable: false,
			itemHeight: 1,
			cardBorders: false,
			indentCols: FILES_INDENT,
		};
	}

	// ── Artifacts tree ───────────────────────────────────────────────────
	// One header per directory (workspace-relative, "./" for the root),
	// newest-touched group first, newest file first within a group. Group
	// expansion is plugin-owned: the widget's expandedKeys is initial-only,
	// so it is re-pushed (setExpandedKeys) after every content update.
	const artCollapsed = new Set<string>();

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

	function artifactSpec(visibleRows: number) {
		const nodes: Array<Record<string, unknown>> = [];
		const keys: string[] = [];
		artRows = [];
		const vis: number[] = [];
		const push = (node: Record<string, unknown>, key: string, row: DockRow, shown = true) => {
			if (shown) vis.push(nodes.length);
			nodes.push(node);
			keys.push(key);
			artRows.push(row);
		};
		if (artifacts.size === 0)
			push({ text: { text: "(no changes yet)" }, depth: 0, hasChildren: false }, "empty", null);
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
			const gcols = DOCK_INNER - 2;
			const gchunks = markContinuations(
				wrapCols(`${dir}  (${items.length})`, gcols, gcols - ART_INDENT - WRAP_W),
			);
			const gstyle = rowStyle(DIR_STYLE, ART_KEY, { group: dir });
			push(
				{ text: { ...gchunks[0], style: gstyle }, depth: 0, hasChildren: true },
				`g:${dir}`,
				{ group: dir },
			);
			const open = !artCollapsed.has(dir);
			for (let i = 1; i < gchunks.length; i++)
				push(
					{ text: { ...gchunks[i], style: gstyle }, depth: 1, hasChildren: false },
					`c:g:${dir}#${i}`,
					{ group: dir },
					open,
				);
			const cols = DOCK_INNER - 2 - ART_INDENT;
			for (const { path, a } of items) {
				const name = dir === "./" ? relPath(path) : relPath(path).slice(dir.length);
				const tag = `  (${artifactTag(a)})`;
				// Wrap the name; the tag rides on the last chunk, or on a chunk
				// of its own when it does not fit there.
				const chunks = wrapCols(`● ${name}`, cols, cols - WRAP_W);
				for (let i = 1; i < chunks.length; i++) chunks[i] = WRAP_GLYPH + chunks[i];
				let last = chunks[chunks.length - 1];
				if (editor.stringWidth(last + tag) <= cols) chunks[chunks.length - 1] = last + tag;
				else chunks.push(WRAP_GLYPH + tag);
				last = chunks[chunks.length - 1];
				const row: DockRow = { path, is_dir: false };
				const style = rowStyle(FILE_STYLE, ART_KEY, row);
				for (let i = 0; i < chunks.length; i++) {
					const text: Record<string, unknown> = { text: chunks[i], style };
					if (i > 0)
						text.inlineOverlays = [
							{ start: 0, end: editor.utf8ByteLength(WRAP_GLYPH.trimEnd()), style: WRAP_GLYPH_STYLE },
						];
					// Red accent on the "-N" span, matching the in-file deletion
					// marker. Offsets in BYTES (the InlineOverlay default unit)
					// via utf8ByteLength — char units miscount the wide ● glyph.
					// The host shifts them past the indent/disclosure prefix.
					if (i === chunks.length - 1 && a.deleted && a.status === "modified") {
						const addPart = a.added ? `+${a.added} ` : "";
						const head = last.slice(0, last.length - tag.length) + `  (${addPart}`;
						const start = editor.utf8ByteLength(head);
						text.inlineOverlays = [
							...((text.inlineOverlays as unknown[] | undefined) ?? []),
							{
								start,
								end: start + editor.utf8ByteLength(`-${a.deleted}`),
								style: { fg: DEL_ACCENT },
							},
						];
					}
					push(
						{ text, depth: 1, hasChildren: false },
						i === 0 ? `a:${path}` : `c:a:${path}#${i}`,
						row,
						open,
					);
				}
			}
		}
		visible[ART_KEY] = vis;
		budget[ART_KEY] = visibleRows;
		return {
			kind: "tree",
			key: ART_KEY,
			nodes,
			itemKeys: keys,
			selectedIndex: hostSel[ART_KEY],
			visibleRows,
			expandedKeys: expandedGroupKeys(),
			checkable: false,
			itemHeight: 1,
			cardBorders: false,
			indentCols: ART_INDENT,
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

	// ── Dock assembly ────────────────────────────────────────────────────
	// The dock spans the terminal's full height; its body rows (everything
	// but the two headers and the divider) are split FILES_RATIO to the file
	// tree. A tree pins the rows it is given and scrolls inside them.
	const dockHeader = (title: string) => ({
		kind: "raw",
		entries: [{ text: ` ${title}`, style: { bold: true } }],
	});
	function dockSpec() {
		const body = Math.max(6, editor.getScreenSize().height - 4); // 3 chrome rows + 1 slack
		const filesRowsN = Math.max(3, Math.floor(body * FILES_RATIO));
		const artRowsN = Math.max(3, body - filesRowsN);
		return {
			kind: "col",
			children: [
				dockHeader("FILES"),
				filesSpec(filesRowsN),
				{ kind: "divider", ch: "─" },
				dockHeader("ARTIFACTS"),
				artifactSpec(artRowsN),
			],
		};
	}

	let dockMounted = false;
	function pushExpanded() {
		if (!dockMounted) return;
		editor.widgetMutate(PANEL_ID, {
			kind: "setExpandedKeys",
			widgetKey: ART_KEY,
			keys: expandedGroupKeys(),
		});
	}
	// Re-publish the whole dock. A collapse/expand goes through here too, not
	// just a setExpandedKeys mutation: fresh 0.5.1 tracks the new state either
	// way (arrow keys skip the hidden rows) but only repaints when the spec is
	// replaced. Both trees are rebuilt (the file tree's ● badges come from
	// `artifacts`); expanded dirs are re-read, which is cheap.
	function renderDock(hoverOnly = false) {
		if (!dockMounted) return;
		if (!hoverOnly) dirCache = new Map();
		try {
			editor.updateFloatingWidget(PANEL_ID, dockSpec());
			pushExpanded();
		} catch (e) {
			editor.debug(`init.ts: dock render failed: ${e}`);
		}
	}
	function renderArtifactsPanel() {
		renderDock();
	}
	// Debounced refresh for disk churn the tree must reflect but that changes
	// no artifact (files created/deleted, new dirs): one re-read per burst.
	let dockRefreshPending = false;
	function scheduleDockRefresh() {
		if (dockRefreshPending || !dockMounted) return;
		dockRefreshPending = true;
		(async () => {
			await editor.delay(500);
			dockRefreshPending = false;
			renderDock();
		})();
	}

	// The startup split is the editor pane; the dock is chrome, not a split,
	// so mounting it changes nothing in the split tree.
	const s0 = editor.listSplits()[0];
	// `let`: the editor split DIES when its last tab is closed (fresh
	// collapses an empty split); ensureEditorSplit below rebuilds + reassigns.
	let editorSplitId: number | undefined = s0?.splitId;
	try {
		// startBlurred: the editor keeps the keyboard; the dock is mouse-first
		// (click / right-click) and gets focus only when clicked into.
		dockMounted = editor.mountFloatingWidget(
			PANEL_ID,
			dockSpec(),
			60,
			40,
			true, // asDock
			false, // focusMarker
			"",
			false, // closable
			true, // startBlurred
			"",
		);
		if (!dockMounted) editor.debug("init.ts: dock mount refused; Files/Artifacts column disabled");
		else {
			editor.floatingPanelControl(PANEL_ID, "dock", DOCK_COLS);
			pushExpanded();
		}
	} catch (e) {
		editor.debug(`init.ts: dock creation failed: ${e}`);
	}
	// Terminal resize: re-split the body rows. (User-driven — never fires on
	// scroll.)
	editor.on("resize", () => renderDock());
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
		if (typeof path !== "string") return null;
		const snap = snapPathOf(path);
		if (snap === null) return null;
		// Under a dir the snapshot skips (.git, node_modules, .fresh, …) there
		// is no baseline by design — that is "unknown", not "all new".
		if (path.slice(CWD.length + 1).split("/").some((seg) => SNAP_EXCLUDE.has(seg))) return null;
		const content = editor.readFile(path);
		// null = unreadable; a binary file comes back undefined (not a string).
		if (typeof content !== "string") return null;
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
	// Gutter bars on added lines — the slot git_gutter used to fill, now fed
	// from the launch-snapshot diff so gutter, overlay, scrollbar and the
	// Artifacts "(+N)" always agree. Deleted lines keep their "-" glyph on
	// the red phantom row. Lines are 0-based here (diff ranges are 1-based).
	const GUT_NS = "fresh-claude-gutter";
	const GUT_SYMBOL = "│";
	function setAddGutter(bufferId: number, ranges: Array<[number, number]>, lineCount: number) {
		const lines: number[] = [];
		for (const [a, b] of ranges)
			for (let ln = a; ln <= Math.min(b, lineCount); ln++) lines.push(ln - 1);
		editor.clearLineIndicators(bufferId, GUT_NS);
		if (lines.length)
			editor.setLineIndicators(bufferId, lines, GUT_NS, GUT_SYMBOL, SB_ADD[0], SB_ADD[1], SB_ADD[2], 100);
	}

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
			editor.clearLineIndicators(bufferId, GUT_NS);
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
			setAddGutter(bufferId, total > 0 ? [[1, lines.length]] : [], lines.length);
			editor.setScrollbarMarkers(
				bufferId,
				SB_NS,
				total > 0 ? [{ position: 0, end: total, color: SB_ADD }] : [],
			);
			return;
		}
		const { adds, dels } = diff;
		setAddGutter(bufferId, adds, lines.length);
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

	// ── Dock interaction ─────────────────────────────────────────────────
	// The host routes every hit on the dock's trees through widget_event: a
	// disclosure-glyph click is `expand`, Up/Down or a click on a row is
	// `select` (a click's payload is tagged via: "click"), Enter is
	// `activate`, a right-click is `context` (payload carries the 0-based
	// screen cell). A CLICK on a file opens it and moves focus to the editor
	// (so typing goes to the file, not the tree); arrowing onto a file
	// previews it with the keyboard staying in the dock; Enter commits.
	// Nothing here runs from a scroll — see repaintAfterAutoReload.
	let lastPreview = "";
	// Hand the keyboard to the editor pane. After a popup over the dock
	// closes, the host puts the layout tree's key focus back on the dock's
	// tree (log: "key routed by the tree … focus=#widget_focus:files") while
	// the dock itself reads as blurred — so a plain blur is a no-op and
	// typing dies in the tree (neither focus_editor nor toggle_dock_focus
	// moves it either, verified on 0.5.1). Making the dock properly focused
	// first, a beat later blurring it, walks the same path a click into the
	// dock and out again takes, and that one does release the keys.
	async function focusEditor() {
		editor.floatingPanelControl(PANEL_ID, "focus", 0);
		await editor.delay(200);
		editor.widgetMutate(PANEL_ID, { kind: "setFocusKey", widgetKey: "" });
		editor.floatingPanelControl(PANEL_ID, "blur", 0);
		if (editorSplitId !== undefined) editor.focusSplit(editorSplitId);
		editor.executeAction("focus_editor");
	}
	// Command dispatch is budgeted across frames: give the popup's unmount a
	// beat to land before the focus dance above.
	async function focusEditorSoon() {
		await editor.delay(250);
		await focusEditor();
	}
	function openCommitted(path: string) {
		lastPreview = path;
		scheduleOpen(path);
		diffChain = diffChain.then(() => focusEditorSoon());
	}
	function toggleDir(path: string) {
		if (expanded.has(path)) expanded.delete(path);
		else expanded.add(path);
		renderDock();
	}
	function toggleGroup(g: string) {
		if (artCollapsed.has(g)) artCollapsed.delete(g);
		else artCollapsed.add(g);
		renderDock();
	}

	// ── Right-click context menu ─────────────────────────────────────────
	// A content-sized popup anchored at the clicked cell (the recipe fresh's
	// bundled orchestrator dock uses): a `col` of bare buttons, every label
	// padded to the widest so the host frames a uniform box that hugs its
	// rows. Intrinsic-width content only — a fullWidth widget in here would
	// stretch the popup to half the screen. Actions come back as `activate`
	// on MENU_ID (click, or Up/Down + Enter); Esc is `cancel`.
	let menuTarget: { path: string; is_dir: boolean } | null = null;
	let menuUp = false;
	const MENU_ITEMS_FILE: Array<[string, string]> = [
		["m:open", "Open"],
		["m:copy", "Copy path"],
	];
	const MENU_ITEMS_DIR: Array<[string, string]> = [["m:copy", "Copy path"]];
	function menuSpec(target: { path: string; is_dir: boolean }) {
		const items = target.is_dir ? MENU_ITEMS_DIR : MENU_ITEMS_FILE;
		let title = relPath(target.path);
		if (editor.stringWidth(title) > 40) title = `…${title.slice(-39)}`;
		const w = Math.max(
			editor.stringWidth(title),
			...items.map(([, label]) => editor.stringWidth(label)),
		);
		const pad = (s: string) => `${s}${" ".repeat(Math.max(0, w - editor.stringWidth(s)))}`;
		return {
			kind: "col",
			children: [
				{ kind: "raw", entries: [{ text: ` ${pad(title)} `, style: { bold: true } }] },
				...items.map(([key, label]) => ({
					kind: "button",
					label: ` ${pad(label)} `,
					key,
					focused: false,
					intent: "normal",
					disabled: false,
					focusable: true,
					bare: true,
					fullWidth: false,
				})),
				{
					kind: "raw",
					entries: [{ text: ` ${pad("Esc closes")} `, style: { fg: "ui.menu_disabled_fg" } }],
				},
			],
		};
	}
	function closeMenu() {
		if (!menuUp) return;
		menuUp = false;
		editor.unmountFloatingWidget(MENU_ID);
	}
	// `col`/`row`: the right-clicked screen cell (0-based). floatingPanelControl
	// takes one numeric arg, packed `row << 16 | col`, like the host unpacks.
	function openContextMenu(target: { path: string; is_dir: boolean }, col: number, row: number) {
		closeMenu();
		menuTarget = target;
		// widthPct/heightPct are ignored once anchored (it sizes to content).
		if (!editor.mountFloatingWidget(MENU_ID, menuSpec(target), 50, 44, false, false, "", false, false, "")) {
			editor.debug("init.ts: context menu mount refused");
			return;
		}
		menuUp = true;
		editor.floatingPanelControl(MENU_ID, "anchor", Math.max(0, row) * 65536 + Math.max(0, col));
		// A popup raised from a BLURRED dock does not take the keyboard by
		// itself — Enter would land in the editor. Focus it explicitly so
		// Up/Down/Enter/Esc drive the menu.
		editor.floatingPanelControl(MENU_ID, "focus", 0);
	}
	function onMenuEvent(e: { event_type: string; widget_key: string }) {
		if (e.event_type === "cancel") {
			closeMenu();
			focusEditorSoon();
			return;
		}
		if (e.event_type !== "activate" || menuTarget === null) return;
		const target = menuTarget;
		closeMenu();
		switch (e.widget_key) {
			case "m:open":
				openCommitted(target.path);
				break;
			case "m:copy":
				editor.copyToClipboard(target.path);
				editor.setStatus(`Copied path: ${relPath(target.path)}`);
				focusEditorSoon();
				break;
			default:
				focusEditorSoon();
		}
	}

	editor.on("widget_event", (e) => {
		if (e.panel_id === MENU_ID) {
			onMenuEvent(e);
			return;
		}
		if (e.panel_id !== PANEL_ID) return;
		const payload = (e.payload ?? {}) as {
			index?: unknown;
			key?: unknown;
			expanded?: unknown;
			via?: unknown;
			list_key?: unknown;
			col?: unknown;
			row?: unknown;
		};
		// The tree a hit belongs to: its key rides in widget_key; a mouse hit
		// on a row may name the item instead and carry the tree in list_key.
		const key = typeof payload.key === "string" ? payload.key : e.widget_key;
		const tree =
			e.widget_key === FILES_KEY || e.widget_key === ART_KEY
				? e.widget_key
				: typeof payload.list_key === "string"
					? payload.list_key
					: key.startsWith("a:") || key.startsWith("g:") || key.startsWith("c:a:") || key.startsWith("c:g:")
						? ART_KEY
						: FILES_KEY;
		const rows = tree === ART_KEY ? artRows : filesRows;
		if (e.event_type === "expand") {
			if (key.startsWith("d:")) {
				const d = key.slice(2);
				const open = typeof payload.expanded === "boolean" ? payload.expanded : !expanded.has(d);
				if (open) expanded.add(d);
				else expanded.delete(d);
				renderDock();
			} else if (key.startsWith("g:")) {
				const g = key.slice(2);
				const open = typeof payload.expanded === "boolean" ? payload.expanded : artCollapsed.has(g);
				if (open) artCollapsed.delete(g);
				else artCollapsed.add(g);
				renderDock();
			}
			return;
		}
		if (e.event_type !== "select" && e.event_type !== "activate" && e.event_type !== "context") return;
		const index = typeof payload.index === "number" ? payload.index : -1;
		const row = rows[index];
		const clicked = payload.via === "click";
		if (e.event_type === "select") {
			// The host swallows a right-click on the tree's SELECTED row (no
			// context event at all). Mouse users right-click next, so a click
			// drops the host selection; keyboard navigation keeps it (Up/Down
			// continue from it) and the whole-entry highlight marks the row.
			hostSel[tree] = clicked ? -1 : index;
			if (clicked)
				editor.widgetMutate(PANEL_ID, { kind: "setSelectedIndex", widgetKey: tree, index: -1 });
			if (!sameRow(hilite[tree], row)) {
				hilite[tree] = row;
				renderDock();
			}
		}
		if (!row) return;
		if (e.event_type === "context") {
			if ("group" in row) return;
			const col = typeof payload.col === "number" ? payload.col : 0;
			const r = typeof payload.row === "number" ? payload.row : 0;
			openContextMenu(row, col, r);
			return;
		}
		// Click or Enter on a folder toggles it; on a file opens it and hands
		// the keyboard to the editor. Arrowing onto a file previews it (focus
		// stays in the dock).
		const commit = e.event_type === "activate" || clicked;
		if ("group" in row) {
			if (commit) toggleGroup(row.group);
			return;
		}
		if (row.is_dir) {
			if (commit) toggleDir(row.path);
			return;
		}
		if (commit) openCommitted(row.path);
		else if (row.path !== lastPreview) {
			lastPreview = row.path;
			scheduleOpen(row.path);
		}
	});
	// ── Hover: light every row of the entry under the pointer ────────────
	// The host paints a hover band on the one row under the mouse; a wrapped
	// name spans several rows, so mouse_move (screen cell, 0-based) is mapped
	// back to the entry and its other rows get the same band from here. The
	// map is exact only while a tree shows all its rows: the host owns tree
	// scrolling and reports no offset (dock wheel events never reach a
	// plugin), so a tree that overflows its budget keeps the host's one-row
	// hover alone. Layout, top to bottom: FILES header, the file tree's rows
	// (as many as it shows), divider, ARTIFACTS header, the artifacts rows.
	function hoverTargetAt(column: number, row: number): { tree: string; row: DockRow } | null {
		if (column < 0 || column >= DOCK_INNER || row < 1) return null;
		const filesVis = visible[FILES_KEY];
		const filesShown = Math.min(filesVis.length, budget[FILES_KEY]);
		if (row <= filesShown) {
			if (filesVis.length > budget[FILES_KEY]) return null; // scrollable: offset unknown
			return { tree: FILES_KEY, row: filesRows[filesVis[row - 1]] ?? null };
		}
		const artTop = filesShown + 3; // divider + header
		const artVis = visible[ART_KEY];
		const i = row - artTop;
		if (i < 0 || i >= Math.min(artVis.length, budget[ART_KEY])) return null;
		if (artVis.length > budget[ART_KEY]) return null;
		return { tree: ART_KEY, row: artRows[artVis[i]] ?? null };
	}
	editor.on("mouse_move", (m) => {
		if (!dockMounted || menuUp) return;
		const target = hoverTargetAt(m.column, m.row);
		let changed = false;
		for (const tree of [FILES_KEY, ART_KEY]) {
			const next = target !== null && target.tree === tree ? target.row : null;
			if (next === hover[tree] || sameRow(next, hover[tree])) continue;
			hover[tree] = next;
			changed = true;
		}
		if (changed) renderDock(true);
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
			scheduleDockRefresh(); // created/deleted paths reshape the file tree
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
