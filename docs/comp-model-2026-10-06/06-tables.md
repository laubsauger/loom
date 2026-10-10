# 06. A table data type (a DAT analog) and one table editor

*Part of the [COMP model proposal](README.md). Independent of the COMP work: it can start first. [05](05-mappers.md) (mapping tables), [04](04-dashboards-presets-and-library.md) (preset banks) and [07](07-command-bus.md) (the command bible) all display through it.*

Presets, cue lists, mapping tables and Panel boards are all tables, and Loom stores each as a JSON string in a `code` parameter (`presets1.presets`, `cuelist1.cues`, `desk.board`, `midiIn.mapping`), each with its own editor or none. TouchDesigner's answer is the DAT: a node whose payload is a table (or text), with one editor for all of them.

- **A table node family**: a node whose output is a typed table (rows × named columns). It is the store behind mappers, preset banks and cue lists, and plain data too (a fixture schedule, a pixel map, a setlist) that nodes and expressions can read by row and column.
- **Import, export and sync** with TSV, CSV and JSON; XML shown as a table. A table can be linked to a file in the project and re-read when the file changes.
- **One table editor for all of it**, Lister-style, as a pane and as bottom-bar tabs. The starting point is [drmbt/TD-table-editor](https://github.com/drmbt/TD-table-editor), the proposer's own dependency-free browser grid, built to replace TD's DAT editor. It already has two-way sync with its source table, virtualized scrolling, cell editing with undo/redo, multi-range selection, TSV copy/paste, row and column drag-reorder, insert/delete, view-only sort and filter (Lister's rule: the view never changes the data unless you apply it), selection outputs and theming. Porting it means replacing its WebSocket relay with the command bus (every edit a patch, §V29), restyling with Loom's tokens, and mounting it as a React pane.

## Proposed §T rows

```
T____|.|**TABLE NODE + TABLE EDITOR.** A node whose payload is a typed table (rows × named columns); TSV/CSV/JSON import/export and file sync, XML as a table; readable by row/column from expressions. One Lister-style editor as a pane and bottom-bar tabs, ported from drmbt/TD-table-editor onto the bus (every edit a patch, §V29) and Loom's tokens. Presets, cue lists, boards and mapping tables can be backed by a table. Gate: a 10k-row table edits with undo; a file-synced table re-reads on change.|V29,V458
```
