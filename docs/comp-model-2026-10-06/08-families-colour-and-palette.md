# 08. Operator families, family colour, and a three-tier component palette

*Part of the [COMP model proposal](README.md). §1–2 are independent of the rest and can be ruled on alone. §3 depends on [01](01-comps-as-folders.md) (folders) and [03](03-base-and-container-comps.md) (Base and Container). §4 extends [04](04-dashboards-presets-and-library.md) §3's library. Contributed by a parallel session on the fork; merged here.*

## 1. Families and colour today

Loom colours a node in three separate layers. TouchDesigner has one strong family colour.

1. **Family body tint** (T712; `src/ui/tokens.css:162`, `src/editor/nodes/node-family.ts:45`). The family comes from the node's primary *output* port kind, and there are five:
   - `texture` (≈ TOP);
   - `points` (≈ POP);
   - `spatial`: scene, material, camera, light, projector and transform3d, which is TD's 3D COMPs and MATs together;
   - `value` (≈ CHOP, but also scalar, vector, matrix, event and audio features);
   - `data`: a GPU storage buffer, which resembles a DAT only by name.

   Sinks get no tint. The tints are tuned to one brightness and kept only 5–9 ΔE apart by `node-family.test.ts`, which cites §V90 (a hint, not decoration). That subtlety was the maintainer's own request in T712: "a very very subtle hint".
2. **Port and wire hue** (§V26). This is the strong signal: one hue per port kind, and an edge takes its source port's hue.
3. **Category badge** (T964). This shows the node's role: generator, filter, composite, color, points, render, shader, temporal, value, input, output, utility. Its colours are deliberately dim.

## 2. Proposed family changes

### 2.1 A stronger family colour, matching the port hue
In a dense graph the T712 tints read as noise, so the family is effectively carried by the wires alone. Proposal: give each family a clearly distinct colour that matches its port hue, carried by a header band or a saturated edge as in TD, and keep the body neutral. The category badge stays as the secondary, dim role signal.

**This needs a ruling,** because it reverses T712's explicit ask and the ≤9 ΔE bound in `node-family.test.ts`. A middle path: keep the subtle body tint, and add the family hue only to the header band.

### 2.2 MAT as its own family
Split `material` out of `spatial`. The port already has its own hue (`--port-material`). What remains of `spatial` is the 3D-object family (≈ TD's Geometry, Camera, Light and Projector COMPs).

### 2.3 A real DAT family
The table type from [06](06-tables.md) becomes its own family. Mapper tables ([05](05-mappers.md)), cue lists, preset banks and the command bible ([07](07-command-bus.md)) are its natural members. Open question: does today's GPU `buffer` (`data`) stay a separate family, or fold into DAT?

### 2.4 COMP family
Base and Container COMPs ([03](03-base-and-container-comps.md)) are the COMP family. A Base is a folder of real nodes with no UI. A Container is a Base with a panel.

## 3. "Component" comes to mean a published, versioned COMP

What Loom calls a *component* today is a definition in `componentLibrary` with an identity, a version, linked instances and upgrades. That becomes a **published component**: a Base or Container that has been published with a version and is tracked. None of the definition, version and upgrade machinery is lost; it stops being the only way to make a box. A plain COMP is a folder ([01](01-comps-as-folders.md)), and only a published one can be linked to (01 stage 3).

This settles a word: **"publish" is reserved for components.** The gesture that promotes an inner parameter onto a COMP's page is **promote**, and what it creates is a **custom parameter** ([02](02-terminology-and-parameter-modes.md)).

## 4. The palette: three tiers, and publishing from the UI

Today's component library is Loom's equivalent of TD's Palette. Proposal, modelled on alphamoonbase OLIB and the Function Store (curated third-party TD tools):

| Tier | Where it lives | Distribution |
|---|---|---|
| **Built-in** | This repo (today's `examples/components/*.loom.json`, `src/examples/starter-components.ts`) | Always present |
| **Community** | A separate, maintainer-curated repo of reviewed components | Indexed in the palette, **downloaded on demand**, not bundled |
| **Local** | The user's machine: [04](04-dashboards-presets-and-library.md) §3's persistent library, which also holds node presets | Never distributed unless the user publishes it |

- **Publish from the UI.** "Publish component…" bumps the version and writes the `.loom.json` plus metadata: author, tags, requirements (for example T1340b's), and a thumbnail. It then **opens a pull request against the curated repo**. Maintainers review and merge, and the index updates.
- **Version tracking.** An instance records `{tier, componentId, version}`. The palette shows when an update is available and upgrades through the existing upgrade path (§V84: never in bulk, one instance at a time). A component can be promoted from local to community to built-in.
- **Placing copies the network.** Placing a component from any tier copies its network into the project ([01](01-comps-as-folders.md) §3.1), linked only if asked. So a project still opens the same on a machine without the community index or the local library.
- **Safety.** Components are data: expressions run in Loom's own grammar with no `eval` (§V71), and actions are commands, never code ([07](07-command-bus.md) §1). That makes a third-party palette far safer than TD's Python-carrying `.tox` files, which is worth saying when the community tier is announced. Container stylesheets and any future script widgets are the exception, and need [README](README.md)'s trust ruling first.

## 5. Open questions for the maintainer

- Does the stronger family colour replace T712's "very subtle" rule, or sit beside it (header band only)?
- Does `buffer` stay its own family or fold into DAT?
- Who hosts the curated repo, and what is the review bar? CI could render a thumbnail and run a GPU smoke test per component.
- How does a browser-only app open a PR: GitHub's OAuth device flow, or the local helper shelling out to `gh`?

## Proposed §T rows

```
T____|.|**FAMILY COLOUR MATCHES PORT HUE.** Each family carries a distinct colour matching its port hue (header band or saturated edge, TD-style), body neutral; category badge stays the dim role signal. Ruling needed on T712 / §V90's ≤9 ΔE bound (`node-family.test.ts`).|T712,V90,V26,T964
T____|.|**MAT FAMILY.** Split `material` from `spatial`; `spatial` becomes the 3D-object family.|T712,V705
T____|.|**DAT FAMILY.** The table type (06) as its own family; decide whether `buffer` folds in.|T712,T____
T____|.|**PUBLISHED COMPONENTS + PALETTE TIERS.** "Component" = a published, versioned COMP; "publish" reserved for components, "promote" for custom parameters. Palette tiers built-in / community (curated repo, on-demand download) / local (04's library); "Publish component…" opens a PR against the curated repo; instances record {tier, componentId, version}; upgrades via §V84, never in bulk. Gate: a community component placed into a project opens identically with the index offline.|V79,V84,V71,T____
```
