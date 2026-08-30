import type { KeyBinding } from "./types.ts";

/**
 * Default keymap (T77), verified against docs.derivative.ca/Application_Shortcuts.
 *
 * TouchDesigner's network editor is single-key, no modifier, and case is semantic:
 * uppercase acts on everything, lowercase on the selection (`H`/`h` home, `F`/`f`
 * frame). We adopt that: modifier-heavy graph bindings do not feel like TD. Internally
 * `H` is stored as `shift+h` — one spelling per physical chord — and rendered back as
 * "H" (see `formatKeys`).
 *
 * Bare letters in the `graph` context are exactly why §V53 is load-bearing rather than
 * theoretical: `b` must toggle bypass on the canvas and must type a "b" in a text
 * field, never both.
 *
 * COMMAND NAMES: most of these name commands no track has registered yet. That is
 * deliberate — a binding is data naming a command (§V52), the palette renders an
 * unregistered one as unavailable, and the engine reports `unresolved` instead of
 * throwing. Nothing here is stubbed onto the bus.
 *
 * NOT IN THIS TABLE — and deliberately so (T443, §V354): `mod+f` / `ui.findInGraph`. A
 * planned command is honestly absent while the feature is unbuilt, and stops being
 * honest once the SURFACE it names is on screen: the graph is right there, so a `mod+f`
 * that does nothing reads as a broken app rather than a missing one. Finding existing
 * nodes and jumping to one is a surface that does not exist — `mod+k` searches COMMANDS
 * and `tab` adds an OPERATOR, neither of which is this — so the key is unbound until it
 * ships rather than left promising something no key press can deliver. It leaves
 * `PLANNED_COMMANDS` with the binding, because that list's own rule is that a planned
 * command must be NAMED by a binding or a menu — a promise nothing shows is a promise to
 * nobody. The task keeps the promise (T443); re-adding the binding is what puts it back.
 *
 * `e` (`ui.openShaderEditor`) stays BOUND by the same rule read the other way: the shader
 * pane already follows the selection and T436's dock-reveal seam has landed, so it is
 * imminent rather than hypothetical.
 *
 * NOT IN THIS TABLE: pan/zoom mouse gestures (middle-drag / space-drag pan, scroll
 * zoom, alt+drag zoom). Those are pointer gestures on the canvas and belong to the
 * graph-canvas track, not to a key binding table. They are still unconfirmed vs a real
 * TD install (§I defaults, "mouse").
 */

/** Verified TD network-editor bindings. Single key, case-significant. */
const TD_GRAPH_BINDINGS: readonly KeyBinding[] = [
  {
    id: "graph.addOperator",
    keys: "tab",
    context: "graph",
    command: "ui.openNodeSearch",
    label: "Add operator",
    description: "Open the node search at the cursor.",
  },
  {
    // OURS, not a transcription (T430). §I read TD's `H` as "default view", which could
    // equally have meant fit-all — and fit-all is already `F`. Here it means 1:1 zoom
    // centred on the content: the one thing fit cannot give you, because fit picks
    // whatever zoom fills the window and so hides how big the graph actually is.
    //
    // `h` (home selected) and `o` (overview) are DELIBERATELY absent beside it. "Home
    // selected" has no meaning once `H` is about scale rather than extent, and TD's
    // overview is a separate PANE this app does not have. A key taught a wrong meaning
    // costs more to un-teach than an absent one costs to add (T430, §V354).
    id: "view.home",
    keys: "H",
    context: "graph",
    command: "view.home",
    label: "Home — 1:1 zoom",
  },
  {
    id: "view.frame",
    keys: "F",
    context: "graph",
    command: "view.frameAll",
    label: "Frame — fit content",
  },
  {
    id: "view.frameSelected",
    keys: "f",
    context: "graph",
    command: "view.frameSelected",
    when: "hasSelection",
    inputFrom: { from: "selection", as: "nodeIds" },
    label: "Frame selected",
  },
  {
    id: "node.toggleBypass",
    keys: "b",
    context: "graph",
    command: "node.toggleBypass",
    when: "hasSelection",
    inputFrom: { from: "selectionOrHovered", as: "nodeIds" },
    label: "Toggle bypass",
  },
  {
    id: "node.toggleDisplay",
    keys: "d",
    context: "graph",
    command: "node.toggleDisplay",
    when: "hasSelection",
    inputFrom: { from: "selectionOrHovered", as: "nodeIds" },
    label: "Toggle preview",
  },
  {
    id: "node.toggleRender",
    keys: "r",
    context: "graph",
    command: "node.toggleRender",
    when: "hasSelection",
    inputFrom: { from: "selectionOrHovered", as: "nodeIds" },
    label: "Toggle render",
  },
  {
    id: "node.openViewer",
    keys: "v",
    context: "graph",
    command: "node.openViewer",
    when: "hasSelection",
    inputFrom: { from: "selectionOrHovered", as: "nodeIds" },
    label: "Open viewer",
  },
  {
    id: "graph.diveIn",
    keys: "i",
    context: "graph",
    command: "graph.diveIn",
    when: "hasSelection",
    inputFrom: { from: "selection", as: "nodeIds" },
    label: "Dive in",
  },
  {
    id: "graph.jumpUp",
    keys: "u",
    context: "graph",
    command: "graph.jumpUp",
    label: "Jump up",
  },
  {
    // TD lists "Enter — jump down" beside "i — dive in"; both descend into the
    // current operator, so they name one command with two keys.
    id: "graph.diveIn.enter",
    keys: "enter",
    context: "graph",
    command: "graph.diveIn",
    when: "hasSelection",
    inputFrom: { from: "selection", as: "nodeIds" },
    label: "Jump down",
  },
  {
    id: "node.rename",
    keys: "n",
    context: "graph",
    // B60/T415: this named `node.rename` — the DOCUMENT command, which needs a `label`
    // nothing on this route could supply, so pressing `n` fired a rename with no name and
    // did nothing. It names the OPENING now; the editor it opens runs `node.rename` with
    // what the user typed (§V342). The binding id is unchanged so a user's override of it
    // survives (§V54).
    command: "ui.beginRename",
    when: "hasSingleSelection",
    inputFrom: { from: "selection", as: "nodeIds" },
    label: "Name",
  },
  {
    id: "node.colorPalette",
    keys: "c",
    context: "graph",
    command: "node.openColorPalette",
    when: "hasSelection",
    inputFrom: { from: "selection", as: "nodeIds" },
    label: "Color palette",
  },
  {
    id: "node.editExpose",
    keys: "e",
    context: "graph",
    command: "ui.openShaderEditor",
    when: "hasSingleSelection",
    inputFrom: { from: "selection", as: "nodeIds" },
    label: "Edit / expose",
    description: "TD's edit/expose. Here: open the node's shader source in the dock.",
  },
  {
    // §I lists `L layout` and `l layout all` — the reverse of the H/h and F/f case
    // convention. Transcribed literally from the spec table rather than "corrected"
    // to match the pattern; `unconfirmed` stays until a real TD install settles it.
    //
    // B84/T440: both were PLANNED commands until the layout commands landed, so the
    // engine answered `unresolved` and the keys did nothing while the canvas they tidy
    // filled the window (§V354). `L` carries the selection because "layout" without a
    // target is "layout all", which is what `l` is for.
    id: "graph.layout",
    keys: "L",
    context: "graph",
    command: "graph.layout",
    when: "hasSelection",
    inputFrom: { from: "selection", as: "nodeIds" },
    label: "Layout",
    description: "Move the selected nodes to where the whole-graph layout would put them.",
    unconfirmed: true,
  },
  {
    id: "graph.layoutAll",
    keys: "l",
    context: "graph",
    command: "graph.layoutAll",
    label: "Layout all",
    description: "Arrange every node in reading order: data flows left to right.",
    unconfirmed: true,
  },
  {
    id: "graph.delete",
    keys: "delete",
    context: "graph",
    command: "graph.removeNodes",
    when: "hasSelection",
    inputFrom: { from: "selection", as: "nodeIds" },
    label: "Delete selection",
  },
  {
    // Not a second TD binding: the key labelled "delete" on every Apple keyboard
    // emits Backspace, so without this the verified `Del` binding is unreachable on
    // the hardware most of this tool's users have.
    id: "graph.delete.backspace",
    keys: "backspace",
    context: "graph",
    command: "graph.removeNodes",
    when: "hasSelection",
    inputFrom: { from: "selection", as: "nodeIds" },
    label: "Delete selection (Backspace)",
  },
  {
    id: "graph.selectAll",
    keys: "mod+a",
    context: "graph",
    command: "graph.selectAll",
    label: "Select all",
  },
  {
    id: "graph.copy",
    keys: "mod+c",
    context: "graph",
    command: "graph.copySelection",
    when: "hasSelection",
    inputFrom: { from: "selection", as: "nodeIds" },
    label: "Copy",
  },
  {
    id: "graph.cut",
    keys: "mod+x",
    context: "graph",
    command: "graph.cutSelection",
    when: "hasSelection",
    inputFrom: { from: "selection", as: "nodeIds" },
    label: "Cut",
  },
  {
    id: "graph.paste",
    keys: "mod+v",
    context: "graph",
    command: "graph.paste",
    label: "Paste",
  },
];

/** Ours: app-level, not part of TD's network-editor list. */
const APP_BINDINGS: readonly KeyBinding[] = [
  {
    // Node info (T145). TouchDesigner opens this with the middle mouse button and binds
    // no key to it, so the key is ours to choose. "?" reads as "what is this", and the
    // obvious alternative — `i` for info — is TD's dive-in.
    //
    // Written as `shift+/`, not `?`, because the engine matches on `event.code` (§T76):
    // pressing the key labelled `?` on a US layout produces code `Slash` with Shift, and
    // a binding spelled `?` would never fire. `formatKeys` renders it back for the UI.
    id: "ui.showNodeInfo",
    keys: "shift+/",
    context: "graph",
    command: "ui.showNodeInfo",
    label: "Node info",
    description: "Resolution, format, estimated bytes, GPU time and pass count for a node.",
  },
  {
    id: "ui.cancel",
    keys: "escape",
    context: "global",
    command: "ui.cancel",
    label: "Cancel / close",
  },
  {
    id: "graph.undo",
    keys: "mod+z",
    context: "global",
    command: "graph.undo",
    label: "Undo",
  },
  {
    id: "graph.redo",
    keys: "mod+shift+z",
    context: "global",
    command: "graph.redo",
    label: "Redo",
  },
  {
    id: "project.save",
    keys: "mod+s",
    context: "global",
    command: "project.save",
    label: "Save project",
  },
  {
    id: "graph.duplicate",
    keys: "mod+d",
    context: "graph",
    command: "graph.duplicateSelection",
    when: "hasSelection",
    inputFrom: { from: "selection", as: "nodeIds" },
    label: "Duplicate",
  },
  {
    id: "ui.commandPalette",
    keys: "mod+k",
    context: "global",
    command: "ui.openCommandPalette",
    label: "Command palette",
    description: "Search every command on the bus and run it.",
  },
  {
    // Help (T200). `?` — spelled `shift+/` — is already the graph context's node info,
    // and TouchDesigner has no shortcut of its own here, so help takes `mod+/`: the
    // same physical key, one modifier apart, and global rather than graph-only because
    // a shortcut you can only reach from the canvas is not a way to learn the canvas.
    id: "ui.help",
    keys: "mod+/",
    context: "global",
    command: "ui.openHelp",
    label: "Help",
    description: "Shortcuts, node reference and expression reference.",
  },
  {
    id: "ui.settings",
    keys: "mod+,",
    context: "global",
    command: "ui.openSettings",
    label: "Settings",
  },
  {
    id: "transport.playPause",
    keys: "space",
    context: "global",
    command: "transport.togglePlay",
    label: "Play / pause",
  },
  {
    id: "transport.stepFrame",
    keys: ".",
    context: "global",
    command: "transport.stepFrame",
    input: { frames: 1 },
    label: "Step one frame",
  },
  {
    /**
     * T433. `L` is the loop key everywhere that has one, and both `l` and `L` are already
     * spent on the graph's reference lines — so this is the free chord one modifier out,
     * the same reasoning `mod+shift+f` records below. `global`, not `viewer`: looping is
     * something you turn on while working in the graph.
     */
    id: "transport.toggleLoop",
    keys: "mod+shift+l",
    context: "global",
    command: "transport.toggleLoop",
    label: "Loop the range",
    description: "Cycle playback over the timeline's in and out points.",
  },
  {
    /**
     * T433 — rendering the range out. `mod+shift+e` for export; `mod+e` is left alone
     * because `e` alone already names the shader editor and the two would read as a pair
     * that does not exist.
     */
    id: "export.renderRange",
    keys: "mod+shift+e",
    context: "global",
    command: "export.renderRange",
    label: "Render the range",
    description: "Render the timeline's in/out range to a video file.",
  },
  {
    // Fullscreen the viewer (T394). `global`, not `viewer`: filling the screen with the
    // render is something you ask for while working in the graph or the shader editor,
    // and a shortcut that only fires once the picture already has focus is the one you
    // cannot use. `mod+shift+f` because the whole `f` family is taken — TD's `F`/`f`
    // frame the graph, `mod+f` finds in it — and this is the free key one modifier out.
    id: "view.fullscreen",
    keys: "mod+shift+f",
    context: "global",
    command: "view.toggleFullscreen",
    label: "Fullscreen viewer",
    description: "Fill the screen with the viewer's output. Escape returns.",
  },
  {
    id: "runtime.resetFeedback",
    keys: "mod+shift+r",
    context: "global",
    command: "runtime.resetFeedback",
    label: "Reset feedback history",
  },
];

export const DEFAULT_BINDINGS: readonly KeyBinding[] = [...TD_GRAPH_BINDINGS, ...APP_BINDINGS];
