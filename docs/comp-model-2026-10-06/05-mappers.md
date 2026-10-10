# 05. Mappers: MIDI, OSC and keys, one tool with a table per protocol

*Part of the [COMP model proposal](README.md). Depends on [01](01-comps-as-folders.md) (paths), [02](02-terminology-and-parameter-modes.md) (bind, for feedback), [04](04-dashboards-presets-and-library.md) (dashboards as targets) and [06](06-tables.md) (the table and its editor). Actions on a row wait on [07](07-command-bus.md).*

## 1. What exists

Upstream landed MIDI learn onto Panel controls on 2026-10-04 (T1388b phase 2, `docs/panel-midi-learn-2026-10-04.md`). In the Controls pane, MIDI Learn arms a widget, the next CC or pitch bend creates or reuses a MIDI In node and appends a row to its `mapping`, and the widget's parameter slot reads the MIDI channel through an expression. It is one undoable patch, raw MIDI readings never edit the document, and unlink restores the retained constant.

That is the right base, and this proposal generalizes it in four directions:

- **Targets beyond widgets.** Any addressed parameter, dashboard control or shortcut, inside any COMP, not only a root-level widget.
- **A table you can see and edit**, rather than a JSON list in a MIDI In node's `mapping` code parameter.
- **More protocols through the same tool**: OSC and keys now, DMX/Art-Net later.
- **Feedback** to the hardware.

## 2. The mapper

MIDI, OSC, keyboard shortcuts and, later, DMX/Art-Net all need the same thing: a list of "this input drives that address", editable, portable, and honest when a target has gone. Proposed: **one mapper tool, with a separate table and its own learn mode per protocol**, after HIVE's MidiMapper for TouchDesigner.

MIDI, OSC, keyboard shortcuts and, later, DMX/Art-Net all need the same thing: a list of "this input drives that address", editable, portable, and honest when a target has gone. Proposed: **one mapper tool, with a separate table and its own learn mode per protocol**, after HIVE's MidiMapper for TouchDesigner. Today a MIDI In node keeps its learned controls as a JSON list in a `mapping` code parameter (`midi.ts`); that becomes a MIDI table.

**Modes and hotkeys.** Learn mode follows Resolume (arm, move a control, click a target); the table follows HIVE:

| Protocol | Learn mode | Open its table |
|---|---|---|
| MIDI | Mod+Shift+M | Mod+Alt+M |
| OSC | Mod+Shift+O | Mod+Alt+O |
| Keys | Mod+Shift+K | Mod+Alt+K |
| DMX / Art-Net | roadmap | roadmap |

In learn mode every mappable target (dashboard controls, custom parameters, any parameter by path) is highlighted, and the next input plus click writes a row. Mod is Ctrl on Windows and Linux, Cmd on macOS. None of these collide with Loom's defaults (only Mod+K is taken, `src/editor/keymap/defaults.ts:444`), but a browser tab will lose some to the browser (Chrome binds Ctrl+Shift+O to its bookmark manager); the Electron build can own all of them, and the keymap is data, so they stay rebindable.

**A row** (columns follow HIVE's mapping table):

| Column | Meaning |
|---|---|
| controller | The source, in the protocol's words: `ch3ctrl10`, `ch3n15`, `/fader/1`, `Shift+F` |
| path | The target address: a dashboard control ([04](04-dashboards-presets-and-library.md)), a shortcut path ([03](03-base-and-container-comps.md) §4), or any parameter path |
| name, parameter | Readable target, derived from the path |
| min, max | Output range |
| behavior | absolute, relative, toggle, momentary, pickup |
| invert | Flip the range |
| feedback | Send the target's value back to the source (below) |
| active | Per-row enable |
| missing | Set when the path no longer resolves |

**Feedback output.** Each table can have an output that returns values to the hardware or onward, so a motorized fader, an LED ring or a TouchOSC page follows the session. For a row with feedback on, the mapper **watches the mapped target**, including changes from the inspector, a preset recall, another surface or an expression. It inverse-maps the value through the row's min, max and invert back to the normalized control value, then expands it to the protocol's range: 0..127 for MIDI CC, the declared range for an OSC address. It suppresses the echo of the value it just received, so a moving knob does not fight itself. The same output gives OSC pass-through routing: receive on one address and re-emit, re-ranged, on another. Watching a target needs no new mechanism once bind exists ([02](02-terminology-and-parameter-modes.md)): the feedback output is a binder on the target.

**Missing targets fail gracefully.** A row whose path resolves to nothing is flagged, skipped with one warning naming it, and kept. The table offers **Clear missing** and **Resolve missing**. Resolve suggests candidates in a dialogue: the same node type under a different name in the same place (a rename), or the same name in a different folder (a move). The user accepts or rejects each one. This is §B170's lesson (§V821: about 150 dangling references once shipped silently because two fallbacks matched) applied to mappings: a target that no longer resolves has to say so, and the fix has to be one click.

**Portable and findable.** A table can live inside a component (it copies with it, with paths relative to the folder) or at project level. Tables export and import, and import can **add** to the current rows rather than replace them, so a controller layout moves between projects. The editor gathers every table of a protocol in the session, project-level and inside any component, into one view grouped by owner, filterable and searchable. In TD this is done by tagging table DATs (the `tags` member of the OP class); in Loom a mapping table is a kind the editor can enumerate directly, so no tag convention is needed. The tables live as tabs in the bottom bar, next to the preset editor proposed in a sister session; all of them are the same table editor ([06](06-tables.md)) over different data.

**Firing triggers needs nothing new.** A pulse parameter fires on a rising edge from any mode (§V125), so a MIDI note mapped with `behavior: momentary` to a pulse's path (a preset bank's Recall, a node's reset) fires it on note-on. Rows that run a command with arguments are an RFE in [07](07-command-bus.md); a row can never run code.

## Proposed §T rows

```
T____|.|**MAPPERS: MIDI, OSC, KEYS.** Generalizes T1388b phase 2's MIDI learn. One mapper tool, a table and a learn mode per protocol (learn Mod+Shift+M/O/K, table Mod+Alt+M/O/K, rebindable). Row = controller, path (parameter, dashboard control or shortcut path, inside any COMP), min/max, behavior (absolute/relative/toggle/momentary/pickup), invert, feedback, active, missing. Feedback output binds to the target, inverse-maps to normalized and expands to the protocol range (0..127 for CC), with echo suppression; OSC pass-through routing. Missing rows flagged, warned once and kept; Clear missing; Resolve missing suggests same-type-same-place and same-name-elsewhere. Tables live in a COMP (relative paths) or the project; export, import additive or replacing; one view per protocol gathers every table grouped by owner. Notes fire pulse parameters by path (§V125). Gate: renaming a mapped node flags its row and Resolve offers it; a preset recall moves a feedback fader to the inverse-mapped CC value.|T1388b,T942,V125,V821,B170
T____|.|**RFE: DMX/ART-NET ADAPTER.** The same mapper over DMX/Art-Net universes, input and output.|T____
```
