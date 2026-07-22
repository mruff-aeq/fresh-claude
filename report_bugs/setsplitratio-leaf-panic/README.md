# `setSplitRatio` on a leaf split panics the editor

## Summary

Calling the plugin API `editor.setSplitRatio(splitId, ratio)` with the
`splitId` of an ordinary (leaf) split — e.g. the id just returned by
`createTerminal` — hits an `unreachable!` in the split manager and aborts
the whole editor process. A plugin bug or a plugin passing the only kind of
id it can obtain (plugins only ever see leaf split ids from `listSplits`
and `createTerminal`; container ids are internal) takes down the entire
session, including every embedded terminal.

## Environment

- fresh 0.4.3 (Homebrew), macOS (Darwin 25.3.0)

## Reproduction

```
python3 repro.py
```

The script launches `fresh --no-restore` in a pseudo-terminal with an
isolated `HOME` whose `init.ts` (in this directory) does only:

```ts
const t = await editor.createTerminal({ direction: "horizontal", ratio: 0.5, focus: false });
editor.setSplitRatio(t.splitId, 0.75);
```

Exit code 0 and a `BUG REPRODUCED` line mean the panic fired.

## Expected

Either the split's ratio changes, or the call returns `false` (the
documented failure mode of the `boolean`-returning split APIs). A plugin
API call should never abort the editor.

## Actual

```
thread 'main' (…) panicked at crates/fresh-editor/src/view/split.rs:1543:17:
internal error: entered unreachable code: ContainerId ContainerId(SplitId(9)) points to a leaf
   2: fresh::view::split::SplitManager::set_ratio
   3: fresh::app::plugin_dispatch::<impl fresh::app::Editor>::handle_plugin_command
   4: fresh::app::async_dispatch::<impl fresh::app::Editor>::process_async_messages
```

The process exits; the tmux pane running fresh dies with it.

## Notes on the root cause

`SplitManager::set_ratio` (`crates/fresh-editor/src/view/split.rs:1543`)
asserts its argument resolves to a *container* node and treats a leaf as
`unreachable!`. The plugin dispatch path (`handle_plugin_command`) passes
the plugin-supplied `SplitId` straight through as a `ContainerId` without
validating the node kind, so any plugin-visible split id triggers the
assertion. A leaf id should either be rejected (return `false`) or be
resolved to its parent container so the call does what plugins plainly
intend ("resize this split").
