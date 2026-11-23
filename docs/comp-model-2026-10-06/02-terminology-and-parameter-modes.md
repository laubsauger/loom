# 02. Terminology and parameter modes, on TouchDesigner's definitions

*Part of the [COMP model proposal](README.md). Depends on [01](01-comps-as-folders.md) for paths. Everything after it uses this vocabulary.*

Loom borrows TouchDesigner's idiom (TOP, POP, COMP), but several of its words mean something different from TD's. A user arriving from TD reads "bind", "panel" or "component" and expects TD's behaviour, and today gets something else. This document proposes adopting TD's definitions wherever Loom has an equivalent, and renaming where Loom's word collides.

## 1. Terms that collide today

| Loom today | What it means in Loom | TD's word, and what TD means by it | Proposed |
|---|---|---|---|
| **component** | A linked instance of a definition in `componentLibrary` (§V79); always a clone | **COMP**: an operator that *contains a network*. Cloning is an option on it (Common page: Clone, Enable Cloning, Clone Immune) | **COMP**, a folder by default with linking opt-in ([01](01-comps-as-folders.md)). "Component" is kept for a **published**, versioned COMP in the palette ([08](08-families-colour-and-palette.md)) |
| (none) | — | **Base COMP**: a container with no panel | **Base COMP**: the generic container ([03](03-base-and-container-comps.md)) |
| **Panel** (node) | A standalone control desk that lays out widget nodes wired into it (`controls.ts:595`) | **panel**: the UI surface of a panel COMP. A **Container COMP**'s panel arranges its children's panels | **Container COMP**. Today's Panel node becomes a Container COMP whose children are controls ([03](03-base-and-container-comps.md)) |
| **widget** (`slider`, `toggle`, `button`, `xyPad`) | Value nodes that publish a channel | **panel COMPs**: Slider COMP, Button COMP, Field COMP… each a COMP with a panel and panel values | Controls on a dashboard or a Container's panel ([03](03-base-and-container-comps.md), [04](04-dashboards-presets-and-library.md)) |
| **published parameter**, **published page** | An inner parameter promoted onto the component's page; the instance's value fans out to its targets (§V80) | **custom parameter** on a **custom page**. Promoting an inner parameter means binding it to a custom parameter | **custom parameter**. The gesture becomes **promote**: it creates a custom parameter that inner parameters **bind** to (§2 below). "Publish" is reserved for components ([08](08-families-colour-and-palette.md) §3) |
| **bind** (mode) | A one-way pull from a parameter already in scope: a sibling or `parent.<key>` (`resolve.ts`, `case "bind"`) | **Bind**: two-way and value-identical with a **bind master** | **Bind, TD's meaning** (§2). Today's one-way bind is migrated to an expression |
| `parent.<key>` | Read the owning component's published parameter `key` (§V81) | `parent()` is the parent COMP, so `parent().par.Key` reads its parameter. `parent.Name` is a **parent shortcut** (Common page) | `parent().par.key` for parameters, `parent.Name` for shortcuts ([03](03-base-and-container-comps.md) §4). Old spellings migrate on load |
| **detached** | Spill a component's internals into the parent graph and drop the container | Turning cloning off: the COMP stays, the link goes | Retired; "unlink" keeps the folder ([01](01-comps-as-folders.md), stage 3) |
| `componentOverrides` | Per-instance overrides of a definition's internals | **Clone Immune**: children whose local state survives master updates | Clone-immune children of a linked COMP ([01](01-comps-as-folders.md)) |
| **channel** | A named number a value node publishes | **CHOP channel** | Same concept; no change |
| **expression** mode | A formula in Loom's grammar: `op('x').par.y`, `op('x').chan.y` | **Expression** mode | Same concept, called a **reference** when it reads another parameter or channel |
| **static** mode | A typed value | **Constant** mode | **Constant**, same behaviour |

Renames land as display text and documentation first. Stored mode names (`static`, `expression`, `bind`) change only where the meaning changes, which is `bind` alone.

## 2. Parameter modes

TD gives every parameter one of four modes. Loom keeps three; TD's fourth, Export (a CHOP pushing into a parameter), is left out. It is largely superseded in current TD practice, and the mapper's writes ([05](05-mappers.md)) cover the case of hardware pushing into a parameter.

| Mode | Meaning | Direction | Editable in the inspector? | Many-to-one? |
|---|---|---|---|---|
| **Constant** | A value typed into the parameter | — | Yes | — |
| **Reference** (TD: Expression) | The parameter computes its value from something else: `op('rig/projDS').par.throwRatio`, `op('desk/intensity').chan.value * 0.8`, `parent().par.gain`. May transform it: range, invert, curve | One-way: this parameter reads | You edit the expression or its range, not the value | Yes: any number of parameters may reference one source, each with its own transform |
| **Bind** | The parameter and its **bind master** hold **one value**. Change either and both change | Two-way | Yes: editing a binder writes the master, and every other binder follows | Yes: many binders, one master |

What separates the two that link:

- **A reference transforms; a bind does not.** A reference may re-range a 0..1 dashboard control to 0.3..2.5 throw. A bind is value-identical, so a bound parameter and its master always read the same number.
- **A reference makes its parameter read-only; a bind does not.** This is the dead inspector field Loom has today, named in upstream's own MIDI-learn note: "Bound controls reject manual writes" (`docs/panel-midi-learn-2026-10-04.md`). In TD terms those controls are referenced, not bound. Under this proposal you choose: reference it (transform, read-only) or bind it (identical, editable from either end).
- **One mode per parameter.** A parameter is Constant, Reference or Bind, never two at once. Binding a referenced parameter is refused with a sentence naming the reference: the "one link, one truth" rule source references already enforce (`src/compiler/source-reference-edges.ts`).

### Where each mode is used in the rest of the proposal

- **Promoting is a bind.** A COMP's custom parameter is the bind master; the inner parameters it drives are binders. Edit the inner parameter from inside the COMP and the custom parameter moves; edit the custom parameter and every inner binder follows. This replaces today's one-way fan-out (`internalParameterValues`, `src/domain/components/flatten.ts`) and the knob-holder workaround ([01](01-comps-as-folders.md) §2.3).
- **Dashboards are referenced.** A dashboard control is a normalized null; parameters reference it over their own ranges ([04](04-dashboards-presets-and-library.md)).
- **Mirrors are bound.** A second control surface showing the same value, a phone page, and a mapper's feedback output ([05](05-mappers.md)) bind to the value they show, so they see changes made anywhere.

### Migration

- **Today's `bind` becomes a reference.** A stored `bind` slot reading `parent.blur` or a sibling becomes the equivalent `expression` slot, value-identically, on load. This is the pattern §T897 used to retire `driven` (`src/domain/project/load.ts`: "Parse forever, emit never"). It frees `bind` for TD's meaning.
- **`parent.<key>` becomes `parent().par.key`.** The old spelling parses forever and is rewritten on save.
- **Gate.** Every shipped example loads, migrates and renders identically, and (per §V821) the gate asserts that both sides *resolved*, not only that they match.

## Proposed §T rows

```
T____|.|**TD TERMINOLOGY.** Display names and docs adopt TD's words where Loom has the equivalent: COMP (was component), custom parameter (was published parameter), Constant (was static), Reference (expression reading another parameter/channel), Container COMP (was Panel node), clone/clone-immune (was linked/overrides). Stored names change only where meaning changes (`bind`). Gate: copy-guard lists every user-facing string that still says "component" for a COMP.|T____
T____|.|**TD PARAMETER MODES: BIND TWO-WAY.** `bind` = TD bind: two-way, value-identical with a bind master, many binders per master; inspector edits on either end write the master. Today's one-way `bind` migrates to an equivalent reference on load (§T897's pattern). One mode per parameter; reference+bind refused by name. Publishing becomes a bind from inner parameters to the COMP's custom parameter. Gate: edit a binder and the master and every binder read it; a pre-migration document renders identically, both sides resolved (§V821).|V81,V61,V80,T897
T____|.|**`parent()` AND `parent.Name`.** `parent()` / `parent(n)` return the enclosing COMP(s) in the expression grammar, `.par.key` reads a parameter; `parent.Name` resolves a parent shortcut (03). `parent.<key>` parses forever, saves as `parent().par.key`.|V81,T____
```
