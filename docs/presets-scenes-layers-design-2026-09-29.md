# Presets, looks and layers: the design, with the owner's rulings

Row: §T1398b. First written 2026-09-29 (`e56e63aa`). The owner ruled on all fifteen questions the same day. This revision folds the rulings in. §13 records each ruling, and §12 is the build plan in row-sized slices. File:line citations are against the tree this revision was written on (main at `f9f451ff`, which includes the phone door `be146d5d` and component files `5a438a8f`). Nothing here is built yet.

**Corrected 2026-10-03 against the landed build** (§T1496b–§T1504b): the fold's chain rules in §5.3 (epoch, contiguous tail, a finished record ends older ones, structural keys cut), a shot writing each nested bank's `current` (§4.4, §8.1), the nesting limit counted in `recalls` hops, the agent tool `set_cue_standby` (§10), and a MIDI trigger that MIDI In can actually publish (§8.2). The rulings in §13 are recorded as given.

What the rulings changed from the first draft:
- **Morph is in v1.** It runs on the **timeline clock**, so it pauses with the transport and renders the same way every time (§5).
- The performance role is called a **look**. "Scene" stays reserved for the 3D scene (§6).
- There is a **cue list**, as a node of its own (§8.2).
- The phone door gets an **exact contract extension** (§9.2).
- The layer stack's mapping slot is **Corner Pin** (§7.4).

---

## 1. The problem, in your words

> "a preset system in addition with a layering system so that we can actually build scenes with presets and shots and layers … mix and match … input, projection mapping, colorization, glitching FX layers … not always bespoke to the scene, and then the actual scene itself or multiples" (owner, 2026-09-27)

In this design's words (your "scene" is a **look** here, by ruling 7):

1. **Presets.** Save the values of a set of parameters under a name, and bring them back in one move: one undo step and one audit entry, with the change either cut or morphed.
2. **Looks.** A self-contained picture-maker with its own presets. You can have several.
3. **Layers.** A stack running input → look(s) → FX (colourise, glitch) → mapping → output. Each layer can be switched on and off and faded, and an FX layer is not tied to one look.
4. **Shots and a cue list.** A shot is a named moment that sets several of the above at once. A cue list plays shots and presets in order, with GO.
5. **Recall from the stage:** Panel buttons, the phone, MIDI, the keyboard, a beat.

## 2. What exists today

### 2.1 The document and how it persists

- `ProjectDocument` holds `graph`, `settings` and `assets` (`src/domain/types/graph.ts:399-408`). `GraphDocument` holds nodes, edges, groups and viewport (`graph.ts:207-214`). Component definitions sit beside the graph under `componentLibrary` (`src/domain/project/project-file.ts:33`).
- `SCHEMA_VERSION = 5` (`src/domain/types/schemas.ts:12`), reached by four document migrations (`src/domain/migrations/document-migrations.ts:51, 86, 162, 341`). Nodes also migrate individually by `definitionVersion` (`src/domain/migrations/node-migrations.ts:7-20`). A node type this build does not know loads as a placeholder that keeps its data (`src/domain/project/forward-compat.ts:36-37`).
- `ui.bypassed` and `ui.muted` are document state (`graph.ts:145-146`). `GraphNode.state` is an open record (`schemas.ts:162-166`), but **no patch operation writes it and copy/paste drops it**: paste restores ui, resolution and format and nothing else (`src/domain/commands/editor-commands.ts:262-285`).

### 2.2 The bus, patches, undo, audit, actors

- Every change goes through `AppCommandBus.execute`. A handler's `context.apply(recipe)` produces one revision, one undo group and one audit entry together (`src/domain/commands/bus.ts:137-144`). `splitUndo` forces a fresh undo group (`bus.ts:63`). The context also carries runtime readers the app attaches, such as the channel resolver (`bus.ts:107-135`).
- A `GraphPatch` applies all its operations or none (`src/domain/types/patch.ts:104-127`). `setParameters` and `setNodeUi` are operations in it (`patch.ts:57, 69`).
- Undo is per actor (`src/domain/graph/store.ts:97, 102`). An undo group holds before/after per entity (`store.ts:54-74`). An undo is refused on an entity another actor changed since (`store.ts:531`). The audit ring holds 512 entries (`store.ts:37`).
- `Actor.kind` is `"human" | "agent" | "system"` (`src/domain/types/commands.ts:6-10`). Graph edits need no capability grant (`commands.ts:12-13`, §V38).

### 2.3 Components

- A component instance stores its published values in its own `node.parameters` (`src/domain/components/instance.ts:10-19`), so writing an instance's page is one `setParameters`.
- Definition edits go to the component registry, not to the document store. They get no revision and no undo (`src/domain/components/commands.ts:400-410`).
- A muted or bypassed instance is not inlined, so its interior costs nothing (`src/compiler/flatten.ts:663-681`).
- **§T1395b has landed (`5a438a8f`):** components export to a file and import by drop, with an identity rule (`src/domain/components/component-file.ts`, `file-commands.ts`).

### 2.4 Panels, widgets, pulses

- Widget nodes publish a hand-set value as a channel (`src/nodes/definitions/controls.ts:42-135`). A `panel` node lays them out by name (`controls.ts:147-180`), and its `remote` switch publishes it to the phone (`controls.ts:178-186`). The controls pane draws a Panel by looking up widget names (`src/editor/controls/controls-pane.tsx:100-109`) and writes through the parameter editor, one undo group per gesture (`controls-pane.tsx:96`).
- A **pulse** parameter fires a named bus command (`src/domain/types/parameters.ts:242-247`). An expression that turns non-zero fires it on the rising edge (`src/app/pulse-firing.ts:10-28, 73`). The watcher runs in the live app's frame loop (`src/app/use-frame-loop.ts:151-158, 565-569`).

### 2.5 Switching and mixing

- The texture `switch` **binds and cooks every source** whatever its index (`src/nodes/definitions/switch.ts:188-191`, §T1014).
- `cross` dissolves between two inputs (`src/nodes/definitions/composite.ts:265`).
- The composite family puts `in1` in front, and its single `opacity` scales only the front (`composite.ts:145-153`). With `in1` missing it emits nothing (`composite.ts:160-164`).
- `valueSwitch` (`src/nodes/definitions/value-graph-nodes.ts:623`) and `valueSelect` (`value-graph-nodes.ts:1196`) switch and filter channel bags.
- **Corner Pin** (§T1491b, being built now) is the 2D mapping node: a perspective homography, pin and extract quads, and corner handles in the viewer.

### 2.6 Bypass, mute, cost

- Bypass wires a node's first kind-matching input to its first output (`src/domain/graph/bypass.ts:25-34`). Mute removes the node and its edges (`src/compiler/compile.ts:657-700`).
- Only what an active sink reaches is compiled (`src/compiler/prune.ts:10-16`). Bypass and mute recompile the region downstream (`src/compiler/recompile.ts:112-121`).
- A **driven structural parameter is refused at runtime** (`switch.ts:181-183`), so on/off cannot follow an expression.

### 2.7 Parameters and clocks

- A stored parameter is a bare value or a slot holding a mode and every mode's last payload (`parameters.ts:384-395`).
- `resolveParameters` is the one read path (`src/domain/parameters/resolve.ts:30-60`). It has a per-node **driver seam that outranks the stored slot** (`resolve.ts:153-155`).
- The frame loop decides "this document animates" from slot modes (`src/domain/channels/graph-channels.ts:108-136`). The values-only recompile decides which keys animate the same way (`src/compiler/frame-compile.ts:108-118`).
- A frame carries three clocks (`src/domain/types/frame.ts:11-72`):
  - **timeline** (`frameIndex` / `timeSeconds`): wraps at a lap, jumps on a seek;
  - **wall** (`wallSeconds`);
  - **absolute** (`absFrameIndex` / `absTimeSeconds`): a count of the frames the transport has produced, at the timeline's rate. It advances only when frames are produced, runs through laps and seeks untouched (`src/domain/transport/live-clock.ts:150-164, 243-253, 302-306`), and is **zeroed by a render** (`live-clock.ts:287-300`, `src/app/render-range.ts:205-213`).

  A frame also says whether it is `realtime` or `offline` (`frame.ts:34`).
- Precedent for editable table data kept as document state: the MIDI mapping is a `code`/`json` parameter, *"so a learn is an ordinary parameter edit, and undo, autosave, the agent surface and the diff all work on it"* (`src/nodes/definitions/midi.ts:89-110`).
- Names are the reference currency (§V129). A rename rewrites references through one clause list (`src/domain/graph/names.ts:210-214`), and paste reuses it (`editor-commands.ts:193-233`).

### 2.8 Window Out and the phone door

- Window Out takes its picture by wire or by name (`src/domain/graph/source-references.ts:54`) and states the house rule: *everything is a node* (`src/nodes/definitions/window-out.ts:19-21`).
- **The phone door has landed** (§T1396b; page half `be146d5d`).
  - The contract is `src/devices/phone/phone-protocol.ts`: `PhoneWidget` has four kinds (`:46-67`), `PHONE_WRITABLE_KEYS` (`:89-94`), and `PhoneSet` values are `number | boolean` (`:101-106`).
  - The snapshot and the vetting of each write both read one list of published widgets (`src/devices/phone/phone-snapshot.ts:160, 206, 244`). A driven widget is left out.
  - Writes go through a parameter editor whose actor is `{kind: "human", id: "remote-<phone>"}` (`src/app/phone-writes.ts:64-67, 104`).

---

## 3. The model on one page

```
   camera ──────────────┐
   (input)              ▼
                   [layer1] picture = "city"     blend over     opacity 1
                        ▼
                   [layer2] picture = "smoke"    blend screen   opacity 0.4    (bypassed = off, costs 0)
                        ▼
      ┌──── glitch1 ◄───┤
      └──────────► [layer3] picture = "glitch1"  blend replace  opacity 0.7    (wet/dry)
                        ▼
                   colorize1   (bypass = off)
                        ▼
                   cornerPin1  (§T1491b: the mapping slot)
                        ▼
                   Window Out

   [presets "cityLooks"]  targets: city                    presets: dawn, noon, riot
   [presets "fx"]         targets: glitch1 colorize1       presets: clean, dirty
   [presets "shots"]      targets: layer1 layer2 layer3    presets: intro, drop   (each can recall cityLooks / fx presets)
   [cueList "set"]        cues: 1 intro (4 s) · 2 drop (0.5 s) · 3 cityLooks/noon (8 s) …   GO · BACK
   [panel "perform"]      names the banks, layers and cue list → buttons, toggles, faders, GO; Phone switch on
```

- A **preset** is an entry in a **Presets node** (bank). Recall is one patch: one revision, one undo step, one audit entry. It can **morph**. The target parameters take their end values immediately, and the screen blends toward them on the timeline clock.
- A **look** is a role, usually a component instance, whose presets live in a bank that targets its published page.
- A **layer** is a new `layer` node. Its first input is the stack below it, the picture comes by wire or name, and it has opacity and blend. **Off is bypass**, which costs nothing. Opacity is the fade that can follow an expression.
- A **shot** is a preset that sets layers and can recall other banks' presets in the same patch.
- A **cue list** is a node holding an ordered list of preset or shot recalls with morph times. GO fires the standby cue.
- **Panels** and the **phone** show banks, layers and cue lists as controls.

Nothing is added at the document root.

---

## 4. Presets

### 4.1 Data shape

A bank is a node of the new type `presets`:

| key | type | meaning |
|---|---|---|
| `targets` | string list | What Store captures: `glow` (every parameter of that node) or `glow.radius` (one key). Spaces or commas, like Render's `scenes` (`source-references.ts:41`). |
| `presets` | `code` / `json` | The bank (format below), editable by hand like the MIDI mapping. |
| `select` | string, drivable | The preset the `recall` pulse recalls. |
| `recall` | pulse → `preset.recall { nodeId: "$node" }` | Fires on a beat, a MIDI note or a Button widget when driven by an expression. |
| `morph` | number, seconds, default 0 | The bank's default morph time. 0 means cut. |
| `curve` | enum `linear` · `smooth` · `in` · `out`, default `smooth` | The bank's default morph curve. |
| `current` | string, written by recall | The last preset recalled. Panels and the phone highlight it. |
| `morphs` | `code` / `json`, written by recall | The morphs in flight on this bank (§5.2). Visible and inspectable, but not meant for typing. |

The bank's JSON (new, headless: `src/domain/presets/bank.ts`):

```ts
import type { StoredParameter } from "../types/parameters.ts";

export type MorphCurve = "linear" | "smooth" | "in" | "out";

/** How a change is carried out over time. seconds 0 = a cut. Timeline seconds (ruling 6). */
export interface MorphSpec {
  readonly seconds: number;
  readonly curve: MorphCurve;
}

export interface PresetBank {
  readonly version: 1;
  /** Button order on a Panel and on the phone. */
  readonly presets: readonly Preset[];
}

export interface Preset {
  /** Unique in the bank; an identifier, so expressions, cues and Panels can spell it. */
  readonly name: string;
  /** node NAME → key → the STORED form (bare value or whole slot), written back verbatim (ruling 2). */
  readonly values: Readonly<Record<string, Readonly<Record<string, StoredParameter>>>>;
  /** node NAME → layer on/off (§7). Written as ui.bypassed = !on. Always a cut. */
  readonly on?: Readonly<Record<string, boolean>>;
  /** Shots (§8.1): other banks' presets in the same patch; cycle-checked, at most 4 hops, own values win (ruling 14). */
  readonly recalls?: ReadonlyArray<{ readonly bank: string; readonly preset: string }>;
  /** This preset's own morph. Absent means the bank's `morph` / `curve`. */
  readonly morph?: MorphSpec;
}
```

**Targets are named by node name, not id.** Names survive paste into another document, and one new entry in the rename clause list (`names.ts:210`) keeps renames and paste renumbering correct. That entry covers:
- the bank's `targets`, `select` and `current`;
- every node-name key in `values`, `on` and the `morphs` records;
- `recalls[].bank`;
- the cue list's cue `bank` fields (§8.2).

### 4.2 Why a node (ruling 1)

The bank is a node, and its data lives in its **parameters**:
- Undo, audit, autosave, copy/paste, save-as-component, component export and the agent's `get_graph` all work with no new plumbing (the MIDI argument, `midi.ts:89-100`).
- It matches Panel, widgets and Window Out.
- An FX chain, a look and the shots each carry their own bank.
- `node.state` would not survive paste and cannot be patched (§2.1).

### 4.3 Store

`preset.store { nodeId, name }`:

1. Resolve `targets`. Take every parameter of each target except pulses, or just the named `node.key` (ruling 3). A component instance's "every parameter" is its published page (`instance.ts:14-15`).
2. Copy each value **as stored**: a slot stays a slot (ruling 2). A parameter with nothing stored is written as its default, so that a recall *resets* it.
3. Write the new JSON with one `setParameters` on the bank. That is one undo step.

The output names every target it could not find.

### 4.4 Recall

`preset.recall { nodeId, name?, morph?: MorphSpec }`. Without `name` it recalls the bank's resolved `select`.

1. Parse the bank. Malformed JSON is refused with a diagnostic that names the bank.
2. Expand `recalls` depth-first. Cycles are refused by name, and so is a chain of more than 4 `recalls` hops (the recalled preset is depth 0, so a shot may reach four banks down; a fifth hop is refused, `MAX_RECALL_DEPTH`). The preset's own values win (ruling 14).
3. Resolve names in the current graph and check each key against the node's effective schema and the manifest (§V66). **Anything missing or invalid is skipped with a warning that names it. The recall is refused only when nothing is left to apply** (ruling 4).
4. Work out the morph (§5.1). If it is non-zero, build one morph record for this recall (§5.2).
5. Build **one** `GraphPatch`:
   - `setParameters` on each target with its end value;
   - `setNodeUi { bypassed }` for each layer in `on`;
   - `setParameters` on the bank with `current` and, when morphing, the updated `morphs`;
   - `setParameters { current }` on every NESTED bank a shot actually wrote something from (and `morphs` on any bank whose records lost keys), so a Panel beside a look's bank highlights the preset the shot just recalled there. A bank reached twice shows the later preset.
6. Apply it with `splitUndo: true` (`bus.ts:63`). The result is one revision, one undo group (`Recall "riot" (cityLooks)`) and one audit entry `preset.recall` carrying the invoking actor.

**Undo** brings back every target, the bank's `current` and its morph records in one step (`store.ts:54-74`). The screen jumps back; it does not fade in reverse. Undo belongs to the actor who recalled (`store.ts:97`), so a phone's recall stays on that phone's history.

**Cost:** one commit, meaning one validation and one compile, however many targets there are. A structural key recompiles its region and cuts (§5.3).

### 4.5 Triggers

| from | how | audited as |
|---|---|---|
| inspector | the bank section's Store, Recall and Delete buttons | the local human |
| Panel | a bank named in the layout → preset buttons (§9.1) | the local human |
| expression, MIDI, OSC, beat | `select` + `recall` pulse (`pulse-firing.ts:73`) | the pulse context (the app's actor) |
| cue list | GO / BACK / fire (§8.2) | whoever pressed GO |
| phone | a `preset` control on a remote Panel (§9.2) | `human:remote-<phone>` |
| agent | `recall_preset` (§10) | the agent |

---

## 5. Morph, on the timeline clock (rulings 5 and 6)

### 5.1 Data and precedence

The morph is a `MorphSpec` of seconds and curve. The first of these that is present wins:
1. the recall's own `morph` input;
2. the cue's `morph` (§8.2);
3. the preset's `morph`;
4. the bank's `morph` / `curve` parameters.

Seconds are **timeline seconds**, and 0 is a cut.

The curves, with `p` the progress from 0 to 1:
- `linear`: p
- `smooth`: 3p² − 2p³
- `in`: p²
- `out`: 1 − (1 − p)²

### 5.2 What commits, and what the record holds

**The end state commits at once, in the recall's single patch** (§4.4 step 5). The target parameters hold their destination values from the moment of the recall, so the inspector, Store, the phone, agents, a save and undo all see the destination. The fade exists only in what is rendered. It is described by a **record** written into the bank's `morphs` parameter in the same patch:

```ts
export interface MorphRecord {
  /** The absolute clock's epoch at recall (§5.4). A record from another epoch is finished. */
  readonly epoch: string;
  /** absTimeSeconds of the last frame before the recall. */
  readonly start: number;
  readonly seconds: number;
  readonly curve: MorphCurve;
  readonly preset: string;
  /** node NAME → key → the slot BEFORE this recall, for every key this recall changed. */
  readonly from: Readonly<Record<string, Readonly<Record<string, StoredParameter>>>>;
  /** node NAME → key → the slot this recall WROTE, used to notice a later edit (below). */
  readonly to: Readonly<Record<string, Readonly<Record<string, StoredParameter>>>>;
}
```

A bank keeps at most **four** records. Each recall drops the ones that are already finished at its `start`. If four are still running, the oldest is dropped; the keys only it covered jump to their end values, and the recall's result says so.

**The command does not read a clock.** The app attaches the transport's latest frame to the command context, the same way it attaches the channel resolver (`bus.ts:107-135`): a `frameClock: { epoch, absTimeSeconds } | undefined` reader. So every caller gets the same stamp without doing anything: Panel, phone, keymap, pulse, cue list, agent. Headless (`src/mcp/serve.ts`) there is no clock attached. A morph requested there then commits as a cut, and the result says why.

### 5.3 What renders during the fade

For each key, the value on screen is a **pure function of the document and the frame**. It is supplied through the resolver's driver seam, which outranks the stored slot (`resolve.ts:153-155`):

1. Gather the records of the clock's current **epoch**, across **every bank**, that touch this key, oldest `start` first. Only the **contiguous tail** counts: a record whose `to` is not the next record's `from` was followed by something other than a recall (a manual edit), so the chain starts after it. A **finished** record (p = 1) ends every older one on the key: the chain starts after the newest finished record, and with none left the key shows its stored value. Structural keys (`compileTime`, or read by a resolution policy) never chain; they cut.
2. If the key's current stored slot is not the newest record's `to`, someone has edited the key since. **The edit wins and no fade applies** (see interruption below).
3. Otherwise, start from the oldest remaining record's `from` slot, resolved at this frame, and fold through the records in order:
   `V = lerp(V, resolve(to_i, frame), curve_i(p_i))`, where `p_i = clamp((frame.absTimeSeconds − start_i) / seconds_i, 0, 1)`.

What that gives:
- **Both ends are evaluated live.** A slot that is an expression at either end (ruling 2 keeps the slot) keeps moving during the fade. Fading from "follows the audio" to a fixed 0.2 blends from the live audio value down to 0.2.
- **Numbers, colours and vectors blend**, colours in the linear working space the resolver already decodes to.
- **Everything else cuts at the start**, because the document already holds the end state: enums, strings, booleans, assets, source names such as a layer's `picture` (§7.3), mode switches that make an end impossible to resolve as a number, structural keys, and layer on/off.
- Inside a component, the published key hands its per-frame value to the internal parameters through the same path an animated knob uses (§T1017, `flatten.ts:690-700`).
- The value graph (widgets, channels) sees the same driver, because there is one read path (§V61, §V109; `src/domain/channels/value-graph.ts`).
- The frame loop counts a key with an unfinished record as animating. `hasAnimatedParameters` (`graph-channels.ts:108`) and `animatedRootKeys` (`frame-compile.ts:108`) learn to look at `morphs`. A document that is otherwise still redraws until the fade ends and then stops.

**Interruption by a new recall mid-morph.** The new recall writes its own record, and the fold above chains it after the one still running. The new fade starts from **what is on screen**, with no jump, and the older record simply stops mattering once the newer one reaches p = 1. This works the same when the two recalls come from different banks: a shot's morph interrupting a look's morph on the same key. A **manual edit** of a morphing key (a slider, the phone, an agent) takes over that key at once, by rule 2 of the fold, and needs no extra write.

### 5.4 The timeline clock: pause, loop, scrub, export, and §V44

The clock is `absTimeSeconds`: the transport's own count of frames produced, at the timeline's rate. It is not the timeline position `timeSeconds`, which **wraps at a lap and jumps on a seek**. Anchored there, a morph would replay on every lap and reverse when you scrub backwards, and a recall made just before the out point would snap at the wrap. This is my reading of "the timeline clock", and I would like the owner to confirm it (§15, question A).

| situation mid-morph | what happens | why |
|---|---|---|
| **paused** | The fade holds exactly where it is. Stepping a frame advances it by one frame. | The absolute clock only advances when frames are produced (`live-clock.ts:243-253`). |
| **looped** | The fade carries on through the lap. | A lap leaves the absolute clock running (`live-clock.ts:302-306`). |
| **scrubbed / seek** | The fade neither replays nor skips. Each rendered frame after a seek advances it by at most one frame step. | A seek does not rewind the absolute clock (T461). |
| **fps changed** | The fade keeps its duration in seconds. | `absTimeSeconds` is accumulated, not divided (`live-clock.ts:159-163`). |
| **offline export** | The document renders exactly as saved: every morph already in the document shows its end state, on every export. | A render zeroes the absolute clock (`render-range.ts:205-213`), which starts a **new epoch**, and a record from an older epoch counts as finished. |
| **reopen a saved file mid-morph** | The end state, with no leftover fade. | A new session is a new epoch. |

The epoch is what makes this deterministic. A bare "start is ahead of now" test is not enough: after a render zeroes the clock, a record stamped at live second 3 would replay three seconds into the next export. The epoch is an opaque id. The app mints a new one each time the absolute clock starts from zero (session start, `resetAbsolute`), and it reaches the resolver alongside the frame. Resolution stays a pure function of (document, frame, epoch).

**§V44** (time arrives only through `FrameEvaluationInput`) holds on both sides:
- No node reads a clock. The morph driver lives in the domain's resolver and reads `frame.absTimeSeconds`.
- The command reads the attached `frameClock`, which is the last `FrameEvaluationInput` the app produced, never `Date.now`.

**What export does not do:** it does not re-perform a live GO. Commands do not run during a render, and a render starts a fresh performance (T467). A render must also not fire a GO from a pulse expression. Whether today's pulse watcher sees render frames is not established by this survey, so the morph slice has to test it (§12, S2). Cues placed *on the timeline*, which an export would reproduce, are a separate question (§15, B).

### 5.5 What the phone and agents see during a morph

- **Phone:** the bank control shows `current` as the destination at once, with `morphing: "<preset>"` until the fade ends. The page republishes the snapshot twice per morph, at the start and at the end, never per frame. Sliders show their document values, which are the end values. Moving one mid-fade takes that key over (§5.3).
- **Agents:** `get_node` shows the end values and the `morphs` records. `list_presets` reports each running morph with its preset, start, seconds, curve and progress on the page's clock. `render_preview` shows the blend that is on screen.

---

## 6. Looks (ruling 7)

A **look** is a role, not a type: a node (in practice a component instance) whose output is a picture that some layer shows. "Scene" stays reserved for the 3D scene, Render's `scenes` (`source-references.ts:41`) and the payloads in `src/domain/types/scene.ts`. **No type, parameter or UI string uses "scene" for this role.** In the UI:
- the layer's input is labelled "Picture (a look, or any node)";
- a Panel heading can read "Looks";
- the library and help text say "look".

- **A look's presets** sit in a bank beside the instance whose `targets` names it (ruling 8). Store captures the published page, and recall writes the instance's `node.parameters`, per instance and undoable (`instance.ts:10-19`).
- **Several looks** means several instances. A look costs GPU time only while a layer that is on shows it, or while its preview tile is visible (`prune.ts:10-16`).
- **Travelling looks.** With §T1395b landed (`5a438a8f`), a component file can carry a look to another project. The follow-on is a bank *inside* the definition that targets the enclosing instance's page, so a look's presets travel with it. It is listed as a later row (§12). It is not v1, because a store inside a definition edits the library, which has no undo (`components/commands.ts:400-410`).

---

## 7. Layers (rulings 9, 10, 11)

### 7.1 The `layer` node (new)

| | |
|---|---|
| inputs | `below` (RGBA) **first**, so bypass passes it through (`bypass.ts:25-34`); then `picture` (RGBA), by wire or by name |
| `picture` | string, a source reference like Window Out's (`source-references.ts:54`), labelled "Picture (a look, or any node)" |
| `opacity` | 0..1, uniform, drivable, morphable |
| `blend` | enum, compileTime: `over`, `add`, `screen`, `multiply`, `replace` (below → picture by opacity, the wet/dry of an FX layer). Same maths as the composite family (§V140). |
| resolution, format | inherit `below` |

### 7.2 On/off versus fade

- **On/off is the layer's bypass flag.** When off, `below` passes through, the picture's chain is not reached and is pruned, and **it costs nothing**. It is structural, so it recompiles the region (`recompile.ts:112-121`). Commands, Panels, presets, shots and cues set it. An expression cannot (§T1014).
- **Fade is `opacity`.** It works per frame, can follow an expression, a widget or a beat, and morphs. At 0 the picture still cooks.

The first time a look that has never been compiled is switched on, it may hitch while its pipelines build. Pre-warming is a later row.

**On/off for any node (added 2026-11-12, §T1770b).** A preset's `on` map names any root node or component instance, not only a Layer, and writes the same flag in the same patch. Off is the node's bypass:

- a Layer passes its stack;
- an effect passes its input;
- a source has nothing to pass and is silent;
- a component instance that is off is not inlined, so nothing inside it is compiled or evaluated.

A bank with one preset per source, each holding the whole `on` row, is the exclusive choice among sources: a recall is one patch, so no frame reads two of them on, or none. Wire the sources into a **Value Switch** and read its output through a Lag. An input takes one wire, and a source that is off is not a branch of the switch, so with one source live the switch passes it whatever its index says. For rest values while nothing is live, use an **Expression** node as the bus instead: its In takes any number of wires and its Defaults supply a channel nobody is publishing.

**One switch, and Store (added 2026-11-12, §T1771b).** Any node named on a Panel's board that is not a widget, a bank, a Layer, a cue list or a look's instance is drawn as its on/off switch, on the desk and on the phone; drop the node on the Panel, or use the board's "+ Add…". It is the Layer's write (`setNodeUi { bypassed }`, the state pressed). Store captures a node's on/off only for a target spelled `node.@on` (a Toggle's own parameter is `node.on`), and writes it into the preset's `on` row; a whole-node target stores parameters only, as before. A recall whose preset switches only part of what its bank's other presets switch says so (`preset.on.partial`) and still applies.

A cue list that follows the timeline switches Layers only. A timed cue whose preset switches another node says so (`cue.timeline.switch`) and skips that switch; fired live, the same cue switches it (§T1772b lifts this).

### 7.3 Swapping looks

Changing `picture` from `"city"` to `"smoke"` is one parameter write that a preset can hold, and only the named look cooks. It is always a cut (§5.3). A crossfade uses two layers: a shot switches the upper layer on and morphs its opacity up. **Switching the lower layer off afterwards is left to the performer** (ruling 13), usually as the next cue.

### 7.4 FX, input, mapping

- **FX layer:** wire the stack into the FX chain and into `below`, name the FX output as `picture`, and use `blend: replace`. Opacity is then wet/dry. An FX node that needs no wet/dry is simply bypassed. **Any look can use it.**
- **Input:** whatever feeds the bottom `below`: a camera, a video, the phone camera (§T1397b), a constant.
- **Mapping:** **Corner Pin** (`cornerPin`, §T1491b), the last node before Window Out. Its pin and extract quads are ordinary parameters, so a bank can hold calibrations per venue or projector, and a shot can recall them. A calibration change is a cut unless the preset asks for a morph, since pin coordinates are numbers and do blend.

### 7.5 Rejected

- Over / Composite as the layer: their front comes first (`composite.ts:113-118`), so bypass would pass the layer instead of the stack.
- Cross: it has no alpha-over (§T234).
- One Switch for all layers: it cooks every source (§T1014).
- A document-level stack compiled into nodes: a second representation of the graph.
- Replicator-style generated layers: too heavy for this.

A **Layers view** listing the stack, derived by walking `below` from each output, is a later row.

---

## 8. Shots and the cue list

### 8.1 Shots (ruling 14)

A shot is a preset in a bank that targets layers (`picture`, `opacity`, `blend`, plus `on`) and recalls other banks' presets through `recalls`. Nesting is cycle-checked, capped at 4 `recalls` hops, and the shot's own values win. Each nested bank the shot wrote from gets its `current` in the same patch (§4.4 step 5). Recalling a shot is one patch across everything it touches. With a morph, one record covers all the keys it changes.

```jsonc
// bank "shots", targets "layer1 layer2 layer3"
{ "version": 1, "presets": [
  { "name": "drop",
    "values": { "layer1": { "picture": "city", "opacity": 1 }, "layer3": { "opacity": 0.8 } },
    "on": { "layer2": false, "layer3": true },
    "recalls": [ { "bank": "cityLooks", "preset": "riot" }, { "bank": "fx", "preset": "dirty" } ],
    "morph": { "seconds": 2, "curve": "smooth" } } ] }
```

### 8.2 The cue list (ruling 15)

A new node type, `cueList`, consistent with ruling 1: it copies, undoes, exports and is visible to agents like any other node.

**Parameters:**

| key | type | meaning |
|---|---|---|
| `cues` | `code` / `json` | The ordered list (format below). |
| `current` | string, written by GO / BACK / fire | The cue that fired last. Empty before the first GO. |
| `standby` | string, written by GO / BACK / fire / standby | The cue GO fires next. Empty means the cue after `current`, or the first cue. |
| `go` | pulse → `cue.go { nodeId: "$node" }` | Fire the standby cue. |
| `back` | pulse → `cue.back { nodeId: "$node" }` | Fire the cue before `current`. |
| `wrap` | boolean, default off | GO past the last cue goes to the first. |
| `keys` | boolean, default on | This list answers the GO / BACK keys. |

**The list** (`src/domain/presets/cue-list.ts`):

```ts
export interface CueList {
  readonly version: 1;
  readonly cues: readonly Cue[];
}

export interface Cue {
  /** Unique in the list; shown as the cue number or label. */
  readonly name: string;
  /** A bank node NAME and one of its presets. A shot is just a preset in a shots bank. */
  readonly bank: string;
  readonly preset: string;
  /** Overrides the preset's and bank's morph for this cue (§5.1). */
  readonly morph?: MorphSpec;
  /** Operator's note, shown on the Panel and the phone. */
  readonly note?: string;
}
```

**Commands and query:**
- `cue.go { nodeId? }` fires `standby` (or the first cue before any GO).
- `cue.back { nodeId? }` fires the cue before `current`.
- `cue.fire { nodeId, cue }` fires a named cue directly.
- `cue.setStandby { nodeId, cue }` moves the standby without firing.
- The query `cue.list { nodeId? }` returns cues, current, standby and running morphs.

Without a `nodeId`, the command acts on the one cue list with `keys` on. With none or several, it is refused, naming the lists.

**Next.** The next cue is always *derived*: `standby`, else the cue after `current`. It is never a third stored field. So GO / next / back are:
- **GO** fires the next cue;
- **next** is shown on every surface and can be moved with `cue.setStandby` (tap a cue on the Panel or phone);
- **BACK** fires the previous cue with its own morph, which is the live way to go back a look without reaching for undo.

**GO is one recall.** `cue.go` runs the same recall planner as `preset.recall` (one code path) with the cue's morph, and adds `current = fired` and `standby = the cue after it` to the same patch. So a GO is:
- **one revision, one undo group** (`GO 2 "drop" (set)`), and **one audit entry `cue.go`** stamped with whoever pressed it;
- undone in one step: targets, bank `current`, morph records, and the list's `current`/`standby` all go back, so pressing GO again fires the same cue again;
- refused, with the standby left where it is, when its cue leaves nothing to apply (ruling 4) or when GO has run past the end without `wrap`. The operator sees why and can move the standby.

**Triggers for GO:**

| surface | how |
|---|---|
| Panel | a cue list named in the layout → GO and BACK buttons, current / next captions, the list (tap a cue = standby) (§9.1) |
| phone | a `cueList` control (§9.2) |
| MIDI / OSC | the `go` pulse driven by an expression on a learned control, e.g. `op('midi1').chan.pad1` (a pad learned as a Control Change and named `pad1`; MIDI In does not read notes) |
| keyboard | new global bindings `mod+alt+g` → `cue.go` and `mod+alt+b` → `cue.back`, free in `src/editor/keymap/defaults.ts` (compare `perform.toggle`, `defaults.ts:538-551`) |
| beat | the `go` pulse driven by a beat channel, e.g. `op('audio1').chan.kick > 0.5` |

**How it relates to a bank's `select` / `recall`.** A bank's pulse is **random access within one bank**: a MIDI pad per preset, stateless. The cue list is **ordered, stateful sequencing across banks**, with a memory of where you are. Both go through one recall planner, so a cue and a pad recall the same preset identically. Neither writes the other's state: a pad recall does not move the cue list, and a GO sets the bank's `current` because it recalled that bank.

---

## 9. Panels and the phone

### 9.1 Panel

The layout syntax is unchanged (`controls.ts:147-157`): lines of node names. The pane chooses the row from the node's **type** (`controls-pane.tsx:106`):

- **bank** → one button per preset, `current` highlighted and a "morphing" mark while a fade runs, plus Store (on the local Panel only). These call `preset.recall` and `preset.store`.
- **layer** → an on/off toggle, an opacity fader and the picture's name. On/off writes `setNodeUi { bypassed }`, which is idempotent: **not** `node.toggleBypass` (`editor-commands.ts:60`), because a double tap from a phone would flip it twice. Opacity goes through the parameter editor, one undo group per drag.
- **cueList** → GO, BACK, current and next with notes, and the list (tap = standby). These call `cue.*`.

### 9.2 Phone: the exact contract additions (ruling 12)

Only banks, layers and cue lists **named on a Panel whose Phone switch is on** are reachable. Every write is audited as `human:remote-<phone>`. There is **no Store** from the phone and no cue editing.

`src/devices/phone/phone-protocol.ts`:

```ts
/** Added to the PhoneWidget union (next to slider / toggle / button / xyPad, :46-67). */
| {
    readonly kind: "preset";
    readonly handle: string;             // the bank node's id, as for widgets
    readonly caption: string;            // the bank's label
    readonly presets: readonly string[]; // names, in bank order
    readonly current: string | null;
    readonly morphing: string | null;    // the preset being faded to, or null
  }
| {
    readonly kind: "layer";
    readonly handle: string;
    readonly caption: string;
    readonly on: boolean;                // !ui.bypassed
    readonly opacity: number;
    readonly opacityDriven: boolean;     // true → the phone draws the fader read-only
    readonly picture: string;            // what the layer shows, for the label
  }
| {
    readonly kind: "cueList";
    readonly handle: string;
    readonly caption: string;
    readonly cues: ReadonlyArray<{ readonly name: string; readonly note: string }>;
    readonly current: string | null;
    readonly next: string | null;        // derived as in §8.2
    readonly morphing: string | null;
  };

/** PHONE_WRITABLE_KEYS gains (:89-94): */
preset:  ["recall"],               // string: a preset NAME
layer:   ["on", "opacity"],        // boolean; number 0..1
cueList: ["go", "back", "standby"] // true; true; string: a cue NAME

/** PhoneSet.values widens (:101-106) from number | boolean to: */
readonly values: Readonly<Record<string, number | boolean | string>>;
```

**Names, not indexes**, for `recall` and `standby`: the list can change between the snapshot the phone drew and the tap, and a stale index would recall the wrong preset. The vet checks the name against the document **now**.

**Phases:** `recall`, `go`, `back`, `standby` and `on` are `commit` only, and a `live` write of them is refused by name. `opacity` behaves like a slider, `live` then `commit` in one transaction.

`src/devices/phone/phone-snapshot.ts`:
- `publishedWidgets` (`:160`) becomes `publishedControls`, adding `presets`, `layer` and `cueList` nodes named on a remote Panel. There is still one list for both the snapshot and the vet.
- `buildPhoneSnapshot` (`:206`) takes the page's `frameClock`, to compute `morphing`.
- `vetPhoneSet` (`:244`) returns a second success shape, `{ ok: true, action: "command", command: "preset.recall" | "cue.go" | "cue.back" | "cue.setStandby", input }`. For a layer's `on` it returns `{ ok: true, action: "layerOn", nodeId, on }`.
- A driven `opacity` stays readable but its writes are refused, as for driven widgets today.

`src/app/phone-writes.ts`:
- `apply` (`:104`) routes by `action`. Parameter entries keep going to the phone's parameter editor. Commands go to `bus.execute(command, input, { ...invocation, actor: phoneActor(phone) })`. `layerOn` goes through one `graph.applyPatch` with `setNodeUi`, on the same per-phone lane so writes keep their order.
- The page republishes the snapshot when a morph starts and when it ends (§5.5).

`src/devices/phone/phone-page.ts` draws the three new kinds: preset buttons with current and morphing marks; a layer toggle with a fader; GO, BACK, current, next and the cue list.

---

## 10. What an agent sees

- Banks, layers and cue lists are nodes. `get_graph` and `get_node` show their parameters, including `current`, `standby` and `morphs`.
- New thin tools following `src/agent/tools/read.ts` and `mutate.ts`:
  - `list_presets`, which includes running morphs with progress;
  - `store_preset`, `recall_preset` (with an optional morph) and `delete_preset`;
  - `list_cues`, `cue_go`, `cue_back`, `cue_fire` and `set_cue_standby`.
- Layers need no new tool.
- An agent may write bank or cue JSON with `set_parameters`. Malformed JSON reports at recall or GO, and nothing is lost.
- No new capability class (§V38).

## 11. Schema and migration

- **No `SCHEMA_VERSION` bump** (`schemas.ts:12` stays 5). Everything here is new node types plus JSON in parameters. Older builds keep the new nodes as placeholders (`forward-compat.ts:36-37`).
- The bank and cue-list JSON carry their own `version` and migrate through each node's `definitionVersion` (`node-migrations.ts:7-20`).
- One rename clause covers banks, morph records and cue lists (`names.ts:210`). `layer.picture` joins the source-reference table.
- Liveness: banks and cue lists do not read their targets each frame, so they are not dependencies. Morphing keys count as animated (§5.3).
- `ProjectDocument`, `GraphPatchOperation` and `ParameterBinding` do not change. The only contract changes are a `frameClock` reader on `CommandContext` and the morph index plus epoch reaching `resolveParameters` (both §5).
- Gates to expect: `composition-seams` (the new keymap rows name `cue.go` / `cue.back`, which must exist in `CommandMap`), `emission-sites` (type strings named once), `layout` and `doc-drift` for the example.

## 12. Build plan: row-sized slices, in dependency order

Each slice lists its goal, the acceptance test that proves it, and the files it touches. "Dawn" means the real GPU path with exact or analytically derived values (§V147).

**S1 · Preset bank core (cut recall)**
- **Goal:** a `presets` node whose Store captures its targets and whose Recall writes them back as one patch.
- **Acceptance:**
  - Recalling a bank over three nodes is one revision, one undo group and one audit entry `preset.recall`, and one undo restores all three.
  - An expression slot stored in a preset comes back as the same expression.
  - A deleted target is skipped with a warning naming it, and the rest applies. A bank whose only target is gone is refused.
  - Pasting a bank with its targets into a document where the names collide rewrites the bank's names.
  - A component instance's published page is captured and recalled.
- **Files:** new `src/domain/presets/bank.ts`, `src/domain/presets/commands.ts`, `src/domain/presets/index.ts` (+ `bank.test.ts`, `commands.test.ts`); new `src/nodes/definitions/presets.ts`, registered in `src/nodes/definitions/index.ts`; `src/domain/graph/names.ts` (the clause); `src/domain/commands/index.ts` (register in `createDomainBus`, which both entry points use).

**S2 · Morph on the timeline clock**
- **Goal:** a recall with a non-zero morph commits the end state and fades the screen on the absolute timeline clock, deterministically.
- **Acceptance:**
  - A 1 s linear morph of a Level's brightness from 0.2 to 0.8, sampled on Dawn at frame 30 of 60 fps, reads the analytic 0.5 (§V147).
  - Paused, two frames apart, the value is unchanged. After a loop lap it continues. After a seek it neither restarts nor skips.
  - Undo mid-morph restores the old value at the next frame.
  - A second recall at half-time continues from the on-screen value, with no jump, measured at the frame of the recall.
  - A slider edit mid-morph wins at once.
  - An export of a document saved mid-morph renders the end state, byte-identical across two exports.
  - A render with a `go` / `recall` pulse on a beat expression fires no command.
  - A headless recall with a morph commits as a cut, with a diagnostic.
- **Files:** new `src/domain/presets/morph.ts` (record type, curves, fold, index per revision); `src/domain/presets/commands.ts` (record writing); `src/domain/commands/bus.ts` (`frameClock` on `CommandContext`); `src/domain/parameters/resolve.ts` (morph drivers); `src/compiler/validate.ts` and `src/compiler/frame-compile.ts` (driver plumbing, `animatedRootKeys`); `src/domain/channels/graph-channels.ts` (`hasAnimatedParameters`); `src/domain/channels/value-graph.ts`; `src/compiler/flatten.ts` (published keys that are morphing); `src/domain/transport/live-clock.ts` (epoch); `src/app/use-frame-loop.ts` / `src/app/app-runtime.ts` (attach `frameClock`); `src/app/render-range.ts` (check that pulses do not fire during a render).

**S3 · The `layer` node**
- **Goal:** a layer node on the stack: bypass means off at no cost, opacity and blend, and the picture by wire or name.
- **Acceptance (Dawn):**
  - Bypassed, the output equals `below` bit for bit, and the plan has **no passes** for the picture's chain.
  - `over` and `replace` at opacity 0.5 give analytic pixel values.
  - Swapping `picture` by name cooks only the named node (its passes appear, and the other's do not).
  - A preset's `on` bypasses the layer as part of its one patch.
- **Files:** new `src/nodes/definitions/layer.ts`, `src/nodes/shaders/layer.wgsl.ts` (+ `layer.gpu.test.ts`); `src/nodes/definitions/index.ts`; `src/domain/graph/source-references.ts` (`layer: picture`); `src/domain/presets/bank.ts` / `commands.ts` (`on`).

**S4 · Shots**
- **Goal:** a preset can recall other banks' presets inside its one patch.
- **Acceptance:**
  - A shot recalling two banks is one revision and one undo.
  - A cycle between two banks is refused, naming both.
  - Depth 5 is refused.
  - The shot's own value wins over a nested one.
  - A morphing shot writes one record covering all of its keys.
- **Files:** `src/domain/presets/bank.ts`, `src/domain/presets/commands.ts` (+ tests).

**S5 · Cue list**
- **Goal:** a `cueList` node with GO / BACK / fire / standby as one-patch recalls, with current and next.
- **Acceptance:**
  - GO fires the standby cue with the cue's morph, advances `current`/`standby` in the same revision, and one undo puts the list back so the next GO fires the same cue.
  - BACK fires the previous cue.
  - GO past the end without `wrap` is refused and the standby stays.
  - A cue naming a missing bank is refused and the standby stays.
  - `mod+alt+g` reaches `cue.go` on the list with `keys` on, and two such lists give a refusal naming both.
  - A MIDI-driven `go` pulse advances the list once per rising edge.
- **Files:** new `src/domain/presets/cue-list.ts` (+ test); `src/domain/presets/commands.ts` (`cue.*`, `cue.list`); new `src/nodes/definitions/cue-list.ts`; `src/nodes/definitions/index.ts`; `src/domain/graph/names.ts` (cue `bank` names); `src/editor/keymap/defaults.ts`.

**S6 · Bank, layer and cue-list surfaces**
- **Goal:** the inspector and the Panel drive all three node types.
- **Acceptance (browser tests):**
  - Clicking a preset button on a Panel changes the target node, and one undo restores it.
  - The layer toggle writes `ui.bypassed` idempotently: two presses of "off" leave it off.
  - GO on the Panel advances the list.
  - The inspector's Store adds a preset that Recall brings back.
- **Files:** `src/editor/controls/controls-pane.tsx`; new `src/editor/controls/preset-row.tsx`, `layer-row.tsx`, `cue-list-row.tsx` (+ tests); new `src/editor/inspector/preset-bank-section.tsx`, `cue-list-section.tsx`.

**S7 · Agent tools**
- **Goal:** agents list, store, recall and delete presets and run the cue list.
- **Acceptance:**
  - Each tool round-trips through the bus under the agent actor.
  - `recall_preset` with a morph reports the record.
  - `list_presets` reports progress.
- **Files:** `src/agent/tools/read.ts`, `src/agent/tools/mutate.ts`, `src/agent/schemas.ts` (+ tests).

**S8 · Phone controls**
- **Goal:** a remote Panel's banks, layers and cue lists work from the phone as `human:remote-<phone>`.
- **Acceptance:**
  - A phone `recall` is audited under the phone actor and lands on that phone's undo stack.
  - A bank that is not on a remote Panel is refused.
  - A `live` recall is refused.
  - A stale preset name is refused by name.
  - A driven opacity is shown but its write is refused.
  - The snapshot carries `morphing` at the start of a fade and clears it at the end.
  - No path reaches `preset.store`.
- **Files:** `src/devices/phone/phone-protocol.ts`, `src/devices/phone/phone-snapshot.ts`, `src/devices/phone/phone-page.ts`, `src/app/phone-writes.ts` (+ their tests).

**S9 · The worked example**
- **Goal:** one shipped example that plays a set.
- **Contents:** camera → two looks → glitch FX layer → Corner Pin → Window Out, with `cityLooks`, `fx` and `shots` banks, a cue list and a remote Panel.
- **Acceptance:** the example's claims are checked from rendered pixels: each cue's end state, and a mid-morph frame at its analytic value. It needs §T1491b (Corner Pin) landed.
- **Files:** new `src/examples/documents/<E-number>.ts`, `examples/<E-number>*.loom.json` / `.md` (regenerated with `--only`), README index row, `*-claims.gpu.test.ts`.

**Later rows** (filed separately, not sliced here):
- a look's presets inside its component definition, targeting the instance page (unblocked by §T1395b);
- a derived Layers view;
- pre-warming a layer's pipelines before its first switch-on;
- timeline-placed cues, if §15 B is ruled in;
- a mesh warp beyond Corner Pin.

## 13. Rulings (owner, 2026-09-29)

1. **Where do presets live?** → **In a Presets node (bank) in the graph.** As recommended. (§4.2)
2. **What does a preset hold for a driven parameter?** → **The whole slot: mode and expression.** As recommended. (§4.3, §5.3)
3. **What does a preset capture?** → **The bank's `targets`: whole target nodes, or single `node.key` entries.** As recommended. (§4.3)
4. **A missing node or invalid value on recall?** → **Skip it with a warning naming it; refuse only when nothing is left to apply.** As recommended. (§4.4, and for cues §8.2)
5. **Morph in v1?** → **Yes, in v1.** This departs from the recommendation. Fully designed in §5: data and precedence (§5.1), the end state committed in one patch with one undo (§5.2), what renders during the fade (§5.3), interruption (§5.3), and what the phone and agents see (§5.5).
6. **Morph clock?** → **The timeline clock**, not the wall clock, so it pauses with the transport and renders deterministically. This departs from the recommendation. Implemented as the transport's absolute timeline clock with an epoch (§5.4). Pause, loop, scrub, export and §V44 are all covered there, and the reading is to be confirmed (§15 A).
7. **The name for the performance role?** → **"Look".** "Scene" stays reserved for 3D. This departs from the recommendation. Renamed throughout (§6), including UI text.
8. **Where do a look's presets live?** → **In a bank beside the instance.** As recommended. §T1395b has landed (`5a438a8f`), so the travelling-look follow-on is unblocked and listed in §12's later rows.
9. **Layer on/off?** → **The bypass flag. Opacity is the drivable fade.** As recommended. (§7.2)
10. **A new node or reuse?** → **A new `layer` node.** As recommended. (§7.1)
11. **Picture by name as well as by wire?** → **Yes.** As recommended. (§7.1, §7.3)
12. **Widen the phone door?** → **Yes: only banks and layers named on a remote Panel, audited as the phone's actor, and no Store from the phone.** As recommended. The door's page half has landed (`be146d5d`). The exact contract additions are in §9.2, and they also give the cue list its phone control.
13. **Switch off the lower layer at the end of a transition automatically?** → **No: left to the performer.** As recommended. (§7.3)
14. **Shots nest?** → **Yes: cycle-checked, depth 4, own values win.** As recommended. (§8.1)
15. **A cue list?** → **Build it as a first-class surface.** This departs from the recommendation. Designed in §8.2: an ordered list with per-cue morph, GO / next / BACK with current and next, a `cueList` node, GO from Panel, phone, MIDI, keymap and beat, one patch with one undo and one audit entry per GO, and how it relates to a bank's `select` / `recall`.

Also ruled with the above: **Corner Pin** (`cornerPin`, §T1491b) is the mapping node, and the layer stack's mapping slot names it (§3, §7.4).

## 14. How this compares

- **TouchDesigner** has no first-class preset object. The usual idiom is a table of parameter values applied by script, with a COMP's custom parameters as the preset surface. That supports banks as network nodes, and a look's published page as what gets stored. The Switch TOP's crossfade is §T1054, and its cost is why a layer takes its picture by name.
- **Resolume:**
  - Its composition of layers, each with opacity, blend and bypass and each playing one clip at a time, gave §7.
  - Its column trigger gave the shot.
  - Its per-layer transition time is the morph here.
- **Cue-list software (QLab-style)**: GO fires the standby cue and the standby advances. §8.2 follows that convention, so an operator who knows it knows this.

## 15. Questions these rulings raise

A. **"Timeline clock" read as the transport's absolute timeline clock.** It pauses with the transport and advances only on produced frames, but it runs through loops and seeks, where the timeline position would replay the fade on every lap and reverse it on a backwards scrub. *Recommendation: confirm the absolute clock.* The alternative, the timeline position, makes a morph behave like a keyframe on the timeline.

**Ruled 2026-09-29: the absolute clock.**

B. **Cues placed on the timeline**, which an export would reproduce: for music videos and fixed shows. A live GO is not re-performed by an export, because commands do not run during a render. Timeline cues would need the cue list to act as a pure function of the playhead, applying values as drivers without writing the document. *Recommendation: a separate row after S5, only if you want exports of cued shows.*

**Ruled 2026-09-29: a separate row after S5 (§T1508b).**

C. **What BACK means.** This design fires the previous cue (with its morph). The other common meaning moves the standby back one without firing. *Recommendation: fire*, because moving the standby is already a tap on the list.

**Ruled 2026-09-29: BACK fires the previous cue.**
