# fresh bug reports

Plugin-API bugs found in fresh 0.4.3 while building the fresh-claude
startup layout (init.ts in this repo). One directory per bug; each
contains a write-up (`README.md`), a minimal `init.ts` repro plugin, and a
self-contained `repro.py` that launches a real `fresh` in a
pseudo-terminal (isolated `HOME` — your own config/session is never
touched) and prints a verdict; no dependencies beyond Python 3.

```
python3 <bug-dir>/repro.py   # exit 0 = reproduced, 1 = not, 2 = setup issue
```

| Bug | Severity |
| --- | --- |
| [setsplitratio-leaf-panic](setsplitratio-leaf-panic/) — `setSplitRatio` on a leaf split id panics and kills the whole editor | crash |
| [openfileinsplit-dead-split](openfileinsplit-dead-split/) — `openFileInSplit` on a dead split id returns `true`, displays nothing | silent failure |
