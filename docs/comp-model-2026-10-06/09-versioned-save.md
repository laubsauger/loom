# 09. Save follows TouchDesigner's versioning convention

*Part of the [COMP model proposal](README.md), but independent of it: this can ship on its own at any time.*

## Today

`Mod+S` runs `project.save` (`src/editor/keymap/defaults.ts:427`), which overwrites the open file in place (`src/app/project-io.ts`). Anyone who wants history versions their sessions by hand: the stage previz in #2 carries `stage-previz-7` and `stage-previz-8` side by side. Nothing then says which one is current, so a link, a script or another session has to guess.

## Proposed

TouchDesigner's convention. On every save of a project `name`:

1. **Move** the current highest numbered file, `name.N.loom.json`, into a `Backup/` subfolder beside it.
2. **Write** the document as `name.(N+1).loom.json`.
3. **Overwrite** the unnumbered `name.loom.json` with the same bytes.

Afterwards:
- **The unnumbered file is always the latest**, so anything that refers to a project (a link, a build script, `upgrade.ts`, another session, an agent) can name it deterministically.
- **The numbered file beside it says which version that is.**
- **Every earlier version is recoverable** from `Backup/`.

## Open questions

- **Naming.** TD's form is `name.N.toe`, which here would be `name.N.loom.json`; the form already in use is `name-N.loom.json`. Pick one and parse both.
- **Autosave.** Likely outside the scheme: autosave stays in IndexedDB and never bumps the index.
- **Pruning.** Keep everything in `Backup/`, or cap it at the last *k* versions?
- **The browser.** Writing a sibling folder needs a directory handle, not the file handle the user granted. VNB4's ruling (a handle the user gave Loom is the consent) covers the file only. The desktop build has no such limit.
- **Save As.** Starts a new name at 1 and writes its unnumbered copy.

## Proposed §T row

```
T____|.|**VERSIONED SAVE (TD CONVENTION).** Mod+S on `name.loom.json`: move the current `name.N.loom.json` to `Backup/`, write `name.(N+1).loom.json`, overwrite the unnumbered `name.loom.json` with the same bytes, so the unnumbered file is always the latest. Autosave unchanged. Browser needs a directory handle; desktop writes directly. Gate: three saves leave name.loom.json == name.3.loom.json and Backup/ holding 1 and 2.|T____
```
