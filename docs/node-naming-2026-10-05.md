# Node names carry their kind: `kind_role`

T1593b and T1597b. Owner's ruling, 2026-10-05, and the lead's rulings on phase 1's open questions the same day. Phases 1 and 1b are built, including the low-zoom kind label (section 8). Phase 2a is built too: the rename map, the check that a rename changes nothing but names, and the apply tool, all run without writing a shipped byte (section 10). Phase 2b applies them.

The owner's reason: "it's pretty damn hard that we need to zoom in and figure out, ah okay, this is this kind of operator". A new node is auto-named from its type (`blur1`), and then nearly every shipped node was renamed to a bare role (`dye1`, `lamp`, `pathx1`), which throws the identification away. TouchDesigner practice keeps the operator type in the name (`null_out`, `constant_color`), so a node says what it is on the canvas and inside every `op('…')`.

## 1. The rule

A node's name is its **kind**, one underscore, then its **role**.

| Name | Node type | Reads as |
| --- | --- | --- |
| `slider_lamp` | `slider` | the slider for the lamp |
| `light_lamp` | `light` | the light that is the lamp |
| `blur_diffuse` | `blur` | the blur that diffuses |
| `lfo_pathx` | `lfo` | the LFO driving path x |
| `kernel_joints` | `pointKernel` | the point kernel for the joints |
| `mesh_car01` | `meshFileIn` | the mesh file for car 01 |
| `depthpoints_holo` | an instance of the component DepthPoints | the Depth Points used as the hologram |

Three forms conform, and no others:

| Form | Example | When |
| --- | --- | --- |
| `kind` | `blur` | a deliberate bare name |
| `kind<digits>` | `blur1`, `kernel12` | what auto-naming mints; the node has no role yet |
| `kind_<role>` | `blur_diffuse`, `lfo_path_x` | a named node |

## 2. The parts, the separator, the characters

- **Kind**: lowercase ASCII letters only. No digit, no underscore. One word per node type, from one table (section 3).
- **Separator**: exactly one underscore between kind and role.
- **Role**: letters, digits and underscores, starting with a letter or a digit. It may contain further underscores (`lfo_path_x`). Letters and digits are Unicode (`blur_größe`, `blur_ぼかし`): nothing in the reference grammar needs ASCII.
- **Nothing else.** A space, a comma, a dot, a colon or a hyphen in a name breaks one of the forms that hold names: a name list splits on spaces and commas (a Render's `lights`), a preset target is `name.key`, a legacy channel is `name:channel`. Today the document accepts such names and those references then fail quietly; a conforming name cannot hit that.
- **Case matters.** A name is an identifier. `Blur_soft` is a different name from `blur_soft` and does not conform.

Because a kind has no digit and no underscore, a name parses one way: the kind is everything before the first underscore, or before the trailing digits. `camerablur1` is a Camera Blur's auto-name and can never be read as a `camera`.

## 3. Where a kind comes from: one table

`NODE_KINDS` in `src/domain/graph/node-kinds.ts` maps every node type to its kind. The full table is section 13. 148 types, 132 distinct kinds, 59 of them different from the old base.

**Decision: one central table is the only source, not a field on each definition.** Reasons:

1. The kinds are one shared namespace, like TouchDesigner's operator type names. Whether two types may share a word is a property of the set, and it can only be reviewed as a list.
2. Everything that uses a kind is a pure function of `(name, type)`: auto-naming, the rename rule, the gate, the builders, the phase 2 sweep. With the table in the domain they need no registry in hand. `SOURCE_REFERENCE_PARAMETERS` is keyed by node type in the same folder for the same reason.
3. No node definition file is edited. Several are being changed by other sessions, and definitions stamped out by a factory would need plumbing for a field.

The cost is a second place to touch when adding a node type. It is one line, and it is enforced: the table is **total**, and `src/examples/node-names.test.ts` (on `pnpm test:gates`) fails by name when a registered type has no row, or a row names a type that is gone.

How each kind was chosen:

1. The type, lowercased, when that is one word: `blur`, `noise`, `feedback`.
2. A leading family word is dropped: `point…`, `value…`, `custom…`, `component…`, `render…`. The family is already drawn on the node (body wash, port colours); the kind names the operation. `pointKernel` → `kernel`, `valueMath` → `math`, `customWgsl` → `wgsl`.
3. A file input is named for its medium: `movieFileIn` → `movie`, `meshFileIn` → `mesh`.
4. A compound stays whole when no single word says it: `cornerpin`, `camerablur`, `personmask`.
5. Wherever possible the kind is the word the library shows as the title, so it can be found by typing it.

**Kinds are unique except for 11 declared families** (`KIND_FAMILIES`; a test holds the declaration equal to what the table actually shares, both ways). Two reasons a kind is shared, and no third:

| Why | Kind | Types |
| --- | --- | --- |
| Variants of one thing | `wgsl` | `customWgsl`, `customWgslMulti` |
| | `kernel` | `pointKernel`, `pointKernelAdvanced` |
| | `material` | `materialUnlit`, `materialPhong`, `materialPbr`, `materialGlass`, `materialWgsl` |
| | `in` | `componentIn`, `componentInPoints`, `componentInValue` |
| | `out` | `componentOut`, `componentOutPoints`, `componentOutValue` |
| The same operation on another payload, under the same title | `limit` | `limit`, `valueLimit` |
| | `slope` | `slope`, `valueSlope` |
| | `switch` | `switch`, `valueSwitch` |
| | `range` | `valueRange`, `pointRange` |
| | `transform` | `transform`, `pointTransform` |
| | `circle` | `circle`, `pointCircle` |

The second group is TouchDesigner's own model: a Transform TOP and a Transform SOP are both `transform1`. Members of a family are numbered in one sequence (`limit1`, `limit2`), so names stay unique.

**Two special cases.**

- A **component instance is named for its component** (ruled 2026-10-05). An instance of Bloom is `bloom1`, then `bloom_glow`. Its kind is the component's own name, lowercased, letters only (`Depth Points` → `depthpoints`), or `component` when the name holds no letter a kind can hold. It is not `comp`: that says only that the node is a component, which the stacked card on the canvas already says.
  - **The kind is not in the type.** A saved component's id is minted (`cmp_7`), so the type `component:cmp_7@2` holds nothing a person can read. The name is on the component's definition, which the registry hands out as the instance's title. So `kindOf(definition)` answers for every node, and `kindOfType(type)` refuses an instance type by name rather than answer with a wrong word.
  - **A component may share a word with a built-in kind.** One called "Blur" makes instances of kind `blur`. To the reader it is that kind of thing. The two are numbered in one sequence (`blur1`, `blur2`), so names stay unique.
  - **Renaming a component renames no node.** Instances made under the old name keep it, and every reference to them still resolves. They stop carrying the kind, so the canvas shows their type again and the title editor offers the new kind at the next rename. Tested.
  - **A new instance is named**, where it used to be left unnamed and so was the one new node `op('…')` could not address. All four doors do it: the library, an import, an `addNode`, and save as component. The last waited for the sweep, because every shipped starter component is authored through that command and ships the document it leaves behind: naming the instance there added one line (`"label": "mattecut1"`) to each of the 12 files under `examples/components/`, which is the sweep's step 0.
- A component's **In and Out** are not bound by the convention. Their name is the label of the socket the component shows from outside (`boundary-ports.ts`), so `in_depth` would put the direction on the socket twice. They are auto-named with their kind (`in1`, `out1`), never prefixed on a rename, and the gate does not ask them to conform.

A type the table does not hold (a test fixture, a definition registered at runtime) falls back to the old base, `nameBaseFor(type)`.

## 4. Who names a node, and what each does

| Door | What it stores |
| --- | --- |
| A new node, no label | `kind` + the next free number: `blur1`, `kernel1`, `movie1`. An unrenamed node already conforms. |
| `node.rename` (the command) | The kind goes in front of a name that lacks it, and the result says so (`node.name.kind`). `exact: true` stores the name as given. `label: null` clears it. |
| The title editor | Calls `node.rename`. Section 6. |
| Agent `add_node` with `label`, and `rename_node` | Same rule. `data.name` in the result is the name that was stored. `exactLabel` / `exact` opt out. |
| A patch (`addNode.label`, `setNodeLabel`) | **Exactly what it carries.** A patch is replayable and its references were written against its own labels (§V324, §V325). Through the agent tool `apply_graph_patch` a label without its kind is still stored, and the result carries a warning (`node.name.kindMissing`) and `data.unconformingLabels`, each label beside its conforming form (ruled). |
| "Control from Panel" | `slider_brightness`, `toggle_flipU`, `xypad_pinTopRight`. The channel it publishes stays the bare word. |
| MIDI learn | `midiin1`, and `count_midi` for the press counter. |
| Paste, duplicate, detach, flatten | The copied name, renumbered when taken (`slider_lamp` → `slider_lamp1`). Still conforming. |
| A new component instance (library, import, or an `addNode`) | Named for its component: `bloom1`. |
| The instance a saved selection becomes (save as component) | Named for the component it was saved as (`doubleblur1`), counted against the names the graph still holds. Since the sweep's step 0. |

**Where the rule lives: in the command, not in each surface.** `node.rename` is the one door the title editor and an agent's rename both use (§V78), so the rule is stated once there. The patch operation underneath stays exact. The convention belongs to the act of naming, never to the replay of one.

**One function decides conformance**: `conformsToKind(name, kind)`. Beside it: `withKind(kind, role)`, `roleOf(name, kind)`, `roleFromText(text)` (free text to a role: `Bloom pass` → `Bloom_pass`), and `nameInKind(typed, kind)` / `conventionalName(typed, type)`, which is the rename rule:

- typed text that already conforms is taken as it is (`blur_soft`, `blur2`);
- text that conforms once cleaned is cleaned and not prefixed twice (`blur soft`, `Blur_soft` → `blur_soft`);
- anything else gets the kind in front (`soft` → `blur_soft`, `Bloom pass` → `blur_Bloom_pass`).

**Collisions (ruled).** An explicit name that is taken is refused, with the free neighbour suggested (§V325 stands): `The name "slider_lamp" is already in use. "slider_lamp2" is free.` Auto-numbering applies to the names the app mints.

**References.** A rename still rewrites every stored reference in the same patch (§V128), now to the prefixed name. Tested through the real bus: `op('slider1')` becomes `op('slider_lamp')`.

**What a performance surface calls a node: the role (ruled).** A Panel board, the Controls tab, the Layers list and the phone caption a Presets bank, a Layer, a Cue List and an untitled Panel by the role of the name. `presets_looks` reads `looks`; `layer_graphic` reads `graphic`. The surface already draws a bank as a bank, so the kind in front would be the same fact twice in the one place where every character is read from across a room.

- One rule for all of them, `surfaceNameOf`: the role when the name carries its kind and has one, otherwise the name as it is. `presets1`, `looks` and anything saved before the rule are shown whole. Nothing is cut from a name the rule did not make.
- A look's instance is a bank from outside. It is captioned against its component's name, read from the catalogue; without one its name is shown whole.
- It is a caption, never an address. A board stores its members under the full name, and a phone writes to a node id.
- Not switched, on purpose. The board editor's "+ Add…" list and the "Driven by" hover name the node in full, because there the name identifies a node. A Layer's picture and a layer stack's title name another node, whose kind the surface does not draw (open question 2).

## 5. Stored names never move

A kind is read when a name is **minted** or **checked**. It is never read when a document is loaded. Changing a row in the table changes what the next new node is called and what the gate asks of shipped files. It rewrites nothing.

A Point Kernel auto-named `pointkernel1` last week is still `pointkernel1`, every reference to it still resolves, and the next one added beside it is `kernel1`. This is tested (`node-naming.test.ts`, "a stored name never moves when a kind changes").

No migration, no schema bump, and no shipped example's bytes change in phase 1: `sync.test.ts` and `component-sync.test.ts` stay green on `pnpm test:gates`.

## 6. The title editor

The only place a person types a node name is the title on the canvas (double-click, `n`, or Rename… in the menu, which all open the same field). **The inspector has no name field** and the palette has no rename prompt; both show or open the title editor. If an inspector field is added later it must call `node.rename` and should reuse this field.

**What I chose.** The field is two parts that read as one: the kind and its underscore as fixed text (`slider_`), then the input, which holds the role alone (`lamp`). One border, one background, one focus ring.

- It opens on the role: `lamp` for `slider_lamp`; empty for an auto-name, because `blur1` has no role yet; the whole cleaned name for one that does not carry its kind.
- A space becomes an underscore **as it is typed**, so the field shows the name that will be stored.
- Typing a name that already carries the kind (`slider_lamp`, `slider2`) is taken as it is.
- With the kind kept and no role typed there is nothing to rename to, and the name stays.

**Removing the kind is possible and deliberate.** The fixed part is a toggle:

- **Backspace** with the caret at the very start of the role switches it off. It has to be a fresh press: a held key that has just emptied the role stops at the kind.
- A **click** on the kind does the same, and a second click brings it back.
- Off, the kind stays on screen, struck through, and the name is stored exactly as typed (`exact: true`). Spaces are spaces again.

**Why this and not the alternatives.**

- *A modifier on Enter* (say Alt+Enter stores the name bare): invisible until known, and the field would show one name while storing another.
- *A separate clearable chip with an ×*: more chrome in the most crowded row in the app, for an act that should be rare.
- *Backspace at the start* is the key someone presses when they want what is left of the caret gone, so the gesture already means this. Requiring a fresh press keeps "clear the role" and "drop the kind" apart.

**Enter and blur differ in one case.** For a name that does not carry its kind yet (`dye1` on a Feedback), the field opens showing `feedback_` in front of `dye1`. Enter is an answer and gives it the kind. Leaving the untouched field renames nothing: opening a field and clicking away is not an edit, and must not rewrite references (§V33). Everywhere else Enter and blur both commit, as before.

### Looked at in a real browser

Headless Chromium, a Camera Blur at 100 % zoom (a 178 px node, kind `camerablur`, 11 letters). The name slot is 103 px wide: the status dot and the three toggles take the rest of the header. Four things were wrong that the jsdom tests could not see, and all four are fixed.

| What the browser showed | Now |
| --- | --- |
| The focus ring was drawn round the input only. It cut the field in two between `camer…` and what was being typed, so the kind read as a separate grey tag. | The border, the ground, the ring and the refusal's red edge are on the field as a whole. |
| The kind took exactly half the slot and elided as `camer…`, losing the underscore. The role was left 50 px, about seven letters. | The kind takes at most 45 %. Its word elides and the join does not: `cam…_soft`. The role has 55.5 px. The start of the word is kept because that is what identifies a kind. |
| Opening on a 25-letter role showed its END (`…ox_jumps`): selecting the text had scrolled the field 111 px. | It opens on the start of the role. |
| A refused name showed `Operation 0 (setNodeLabel): the name "lfo_pathx" is already in use. "lfo_pathx2" is free.` in a card 103 px wide, over five lines, covering the node. | `The name "lfo_pathx" is already in use. "lfo_pathx2" is free.` in two lines, 222 px wide. The prefix is the patch's own bookkeeping and comes off at this surface only. |

Confirmed working as designed: a space typed in the middle of a word becomes an underscore and the caret stays after it (`key_light`, caret at 4); a click on the kind switches it without committing the rename; Backspace at the start switches it off, struck through at 60 % opacity, focus kept; a very long role scrolls inside the field and never widens the node.

There is only a dark theme (`color-scheme: dark`, no theme switch), so nothing was checked in light.

Left as it is: at rest a long name ends in an ellipsis (`camerablur_the…`), so there the kind survives and the role is cut. Open question 3.

## 7. The gate and its ledger

`src/examples/node-names.test.ts`, on `pnpm test:gates`. It reads the shipped bytes of every `.loom.json` under `examples/`, `examples/components/` and `projects/`: the root graph and every component graph the file embeds. A named node whose name does not carry its type's kind fails it.

Not counted: an unnamed node, and a component's In and Out.

Phase 1 renamed nothing, so the files written before the rule went into `NOT_YET_RENAMED`, each with the **exact number** of names it still owed. It is a count, not an allow-list, and it is checked both ways:

| Situation | The gate says |
| --- | --- |
| A file not on the ledger has a non-conforming name | names each node, its type and the kind it wants; a new document does not go on the ledger |
| A listed file now conforms | remove its line |
| A listed file's count went down | lower its line to N |
| A listed file's count went up | a non-conforming name was added to an old file; name the new node `kind_role` |
| A line names a file that is not shipped | remove the line |

On 2026-10-05, before the sweep, under the new kinds:

| Set | Files | Named nodes the rule binds | Not conforming |
| --- | --- | --- | --- |
| `examples/` | 74 | 1,799 | 1,732 |
| `examples/components/` | 12 | 53 | 50 |
| `projects/` | 26 | 1,541 | 1,515 |
| **Total** | **112** | **3,393** | **3,297** |

106 files were on the ledger. The 6 that were not have no named nodes at all.

**Since the sweep (2026-10-06): 112 files, 3,462 named nodes the rule binds, none not conforming. The ledger is empty** (section 10.6). It stays as the mechanism: a line added to it is a debt somebody decided on in a diff, with its count.

The brief's figure was 1,714 named and 1,653 non-conforming. That counted the root graphs of the examples only, against the old bases. This table also counts embedded component graphs and the projects, against the new kinds, so the numbers are not comparable line for line.

The same file also holds the kind table total over the catalogue, both ways.

Red-verified on the real set by editing: one ledger line raised, one lowered, one removed, and one kind row removed. Each failed with the instruction above. The gate's own cases also run on hand-built files, so a red result there is about the gate.

## 8. The canvas

### 8.1 The type chip beside the name (T416)

T416 shows the type beside the name once a rename has spent the identification. It now asks `conformsToKind`, so `blur_diffuse  Blur` never shows the same word twice, and a name without its kind (`Bloom pass`) still gets the chip. The setting that hides the chip entirely is unchanged. Two more cases follow from phase 1b:

- **An unnamed node gets no chip.** It shows its definition's title as its name, so the chip was that word again (`Blur  blur`).
- **For a component instance the chip is the component's name** (`holo1  DepthPoints`), not the word "component". T639/T640 chose "component" because an instance then showed its component's name as its own and the chip repeated it. With the component's name as the kind, that repetition cannot happen (no chip when the name carries the kind, none when unnamed), and the chip is free to say what kind of thing the node is. That it is a component at all is said by the stacked card and the version chip.

For a family kind the chip also hides (`material_floor` no longer shows "Material · PBR"). The variant stays on hover and in the inspector's type badge.

### 8.2 The kind stays legible at low zoom (T1597b, built; where it stands, B258)

**The problem, measured.** A node is 178 px wide and its header text is 11 px. At 60 % zoom that is 6.6 px, at 35 % under 4. And E79 Crucible, 79 nodes, **opens at 15 %** in a 1600 px window: a node is 27 px wide and its name is 1.65 px tall. This is where the owner's "we need to zoom in and figure out … this is this kind of operator" comes from. A better name does not help someone who cannot read the name.

**What was built.** Below 70 % every node carries one label: its kind in bold, then the rest of its name, at a size that does not shrink with the canvas (11 px text on screen at every zoom). It stands on the line under the node's header and grows upward (see "Where the label stands" below; the first version lay inside the node and that was B258).

| Zoom | The label | Example |
| --- | --- | --- |
| 70 % and above | none: the header is readable | |
| 45 % to 70 % | kind, then the rest of the name | **geometry** swarm2geo1, **kernel**_joints |
| 9 % to 45 % | the kind alone | **geometry**, **kernel**, **wgsl** |
| below 9 % | none: a node is under 16 px wide and no word fits | |

The kind comes from the node's **type**, not from its name. So the label is right for every node today, including the 3,297 shipped ones still named `dye1` or `lamp`. A name that carries its kind is split where the kind ends (`kernel` + `_joints`); a name that does not follows the kind as a word of its own (`feedback dye1`).

**One calm line, and no pile-up, by construction.** The label is clipped to its own node's width, so it cannot run over a neighbour beside it. As the node gets narrower on screen the label simply shows less, and the last eighth of the width fades instead of slicing a letter. There is no collision test and nothing to tune. Upward it has the room the layout rule keeps above every node (below).

**No layout cost.** The label is absolutely positioned, inside the box and above it. Measured: all 79 node boxes are identical with the labels on and off.

**No React work while the canvas moves.** A label that does not shrink has to be told the zoom. Three ways were measured on E79 (79 nodes, 1,802 elements under them), as the cost of one zoom change with style and layout brought up to date:

| How the labels learn the zoom | Per zoom step |
| --- | --- |
| a custom property on the nodes' common ancestor | 4.23 ms |
| the property written on each label element | 0.35 ms (0.77 ms on the finished labels) |
| a property on a separate layer holding only the labels | 0.12 ms |

The first is the obvious way and it is the expensive one: a custom property is inherited, so changing it on an ancestor restyles every element under every node on every frame of a zoom. **Chosen: the second.** One subscription to the canvas's transform compares one number per event; a pan changes no number and does nothing. On a zoom it writes one property on each label. Above 70 % it writes nothing at all: the tier is one attribute on the canvas root, written only when a threshold is crossed. No component re-renders at any point.

Observed in the browser, as DOM mutations under the nodes: a pan, none; a zoom at working zoom, none; a zoom inside the label range, the labels' own `style` and nothing else (474 writes for six wheel steps on 79 labels).

**Rejected.**

- *The inherited property*: twelve times the cost, and it grows with everything inside a node.
- *A separate label layer*: cheapest to update, but its labels would have to be positioned from the canvas's node list (React work on every frame of a drag), would paint above every node instead of with their own, and would not be culled with them.
- *A label above or below the node, outside its box*: rejected in the first build because it needs the gutter (at 35 % a 13 px label needs 37 flow px and the layout gate guarantees 36), on the reasoning that inside the box there is nothing to collide with. That reasoning was wrong: inside the box is the node's content. B258 moved the label out; see "Where the label stands".
- *Fading the kind out below a second threshold near 30 %* (the brief's suggestion): E79 opens at 15 %, so the label would be gone at the zoom the complaint is about. Clipping to the node's width keeps it calm without removing it. It goes only when no word fits (below 9 %).
- *An ellipsis*: at 27 px it would take one of four letters.
- *An earlier version of this design* clipped the label with a `max-width` that followed the zoom. The browser measured it re-laying out every label on every step (1.16 ms). The clip is now a separate box that never changes, and only the label's transform does.

**What the screenshots show** (E79 Crucible, headless Chromium, 1600 × 1000; no GPU there, so previews read "no signal"):

- **100 %**: unchanged. No label; the header's own name and type chip.
- **60 %**: every node reads `geometry swarm2geo…`, `kernel swarm2…`: the kind bold, the name dim after it, cut at the node's edge with a short fade. 79 of 79 shown, 26 cut at the edge.
- **35 %**: the kind alone, whole: `kernel`, `geometry`, `wgsl`, `light`, `material`. One of 79 is cut at the edge (a node is 63 px wide there; the example's longest kind, `audioanalysis`, is the only one that needs more). Before, this zoom showed `swarm0…` and a 4 px type chip.
- **15 %** (where the example opens): `grid`, `kern`, `geo`, `rend`, `reor`, `mas`, `wgs`, `blur`, `add`, `lag`, `tail`, `beat`, `light`, `mat`, `cam`. Three to five letters each, 73 of 79 cut at the edge. The patch reads left to right as audio, select, range, lag, grid, kernel, geometry, render, wgsl, output. Before, nothing on the canvas could be read at all.

That look had no GPU, and it is what hid B258: with every preview dark, a label lying on a picture's slot looked fine.

**What the browser showed that was fixed.** At 35 % a short label (`wgsl`) left the rest of the header visible beside it: the same name and type at 4 px, as a grey smear. While the label is showing, the header's own name and type are not drawn.

#### Where the label stands (B258, 2026-10-06)

The owner, on the first build: "the enlarging labels on the nodes now cover the content weirdly on some and on others they get covered. like value operators get covered by the label while previews overlap the thing. both is not great."

**Looked at with real previews.** Headless Chromium, 1600 × 1000 at 2×, with a Metal adapter this time (the full Chromium build in its headless mode, `channel: "chromium"`, with `--enable-unsafe-webgpu --use-angle=metal`; the default headless shell resolves none, §V895). E79 Crucible and E82 Set List (two sliders, sixteen pictures, a Panel and seven notes), at 60 %, 35 % and 15 %. The first build grew the label down from the node's top edge, inside the node:

| Zoom | On a value node | On a node with a picture |
| --- | --- | --- |
| 60 % | the label's last 2 px lie on the first row of the readout | the same 2 px are under the tile |
| 35 % | the label covers the first row: the channel's name and the start of its bar | the tile cuts the label's lower half off |
| 15 % | the label covers the upper 70 % of the node, readout and plot | the label is gone under every live tile: counted on the E79 screenshot, 42 of the 53 picture nodes in view show no word at all, and the other 11 had no live tile |

Both halves have one cause, the label lying on the node's content, and they differ because the two kinds of content are drawn by different things. A value's readout is DOM in the node, under the label. **A live preview is not in the node.** One canvas over the whole pane paints every tile, above everything any node draws (`.previewSurface`, `app/panes.module.css`; the camera toggle moved out of the node for the same reason, T892). Nothing drawn inside a node can be put on top of a tile.

**The rule: the label stands on the line under the header and grows upward. It never enters what the node shows.** It takes the header band, whose name it replaces, and what does not fit there goes up, out of the box, into the gutter above the node. One rule for every node: a value node, a node with a picture, a Panel, a node with ports alone.

- At 60 % the header band is 14.4 px and the label is 13.2: it sits where the name was.
- At 35 % the band is 8.4 px: the label rises 4.7 px above the top edge, as a tab on the node's corner.
- At 15 % the band is 3.6 px: the label rises 9.6 px, and reads as a caption over the picture.

**The room.** In the node's own px the band is 23 above the header's hairline and the layout rule keeps 36 clear above every node (§V389): 59 × zoom on screen, for a label 13.2 px tall. So down to **22.4 %** a label reaches no other node and no other label in any layout that passes the rule. The shipped layouts have far more above a node (the tightest stack in E79 has 86 px, in E82 70), and a label needs 65 at 15 %.

Measured over every label, with the tiles live:

| | E79, 79 labels | E82, 23 labels |
| --- | --- | --- |
| labels that overlap another label, at 60 / 35 / 15 % | 0 / 0 / 0 | 0 / 0 / 0 |
| labels on a node that is not their own | 0 / 0 / 0 | 0 / 0 / 0 |
| labels in a picture's or a plot's slot, their own or another's | 0 / 0 / 0 (was every label in view: 73 of 73 at 15 %) | 0 / 0 / 0 (was every node that has a slot: 18 of 23 at 15 %) |
| labels that cross the line under their header | 0 / 0 / 0 | 0 / 0 / 0 |

**When the label is taller than the room.** Below 22.4 %, in a layout packed to the rule's minimum, the top of a label reaches into the bottom of the node above it: at 15 % by 29 of the node's px (4.4 on screen), which is that node's port row (23 px at the least) and under 1 px of what is over it. The label is not shrunk to prevent this and is not cut. What would fit at 15 % is 7.4 px text, and under 7.7 px is the size at which the header was judged unreadable and the label takes over. Cutting it at the gutter would slice the tops off the letters. A diagnostic row on the node above uses the same gutter (it is why the gutter is 36), so in a layout at the minimum, under a node that is showing a two-line error, the label can lie on the end of that message as soon as it leaves its own box, below 57 %.

**Rejected.**

- *The label as it was, on top, with its plate* ("the content under it is unreadable at that zoom anyway"). Not available: a tile is painted over everything in a node, so on a node with a picture this is the build the owner rejected. It would take a label layer above the tile canvas, placed from the canvas's node list, which was already rejected for React work on every frame of a drag. And it is false for pictures, which read well at 35 %.
- *The label inside the header band only*, limited to the band's height: 6 px text at 35 % and under 3 px at 15 %.
- *The label wholly above the top edge.* It never covers the header's toggles, but it needs its whole height from the gutter: 36 × zoom, so a layout at the minimum runs out at 37 %, not 22 %, and at 15 % on E79 46 of 79 labels of the first build's height would lie on the node above. It also leaves an empty title bar under a floating name at 60 %. Standing on the header's line uses the band the label has emptied anyway.
- *Shrinking toward a floor size* and *fading below a threshold*: both give up legibility at 15 %, which is where E79 opens and where the label is wanted.

**What it stands next to.**

- *Notes.* A note is a region behind the nodes, and a label over it is drawn like the node's own body over it. On E82 at 15 % four labels reach the empty bottom strip of the note above them, none reaches a note's words.
- *A selected node.* The outline and three of the four resize handles are clear; the label's plate covers the top edge along its own width and half of the top-left handle. The handle still takes the press: the label takes no pointer.
- *The debug timing readout* (T1010) stands above the node, which is now the label's room. With both on, the readout moves up by exactly what the label takes above the top edge and stands on the label: bar, number, label, node. It is told the zoom the same way the label is. Measured at 35 % and 15 %: 0 of 23 readouts overlap their label.
- *The status hairline* on the node's top edge is under the label's plate along the label's width once the label rises past it (below 57 %). It shows on the rest of the edge. At 15 % it is 0.15 px and was not visible before either. Open question 9.
- *The map, Frame all and the layout rule* read node boxes, and the label is in none of them.

**Held by** `kind-label.test.tsx` (the tiers, what the label says, and what a pan and a zoom write), `node-view.test.tsx` (a real node renders it and joins its canvas), `node-timing-overlay.test.tsx` (the readout is told the zoom) and `src/tests/e2e/kind-label.spec.ts`, which measures the real page:

- the label's height is the same at 60 %, 35 % and 15 % to a tenth of a pixel; node boxes do not change; a pan mutates nothing;
- on E79, at all three zooms, no label runs past its node's side, crosses the line under its header, lies in a slot, lies on another node or overlaps another label;
- on E82, for a value node, a picture node and the Panel in the same pane: at nine points of every label's own rectangle the label is what is on top (`elementsFromPoint`, with hit testing switched on for the reading); at twelve points just under each header line no label is on top; and no label lies in any slot. That last one is geometry because a tile is not an element in a node. The test first checks its premise, that the tile canvas is over everything in the nodes;
- with the timing readout on, no readout shares rows with its label.

Broken on purpose, each failed for its reason: against the first build (the label 2.1 px over the header line at 60 %, 6 of the value nodes' probe points under a label); with the clip's stacking lowered (the label under its own node); with the readout's move removed (23 of 23 overlapping).

**Not checked.** The three thresholds, by the owner's eye in the running app (open question 4). The headless lane the spec runs in still has no GPU; the claims about live tiles above come from the look described here, not from a test that reads pixels.

### 8.3 The join reads as one name (B258)

The owner, in the same message: "there seems to be a space after all the prefixes in labels before the underscore".

It was not in the low-zoom label. It was in the header at rest, at working zoom. A name is drawn there as kind, join and role so that a long name can give up its kind first (ruled 2026-10-05), and the kind had a floor of 3.4em so it would not elide past `cam…`. A floor is a minimum width, so a kind NARROWER than 3.4em (37.4 px) was held open to it and the join was drawn after the empty room. Measured on E82, 11 of the 21 names in parts:

| Name | Empty before the `_` |
| --- | --- |
| `level_dim` | 11.3 px |
| `solid_black` | 10.9 px |
| `layer_fx`, `layer_grid`, `layer_rings` | 9.9 px |
| `slider_master`, `slider_keystone` | 6.8 px |
| `noise_source`, `noise_tear` | 6.8 px |
| `panel_desk` | 6.4 px |
| `cuelist_set` | 0.3 px |

Kinds of four letters or fewer were already exempt, by a mark that guessed the width from the letter count. `slider` is six letters and 30.5 px.

**Fixed in the stylesheet, at the cause.** The floor is now the smaller of 3.4em and the word itself, which is what `min-width: auto` means on a flex item when its `width` is 3.4em, its basis is its content and it is not a scroll container (`overflow: clip`, not `hidden`). All three are needed and the stylesheet says why. After: 0 of 21, and `panel_desk`, which was drawn `panel _d…`, fits whole.

**Held by** the same spec: every name at rest that is in parts, and every low-zoom label that continues its kind, starts the part after the kind where ONE span of the same text and style would start it, within half a pixel. A second test renames a Transform to a 35-letter name through the real field and checks that the kind still elides to the 3.4em floor and no further. Broken on purpose: against the old floor (`level_dim`, 11.36 px off); with a 3 px margin put on the label's second part (3.02 px off); with the floor's `width` removed (the kind no longer gives way).

**Checked and found clean.** The low-zoom label draws the kind at weight 600 and 112 % width and the rest at 400 and 100 %. The parts are adjacent boxes, 0.00 px apart. The underscore's own left side bearing in Archivo is 0.00 px in both styles, so the change of weight and width opens no air either: what stands between the last letter's ink and the underscore is that letter's own right bearing (0.03 to 0.75 px) less the kind's tracking, the same as in one span. The kind's letter-spacing is negative (−0.01em), so it was never the cause.

**Left as it is.** In a name too long for the header the kind is cut to its floor and ends in dots, and the dots follow the last whole letter, so up to a letter's width of the floor is empty after them: `tran… _the_quic…`. That is how an ellipsis is cut and it was so before. Open question 10.

## 9. Judgement calls in the kind table

Each of these could reasonably go the other way.

| Call | Chosen | Alternative | Why |
| --- | --- | --- | --- |
| Same title on another payload | shared kind (`limit`, `slope`, `switch`, `range`, `transform`, `circle`) | invent a word (`clamp`, `ring`, `xform`) | The kind should be the word the library shows. TouchDesigner shares these names. Cost: the name alone does not say texture or value; the node's wash does. |
| The five materials | one family, `material` | `unlit`, `phong`, `pbr`, `glass` (TouchDesigner's MAT names) | Their titles are "Material · X". A look moved from Phong to PBR keeps its name. Cost: the name does not say the shading model. |
| `customWgsl` and its multi-input form | one family, `wgsl` | `wgsl` and `wgslmulti` (TouchDesigner has `glsl` and `glslmulti`) | Same reasoning as materials. |
| Component instance | the component's own name (`depthpoints_holo`), **ruled** | `comp` | To a reader an instance of Bloom is "a bloom". Cost: the kind is not in the type string, so it is read from the definition; a non-Latin name gives `component`. |
| `geometry` | full word | `geo` (TouchDesigner's default) | The ruling asks for the full kind word. It is the most common scene node (342 shipped). |
| `output` / component `out` | `output` and `out` | `out` for both | Different things. Every shipped Output is named `out1` today; phase 2 makes it `output1`. |
| `pointCircle` | `circle`, shared with the texture Circle | `ring` | Same shape on points. |
| Point shapes | `grid`, `line`, `sphere`, `tube`, `torus`, `box` | keep `pointgrid` … | The ruling's own example drops `point` (`kernel`, not `pointkernel`). These are TouchDesigner's POP names. |
| `renderPoints` / `renderInstances` / `renderSurface` | `points`, `instances`, `surface` | one family `render` | Named for what they draw; distinct. `surface` may be confused with a surface material in the projects. |
| `pointGenerator` | `generator` | `points` (taken by Render Points) | |
| `textureToAttribute`, `pointsFromTexture` | `sample`, `texturepoints` | `texattr`, `texpoints` | The owner's ruling, 2026-10-05: spell them out. `texattr` and `texpoints` were abbreviated from the titles, as TouchDesigner does (`topto`, `hsvadj`), and were the least natural words in the table. |
| `audioPattern` | `pattern` | `audiopattern` (12 letters) | Too long. Cost: loses the `audio…` family with `audioin`, `audiofile`. |
| `audioFileIn` | `audiofile` | `audio` | `audio` alone would not say which of three audio sources. |
| `annotate` | `note` | `annotation` | Every shipped one is already named `note…`. |
| `filmGrade`, `cameraBlur`, `personMask`, `cornerPin`, `gridWarp`, `crtTube`, `slitScan`, `channelIn`, `cueList`, `xyPad`, `laserPath` | kept whole | `grade`, `person`, `pin`, `warp` … | No single word says it without ambiguity. `grade` is also a common role on other kinds. |
| Unicode in roles | allowed | ASCII only, as TouchDesigner | No reference form needs ASCII. |

## 10. Phase 2: the sweep (applied 2026-10-05 and -06)

Rename every shipped name to `kind_role`, rewrite every reference, regenerate, empty the ledger. Phase 2a built the map, a check that the rename changes nothing but names, and the tool that applies it, and ran all three without writing a shipped byte. Phase 2b applied it once the map was approved: 10.1 to 10.5 are the plan as it stood, 10.6 is what happened.

`projects/sentinel-bot/**` and `src/projects/sentinel-bot/**` are left out of all of it: that session renames its own names.

### 10.1 The pieces

All under `src/examples/rename/`, all run with `node --import ./src/tooling/alias-hooks.ts <file>`.

| File | What it is |
| --- | --- |
| `rename-rules.ts` | The rules: what the old naming habit added to a name, and which words only say the kind again. Pure, exact-tested. |
| `rename-judgements.ts` | The 70 names a rule could not decide, each with its role and one sentence of why. **This is the file to edit when a review changes a name.** |
| `rename-map.ts` | Builds the map from the shipped bytes, the rules and the judgements, and audits it: every name ends carrying its kind, no graph holds a name twice, no thin role is undecided, no judgement is stale. |
| `build-rename-map.ts` | Writes `docs/node-rename-map-2026-10-05.md` (for a person) and `.json` (the whole map). `--check` fails when they are stale. |
| `apply-rename-map.ts` | The map applied to one file's bytes in memory, through the product's own `rewriteNodeNameReferences`. |
| `rename-equivalence.ts`, `check-rename-equivalence.ts` | The equivalence check (10.3). |
| `source-rewrite.ts`, `apply-rename.ts`, `overlay-hooks.ts` | The apply tool (10.4). |

### 10.2 The map

`docs/node-rename-map-2026-10-05.md`. 111 documents, 3,130 nodes, 2,143 distinct names.

A name is decided once per **scope**, not once per file: an example's own graph, a component's graph wherever it is embedded, or a whole project. A starter component's graph ships inside every example that uses it, and on-nothing's two dozen shots are built by shared source; one answer per name is what lets that source be rewritten at all.

Five rules are mechanical and keep the author's word exactly (2,549 nodes). Three are listed in full in the map for review: the role said the kind again at one end (`wallgrid1` → `grid_wall`, 328 nodes), the role was only the kind (`out1` → `output1`, 163 nodes), and the 70 decided by hand (90 nodes). The line for those: a role is decided by hand when the rules leave one or two characters, and then its whole chain is renamed with it, so three nodes in a row do not mix two spellings. A chain with no thin member keeps the author's words.

### 10.3 The equivalence check

`check-rename-equivalence.ts` applies the map to every shipped document in memory and asks whether each still does what it did. CPU only: it loads, flattens and compiles, and opens no device. **2.8 s for all 111 documents.**

Four questions, because no one of them is enough:

1. **The same graph.** Flatten before and after. With every name replaced by the id of the node that holds it, in labels and in references, the two flattened graphs must be the same bytes.
2. **The same plan.** Compile both. Wherever the plans differ, the difference must be nothing but a name standing where its other name stood, word for word.
3. **No old name left behind.** After the rename, no parameter may still spell a name no node holds. (1) and (2) find references through the product's own walker and inherit its blind spots: a reference kind the walker does not know is the same text on both sides. (3) reads the text.
4. **As many references as before**, per renamed node.

Result: 111 of 111 the same, 3,260 names and 2,760 references moved.

**It can fail.** `--sabotage` breaks the rename of every document in every way it knows (a reference left on its old name, a reference moved onto another node that exists, every label renamed and no reference rewritten) and requires each to be reported: 1,920 broken renames, 1,920 caught (123 s; run it through `tools/heavy.sh`).

**It found three things before the sweep ran:**

- **A reference kind the product's rename did not know.** A Channel In reads a published channel by name, and an Analyze publishes under its own name. Renaming the Analyze left every Channel In reading its Fallback for good, with no diagnostic. The sweep would have cut the sensor out of the control loops of E14, E27, E64 and furnace. Only check 3 saw it; the plans were identical. Fixed in `names.ts` (clause 8), with the literal bug as a test through `node.rename`.
- **A component that reads the document around it.** Kaleidoscope's `facets` reads `op('driftx1')` and `op('drifty1')`, two LFOs that are not in the component but beside it in the document it ships in. The map carries those two references as their own rule (`outward`) so they follow the LFOs. Anywhere else the component is used, the references name nothing, today and after. That is probably not what was meant and is worth its own row.
- **Prose that names nodes.** 35 sentences in the notes of E81 and E82 mention a node by its old name. They are not references and fail nothing; `--mentions` lists them for the hand pass.

### 10.4 The apply tool

`apply-rename.ts` rewrites the text that builds and describes the documents. Without `--write` it writes nothing: it rewrites every file in memory and prints what would change.

A node's name is found by **where it is written**, read from the syntax tree: a `label:`, a parameter that holds names (from `SOURCE_REFERENCE_PARAMETERS`, the table the product renames by), an argument of a function, the key of a preset's `values`, `op('…')` anywhere, and in comments and pages the name in backticks. A node's **id** is never touched, even where it is the same word as the label: it is the address edges are written against.

Dry run, 2026-10-05:

| | Files | Spellings |
| --- | ---: | ---: |
| Sources, `src/examples/documents/` and `starter-components.ts` | 68 | 3,077 |
| Sources, `src/projects/furnace/` and `on-nothing/` | 23 | 379 |
| Pages, `examples/*.md` and the README index | 66 | 2,356 |
| Tests that name nodes, 9 directories | 62 | 377 |
| Project documents, renamed in place | 25 | 1,482 |
| **Total** | **244** | **7,671** |

Plus 86 generated documents under `examples/`, regenerated and not written by the tool.

**The proof** (`--build-in <dir>`): the rewritten example sources are put in a scratch directory, every example and starter component is built from them (a loader hook swaps the text; the tree is not touched), and each built file is compared with the same file renamed in memory by the map. 4.5 s.

- **75 of 77** documents tried are byte for byte the renamed document.
- E81 is the same but for the text of a note, which the rewritten source updates and a rename in memory does not.
- `components/AudioAnalysis` differs in one expression. The tool refused it and said so: `hits` is a node in the host document and a socket inside the component, and one file builds both.
- **9 were not tried**, because their sources build names in code: E71, E72, E73, E74 (one helper builds three transports' send and receive nodes) and E75 to E79 (loops over rings, slabs and swarms; an occluder pass that looks nodes up by a name it composes).

**By hand in 2b**, all listed with line numbers by `--notes`:

| What | Size |
| --- | --- |
| Names built by code, which no file writes | 501 in 10 scopes: E71, E72, E74 (2 each), E75 (6), E76 (24), E77 (72), E78 (72), E79 (24), furnace (42), on-nothing (255) |
| The 85 places such a name is built | mostly `src/projects/on-nothing/shots/` |
| Literals in tests that are a node's name AND a node's id | 188; the tool shows each and moves none |
| Sentences that mention a node | 30 in sources, the 35 in the notes of E81 and E82 |
| A name two documents of one file rename differently | 24 |

**Projects are different, and this is a decision for the lead.** furnace and on-nothing are not regenerated by a gate: their documents are built by `build.ts` from GLB and audio files this checkout does not always have, and nothing checks the shipped JSON against the source. So:

- Their **documents** are renamed in place, through the save path's own serialiser. Every one of the 111 shipped files comes back byte for byte from that serialiser with an empty map, so the rename is the only change. The equivalence check covers exactly this.
- Their **sources** have to say the new names too, or the next build undoes the sweep. on-nothing writes few names: a shot is a plate with an id, a plate is prefixed (`Plate.prefixed("car")` turns `cam1` into `carcam1`), and labels are `` `${id.toLowerCase()}1` `` in a dozen helpers. That is a change to those helpers, checked against a real build, and not a text rewrite. It needs the build inputs and somebody who knows the project.

### 10.5 Order for 2b

In its own worktree, never the shared tree.

0. **Done.** The two kinds the owner spelled out (`sample`, `texturepoints`), and save as component names its instance (`commands.ts`; `instance-names.test.ts`). Each of the 12 starter component files gained `"label": "<component>1"` on its root instance and nothing else, regenerated one at a time, `--only Antialias` and so on. Gates: `component-sync.test.ts`, `only-flag.test.ts`, `component-port-names.test.ts`, `instance-names.test.ts`.
1. `build-rename-map.ts --check`, then `check-rename-equivalence.ts`. Both must be green on the tree as it is that day; the map is rebuilt from the bytes, so a document another session changed since is picked up, or refused.
2. **One batch at a time**: `apply-rename.ts --only <batch> --write`. A batch is widened to every scope that shares a source file, and says so. Then `--only <batch> --build-in <dir>` until every document of the batch is byte for byte the renamed one, finishing by hand what `--notes` lists. Then regenerate, one `--only E<n>` at a time, reading the list each run prints.

   | Batch | `--only` | Documents |
   | --- | --- | --- |
   | A | `components/` | the 12 starter components, their graphs, and E1, E5, E6, which are built from the same sources |
   | B | each of `E2` … `E70`, `E80` … `E82` | one example each; the tool widens where a source is shared |
   | C | `E71` | E71 to E74 (hand work: one helper, three transports) |
   | D | `E75` | E75 to E78 (hand work: the family's loops and the occluder pass) |
   | E | `E79` | E79 (hand work: the swarm loop) |
   | F | `furnace`, `on-nothing` | documents in place; sources by hand, against a build |

3. **After each batch, by name:** `src/examples/sync.test.ts`, `component-sync.test.ts`, `doc-drift.test.ts`, `doc-claims.test.ts`, `readme.test.ts`, `reference-integrity.test.ts`, `channel-integrity.test.ts`, `layout.test.ts`, `only-flag.test.ts`, `node-names.test.ts` (lower or remove the batch's ledger lines), and the test files the batch's dry run lists under `test` (`--files`). `pnpm typecheck` always.
4. **No GPU suite per batch.** The equivalence check is what stands in for it: the documents compile to the same plan. At the end, the lead's choice of a GPU sample, and the thumbnails, which carry no names and must not change by a pixel.
5. The ledger is empty. Keep the gate and the empty map. Delete `src/examples/rename/` and the two map files, or keep them one release as the record; they describe a tree that no longer exists.

### 10.6 What 2b did

Step 0 and batches A to F, each its own commit, in the order of 10.5. Every shipped document carries `kind_role` names, the sources that build them say the same names, and the ledger is empty.

**What held.** For every batch, before a byte was written: the equivalence check over all 111 documents, and `--build-in`, which builds the batch from its rewritten sources and compares with the map applied in memory. After it: the gates of 10.5 step 3 by name, and the GPU claims files of what the batch rewrote or hand-edited, one worker.

**What the application found, beyond what 2a had:**

- **A gate that assumed the old habit.** `doc-drift.test.ts` took a token for a node's name when it ended in a digit. Under the rule most names do not, so one check went red on E13 and another would have passed by reading nothing. It asks `nameShaped` now: letters and digits, or `kind_role` with a real kind.
- **Shader comments name nodes.** A point kernel's comment that says which node feeds it is part of the shader text, so the frame-zero digests of E27, E31, E32, E33, E34 and E54 moved with the names and were re-stamped. The equivalence check reports this as "the same but for prose", which is what it is.
- **An id is never a name.** The tool once rewrote a fixture's ids because the same word was a name in another scope, and half-renamed private fixtures in three engine tests because a comment mentioned an example. It now refuses an id by position, and takes a test file only when the test loads the document. Private fixtures are not shipped names and were left alone.
- **Names a test computes are found by running it.** A regular expression over two names in `orrery-detail.gpu.test.ts`, `id + "1"` in E24's test, three assertions in `set-list-claims.gpu.test.ts` (a cue's bank, a Layer's picture, a Panel's members): no rewrite of literals reaches these. Each failed when run and was fixed by hand.
- **Diagrams.** A fenced diagram in a page is laid out around its names, and a longer name pushes a joint off its line. The page rewrite re-lays each drawing: joints stay under the word they point at.
- **A test that passed on a dead feed, and one that was red where nobody looked.** Both found at the very end, not in their batch. `relay-circuit.test.ts` fed E64's meter by its name, `meter1`. After the rename the probe fell to its Fallback, 0.25 went round the UDP loop instead of the number the test chose, and every assertion still held, because none of them said which number had left. It asserts that now. `technical-examples.test.ts` asserted two Output names of E71 and E72 and was red on the gate script from batch C on: the batches ran ten gates by name, not the script, and the tool takes a test only when it names its example's file, which this one does not (it finds it by number). **The whole gate script is 30 s; a sweep should run it after every batch.** After that, every test that reaches a shipped document and that the sweep had not changed was read for old names: 132 files, the end-to-end specs that open an example among them (they address nodes by `data-id`), and the 43 GPU files of that kind. Nothing else.

**Projects had an oracle after all.** 10.4 said nothing checks a project's JSON against its source. Something can: the build is a pure function of facts read from a GLB, and the GLBs are in the main checkout. Built in memory from there, read-only, 23 of the 25 project documents were byte for byte the shipped ones before any rename (the other two, `sleep-like-a-baby` and `-2`, are saved by hand and have no source). So the documents were renamed in place by the map through the serialiser, the sources were edited, and the build of the edited sources had to be those renamed bytes again.

- **furnace**: 101 names. The director's 31 lanes were named `${id}1` by one helper; they are written out in one table now.
- **on-nothing**: 1,331 names in 24 documents; 255 of them built by code in some sixty places. Three small things carry most of it: `names.ts` (an area's mesh and geometry, a light), the title graph's `Chain.add` (a node is named for its kind and its id unless told otherwise), and `Plate.prefixed`, which now keeps a name's kind and puts the prefix on its role.
- **The shots nobody ships.** The 22 shipped documents are one take of each shot; the sources hold 160 different graphs (every take, and each shot with the CRT pass, without the song, without the HDRI). Each was built from the sources as they were and as they are and put through the equivalence check: 160 of 160 the same graph but for names, every one of 10,104 names carrying its kind. 93 names appear in no shipped document; they follow the same rules. One branch (`take.second` in `shots/wide.ts`) is reached by no take and was edited by reading.

**Where a document is not the map's.** One document, 19 names. The split screen is two plates under a prefix. The old helper glued the prefix to the old name (`car` + `geocar01`), and the map, reading the result, kept the `geo` in the middle: `geometry_cargeocar0`, `geometry_cargeowh`. The source cannot build that without remembering a name that no longer exists; it builds the prefix on the plate's own name: `geometry_carcar0`, `geometry_carwarehouse`. `split.loom.json` is what the source builds, and it is the map's document with those 19 names moved once more by the product's own rename, byte for byte.

**Left as the map has them, and worth a look.** `light_key1` and `light_fill1`. The key light was `key1` (the id `key` and the habit's `1`), and the map read it as one of a numbered run because the white limbo has six keys `key0` … `key5` whose old names were `key01` … `key51`. The same for `fill1` beside `fill281`. So the one key light of the pendant is `light_key1`. `lightName` in `names.ts` says so in one place; changing two names there and renaming them in the documents would make them `light_key` and `light_fill`.

## 11. Open questions

Ruled on 2026-10-05 and no longer open: the map is approved and applied (the hand line for judgements stands, the authors' three-letter abbreviations stay, `sample` and `texturepoints` are spelled out); project sources are renamed with their documents where a build can check them (10.6); Kaleidoscope's outward references move with the map, and the component owning its LFOs is its own row (T1605b); sentinel-bot names its own nodes and is off the ledger; collisions stay refused; the cross-payload families and `material` stay shared; a component instance is named for its component and is auto-named; In and Out stay exempt; surfaces caption by the role, a Layer's picture and a stack's title stay whole; starter component versions do not bump at the sweep; `apply_graph_patch` warns; save as component names its instance at the sweep's first step; a long name at rest gives up its kind first (built); 15 % zoom at three to five letters is accepted for now; a held `add_node` shows the name it will store (built).

Still open:

1. **The split screen's 19 names** (10.6) are the source's, not the map's. Accept, or name them otherwise.
2. **`light_key1` and `light_fill1`** (10.6): keep the map's reading, or drop the `1`.
3. **The sweep's tooling** (`src/examples/rename/`, the two map files): delete, or keep one release as the record. It describes a tree that no longer exists; the gate and the empty ledger are what stay.
4. **The three thresholds** (70 %, 45 %, 9 %) come from measurements on one example in a headless browser. They want the owner's eye in the running app, over real previews.
5. **A component whose name has no Latin letter** makes instances of kind `component`. Acceptable, or should a kind take letters of any script, as a role does?
6. **A family's variant** (`material_floor` on a PBR) is no longer on the canvas chip. Show the chip when a kind is shared and the titles differ?
7. **A node's status at overview zoom** (8.2). Below 57 % the label's plate lies over the status hairline along the label's width, and at 15 % the hairline is 0.15 px whatever is on it. Should the label carry the status, for example an erroring node's kind in the error colour, so a failing node can be found without zooming in?
8. **The room after an elided kind's dots** (8.3): `tran… _the_quic…` on a name too long for the header. A fade in place of the dots would close it; the ruling chose dots.

## 12. TouchDesigner: what was checked and what was not

Read from Derivative's documentation:

- The [OP class](https://docs.derivative.ca/OP_Class) gives an operator a `name` ("Get or set the operator name"), a read-only `base` ("the beginning portion of the name occurring before any digits") and read-only `digits` ("the numeric value of the last consecutive group of digits in the name"). TouchDesigner itself models a name as a base plus digits, which is our `kind<digits>` form.
- Derivative hosts a community tutorial, [Naming Things in TouchDesigner](https://derivative.ca/community-post/tutorial/naming-things-touchdesigner/71482), whose summary is the problem this row is about: "Ever looked at an old project and tried to figure out wtf `op('../base4/null1['chan1']` means?" The tutorial is a video; I could read only its summary.

**Not read from a page**, and stated here from common practice and the owner's own description: that a new operator is named type plus number (`noise1`); that names are limited to letters, digits and underscores; the `null_out` / `constant_color` habit; and the default names used as a guide in section 9 (`glsl`, `glslmulti`, `geo`, `phong`, `pbr`, `topto`, `hsvadj`). The OP class page does not state the allowed characters. Treat these as recollection until someone checks them in the application.

## 13. The table

Generated from `NODE_KINDS`. The code is the source; this is a snapshot of 2026-10-05. "Before" is what a new node of that type was auto-named until now.

| Type | Library title | Kind | A new node | Before | Note |
| --- | --- | --- | --- | --- | --- |
| **generator** | | | | | |
| `solid` | Solid | `solid` | `solid1` | same |  |
| `noise` | Noise | `noise` | `noise1` | same |  |
| `ramp` | Ramp | `ramp` | `ramp1` | same |  |
| `uv` | UV | `uv` | `uv1` | same |  |
| `checker` | Checker | `checker` | `checker1` | same |  |
| `circle` | Circle | `circle` | `circle1` | same | family |
| `rectangle` | Rectangle | `rectangle` | `rectangle1` | same |  |
| `matte` | Matte | `matte` | `matte1` | same |  |
| `personMask` | Person Mask | `personmask` | `personmask1` | same |  |
| `text` | Text | `text` | `text1` | same |  |
| **shader** | | | | | |
| `customWgsl` | Custom WGSL | `wgsl` | `wgsl1` | `customwgsl1` | family |
| `customWgslMulti` | Custom WGSL · Multi | `wgsl` | `wgsl1` | `customwgslmulti1` | family |
| **output** | | | | | |
| `output` | Output | `output` | `output1` | same |  |
| `syphonOut` | Syphon Out | `syphonout` | `syphonout1` | same |  |
| `window` | Window Out | `window` | `window1` | same |  |
| `ndiOut` | NDI Out | `ndiout` | `ndiout1` | same |  |
| `whipOut` | WHIP Out | `whipout` | `whipout1` | same | T1809b |
| `spoutOut` | Spout Out | `spoutout` | `spoutout1` | same |  |
| `oscOut` | OSC Out | `oscout` | `oscout1` | same |  |
| `laserOut` | Laser Out | `laserout` | `laserout1` | same |  |
| **filter** | | | | | |
| `transform` | Transform | `transform` | `transform1` | same | family |
| `flip` | Flip | `flip` | `flip1` | same |  |
| `mirror` | Mirror | `mirror` | `mirror1` | same |  |
| `crop` | Crop | `crop` | `crop1` | same |  |
| `tile` | Tile | `tile` | `tile1` | same |  |
| `cornerPin` | Corner Pin | `cornerpin` | `cornerpin1` | same |  |
| `gridWarp` | Grid Warp | `gridwarp` | `gridwarp1` | same |  |
| `blur` | Blur | `blur` | `blur1` | same |  |
| `edge` | Edge | `edge` | `edge1` | same |  |
| `convolve` | Convolve | `convolve` | `convolve1` | same |  |
| `displace` | Displace | `displace` | `displace1` | same |  |
| `remap` | Remap | `remap` | `remap1` | same |  |
| `slope` | Slope | `slope` | `slope1` | same | family |
| `streak` | Streak | `streak` | `streak1` | same |  |
| `halo` | Halo | `halo` | `halo1` | same |  |
| `lens` | Lens | `lens` | `lens1` | same |  |
| `flare` | On-Axis Flare | `flare` | `flare1` | same |  |
| `crt` | CRT | `crt` | `crt1` | same |  |
| `crtTube` | CRT Tube | `crttube` | `crttube1` | same |  |
| `cameraBlur` | Camera Blur | `camerablur` | `camerablur1` | same |  |
| `depth` | Depth | `depth` | `depth1` | same |  |
| `pose` | Pose | `pose` | `pose1` | same |  |
| **color** | | | | | |
| `level` | Level | `level` | `level1` | same |  |
| `hsv` | HSV | `hsv` | `hsv1` | same |  |
| `threshold` | Threshold | `threshold` | `threshold1` | same |  |
| `limit` | Limit | `limit` | `limit1` | same | family |
| `lookup` | Lookup | `lookup` | `lookup1` | same |  |
| `reorder` | Reorder | `reorder` | `reorder1` | same |  |
| `premultiply` | Premultiply | `premultiply` | `premultiply1` | same |  |
| `filmGrade` | Film Grade | `filmgrade` | `filmgrade1` | same |  |
| **composite** | | | | | |
| `composite` | Composite | `composite` | `composite1` | same |  |
| `cross` | Cross | `cross` | `cross1` | same |  |
| `over` | Over | `over` | `over1` | same |  |
| `add` | Add | `add` | `add1` | same |  |
| `multiply` | Multiply | `multiply` | `multiply1` | same |  |
| `screen` | Screen | `screen` | `screen1` | same |  |
| `difference` | Difference | `difference` | `difference1` | same |  |
| `mask` | Mask | `mask` | `mask1` | same |  |
| `layer` | Layer | `layer` | `layer1` | same |  |
| **temporal** | | | | | |
| `feedback` | Feedback | `feedback` | `feedback1` | same |  |
| `cache` | Cache | `cache` | `cache1` | same |  |
| `echo` | Echo | `echo` | `echo1` | same |  |
| `slitScan` | Slit Scan | `slitscan` | `slitscan1` | same |  |
| **points** | | | | | |
| `pointKernel` | Point Kernel | `kernel` | `kernel1` | `pointkernel1` | family |
| `pointRay` | Ray | `ray` | `ray1` | `pointray1` |  |
| `textureToAttribute` | Texture To Attribute | `sample` | `sample1` | `texturetoattribute1` |  |
| `renderPoints` | Render Points | `points` | `points1` | `renderpoints1` |  |
| `pointGenerator` | Point Generator | `generator` | `generator1` | `pointgenerator1` |  |
| `pointGrid` | Grid Points | `grid` | `grid1` | `pointgrid1` |  |
| `pointLine` | Line Points | `line` | `line1` | `pointline1` |  |
| `pointCircle` | Circle Points | `circle` | `circle1` | `pointcircle1` | family |
| `pointSphere` | Sphere Points | `sphere` | `sphere1` | `pointsphere1` |  |
| `pointTube` | Tube Points | `tube` | `tube1` | `pointtube1` |  |
| `pointTorus` | Torus Points | `torus` | `torus1` | `pointtorus1` |  |
| `pointBox` | Box Points | `box` | `box1` | `pointbox1` |  |
| `pointsFromTexture` | Points From Texture | `texturepoints` | `texturepoints1` | `pointsfromtexture1` |  |
| `renderInstances` | Render Instances | `instances` | `instances1` | `renderinstances1` |  |
| `renderSurface` | Render Surface | `surface` | `surface1` | `rendersurface1` |  |
| `pointTopology` | Topology | `topology` | `topology1` | `pointtopology1` |  |
| `meshFileIn` | Mesh File In | `mesh` | `mesh1` | `meshfilein1` |  |
| `pointGather` | Gather | `gather` | `gather1` | `pointgather1` |  |
| `pointProximity` | Proximity | `proximity` | `proximity1` | `pointproximity1` |  |
| `pointRange` | Range | `range` | `range1` | `pointrange1` | family |
| `pointTransform` | Transform | `transform` | `transform1` | `pointtransform1` | family |
| `laserPath` | Laser Path | `laserpath` | `laserpath1` | same |  |
| `pointKernelAdvanced` | Point Kernel (Advanced) | `kernel` | `kernel1` | `pointkerneladvanced1` | family |
| **utility** | | | | | |
| `null` | Null | `null` | `null1` | same |  |
| `switch` | Switch | `switch` | `switch1` | same | family |
| `annotate` | Annotation | `note` | `note1` | `annotate1` |  |
| **component** | | | | | |
| `componentIn` | In | `in` | `in1` | `componentin1` | family, socket-named |
| `componentOut` | Out | `out` | `out1` | `componentout1` | family, socket-named |
| `componentInPoints` | In (points) | `in` | `in1` | `componentinpoints1` | family, socket-named |
| `componentOutPoints` | Out (points) | `out` | `out1` | `componentoutpoints1` | family, socket-named |
| `componentInValue` | In (value) | `in` | `in1` | `componentinvalue1` | family, socket-named |
| `componentOutValue` | Out (value) | `out` | `out1` | `componentoutvalue1` | family, socket-named |
| **value** | | | | | |
| `lfo` | LFO | `lfo` | `lfo1` | same |  |
| `constant` | Constant | `constant` | `constant1` | same |  |
| `timer` | Timer | `timer` | `timer1` | same |  |
| `analyze` | Analyze | `analyze` | `analyze1` | same |  |
| `mouse` | Mouse | `mouse` | `mouse1` | same |  |
| `channelIn` | Channel In | `channelin` | `channelin1` | same |  |
| `valueMath` | Math | `math` | `math1` | `valuemath1` |  |
| `valueLimit` | Limit | `limit` | `limit1` | `valuelimit1` | family |
| `valueSelect` | Select | `select` | `select1` | `valueselect1` |  |
| `valueSlope` | Slope | `slope` | `slope1` | `valueslope1` | family |
| `valueTrigger` | Trigger | `trigger` | `trigger1` | `valuetrigger1` |  |
| `valueLag` | Lag | `lag` | `lag1` | `valuelag1` |  |
| `valueFilter` | Filter | `filter` | `filter1` | `valuefilter1` |  |
| `valueSwitch` | Switch | `switch` | `switch1` | `valueswitch1` | family |
| `valueStep` | Step | `step` | `step1` | `valuestep1` |  |
| `valueNormalize` | Normalize | `normalize` | `normalize1` | `valuenormalize1` |  |
| `valueSpeed` | Speed | `speed` | `speed1` | `valuespeed1` |  |
| `valueRange` | Range | `range` | `range1` | `valuerange1` | family |
| `valueTail` | Tail | `tail` | `tail1` | `valuetail1` |  |
| `valueBeat` | Beat | `beat` | `beat1` | `valuebeat1` |  |
| `valueTrend` | Trend | `trend` | `trend1` | `valuetrend1` |  |
| `valueRate` | Rate | `rate` | `rate1` | `valuerate1` |  |
| `valueNovelty` | Novelty | `novelty` | `novelty1` | `valuenovelty1` |  |
| `valueCount` | Count | `count` | `count1` | `valuecount1` |  |
| `valueDelay` | Delay | `delay` | `delay1` | `valuedelay1` |  |
| `valueExpression` | Expression | `expression` | `expression1` | `valueexpression1` |  |
| `slider` | Slider | `slider` | `slider1` | same |  |
| `toggle` | Toggle | `toggle` | `toggle1` | same |  |
| `button` | Button | `button` | `button1` | same |  |
| `xyPad` | XY Pad | `xypad` | `xypad1` | same |  |
| `panel` | Panel | `panel` | `panel1` | same |  |
| `presets` | Presets | `presets` | `presets1` | same |  |
| `cueList` | Cue List | `cuelist` | `cuelist1` | same |  |
| `audioPattern` | Audio Pattern | `pattern` | `pattern1` | `audiopattern1` |  |
| **input** | | | | | |
| `movieFileIn` | Movie File In | `movie` | `movie1` | `moviefilein1` |  |
| `webcam` | Webcam | `webcam` | `webcam1` | same |  |
| `screenIn` | Screen In | `screenin` | `screenin1` | same |  |
| `syphonIn` | Syphon In | `syphonin` | `syphonin1` | same |  |
| `ndiIn` | NDI In | `ndiin` | `ndiin1` | same |  |
| `spoutIn` | Spout In | `spoutin` | `spoutin1` | same |  |
| `audioIn` | Audio In | `audioin` | `audioin1` | same |  |
| `audioFileIn` | Audio File In | `audiofile` | `audiofile1` | `audiofilein1` |  |
| `midiIn` | MIDI In | `midiin` | `midiin1` | same |  |
| `oscIn` | OSC In | `oscin` | `oscin1` | same |  |
| **render** | | | | | |
| `camera` | Camera | `camera` | `camera1` | same |  |
| `light` | Light | `light` | `light1` | same |  |
| `projector` | Projector | `projector` | `projector1` | same |  |
| `geometry` | Geometry | `geometry` | `geometry1` | same |  |
| `render` | Render | `render` | `render1` | same |  |
| `materialUnlit` | Material · Unlit | `material` | `material1` | `materialunlit1` | family |
| `materialPhong` | Material · Phong | `material` | `material1` | `materialphong1` | family |
| `materialPbr` | Material · PBR | `material` | `material1` | `materialpbr1` | family |
| `materialGlass` | Material · Glass | `material` | `material1` | `materialglass1` | family |
| `materialWgsl` | Material · WGSL | `material` | `material1` | `materialwgsl1` | family |
