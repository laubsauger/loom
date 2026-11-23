# 03. Base and Container COMPs: panels, panel inheritance, the Common page

*Part of the [COMP model proposal](README.md). Depends on [01](01-comps-as-folders.md) (folders, paths) and [02](02-terminology-and-parameter-modes.md) (terms, bind). [04](04-dashboards-presets-and-library.md) and [05](05-mappers.md) build on it.*

## 1. Why

A Loom component cannot carry its own control layout (VN10). The only control surface is a Panel node, and a Panel only sees widgets in the top-level graph (`panelBoard`, `src/nodes/definitions/controls.ts:595`), as does the phone door (`vetPhoneSet`, `src/devices/phone/phone-snapshot.ts:538`). In the stage previz that forced 24 widget nodes and 28 boundary-crossing expressions at the root, to move parameters the components already publish ([01](01-comps-as-folders.md) §2.5).

The underlying choice: in Loom, **widget nodes are the source of truth for control**, and parameters read them. TouchDesigner works the other way round. **Custom parameters are the source of truth**, and a panel is a view of them, owned by the COMP it controls. This document proposes TD's model.

## 2. Two COMP kinds to start with

| Kind | TD equivalent | Has a panel? | Use |
|---|---|---|---|
| **Base COMP** | Base COMP | No | The generic container: organise a network, give it custom parameters, scope its names. What "collapse to folder" makes |
| **Container COMP** | Container COMP | Yes | A COMP with a UI: its panel shows its own custom parameters and arranges the panels of its child COMPs |

Today's Panel node becomes a Container COMP whose children are controls. Existing Panel and widget nodes keep loading and working; a "make this desk the COMP's panel" action converts one, so no file has to migrate on day one. A Base COMP can be turned into a Container COMP (and back) without touching its network: the panel is an attribute, not a different thing.

## 3. The panel and panel inheritance (TD's Container behaviour)

A Container COMP's panel is built from three sources, in this order:

1. **Its own custom parameters**, laid out on its parameter page as controls. Promoting a parameter is what puts it on the panel, so there is nothing to keep in sync.
2. **Its children's panels.** A child Container's panel appears inside its parent's, as in TD: a rig panel inside a desk panel inside the project. Each child decides whether it shows (TD: Display) and whether it takes input (TD: Enable).
3. **A background**, referenced: a node's output shown behind the controls (TD: Background TOP), or a colour, plus border and opacity (TD's Look page).

**Arranging children** follows TD's Layout page:
- **Align**: none (children keep their own x/y), horizontal left to right, vertical top to bottom, grid by rows, grid by columns. A child's order comes from an align-order value, so reordering is one edit.
- **Spacing and margins** between and around children.
- **Child sizing**: fixed, fill, or anchored to the parent's edges (TD's horizontal and vertical mode), so a desk reflows when the window or the phone changes shape.

Today's Panel `board` (a column grid of rects) is the "align: none, grid" case of this and migrates into it.

**Presentation is per parameter, separate from its type.** A number shows as a horizontal or vertical fader, a knob or a field; a toggle as a toggle, a momentary button or a radio set; a menu as radio buttons; a colour as a picker; text as a field. Selecting several controls and changing their presentation is one edit. This covers VN19's list of missing widgets without a new node type per widget.

**Styling travels with the COMP.** A Container can carry a stylesheet scoped to its panel (no `url()` to remote hosts). Optional script widgets for custom controls are a later stage: they run in a sandboxed iframe that talks to the bus through a narrow message API and never touches the document directly ([README](README.md), risks).

**Panel values.** As in TD, a panel publishes what the pointer is doing on it (u, v, select, inside, rollover) as channels, so a background can be made interactive without a script.

**Viewer active (interactive viewports).** A panel can host a live, interactive view of a node: orbit, pan and zoom a Render's camera, scrub, pick. This is TD's Viewer Active on a COMP, and the camera viewport its palette offers. The previz needs it badly: today the stage camera is driven blind from Shot, Orbit and Zoom sliders when it should be dragged in a viewport. The viewport maps pointer gestures onto the camera's parameters through a bind ([02](02-terminology-and-parameter-modes.md)), so the parameters, the panel and any MIDI mapping stay in agreement.

**Publishing a panel anywhere.** Any COMP's panel, or a chosen subset of its controls, can be published to a project-level desk that composes panels from any depth, and optionally to the phone/web remote. This replaces "a Panel can only see root widgets" with "any panel can be shown anywhere, by path".

## 4. The Common page: parent and global shortcuts

Every COMP gets TD's **Common page**: the parameters every COMP has, whatever its kind.

- **Parent shortcut.** Name a COMP's parent shortcut `Rig`, and any node inside it at any depth can reach it as `parent.Rig`: `parent.Rig.par.tilt`. It survives moving the inner node deeper, which `parent(2)` does not.
- **Global shortcut.** Name a COMP's global shortcut `Desk`, and it is reachable from anywhere in the project as `op.Desk`: `op.Desk.par.intensity`. A shortcut is unique in the project; a duplicate is refused by name.
- **Clone fields** (from [01](01-comps-as-folders.md), stage 3): link to a master, enable cloning, clone-immune.
- **Tags**, as in TD: free-form labels the editor can filter and search by.

Shortcuts are stable addresses that survive renames and moves of everything except the COMP itself, which makes them the right target for mappings and presets that have to outlive a reorganised network ([05](05-mappers.md)).

## 5. Effect on the previz

The 24 widget nodes, the Panel node, the 28 boundary-crossing expressions and the 17 knob holders go. ProjectorRig's ten lens controls, HazeRender's haze, fog and beams, and the camera's shot are custom parameters on their own COMPs, laid out on their own panels and composed into one desk Container. The stage camera gets a viewport you can drag, and the desk publishes to the phone.

## Proposed §T rows

```
T____|.|**BASE + CONTAINER COMP.** Base COMP (no panel) and Container COMP (panel), switchable without touching the network. Container panel = own custom parameters as controls + children's panels (Display/Enable) + referenced background (node output or colour), border, opacity. Today's Panel node migrates to a Container COMP. Gate: stage-previz desk rebuilt as a Container with zero widget nodes and identical preset recall.|VN10,T1388b,V80
T____|.|**CONTAINER LAYOUT.** TD Layout page: align none/horizontal/vertical/grid rows/grid columns, align order, spacing, margins; child sizing fixed/fill/anchored. Panel `board` migrates to align none/grid. Gate: a desk reflows from desktop width to phone width with no overlap.|V389,T____
T____|.|**PER-PARAMETER PRESENTATION.** Presentation separate from type (fader h/v, knob, field; toggle/momentary/radio; menu as radio; colour picker; text field), group-editable; scoped stylesheet per Container.|VN19,T____
T____|.|**PANEL VALUES + VIEWER ACTIVE.** Panels publish u/v/select/inside/rollover as channels; a panel can host an interactive viewport of a node, mapping gestures onto camera parameters by bind.|T____
T____|.|**COMMON PAGE: PARENT + GLOBAL SHORTCUTS.** Every COMP: parent shortcut (`parent.Rig`), global shortcut (`op.Desk`, unique, duplicates refused by name), clone fields, tags.|V127,T____
T____|.|**RFE: SANDBOXED SCRIPT WIDGETS.** Custom control widgets as scripts carried by a Container, run in a sandboxed iframe, talking to the bus through a narrow message API (read/write the panel's own parameters only), never the document. Needs the maintainer's trust ruling first (README, risks).|V71,T____
T____|.|**PUBLISH PANELS BY PATH.** Any COMP's panel or a subset of its controls published to a project desk and/or the phone/web remote, from any depth. Replaces root-only `remoteLayouts`/`vetPhoneSet`.|T____
```
