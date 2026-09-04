import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { nodeByName, nodeNames } from "../graph/names.ts";
import type { NodeReferenceReader, NodeReferenceResult } from "../expressions/index.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { ParameterDefinition, ParameterSchema, ParameterValue } from "../types/parameters.ts";
import { componentKey, componentNamesFor } from "./slots.ts";
import {
  CHANNEL_RESOLVER_MISSING,
  effectiveParameterSchema,
  resolveParameterSchema,
  type ChannelResolver,
  type ResolveParametersOptions,
} from "./resolve.ts";

/**
 * Reading `op('noise1').par.gain` — the cross-node value path (T316, §V148, §V127).
 *
 * The reference has been storable, validatable and rename-rewritable since T221: the
 * grammar parses it, `names.ts` rewrites it when the target is renamed, and liveness
 * counts it as a dependency (§V154). What it could not do was RESOLVE, so "copy
 * reference → paste → evaluate" — §V148's round trip — held only for the same-node case,
 * which becomes a bind. A cross-node paste stored correctly and then failed.
 *
 * ## One reader, both sides
 *
 * The seam is `ResolveParametersOptions.nodes`, and the reason it is there rather than in
 * the inspector is B8. When the compiler and the inspector each had their own idea of
 * what a parameter was worth, the inspector showed the corrected value and the GPU
 * rendered the other one. A reader supplied by only one of them recreates exactly that,
 * inverted: the plan would carry the referenced value and the panel would show the
 * fallback. So the compiler builds one from the graph it is compiling, the inspector
 * builds one from the graph it is showing, and both go through this function.
 *
 * ## Why resolution recurses, and why that needs a guard
 *
 * `op('a').par.x` is worth whatever `a.x` RESOLVES to, and `a.x` may itself be an
 * expression reading `op('b').par.y`. So a read is a resolve, and a chain of references
 * is a chain of resolves. Which means it can close a loop.
 *
 * §V152 wants that rejected at authoring time with the path named, and since T331 it is:
 * `referenceCyclesThrough` refuses the patch that closes the loop, and
 * `referenceCycleDiagnostics` reports one that arrived from a file. This guard is the
 * last line rather than the only one — §V244's point being that a runtime mitigation must
 * not become the reason the gate never gets built. It stays because a `.loom.json` can
 * still be hand-edited, and it names the loop rather than reporting a stack overflow,
 * because a user who typed the cycle needs to be told which two nodes they joined.
 *
 * The visited set is keyed by NODE, and the gate is keyed the same way on purpose: a read
 * resolves the target's whole schema, so `a.x → b.y` plus `b.z → a.w` really does recurse
 * even though the two parameter chains never touch. Making either half finer without the
 * other would accept documents the other refuses.
 */

/**
 * A path this reader understands. `par` is the only namespace v1 exposes, and one
 * component may follow the parameter (`par.color.r`, §V113/T332).
 */
const PARAMETER_NAMESPACE = "par";
/** T901: `op('lfo1').chan.value` — a value node's OUTPUT channel, TD's CHOP-read idiom. */
const CHANNEL_NAMESPACE = "chan";

/**
 * WHAT `op('…')` CAN COMPLETE TO (T990), answered by the module that decides what it can
 * READ.
 *
 * The owner asked twice: "we know all the node names… and then the sub-properties should
 * also be autosuggested and completable so we don't have to guess all the time." The
 * guessing is the whole cost — a reference is three decisions deep (a name, a namespace,
 * a member) and every one of them fails silently into §V108's retained fallback, so a
 * typo reads as a working wire showing a plausible number.
 *
 * It lives HERE, beside the reader, rather than in the panel that draws the menu, and
 * that is the point rather than a filing convenience. §V150 says a menu that offers what
 * the grammar rejects teaches a wrong API with the tool's own authority; the only way to
 * be sure that cannot happen is for the offer and the refusal to read the same two
 * namespace constants, the same `schemaOf` funnel and the same `componentNamesFor`. A
 * second list in the UI layer would be right on the day it was written.
 *
 * §B170 binds the NAME half: `op()` takes the LABEL, never the id, and two examples
 * shipped dead because something matched on the wrong one. `nodeNames` is the authority
 * and it is keyed by label, so the offer cannot get that wrong either.
 */
export interface NodeReferenceMember {
  readonly text: string;
  /** Shown beside the name: what accepting it would read. */
  readonly detail?: string;
}

export interface NodeReferenceCatalogueOptions {
  readonly graph: GraphDocument;
  /** The same schema funnel the reader uses (§V814): a node's EFFECTIVE parameters. */
  readonly schemaOf: (node: GraphNode) => ParameterSchema | undefined;
  /**
   * The channel names the node called `name` is publishing RIGHT NOW.
   *
   * A function supplied by the caller, and it has to be: a bag is `valueEvaluate`'s
   * RETURN VALUE, so nothing in a definition declares its channel names — `valueMath`
   * republishes whatever arrives, `oscIn` and `midiIn` take theirs off the wire. There is
   * no static list to read and inventing one would be §V150's wrong-API menu. Absent, the
   * `chan` namespace still completes (it is a real namespace) and offers no members,
   * which is the truth: nothing here knows what is on the wire.
   */
  readonly channelsOf?: (name: string) => readonly string[];
}

/** Every name `op('…')` can address — LABELS (§B170), in the graph's own sorted order. */
export function nodeReferenceNames(graph: GraphDocument): readonly string[] {
  return [...nodeNames(graph).keys()];
}

/**
 * The members completable at `op('name').<path…>.` — where `path` is the segments already
 * typed IN FULL and the answer is the set of next segments.
 *
 * `[]` for anything the reader would refuse: a name that is not in the graph, a namespace
 * that is not one of the two, a member under a channel (a channel is a leaf), a parameter
 * whose value an expression cannot read. That last filter is the one worth stating: an
 * `enum` resolves to a string and `asNumber` refuses it BY NAME, so offering it would be
 * a suggestion whose only outcome is the error message underneath it.
 */
export function nodeReferenceMembers(
  options: NodeReferenceCatalogueOptions,
  name: string,
  path: readonly string[],
): readonly NodeReferenceMember[] {
  const targetId = nodeByName(options.graph, name);
  const target = targetId === undefined ? undefined : options.graph.nodes[targetId];
  if (target === undefined) return [];

  const [namespace, key, ...rest] = path;
  if (namespace === undefined) {
    return [
      { text: PARAMETER_NAMESPACE, detail: "a parameter" },
      { text: CHANNEL_NAMESPACE, detail: "a published channel" },
    ];
  }
  if (rest.length > 0) return [];

  if (namespace === CHANNEL_NAMESPACE) {
    // `.chan.<channel>` is the whole path the reader accepts — nothing hangs off a channel.
    if (key !== undefined) return [];
    return (options.channelsOf?.(name) ?? []).map((text) => ({ text }));
  }
  if (namespace !== PARAMETER_NAMESPACE) return [];

  const schema = options.schemaOf(target);
  if (schema === undefined) return [];
  if (key === undefined) {
    return Object.entries(schema)
      .filter(([, definition]) => readableAsNumber(definition))
      // The LABEL as the detail, because a key is an identifier and a label is what the
      // user saw in the panel they are referring to — `gain` next to "Gain" costs nothing
      // and `lowMid` next to "Low Mid" is the difference between finding it and not.
      .map(([parameterKey, definition]) => ({ text: parameterKey, detail: definition.label }));
  }
  const definition = schema[key];
  if (definition === undefined) return [];
  return (componentNamesFor(definition) ?? []).map((text) => ({ text }));
}

/**
 * Can an expression read this parameter — as a number itself, or via a component?
 *
 * Keyed on what `asNumber` accepts (number, boolean) plus the compounds `componentNamesFor`
 * can descend into, and NOT on a hand-kept type list, so a parameter kind added to the
 * union arrives excluded rather than silently offered.
 */
function readableAsNumber(definition: ParameterDefinition): boolean {
  if (componentNamesFor(definition) !== null) return true;
  return definition.type === "number" || definition.type === "boolean";
}


export interface NodeReferenceOptions {
  readonly graph: GraphDocument;
  /**
   * The parameter schema for a node, which is the definition's manifest — passed as a
   * lookup rather than a registry so a component's PUBLISHED schema (§V80), which exists
   * before any node manifest does, resolves through the same reader.
   */
  readonly schemaOf: (node: GraphNode) => ParameterSchema | undefined;
  /**
   * Everything else the referenced parameter needs to resolve — the frame, the channel
   * resolver. Carried through unchanged so a referenced expression reading `time` reads
   * the SAME time as the expression referencing it. Two frames in one evaluation is a
   * value that is right on its own and wrong in context.
   */
  readonly base?: Omit<ResolveParametersOptions, "nodes" | "schema">;
}

/**
 * A number, or a reason it is not one.
 *
 * Only numeric parameters are readable, and that is §V71's rule rather than a limitation
 * of this function: an expression evaluates to a number, so a reference inside one has to
 * be a number too. A curve reports what it is instead of being coerced into whatever its
 * first channel happens to hold; a COMPOUND says which components it has, because
 * `op('x').par.color.r` is now a thing you can write (T332) and "reads a number" alone
 * would send the user looking for the wrong fix.
 */
function asNumber(value: ParameterValue | undefined, reference: string): NodeReferenceResult {
  if (typeof value === "number") return { ok: true, value };
  if (typeof value === "boolean") return { ok: true, value: value ? 1 : 0 };
  if (value === undefined) return { ok: false, reason: `${reference} has no value` };
  return {
    ok: false,
    reason: `${reference} is ${Array.isArray(value) ? "a list" : typeof value}, and an expression reads a number`,
  };
}

export function createNodeReferenceReader(options: NodeReferenceOptions): NodeReferenceReader {
  return readerWithin(options, new Set());
}

/** What a call site knows: the graph being read, the catalogue, and WHEN. */
export interface ParameterReadContext {
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
  /**
   * The moment. A PARAMETER rather than a field the caller sets afterwards, because
   * setting it on the resolve and forgetting it on the reader is the entire bug (§B46).
   */
  readonly frame?: FrameEvaluationInput | undefined;
  /** Absent = `op('x').chan.*` reports "no channel resolver" and §V108's static stands. */
  readonly channels?: ChannelResolver | undefined;
}

/**
 * §V837 / §T1129 — THE ONE FACTORY. The reader and the options it is read alongside are
 * built here, together, or they are not built.
 *
 * `op('lfo1').chan.value` is read INSIDE the reader, off `NodeReferenceOptions.base`. The
 * reader is a CLOSURE built before the resolve, so the `frame` and `channels` handed to
 * `resolveParameters` never reach it: a caller that builds a reader with no `base` gets a
 * panel, a plan or a pump that answers every `.chan` read with "this context has no
 * channel resolver", falls back to §V108's retained static, and freezes there while the
 * picture animates. That is §B8's shape, and it has now recurred FOUR times — §T593, the
 * inspector (§T1000), the OSC pump (§T1001), and §B46 before them.
 *
 * Every one of those fixes was correct and local, and every one left the next call site
 * free to omit the pairing again: three sites each spelled this out, and nothing made
 * site four spell it. So the pairing is no longer spelled at a call site at all. A caller
 * says WHICH graph, WHICH catalogue and WHEN; it cannot say "reader without base",
 * because there is no longer an argument for it.
 */
export function createParameterReadOptions(
  context: ParameterReadContext,
): Pick<ResolveParametersOptions, "frame" | "channels" | "nodes"> {
  const base = {
    ...(context.channels === undefined ? {} : { channels: context.channels }),
    ...(context.frame === undefined ? {} : { frame: context.frame }),
  };
  return {
    nodes: createNodeReferenceReader({
      graph: context.graph,
      /*
       * §T903 — through the funnel: `op('lantern').par.orbitSpeed` reads a key that only
       * exists in the node's REFLECTED schema, and a static-schema reader would answer
       * "no such parameter" for a control the inspector is showing.
       */
      schemaOf: (node) => effectiveParameterSchema(context.registry.get(node.type), node.parameters),
      base,
    }),
    ...base,
  };
}

/**
 * `visited` carries the chain of nodes already being resolved on THIS path.
 *
 * Per-path, not per-reader: two unrelated parameters both reading `op('gain1').par.value`
 * are not a cycle, and a reader that shared one visited set across a whole compile would
 * call the second one a loop. The set grows only as the recursion descends.
 */
function readerWithin(
  options: NodeReferenceOptions,
  visited: ReadonlySet<NodeId>,
): NodeReferenceReader {
  return (name, path): NodeReferenceResult => {
    const reference = `op('${name}').${path.join(".")}`;

    const [namespace, key, component, ...rest] = path;

    /**
     * T901 — `op('name').chan.<channel>`: a value node's OUTPUT, read through the SAME
     * channels resolver the old `driven` mode used, so an expression can do inline maths on
     * a live signal (`op('lfo1').chan.value * 2 + 0.1`) — TD's model, where a channel read
     * is just an expression term and no separate mode exists. `.chan.value` also answers a
     * node's single/bare channel, exactly as the bare `driven` address did, so §T897's
     * migration maps `name` → op('name').chan.value and `name:c` → op('name').chan.c with
     * identical resolution by construction.
     */
    if (namespace === CHANNEL_NAMESPACE) {
      if (key === undefined || component !== undefined || rest.length > 0) {
        return {
          ok: false,
          reason: `${reference}: name one channel, as op('${name}').chan.value or op('${name}').chan.low`,
        };
      }
      const channels = options.base?.channels;
      if (channels === undefined) {
        // §V338: name what would make it present, not accuse the graph — same contract as
        // the old driven mode's missing-resolver case, and the same INFO tier: resolve.ts
        // matches this marker to degrade the failure, because a headless caller with no
        // resolver is a normal state, not a broken document.
        return {
          ok: false,
          reason: `${reference}: ${CHANNEL_RESOLVER_MISSING}, so "${name}"'s channels cannot be read`,
        };
      }
      const channelTarget = nodeByName(options.graph, name);
      const channelNode = channelTarget === undefined ? undefined : options.graph.nodes[channelTarget];
      if (channelNode === undefined) {
        return { ok: false, reason: `${reference}: there is no node named "${name}"` };
      }
      // The resolvers in use (value graph, analyze) key on the ADDRESS; the context rides
      // along for ones that want the frame. The definition is nominal — a channel is a
      // number by contract (§V143).
      const channelContext = {
        node: channelNode,
        key,
        definition: { type: "number", label: key, default: 0 } as const,
        ...(options.base?.frame === undefined ? {} : { frame: options.base.frame }),
      };
      const direct = channels(`${name}:${key}`, channelContext);
      const supplied = direct ?? (key === "value" ? channels(name, channelContext) : undefined);
      if (typeof supplied !== "number" || !Number.isFinite(supplied)) {
        return {
          ok: false,
          reason: `${reference}: "${name}" publishes no channel "${key}" right now`,
        };
      }
      return { ok: true, value: supplied };
    }

    if (namespace !== PARAMETER_NAMESPACE) {
      return {
        ok: false,
        reason: `${reference}: only .${PARAMETER_NAMESPACE} and .${CHANNEL_NAMESPACE} are readable (op('${name}').par.<parameter>, op('${name}').chan.<channel>)`,
      };
    }
    if (key === undefined || rest.length > 0) {
      return {
        ok: false,
        reason: `${reference}: name one parameter, as op('${name}').par.gain, or one of its components, as op('${name}').par.color.r`,
      };
    }

    const targetId = nodeByName(options.graph, name);
    if (targetId === undefined) {
      return { ok: false, reason: `${reference}: there is no node named "${name}"` };
    }
    if (visited.has(targetId)) {
      // §V152. Named, not "maximum call stack exceeded": the user joined two specific
      // nodes and has to be told which.
      return {
        ok: false,
        reason: `${reference}: that reference is a cycle (${[...visited, targetId].join(" → ")})`,
      };
    }
    const target = options.graph.nodes[targetId];
    if (target === undefined) {
      return { ok: false, reason: `${reference}: there is no node named "${name}"` };
    }
    const schema = options.schemaOf(target);
    if (schema === undefined) {
      return { ok: false, reason: `${reference}: "${name}" has an unknown node type` };
    }
    const definition = schema[key];
    if (definition === undefined) {
      return { ok: false, reason: `${reference}: "${name}" has no parameter "${key}"` };
    }

    /**
     * §V113's component addressing, reached from another node (T332).
     *
     * The grammar has parsed `op('x').par.color.r` since T221; the reader refused it
     * rather than guess a namespace. It is not a nicety: colour is stored as four
     * independently-moded slots precisely so one channel can be driven, and a channel
     * nothing outside its own node can read is only half of that.
     *
     * The names and the error wording come from `componentNamesFor` and read like the
     * LOCAL bind case (`color.r` as a bind ref, `resolveBindRef`) because §V113 already
     * settled that grammar — a second spelling for the same idea is a thing users have to
     * learn twice and we have to keep in sync forever.
     *
     * The number handed back is the channel in its STORED space, which for a
     * `space: "display"` colour means the picker's number and not the linear one. Same as
     * the local bind, same as `ResolvedParameter.value`, and deliberate: the decode
     * happens once, where `values` leaves the resolver as evaluation input (T148, §V56).
     * Decoding here would decode twice for anything that lands back on a colour — T187's
     * measured bug (stored 0.5 reached the shader as 0.0376), and the reason the rule is
     * written down at all.
     */
    const componentNames = componentNamesFor(definition);
    if (component !== undefined) {
      if (componentNames === null) {
        return {
          ok: false,
          reason: `${reference}: "${key}" is a ${definition.type} and has no components`,
        };
      }
      if (!componentNames.includes(component)) {
        return {
          ok: false,
          reason: `${reference}: "${key}" has no component "${component}" (it has ${componentNames.join(", ")})`,
        };
      }
    }

    // The recursive step. The target resolves with the same frame and channels, and with
    // a reader that remembers we came through here — so a loop is caught one hop before
    // it would repeat rather than however many frames later the stack gives out.
    const resolved = resolveParameterSchema(target, schema, {
      ...options.base,
      nodes: readerWithin(options, new Set([...visited, targetId])),
    });

    /**
     * The referenced parameter has to have resolved, not merely produced a number.
     *
     * §V108 hands back a fallback whenever a binding fails, so `values[key]` is populated
     * either way — and reading it blindly makes a broken reference look healthy. It is
     * worst for cycles: a loop is caught one hop down, that hop falls back to its default,
     * and the caller reads the default as a perfectly good answer. The cycle is then
     * INVISIBLE at the top of the chain, which is precisely where the person who wrote it
     * is looking.
     *
     * So a diagnostic on the referenced entry propagates. It is the right rule beyond
     * cycles too: referencing a parameter whose own expression is broken should say that,
     * rather than quietly yield the default and read as a working reference to a wrong
     * number.
     */
    const entry = resolved.get(key);

    if (component !== undefined) {
      const resolvedComponent = entry?.components?.find((each) => each.name === component);
      /**
       * §V262 — §V243 applied to the channel actually being read, and not wider.
       *
       * A component with its OWN slot resolved on its own terms, so the compound's
       * fallback says nothing about it and forwarding that diagnostic would be a false
       * alarm on a channel that is fine. One with no slot follows the compound, so it
       * inherits the compound's problem along with the compound's number — and reporting
       * the value without the diagnostic is exactly the fallback-hides-the-error trap,
       * one channel at a time and therefore harder to see.
       */
      const storedItself = target.parameters[componentKey(key, component)] !== undefined;
      const governing =
        resolvedComponent?.diagnostic ?? (storedItself ? null : (entry?.diagnostic ?? null));
      if (governing !== null) return { ok: false, reason: `${reference}: ${governing.message}` };
      return asNumber(resolvedComponent?.value, reference);
    }

    if (entry?.diagnostic != null) {
      return { ok: false, reason: `${reference}: ${entry.diagnostic.message}` };
    }
    if (componentNames !== null) {
      // A compound read WHOLE. Taking channel 0 would be a number that looks like an
      // answer (§V71); the fix is one keystroke away, so the message spells it.
      return {
        ok: false,
        reason: `${reference} is a ${definition.type}, and an expression reads a number — name a component, as ${reference}.${componentNames[0] ?? "r"}`,
      };
    }
    return asNumber(entry?.value, reference);
  };
}
