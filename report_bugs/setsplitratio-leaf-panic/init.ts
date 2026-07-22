// Minimal repro: calling editor.setSplitRatio on a just-created split's id
// panics the whole editor (process aborts).
//
// Loaded as the only init.ts (isolated HOME) by repro.py.
(async () => {
	await editor.delay(500);
	const t = await editor.createTerminal({
		direction: "horizontal",
		ratio: 0.5,
		focus: false,
	});
	if (t.splitId === null) return;
	await editor.delay(300);
	// Panics fresh 0.4.3:
	//   thread 'main' panicked at crates/fresh-editor/src/view/split.rs:1543:
	//   internal error: entered unreachable code:
	//   ContainerId ContainerId(SplitId(N)) points to a leaf
	editor.setSplitRatio(t.splitId, 0.75);
})();
