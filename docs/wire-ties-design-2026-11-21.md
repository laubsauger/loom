# Wire ties — design (T1821b, 2026-11-21)

Owner, 2026-11-21: *"could also think about adding these zip ties to optionally be able to
clean up graphs even further"*. Clarified: both halves — a dot dropped on a wire bends its
route, AND several wires can pass through one tie together, run as one strand and fan out.
Saved in the document, no effect on render. Data wires only (not the dashed `op()` lines).

This note is the contract the build follows. The curvature half of the same request is
§T1820b (`src/editor/edges/wire-path.ts`); ties are drawn by the same function.

## What the other tools do

| Tool | Reroute | Is it a node? | Wires through one | Create / remove |
|---|---|---|---|---|
| TouchDesigner | none. The idiom is a Null OP, which is a real operator: it has a name, takes a box's worth of space and cooks. A reroute has been a wishlist thread since 2021 (forum.derivative.ca/t/add-reroute-node/209858). | — | — | — |
| Notch | none documented; the manual's tidying tools are Region nodes and selection sets (manual.notch.one, "Keeping projects tidy"). | — | — | — |
| Houdini | network **dot** (`hou.NetworkDot`). | a network item, not a node: it has an input and outputs and organises wires only. | one input, any number of outputs. Alt-dragging a dot *picks up* the wires it crosses. | Alt-click a wire adds one. **Unpinned** dots are deleted automatically when all wires into or out of them go; **pinned** ones persist (sidefx.com/docs/houdini/network/wire.html). |
| Nuke | **Dot** node. | yes, a node in the DAG that passes its input through. | one input, many outputs. | Ctrl/Cmd-click a pipe inserts one; delete like any node. Pipes are straight. |
| Unreal (Blueprint, Material) | **Reroute** node. | yes, a node in the graph with a pass-through pin. | one input, many outputs. | double-click a wire adds one (dev.epicgames.com, Reroute Node). |
| Blender | **Reroute** node. | yes, a node in the tree. | one input, many outputs. | Shift+right-drag across links adds reroutes; delete like a node. Curvature is a theme setting ("Noodle Curving"). |

Two shapes, then. Nuke, Unreal and Blender put a NODE in the graph whose only job is to
pass its input on; Houdini makes the dot a lighter network item, still with one input.
Every one of them limits a reroute to ONE source: wires from one output run together
through it and fan out after.

## The decision: a tie is a point on wires, never a node

A tie is a **point that wires are routed through**. It is not in `nodes`, has no ports and
no name, and an edge stays `source → target` whatever ties it passes. Consequences, each of
which is why this beats the node shape here:

- **Zero render effect by construction.** Nothing that compiles reads `ties` or `via`.
  A reroute NODE would have to be recognised and collapsed by flattening, validation,
  bypass, the value graph, liveness, layout and every agent tool that walks wires — and
  any one of them forgetting would be a render difference. With ties there is nothing to
  forget: no compiler module has a reason to open the field.
- **Any wires can share one tie**, not only wires of one output. That is the zip tie the
  owner named: cables from different places bound into one run. Wires from one output
  through one tie are the Houdini/Nuke/Blender case and come for free.
- Deleting a tie never disconnects anything. Deleting a reroute node in Nuke or Blender
  does, unless the tool splices around it.

Houdini's unpinned-dot rule is adopted: **a tie exists only while a wire passes through
it** (§V1040). There is no pinned state; a tie with no wire would be a dot that means
nothing.

## Data model and persistence

```ts
// src/domain/types/graph.ts
interface GraphTie { id: TieId; position: { x: number; y: number } }
GraphDocument.ties?: Record<TieId, GraphTie>
GraphEdge.via?: TieId[]      // the ties this wire passes, in order from its output
```

- The route lives on the EDGE as an ordered list, because one wire can pass several ties
  and the order is the route. The tie holds only its position, so a tie shared by five
  wires is moved by writing one position, and two wires can never disagree about where a
  shared tie is.
- `.loom.json`: `graph.ties` beside `graph.groups`, and `via` on each routed edge. Both
  are absent when there are no ties: an untied document's bytes do not change.
- **No migration and no `schemaVersion` bump.** Both fields are additive and optional, and
  absent means "no ties" — exactly what every earlier document looked like. That is the
  `edge.order` (T225) and `ui.z` (T1102) precedent. An older build reads a newer file
  through the open schema (§V68, `forward-compat.ts` passes unknown keys through), keeps
  the ties and writes them back untouched; it simply draws the wires straight between
  ports. A bump would make every shipped example and component re-generate for a field
  none of them uses.
- Component definitions carry `ties` in their own `graph` (the same `graphDocumentSchema`),
  and a dived canvas edits them like the root's.

## Mutation: patch operations on the bus, with undo

Every change is a `graph.applyPatch` operation, so it is atomic, audited and one undo step
(§V29, §V32, §V34), and the agent tool `apply_graph_patch` reaches it unchanged:

| op | meaning |
|---|---|
| `addTie { ref, position }` | a tie at `position`; `ref` is a `$temp` the rest of the patch can name |
| `moveTies { positions }` | tie id → new position |
| `removeTies { tieIds }` | the ties go, and every wire through them is released (its `via` loses them) |
| `setEdgeVia { edgeId, via }` | the wire's COMPLETE route (the `reorderEdges` shape: a full list, never a move instruction); `[]` clears it |
| `connect { …, via? }` | a new wire born routed, so a splice keeps the halves of the route it cut |

After the last operation of a patch, any tie no wire passes is removed in the same patch
(§V1040). That covers every way a wire can go — `disconnect`, `removeNodes`, a replace drop,
a reconnect — with one rule in one place, and the undo of that patch restores the tie with
the wire. A tie created by a patch that leaves it unused is reported (`tie.unused`, info).

The store records `ties` as a fourth entity collection beside nodes, edges and groups, so
undo, redo, coalescing and §V41's per-actor blocking work on ties as they do on groups.
`patch-scope.ts` names ties `tie:<id>`: `moveTies` is a value edit; the other three are
structural, and `setEdgeVia` touches its edge.

One command, promoting the planned `graph.rerouteEdge` the edge menu has named since T127:
`graph.rerouteEdge { edgeIds, position?, tieId?, index? }` — with `position`, a new tie
there carrying all the given wires; with `tieId`, the given wires join that tie. `index`
places the tie in a single wire's route (the canvas passes the segment it hit); without
it the tie goes where it lengthens the route least. Everything else is a plain patch.

## Gestures

- **Double-click a wire**: a tie on that wire at the point of the wire nearest the click
  (Unreal's gesture; Houdini's Alt-click is taken by Loom's Alt-pan, B195). The edge menu's
  **Add tie** row does the same at the right-click point.
- **Drag a tie**: moves it. The wires follow live; the document is written once, on
  release (§V15), as one `moveTies`.
- **Drop a tie on another tie**: they merge — every wire through the dragged one now passes
  the one under it, and the dragged one goes. This is how wires are bundled.
- **Shift-drop a tie on a wire**: that wire joins the tie (Houdini's Alt-drag pickup, with
  Shift because Alt pans here).
- **Double-click a tie**: removed; its wires return to their direct routes.

A tie is drawn as a small dot in the colour of the first wire through it, above the wires
and the nodes (a reroute hidden under a node cannot be grabbed). Its size is in graph
units, like the nodes.

## Hit-testing and splice drops through ties

`edge-geometry.ts` stops assuming one cubic: a routed wire is published as the path it
DRAWS — `M` then one `C` per leg — and the store keeps every leg. A drop is tested against
the nearest leg (§V14b, §V14c), and the hit names the leg as well as the wire. So:

- a connection released over any leg of a routed wire replaces it (T212), as before;
- a node dropped on leg k of a wire with ties `t0…tn-1` splices into it (T213): the new
  upstream wire keeps `t0…tk-1` and the new downstream wire keeps `tk…tn-1`, so the route
  the person drew survives on both sides of the node.

A replace drop and a reconnect make a NEW wire to a different port: it is born unrouted,
and a tie it leaves empty goes with it.

## Compile, flatten, classify

- The compiler, flattening, validation and the value graph never read `ties` or `via`.
  Test: the compile of a document with ties and routed wires is identical to the compile
  of the same document with both removed.
- `classify-revision.ts` must not call a route change a rewire: an edge whose source,
  target and order are unchanged is the same connection, so moving or adding a tie is
  editor-only work and never recompiles or resets feedback. `ties` is `structure` for the
  canvas (it must redraw), never for the compiler.
- A component session writes its graph back when `ties` moved, as it does for nodes,
  edges and groups.

## Left open (rows in §T1821b's STILL OPEN)

- `graph.layoutAll` moves nodes and leaves ties where they were.
- Copy/paste, duplicate and "save as component" re-create wires without their routes.
- Ties are not part of box selection; moving a selection of nodes leaves its ties.
