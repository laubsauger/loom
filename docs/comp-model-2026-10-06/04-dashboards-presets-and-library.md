# 04. Node dashboards, local presets, and a persistent preset library

*Part of the [COMP model proposal](README.md). Depends on [01](01-comps-as-folders.md) (paths), [02](02-terminology-and-parameter-modes.md) (reference, bind) and [03](03-base-and-container-comps.md) (panels). [05](05-mappers.md) maps hardware onto dashboards.*

## 1. Dashboards on every node (Resolume's model)

Resolume gives every composition, group, layer and clip a **dashboard**: a set of knobs and buttons, each a bare normalized float that drives nothing until something is linked to it. Any parameter inside can be linked to a dashboard knob with its own range, and MIDI or OSC map to the knob persistently, whatever it currently drives. That solves the real shape of control: **one knob usually drives many parameters**, each over its own range.

Proposed for Loom:

1. **Every node has a dashboard, unassigned by default.** A small set of normalized null controls (`d1`…`d8`, renameable) that exist before anything uses them: 0..1 for knobs and faders, 0/1 for buttons and toggles, an index for a radio or menu. A COMP's dashboard is the same thing one level up.
2. **Dashboard controls are addressable.** `rig/projDS.dash.d1`, or by name once renamed: `haze.dash.intensity`. Being addresses, they are targets for mappings ([05](05-mappers.md)), references and presets like any parameter.
3. **The node's own parameters reference its dashboard, each with its own range.** `beamDS.gain` references `beamDS.dash.intensity` over 0..0.8; `atmosphere.density` references the same control over 0.01..0.06. This is a Reference ([02](02-terminology-and-parameter-modes.md)) with a per-parameter transform (min, max, invert, curve, step). The parameter shows which control drives it and links to it, and the inspector edits the range rather than breaking the link.
4. **A COMP's parameters can reference a child's dashboard, and the reverse.** A desk knob drives a rig; a rig's dashboard drives its three projectors. Paths make this unambiguous at any depth ([01](01-comps-as-folders.md) stage 1).
5. **The dashboard shows on the node's panel** ([03](03-base-and-container-comps.md)), and a Container shows its children's dashboards when they are displayed.
6. **Hardware maps to the dashboard, persistently.** A MIDI knob is mapped once to `haze.dash.intensity`. What that control drives can be re-ranged or rewired, and the mapping never needs touching.

Writes from a continuous source (fader drag, knob, phone) stream `live` and `commit` once at rest, so one gesture is one undo step, as the phone protocol already does (`src/devices/phone/phone-protocol.ts`, `phase: "live" | "commit"`). Copying a node or a COMP rebases references inside it onto the copy.

## 2. Presets hold the dashboard

A node's dashboard state is part of that node's presets. Storing a preset captures the dashboard values alongside the node's Constant parameters; recalling one moves the dashboard, and through the references, everything it drives.

- **Local presets.** A preset bank inside a COMP is that COMP's: it captures the COMP's custom parameters and dashboard, travels with it, and recalls per instance. Upstream has designed this case for today's components in §T1505b (`docs/presets-followups-design-2026-10-03.md`, Part 1): the preset list lives in the definition, the `current`/morph state on each instance, and "from the outside, the instance is the bank". With COMPs as folders ([01](01-comps-as-folders.md)), a bank inside a COMP is simply a node in that folder, so most of that design's machinery (synthesized `presetCurrent`/`presetMorphs` parameters on the instance, the reserved `parent` target word) is no longer needed. The `parent` target spelling still works as the folder-relative name.
- **Values, not settings.** A preset of a control captures its value, not its range or name (VN16). With dashboards this falls out: the dashboard control *is* a value, and its references' ranges belong to the parameters that hold them.

## 3. A persistent preset library, inherited by every project

Basic useful configurations shouldn't have to be rebuilt in every project: a projector with a lens you always use, a haze look, a fader range for a strobe, a Container layout for a desk.

- **Save any node's preset to the library.** From a node or a COMP: "Save preset to library". It stores the node type, its Constant parameter values, its dashboard values and references, and for a COMP its whole network and panel.
- **The library lives outside any project**, in the user's app storage (IndexedDB in the browser; a folder on disk in the desktop build), so every project sees it. It is exportable and importable as a file, and import adds to the library rather than replacing it.
- **Use it like TD's palette or Resolume's effect presets.** The node menu and the library pane list library presets beside node types; placing one creates the node already configured. Applying a library preset to an existing node of the same type sets its parameters as one undoable patch.
- **Library presets are copies, not links.** Placing one never links the project to the library, so a project opens the same on a machine that does not have the library. Today Loom's component library only lists what the open document holds plus the shipped starter set (`src/editor/library/component-library.tsx`, `src/examples/starter-components.ts`); nothing persists across projects yet.

## Proposed §T rows

```
T____|.|**NODE DASHBOARDS.** Every node and COMP has an unassigned dashboard of normalized null controls (d1…d8, renameable; knob/fader 0..1, button/toggle 0/1, radio/menu index), addressable as `<path>.dash.<name>`. Parameters reference a dashboard control with their own min/max/invert/curve/step; the inspector edits the range, never breaks the link. Shown on the node's panel. Gate: one dashboard control drives three parameters over three ranges; re-ranging one leaves the other two rendering unchanged.|V81,V80,T____
T____|.|**PRESETS CAPTURE DASHBOARDS; BANKS LOCAL TO A COMP.** A preset stores dashboard values with Constant parameters; a bank inside a COMP is that COMP's and travels with it (simplifies §T1505b once COMPs are folders). Controls capture values, not settings (VN16).|T1505b,VN16,T____
T____|.|**PERSISTENT PRESET LIBRARY.** "Save preset to library" from any node or COMP (type, Constant values, dashboard, and for a COMP its network and panel) into user app storage outside any project; listed in the node menu and library pane; place-as-configured or apply-to-existing as one patch; export/import, additive. Placing copies, never links. Gate: a preset saved in one project places identically in a fresh project, and the project opens on a machine without the library.|V79,T____
```
