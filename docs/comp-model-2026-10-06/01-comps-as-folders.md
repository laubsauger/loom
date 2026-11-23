# 01. COMPs as folders, linking as opt-in

*Part of the [COMP model proposal](README.md). Read this one first: everything else stands on it. It uses Loom's current word, "component"; [02](02-terminology-and-parameter-modes.md) proposes renaming it COMP, after TouchDesigner.*

## 1. Where we are

- **§V79**: "component instance = `componentId` + `version` + own values. ⊥ copy internal graph unless detached. edit to definition → ∀ linked instances, detached ⊥ affected."
- **§V82**: "component compiles by FLATTENING into parent logical graph. source path preserved `Main/Feedback_2/Blur_1` ∀ diagnostic, timing, profile."
- **§V81**: "`parent.<key>` resolved via resolver (V61), lexical up the instance chain. ⊥ direct cross-node param read."
- **§V127**: "node `name` = a unique IDENTIFIER within its graph, auto-numbered on collision".

What an instance actually stores: identity, version, published values, and per-internal-node overrides in `node.state.componentOverrides` (`src/domain/components/instance.ts:15`, `:23`). The internal graph exists only inside the definition. It turns into concrete nodes once per compile, in `src/compiler/flatten.ts`, with ids built by `flattenedNodeId(prefix, nodeId)` → `${prefix}/${nodeId}` (`src/domain/components/internal-resolutions.ts:6-9`, `COMPONENT_ID_SEPARATOR = "/"`). §V529 records that this flatten "is a PURE FN of the document & is recomputed 60×/s", and that ~60% of its cost is B41's label-uniquing `structuredClone`.

The one escape hatch is `component.instantiate` with `mode: "detached"` (`src/domain/components/commands.ts:130-132`), plus `component.detach` (`:71`). Both spill "the whole internal network" (`:139`) into the parent graph as flat siblings. The container goes away, so you either have a linked black box or no box at all.

## 2. Motivating evidence (from a real project)

The touring-stage previz (`projects/stage-previz/stage-previz-8.loom.json`, in #2 as commit 5, VN12) packages a 94-node network into six components: feeds, the stage set, the camera, the work lights, the projector rig, and the haze render. Each of the five limits below forced a workaround in that file.

### 2.1 Loaders cannot write back into a component

`src/app/use-mesh-sources.ts:128-139`: once a Mesh File In has parsed a file, the hook has to write the measured `vertices`/`triangles` (and joints and clips, `:141-145`) back onto the node so that buffers can be sized. It finds the node with `bus.store.getGraph().nodes[nodeId]`. For a node inside a component that lookup returns `undefined`, because the node exists only in the flattened graph. The hook then emits:

> `mesh.component`: Mesh "…" sits inside a component; its Vertices/Triangles must be set on the component's own node

and returns `false`, so **nothing draws**. In v8 the nine Mesh File In nodes had to stay at the root and feed the set component through nine points inputs.

I searched `src/app/*.ts` for the same document-node lookup by id. `use-mesh-sources.ts:130` is the only loader that does this write-back. The phone door has the same root cause more broadly; see §2.5 and [03](03-base-and-container-comps.md). Any future loader that measures facts from a file (GLTF, point caches, model metadata under §V827's "what actually ran") will hit the same wall. *Open item: a worker should sweep `src/app/use-*.ts` and `src/runtime/**` for every `getGraph().nodes[` call against a flattened id. I only checked `src/app`.*

### 2.2 Names are global after flatten, so components have no scope

`src/compiler/flatten.ts:497-520` (`withUniqueNames`) makes each level's labels **globally** unique through one shared `usedNames` set. On a collision it renumbers the internal (`renumberedName`, `:507`) and rewrites only that level's own references. This was the fix for B41: "2 instances of any component whose internals use names CROSS-RESOLVE". §V320 and §V321 generalise it.

The fix is correct for internal references. Its side effect is that **outer references reach inside by bare name**:

- A Render node's `projectors` parameter is a list of names (`src/nodes/definitions/scene.ts:1111`, `:1203`). In the previz it reads `projectors: "projSR projSL projDS"`, which binds three projector nodes that live *inside* the rig component. The binding works only because each name is unique in the whole document.
- Instantiate the "Projector" component three times and the second and third copies' `projDS` gets silently renamed (`projDS1`, …). The outer Render either keeps binding the first copy or binds nothing, and no diagnostic is raised. Same story for `op('projDS').par.x`.

So a reusable projector component is **impossible today**, and a single-use one only works because it leaks. With folders this becomes a scope problem with a scoped answer: `op('rig/projDS')`, `projectors: "rigSR/proj rigSL/proj rigDS/proj"`, and relative paths (`op('../cam')`).

### 2.3 Expressions cannot read `parent.<key>`

`parent.<key>` exists, but only as a **whole-parameter link**. `src/domain/components/parent-scope.ts:20-26` explains that parent scope is "a driver factory": the bare string `"parent.blur"` would be refused by `validateParameters`, and the binding lives in `node.state.parentBindings`. The expression grammar (`src/domain/expressions/evaluate.ts:26`) is "numbers, operators, parentheses, scope variables, `op()` references, and the closed function whitelist". It has no `parent` term. The MCP server's own tool notes say the same thing: `bind` reaches "`parent.<key>` inside a component", and expressions reach other nodes through `op()`.

So `parent.gain * 0.5 + op('lfo1').chan.value` cannot be written. In the previz the workaround was **Constant "knob" holder nodes** inside each component: a published parameter targets the Constant's `value`, and the compound expressions read `op('knob_dsTilt').par.value`. That is one extra node per published parameter a formula reads, in every component that reads it: 17 in v8. It also *adds* bare names to the global namespace from §2.2.

### 2.4 Organising pays the reuse tax

Collapsing a selection into a box today creates a definition, a version (§V84 pins it), a published page and a library entry. For a network used exactly once, the definition/instance split is pure overhead. Every later edit goes through "edit definition → propagate", and the user only wanted a folder.

### 2.5 Control surfaces only see the root graph

A Panel and the phone door both look only at top-level document nodes, so a control cannot live inside the component it controls.

- **Panel membership.** A Panel's members are the widgets wired into its Controls input, plus banks, layers and cue lists named on its board (`panelBoard`, `src/nodes/definitions/controls.ts:595`). Both are looked up in the document graph. A slider inside a component cannot be wired to a Panel outside it, and a board item naming it resolves nothing.
- **Phone door.** The phone snapshot builds its pages from `remoteLayouts(graph)` over the document (`src/devices/phone/phone-snapshot.ts:473`). Every phone write is vetted against `publishedWidgets(graph)` and `publishedMembers(graph, …)` (`vetPhoneSet`, `:538`). A widget or bank inside a component is refused as "a control that is not published to the phone door". A layer toggle reads and writes `ui.bypassed` by document id (`src/app/phone-writes.ts:150`, a `setNodeUi` patch). For a layer inside a component the read finds nothing and the patch targets a node the store does not hold.

The previz cost: all 24 controls (23 sliders and a toggle) had to stay at the root beside the Panel. Each one now drives its component through a published parameter set to `op('dsThrow').chan.dsThrow`. That is 28 instance-parameter expressions (some sliders feed two components) whose only job is to cross a boundary the user never asked for. A reusable "Projector" component cannot carry its own control strip either: the strip has to be rebuilt beside every instance.

With folders, `rig/dsThrow` is a document node, so the Panel can wire it and the phone can vet it. The open design question is whether a Panel should list *published parameters* of a linked instance directly (TD's parameter page on a COMP), which would remove the root slider entirely.

## 3. The proposal

### 3.1 Model

| Concept | Today | Proposed |
|---|---|---|
| Component (default) | Linked instance of a library definition | **Folder**: a container node whose children are real document nodes |
| Child identity | Flatten-time id `prefix/nodeId`, document has no node | Document node with absolute path `folder/child` (same string) |
| Reuse | Always on | **Opt-in link** to a master (`componentId` + `version`), TD Clone-style |
| Placing a library component | Adds a linked instance | **Copies** its network into place as a new folder under a unique name (`rig`, `rig1`, …), unlinked unless asked |
| Parameter addresses | Bare global names, renumbered on collision | Absolute paths (`rig1/projDS.throwRatio`): the target for binds, MIDI, presets and the remote |
| Per-instance tweaks | `state.componentOverrides` | Linked folder: children marked **clone-immune** keep local values |
| Detached | Dissolves container | Retired: "unlink" keeps the folder |

### 3.2 What changes

**Document graph hierarchy.** `GraphDocument.nodes` gains optional parentage: a node either has `parent: NodeId` or a folder node holds a `children` subgraph. I lean towards *nested subgraphs* because it matches `navigation.ts` and the flatten walk. Either way, the stored id of a child is its path. The `/` separator is reserved in labels.

**Path addressing in commands and patches.** `GraphPatch` ops and `AppCommandBus` inputs take node paths. Root nodes keep their bare ids, so existing patches stay valid. Revision checks and the audit trail record full paths. Agent tool schemas in `src/agent/` widen `nodeId` to accept a path. That is a zod change, with no app logic.

**op(), source references and rename scoping.** Name resolution becomes **lexical**: look in your own folder first, then walk out to the parent. Explicit paths (`a/b`, `../b`, `/a/b`) skip that lookup. §V127 uniqueness becomes *unique within its folder*. §V128's rename rewrite only has to cover references that can see the node. B41 renumbering is no longer needed for folders, which also removes the §V529 `structuredClone` hot spot. `opRef.name` (`evaluate.ts` AST) carries a path. Add `parent.<key>` (and `parent.parent.<key>`) to the grammar as a variable resolved through the existing `parentScope` chain (`parent-scope.ts:96-104`). §V81 keeps its rule against direct cross-node parameter reads, because the read still goes through the resolver.

**Write-back.** With real children, `use-mesh-sources` writes onto `nodes["stageSet/meshStage"]`. In a linked folder the write lands on a clone-immune child, or as an override (see stage 0).

**Canvas and inspector navigation.** The canvas still dives into a folder, as `navigation.ts` does now. The difference is that editing inside a plain folder edits *the document* with no "edit definition" mode. The inspector shows a breadcrumb path, and the published parameter page does not change. Linked folders show a link badge, a version, and a per-child clone-immune toggle.

**Persistence and migration.** This needs a new schema version in `src/domain/migrations`. Loading an old file keeps every instance **linked** (no behaviour change). The proposed conversion is: each linked instance becomes a linked folder whose children are materialised from the pinned definition version, and existing `componentOverrides` turn those children clone-immune. Single-instance definitions can be offered a one-click "unlink → plain folder". Old `detached` content is already flat, so nothing changes. Under §V821 the migration gate must be referential ("every `op()` and source reference names a node that exists"), and a numeric comparison alone is not enough.

### 3.3 What stays

- **The published parameter page** (§V80 one edit → one atomic patch → one undo group).
- **Flatten at compile** (§V82). The compiler still sees one logical graph, and diagnostics already use `Main/Feedback_2/Blur_1`-style paths. The flatten gets *simpler* for folders: children are already concrete, so it only re-roots ids.
- **Versioned linked masters for real reuse**: definitions, §V84 version pinning, `upgrade.ts`, and §V83 recursion checks, which now also run on link targets.
- **Component export/import** (`component-file.ts`, `export_component`/`import_component` MCP tools). Exporting a plain folder produces a definition.

### 3.4 Invariants replaced or amended (proposed wording, orchestrator to number)

- **§V79** (replace): "a component is a folder of real document nodes by default. A **linked** component stores `componentId` + `version` + own values + its clone-immune children. A definition edit → ∀ linked folders, except clone-immune children."
- **§V127** (amend): "unique within its **folder**", with references resolved lexically and paths allowed.
- **§V128** (amend): rename rewrites every reference *that resolves to* the node, scope-aware.
- **§V320/§V321** (keep, re-scope): duplication still has to rewrite names, but folder-relative references make copy #2 correct by construction. The "instantiate twice" gate stays, because it is the proof.
- **§V81** (amend, see [02](02-terminology-and-parameter-modes.md)): `bind` takes TouchDesigner's meaning, two-way and value-identical with a bind master; today's one-way `bind` is migrated to an `expression` (a reference), value-identically, as §T897 did for `driven`. A parameter is in exactly one mode.
- **§V81** (amend): the parent's parameters are readable *inside expressions*, spelled TD's way, `parent().par.key` ([02](02-terminology-and-parameter-modes.md)), still resolved through the resolver.
- **§V529** (amend): the B41 uniquing cost applies only to linked masters instantiated more than once.

## 4. Staged migration (each stage ships alone)

**Stage 0: write-back stopgap.** `use-mesh-sources` writes measured facts into the owning instance's `state.componentOverrides` for that internal (keyed by the internal's path), not into a document node that doesn't exist, and drops `mesh.component`. This stage does not fix the control surfaces in §2.5; they need path addressing (stage 1). This unblocks the previz now and makes no model change. The repro is the literal bug: a Mesh File In inside a component, rendered on Dawn, must draw non-zero pixels.

**Stage 1: path-aware names.** `op('a/b')`, path-valued source references (Render `projectors`/`scene`/`camera`), and lexical lookup that prefers same-scope names before falling back to global names (that fallback keeps old files working). Also adds the parent's parameters to the expression grammar, as `parent().par.key` ([02](02-terminology-and-parameter-modes.md)). Done when three projector instances bind correctly and the knob holder nodes can be deleted.

**Stage 2: folder storage.** Plain folders become a document construct, and "collapse to folder" is the default grouping action. Linked instances stay exactly as they are, so the two kinds coexist. Write-back, `bypassed` and the inspector all work on real children. Migration is additive only.

**Stage 3: opt-in link.** "Link to master", clone-immune children, unlink-keeps-folder, migration of old linked instances to linked folders, and retiring `detached`. §V79 is replaced here.


## 5. Risks and open questions

- **Document size.** Materialising children for N linked instances grows files. One mitigation: a linked folder stores only clone-immune children and *references* the master's nodes, which is close to today's override storage. Is that a folder in name only?
- **Propagation semantics.** In TD, editing a clone overwrites local changes on the next master update unless the change is clone-immune. Is that surprise acceptable here, or do we refuse edits to non-immune children of linked folders?
- **Id stability.** If a path is the id, moving a node between folders changes its id. Audit, undo, presets (`presets/detach-page-bank.ts`) and storage addresses (`rename-gate`) all key on ids. Option: keep an opaque stable id and treat the path as a derived address. My lean is opaque id plus path, because §V128 already treats rename as a rewrite.
- **Lexical fallback.** During stage 1, global fallback keeps old leaks working, but it also hides them. We could emit a deprecation diagnostic on cross-scope bare-name binds.
- **Gates.** `composition-seams`, `rename-gate`, `layout` (§V389, which now applies per folder) and `doc-drift` all need folder awareness, and the examples under `examples/` need regenerating with `--only`.
- **Upstream appetite.** This touches the frozen `src/domain/types` contract. That is a maintainer decision, not ours.


## 6. Alternatives considered

1. **Status quo plus overrides.** Do stage 0 and stop. This fixes the mesh loader and nothing else: names still leak (§2.2), expressions still need knob holders (§2.3), and organising still costs a definition (§2.4), and Panels and phones still cannot reach inside (§2.5).
2. **A "local/unlinked component" flag.** Keep a definition per instance and mark it as unshared. This removes the propagation surprise, but each folder still pays for a definition and a version, and internals are still not document nodes, so write-back is still blocked. It is `detached` mode with a box drawn around it.
3. **Improve `detached`** so it keeps a visual group (a canvas annotation). This gives organisation, but no scope, no published page and no `parent.<key>`. It is cosmetic.
4. **Namespacing only** (stage 1 without stage 2): flatten prefixes labels with the instance path rather than renumbering. This is cheap and fixes §2.2, but leaves §2.1 and §2.4 open. It is worth doing anyway as stage 1.


## Proposed §T rows

```
T____|.|**COMPONENT WRITE-BACK VIA OVERRIDES (stage 0).** `use-mesh-sources` writes measured vertices/triangles/joints/clips for a component internal into the owning instance's `state.componentOverrides`, keyed by internal path; retire `mesh.component`. Repro: Mesh File In inside a component draws on Dawn; instantiate twice (§V321).|V79,V321
T____|.|**PATH-AWARE NAMES (stage 1).** `op('a/b')`, relative `../`, path-valued source refs (Render projectors/scene/camera); lexical lookup with global fallback + deprecation diagnostic on cross-scope bare-name binds. Gate: 3× Projector component binds 3 distinct projectors.|B41,V127,V128,V320
T____|.|**`parent().par.key` IN EXPRESSIONS.** Add TD's `parent()` / `parent(n)` to the expression grammar, resolved through `parentScope` chain (§V81 resolver path, no direct cross-node read). Delete knob-holder workaround from stage-previz.|V81,T133
T____|.|**FOLDER COMPONENTS (stage 2).** Plain folders as a document construct: real child nodes, stable id + derived path, canvas dive/breadcrumb, collapse-to-folder default. Linked instances unchanged. Schema migration additive.|V82,V127,V389
T____|.|**OPT-IN LINK + CLONE-IMMUNE (stage 3).** Link a folder to a versioned master; clone-immune children replace `componentOverrides`; unlink keeps folder; migrate linked instances to linked folders; retire `detached`. Replace §V79. Referential migration gate (§V821).|V79,V84,V821,T____
```
