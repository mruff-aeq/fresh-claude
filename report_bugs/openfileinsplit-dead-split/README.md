# `openFileInSplit` against a dead splitId returns `true` and shows nothing

## Summary

Split ids die at runtime: the user can close a split directly, and closing
a split's last tab collapses the split too. Calling
`editor.openFileInSplit(deadSplitId, path, line, col)` afterwards returns
`true` as if it succeeded, but the file is not displayed in any split. A
plugin that cached a split id (the only way to keep targeting "its" pane)
gets a success result and silently shows the user nothing.

Found in practice: an auto-open plugin kept the id of its editor pane;
after the user closed that pane's last tab, every subsequent auto-open
"succeeded" invisibly.

## Environment

- fresh 0.4.3 (Homebrew), macOS (Darwin 25.3.0)

## Reproduction

```
python3 repro.py
```

The script launches `fresh --no-restore` in a pseudo-terminal with an
isolated `HOME` whose `init.ts` (in this directory) does:

```ts
const s0 = editor.listSplits()[0].splitId;
await editor.createTerminal({ direction: "horizontal", ratio: 0.5, focus: false });
editor.closeSplit(s0);                              // s0 is now dead
const ret = editor.openFileInSplit(s0, file, 0, 0); // → true
// …but no split in listSplits() ever shows `file`
```

Exit code 0 and a `BUG REPRODUCED` line mean the call reported success
while the file is displayed nowhere.

## Expected

`openFileInSplit` returns `false` (or throws) when the target split no
longer exists, so the caller can fall back (pick another split, recreate
one, or surface an error).

## Actual

Returns `true`; `listSplits()` shows no split displaying the file. The
buffer may be created in the background, but nothing is visible and the
caller cannot distinguish this from success.
