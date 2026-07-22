// Minimal repro: openFileInSplit() against a closed (dead) splitId
// returns true but shows nothing anywhere.
//
// Loaded as the only init.ts (isolated HOME) by repro.py,
// which replaces __RESULT__ / __TESTFILE__ before launch.
(async () => {
	await editor.delay(500);
	const s0 = editor.listSplits()[0]?.splitId;
	if (s0 === undefined) return;
	// Second split so the first one CAN be closed.
	await editor.createTerminal({
		direction: "horizontal",
		ratio: 0.5,
		focus: false,
	});
	await editor.delay(300);
	editor.closeSplit(s0);
	await editor.delay(300);
	const splitGone = !editor.listSplits().some((s) => s.splitId === s0);
	const openRet = editor.openFileInSplit(s0, "__TESTFILE__", 0, 0);
	await editor.delay(500);
	const fileVisible = editor.listSplits().some((s) => {
		const b = editor.listBuffers().find((bb) => bb.id === s.bufferId);
		return b !== undefined && b.path === "__TESTFILE__";
	});
	editor.writeFile(
		"__RESULT__",
		JSON.stringify({ splitGone, openRet, fileVisible }),
	);
})();
