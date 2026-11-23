# 07. The command bus: no eval, a command bible, arguments, user-defined commands

*Part of the [COMP model proposal](README.md). Independent of the COMP work, except that command targets use paths ([01](01-comps-as-folders.md) stage 1). [05](05-mappers.md)'s action column waits on §3 here. The whole document is RFE-level: nothing here blocks the rest.*

## 1. No eval, and why it has to stay that way

Loom never evaluates JavaScript from a document. Its expressions run in its own grammar: numbers, operators, parentheses, scope variables, `op()` references and a closed list of maths functions, with no `eval` and no `Function` (`src/domain/expressions/`). Three things depend on that:

- **Opening a file is safe.** A project, a COMP from someone else, a mapping table or a library preset imported from the internet cannot run code on the machine that opens it.
- **The phone and web remote are safe.** They render panels from the same document over the LAN.
- **Agents and humans have one door.** Everything that changes a document is a command (§2), so it is audited, undoable and permission-checked whoever asked.

So anything in this proposal that "does something" when an input arrives is **data naming a command**, never code. That includes the TD idiom `parent.reset.pulse()` and an `onValMax` callback in HIVE's mapper.

## 2. What a bus command is

Every change to a document goes through one function: `AppCommandBus.execute(name, input, context)` (`src/domain/commands/`). A command is:

- **A registered name**: `cue.go`, `cue.back`, `transport.togglePlay`, `preset.delete`, `component.saveSelection`, `graph.applyPatch`… The bus can list them all (`listCommands`, `bus.ts:556`); there are on the order of a hundred.
- **A validated input.** Each registration carries an input schema, and the bus refuses input the schema rejects before the handler runs (`bus.ts:597`, §T1556b). It can also declare the capability classes it needs (`requiredCapabilities`).
- **A recorded actor.** The context says who asked: human, agent or system.
- **One atomic, undoable change.** Each one applies as a `GraphPatch` with a revision check and an audit entry.

Menus, the keymap, the palette, the inspector, the phone door and the agent tools are all adapters over this bus.

## 3. RFE: command arguments on triggers

Today a trigger can fire a **pulse parameter** by path from any mode (§V125). That already covers "reset this", "recall that", "go to the next cue" whenever the target exposes a pulse. What's missing is firing a **command with arguments** from a trigger: a mapping row, a panel button, a cue. Proposed:

- An **action** is data, for example `{ command: "cue.go", input: { list: "show/cuelist1" } }` (input shape illustrative). It is checked against the command's input schema when it is authored and again when it fires, and paths in it are folder-relative like every other address.
- It fires on a **condition**: a value crossing non-zero, a rising edge, a release.
- Only commands marked **trigger-safe** can be actions. Marking is an explicit flag on the registration: `cue.go` is safe; `project.save` or `asset.attach` are not. The allowlist is the bible's (§4) "trigger-safe" column.
- Undo groups follow the gesture: one fired action is one undo step, with the actor recorded as the device or surface that fired it.

## 4. A command bible

A generated reference of every registered command, so users, agents and reviewers can see what the bus accepts:

- **One row per command**: name, description, input schema (rendered as fields with types and ranges), required capabilities, undoable or not, trigger-safe or not, and which surfaces offer it (menu, keymap, palette, agent tool).
- **Generated from the registry, never written by hand.** A gate fails if a registered command has no description, or if the bible differs from what the registry produces. That is the same rule `command-holder.test.ts` applies to coverage today, and `doc-drift` applies to example notes.
- **Shown in the table editor** ([06](06-tables.md)) and searchable from the palette. An action field in a mapper row ([05](05-mappers.md)) is a picker over it.

## 5. RFE: user-defined commands

Users should be able to define their own commands and register them, without code:

- **A user command is a named, declarative sequence** of registered commands with typed **slots**. For example (input shapes illustrative), `show.blackout(fade: number)` might stand for `preset.recall {bank: "show/looks", name: "black", morph: $fade}` followed by `cue.setStandby {list: "show/cues", name: "1"}`.
- **It is validated as a whole.** Every step's input is checked against its command's schema with the slots' declared types, at definition time and at run time. A step naming a missing path fails gracefully and names the step, as a missing mapping does ([05](05-mappers.md)).
- **It registers on the bus** like a built-in, so it appears in the bible, the palette, the keymap, mapper actions and the agent surface. It is trigger-safe only if every step is.
- **It runs as one undo group**, with one audit entry naming the user command and the actor.
- **It lives in a COMP** (it travels with the COMP, and its paths are relative to it), **in the project**, or **in the persistent library** ([04](04-dashboards-presets-and-library.md) §3). Its namespace says where it came from: `rig.reset`, `show.blackout`, `lib.strobeFlash`.

There are no loops, conditionals or arithmetic beyond what slots and expressions already allow. A user command composes commands; it does not become a scripting language.

## Proposed §T rows

```
T____|.|**RFE: COMMAND ACTIONS ON TRIGGERS.** An action = {command, input} data, schema-checked at authoring and firing, folder-relative paths, fired on a condition (non-zero, rising edge, release) from a mapping row, panel button or cue; only commands flagged trigger-safe; one undo step per firing, actor = the device/surface.|T1556b,V125,T____
T____|.|**COMMAND BIBLE.** Generated reference of every registered command: name, description, input schema as fields, capabilities, undoable, trigger-safe, surfaces offering it. Gate: a command with no description, or a bible that differs from the registry, fails. Shown in the table editor; the action picker reads it.|T1556b,T____
T____|.|**RFE: USER-DEFINED COMMANDS.** Declarative named sequences of registered commands with typed slots; validated per step at definition and run time; registered on the bus (bible, palette, keymap, mapper actions, agent); one undo group and audit entry; scoped to a COMP, the project or the persistent library; trigger-safe only if every step is. No loops or conditionals.|T____
```
