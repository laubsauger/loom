import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { FrameEvaluationInput } from "../types/frame.ts";
import type { GraphNode } from "../types/graph.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import type {
  ParameterDefinition,
  ParameterMode,
  ParameterSchema,
  ParameterSlot,
  ParameterValue,
  StoredParameter,
} from "../types/parameters.ts";
import {
  evaluateExpression,
  scopeFromFrame,
  type ExpressionScope,
  type NodeReferenceReader,
} from "../expressions/index.ts";
import {
  componentDefinition,
  componentKey,
  componentNamesFor,
  isParameterSlot,
  parseComponentKey,
  staticBindingValue,
} from "./slots.ts";
import { defaultParameterValue, validateParameterValue } from "./validate.ts";
import { numericRangeOf, rangeRemedy } from "./expression-range.ts";

/**
 * THE parameter read path (doc §8.2, §V61, §V109).
 *
 * Nothing reads `node.parameters[key]` to work out what a parameter is worth. Every
 * effective value — for a control, for a diagnostic, and for evaluation — comes through
 * `resolveParameters`. Since T203 that is no longer a passthrough: a stored parameter
 * may be a bare value (static) or a `ParameterSlot` whose active mode is an expression
 * (§V71 grammar), a bind (a sibling parameter or `parent.<key>`, §V81) or a driven
 * channel (reserved for Phase 2 audio/MIDI). This module is the single place any of
 * those become a value (§V109); a second evaluator anywhere is B8 wearing a new hat.
 *
 * Compound parameters (§V113): the manifest declares `color` once, but storage may
 * carry a slot PER COMPONENT (`color.r`, `t.x`) so each channel has its own mode. The
 * resolver reassembles components into the compound value the shader wants — the OUTPUT
 * stays compound-keyed (`values.color` is a vec4, never four scalars). Component
 * addressing is a storage and binding concern; node authors and the compiler never see
 * component keys in `values`.
 *
 * Failure never hangs and never invents: an active mode that cannot produce a value
 * falls back to the slot's retained static payload (§V108), else the manifest default,
 * and says why in a diagnostic. Bind cycles are caught at authoring time
 * (`bind-cycles.ts`, §V110); the visited-set guard here is the runtime backstop.
 *
 * ## Why this module is in `src/domain/`, and headless (T168, B8)
 *
 * It used to live in `src/editor/inspector/`, with the compiler keeping a second copy
 * that resolved values its own way. The two drifted — the display→linear colour decode
 * landed in the editor's copy only, so the inspector showed the fix and the GPU did not
 * (B8). §V61 exists precisely to stop that, and one read path only holds if the path is
 * somewhere BOTH callers can reach: the compiler runs in Node (and must stay
 * worker-ready, §V63), the inspector runs in a browser. So: no React, no DOM, no
 * `src/ui` and no `src/editor` imports from this file, ever.
 */

export type ParameterSource =
  /** The document holds a usable value. */
  | "static"
  /** The document has no value (or one the manifest rejects); the default is in effect. */
  | "default"
  /** A driver, expression, bind or channel supplied the value this resolution. */
  | "driven";

/** One component of a compound parameter, resolved (§V113). For the UI's per-channel rows. */
export interface ResolvedComponent {
  name: string;
  mode: ParameterMode;
  value: number;
  /** The stored per-component slot, when one exists. Undefined = follows the compound. */
  slot: ParameterSlot | undefined;
  diagnostic: RuntimeDiagnostic | null;
}

export interface ResolvedParameter {
  key: string;
  definition: ParameterDefinition;
  /**
   * The value in effect: what a control shows and edits. For most parameter types this
   * is also what evaluation should consume — but a `color` declared `space: "display"`
   * stays display-encoded here (T148): decoding it would make the picker appear to
   * drift its own number every round trip. Evaluation reads the decoded number from
   * `ResolvedParameters.values` instead.
   */
  value: ParameterValue;
  /** What the document stores at the bare key — bare value or slot — for write-back. */
  stored: StoredParameter | undefined;
  source: ParameterSource;
  /** The active mode. Bare values are `static`; fallbacks still report the ACTIVE mode. */
  mode: ParameterMode;
  /** The stored envelope at the bare key, when there is one. What a mode UI renders. */
  slot: ParameterSlot | undefined;
  /** Convenience for the "this parameter is being driven" affordance. */
  driven: boolean;
  /** Per-component resolutions for compound parameters (§V113); undefined for scalars. */
  components?: readonly ResolvedComponent[] | undefined;
  /**
   * Why the value in effect is not the one the document (or the driver) supplied — the
   * manifest refused it, an expression failed, a bind broke — and what stood in. Null
   * when nothing was rejected. Per-component problems live on `components[].diagnostic`
   * and are all forwarded through `ResolvedParameters.diagnostics`.
   */
  diagnostic: RuntimeDiagnostic | null;
}

/**
 * A parameter driver — the pre-slot injection seam (`parent.<key>` fan-out from
 * flattening arrives this way, §V80/§V81). A driver outranks the stored slot: it is the
 * outer, per-instance statement.
 */
export interface ParameterDriverContext {
  node: GraphNode;
  key: string;
  definition: ParameterDefinition;
  /** Absent when resolving for display outside a frame (§V44: never a wall clock). */
  frame?: FrameEvaluationInput | undefined;
}

export type ParameterDriver = (context: ParameterDriverContext) => ParameterValue | undefined;

export type BindLookupResult =
  | { ok: true; value: ParameterValue }
  | { ok: false; message: string };

/**
 * Resolves a `parent.*` bind ref. The components track supplies one
 * (`parentBindResolver` in `src/domain/components/parent-scope.ts`) — declared here
 * structurally so this module never imports the components layer (§V81 stays one-way).
 */
export type ParentBindResolver = (ref: string) => BindLookupResult;

/** Reads a `driven` channel. Absent or returning undefined = channel not attached. */
export type ChannelResolver = (
  channel: string,
  context: ParameterDriverContext,
) => ParameterValue | undefined;

export interface ResolveParametersOptions {
  /** Per-node driver lookup, keyed by parameter. Outranks the stored slot. */
  drivers?: Readonly<Record<string, ParameterDriver>> | undefined;
  frame?: FrameEvaluationInput | undefined;
  /** Resolves `parent.*` bind refs (§V81). Absent = such binds report and fall back. */
  parentBind?: ParentBindResolver | undefined;
  /** Resolves `driven` channels. Absent = driven parameters retain their static value. */
  channels?: ChannelResolver | undefined;
  /**
   * The sibling schema, for same-node bind refs. `resolveParameterSchema` supplies it;
   * a caller resolving one parameter in isolation may omit it, and same-node binds then
   * report "sibling schema unavailable" rather than guessing.
   */
  schema?: ParameterSchema | undefined;
  /**
   * Reads `op('name').par.key` — another node's parameter (T316, §V148, §V127).
   *
   * Absent, a cross-node reference reports and falls back to §V108's retained value, as
   * it did for the whole time the read path did not exist. THAT is the state to be
   * careful about: a caller that omits this while another supplies it makes the same
   * document resolve to two different numbers, which is B8's exact shape. The compiler
   * builds one from the graph it is compiling and the inspector builds one from the graph
   * it is showing, so the two agree by construction rather than by discipline.
   */
  nodes?: NodeReferenceReader | undefined;
}

export interface ResolvedParameters {
  entries: readonly ResolvedParameter[];
  get: (key: string) => ResolvedParameter | undefined;
  /**
   * T286 (§V287): parameters whose ACTIVE mode is `map`, keyed exactly like `values`
   * (compound-component keys included). `values` still carries the retained static
   * for each — this record is the side channel a POINT consumer compiles from.
   */
  maps: Readonly<Record<string, ParameterMapBinding>>;
  /**
   * Effective values only — the shape evaluation wants, compound-keyed. Unlike
   * `entries[].value`, a `color` parameter here is decoded to linear when its manifest
   * says `space: "display"` (T148, §V56): this is the read path evaluation is meant to
   * use, so the decode belongs here rather than in each shader that would otherwise
   * redo it.
   */
  values: Readonly<Record<string, ParameterValue>>;
  /** Every rejected value, in manifest order. Empty when the document is clean. */
  diagnostics: readonly RuntimeDiagnostic[];
}

const clamp01 = (channel: number): number =>
  Number.isFinite(channel) ? Math.min(1, Math.max(0, channel)) : 0;

/**
 * sRGB electro-optical transfer function: a display-encoded channel → linear light.
 *
 * The same curve `src/ui/controls/color.ts` uses for the swatch, but this is the
 * evaluation side and it may not import from the UI layer (see the module note above).
 */
export function srgbToLinear(channel: number): number {
  const c = clamp01(channel);
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * The value evaluation should consume (T148, §V56, §V61, B8).
 *
 * A `color` parameter declared `space: "display"` holds a number that came straight out
 * of a colour picker — sRGB-encoded — while the project's working space is linear
 * (§V56). `resolveParameters` is the sole eval read path, so this is the one place that
 * decode belongs: fixed here, every picker-driven node (solid, ramp, checker, circle,
 * ...) is correct in the inspector AND in the plan, instead of each in-shader curve
 * doing its own slightly different conversion. A `space: "linear"` colour is already in
 * the working space and passes through untouched, and alpha is never touched either way
 * — it is coverage, not light, and encoding it would make 50% opacity read as a
 * different value than the one composed.
 *
 * This is deliberately NOT applied to `ResolvedParameter.value`: that value is what a
 * control displays and edits, and it must stay in the space the user picked (display),
 * or the colour picker would appear to drift its own number every time it round-trips
 * through the document. `values` is the separate "what evaluation wants" shape, so the
 * boundary is: decode happens only when values leaves the resolver as bulk evaluation
 * input, never on the per-entry value the inspector renders.
 */
function decodeRgba(value: readonly unknown[]): readonly number[] {
  const channel = (index: number, fallback: number): number => {
    const entry: unknown = value[index];
    return typeof entry === "number" && Number.isFinite(entry) ? entry : fallback;
  };
  return [
    srgbToLinear(channel(0, 0)),
    srgbToLinear(channel(1, 0)),
    srgbToLinear(channel(2, 0)),
    channel(3, 1),
  ];
}

function evaluationValue(definition: ParameterDefinition, value: ParameterValue): ParameterValue {
  /**
   * §V196 — a CONTAINER carrying colour declares its space like `color` does, and the
   * decode happens PER ENTRY. Decoding the container as a unit is not a thing that means
   * anything, and skipping it entirely reproduces B8 one gradient stop at a time: the
   * swatches in the inspector would be right and the pixels would not. A list makes that
   * N times harder to catch, because the eye checks one swatch and assumes the rest.
   */
  if (definition.type === "stops") {
    if (definition.space !== "display" || !Array.isArray(value)) return value;
    return value.map((stop) => {
      const entry = stop as { position?: unknown; color?: unknown };
      if (!Array.isArray(entry.color)) return stop as { position: number; color: readonly [number, number, number, number] };
      const [r = 0, g = 0, b = 0, a = 1] = decodeRgba(entry.color);
      return {
        position: typeof entry.position === "number" ? entry.position : 0,
        color: [r, g, b, a] as readonly [number, number, number, number],
      };
    });
  }
  if (definition.type !== "color" || definition.space !== "display") return value;
  if (!Array.isArray(value) || value.length !== 4) return value;
  const [r = 0, g = 0, b = 0, a = 1] = decodeRgba(value);
  return [r, g, b, a];
}

interface Checked {
  value: ParameterValue;
  diagnostic: RuntimeDiagnostic | null;
}

/**
 * A candidate value checked against the manifest. The document can legitimately
 * disagree with it — an older project, an unknown-node placeholder (§V10), an agent
 * patch built against a stale schema — and the answer is always the default plus a
 * report, never a silent coercion of the value the user can see.
 */
function checkAgainstManifest(
  key: string,
  definition: ParameterDefinition,
  value: ParameterValue,
  node: GraphNode,
): Checked {
  const diagnostic = validateParameterValue(key, definition, value, node.id);
  if (diagnostic === null) return { value, diagnostic: null };
  return { value: defaultParameterValue(definition), diagnostic };
}

/**
 * The zero frame, DERIVED rather than retyped (T489, §V150, §V316).
 *
 * This used to be a hand-written `{ time: 0, delta: 0, frame: 0 }`, and the hand list had
 * fallen five names behind `scopeFromFrame`: `walltime`, `walldelta`, `abstime` and
 * `absframe` were all absent. That is not a cosmetic gap, because `evaluateExpression`
 * treats an unknown name as a HARD FAILURE — so on the frameless paths (a Text node's
 * raster, a component instance's published values) `time * 2` resolved to `0` while
 * `abstime * 2` failed outright and fell back to the manifest default. A clock the rest of
 * the app offers, refused in one corner.
 *
 * Deriving it from `scopeFromFrame` of an all-zero frame means scope name #N+1 arrives
 * here by construction, the way `frameVariableNames` already does for the completion menu.
 */
const ZERO_FRAME_SCOPE: ExpressionScope = scopeFromFrame({
  timeSeconds: 0,
  deltaSeconds: 0,
  frameIndex: 0,
  mode: "offline",
  randomSeed: 0,
});

/** No frame = the deterministic zero frame (§V44), so a compile-time resolve of `time*2` is 0, not an error. */
function expressionScope(options: ResolveParametersOptions): ExpressionScope {
  return options.frame === undefined ? ZERO_FRAME_SCOPE : scopeFromFrame(options.frame);
}

type Coerced =
  | {
      ok: true;
      value: ParameterValue;
      /**
       * T368: the expression overshot the declared range and the value in effect is the
       * LIMIT, not the number the expression produced. Null when nothing was pinned.
       */
      clamped: { produced: number; limit: number } | null;
    }
  | { ok: false; message: string };

/**
 * Pins into the CLAMPING ends of the declared range, reporting whether it had to (T368).
 *
 * §B111/T537: it takes the DEFINITION rather than a loose min/max pair, because which of
 * those two numbers is a limit and which is only slider travel is a property of the
 * parameter and nothing else here can know it. `numericRangeOf` is the one reader of that
 * declaration; a rotation answers `null` and reaches the early return, so it climbs.
 */
function clampToDeclared(
  result: number,
  definition: ParameterDefinition,
): { value: number; clamped: { produced: number; limit: number } | null } {
  const range = numericRangeOf(definition);
  if (range === null) return { value: result, clamped: null };
  const { min, max } = range;
  if (min !== null && result < min) return { value: min, clamped: { produced: result, limit: min } };
  if (max !== null && result > max) return { value: max, clamped: { produced: result, limit: max } };
  return { value: result, clamped: null };
}

/**
 * An expression evaluates to a NUMBER (§V71); this is the documented bridge to every
 * parameter type (§V107). Number clamps into its declared range (an expression grazing
 * a limit should pin, not snap to default); boolean is ≠0; enum is a menu INDEX, the TD
 * convention for driving menus; string renders the number; a compound at its BARE key
 * broadcasts (per-channel expressions belong on component slots, §V113 — colour
 * broadcasts rgb and leaves alpha opaque, because a brightness expression should not
 * fade the layer out). Curve and asset stay out of reach on purpose: §V107 names
 * number, vector, colour, bool, enum, string — a curve from a scalar is not a thing.
 */
function coerceExpressionResult(definition: ParameterDefinition, result: number): Coerced {
  if (!Number.isFinite(result)) return { ok: false, message: "the expression is not finite" };
  switch (definition.type) {
    case "number": {
      const pinned = clampToDeclared(result, definition);
      return { ok: true, value: pinned.value, clamped: pinned.clamped };
    }
    case "boolean":
      return { ok: true, value: result !== 0, clamped: null };
    // §V125: a pulse driven by an expression is ARMED while the expression is non-zero.
    // The rising EDGE is what fires it (`createPulseWatcher`); a level here would make
    // `time > 4` reset the buffer on every frame after the fourth.
    case "pulse":
      return { ok: true, value: result !== 0, clamped: null };
    case "enum": {
      const index = Math.min(definition.options.length - 1, Math.max(0, Math.floor(result)));
      const option = definition.options[index];
      if (option === undefined) return { ok: false, message: "the enum has no options" };
      return { ok: true, value: option.value, clamped: null };
    }
    case "string":
      return { ok: true, value: String(result), clamped: null };
    case "vector": {
      const pinned = clampToDeclared(result, definition);
      return {
        ok: true,
        value: Array.from({ length: definition.size }, () => pinned.value),
        clamped: pinned.clamped,
      };
    }
    case "color":
      return { ok: true, value: [result, result, result, 1], clamped: null };
    default:
      return {
        ok: false,
        message: `a "${definition.type}" parameter cannot take an expression (§V107)`,
      };
  }
}

/** What one stored parameter (bare key OR component key) resolved to. */
interface StoredResolution {
  value: ParameterValue;
  mode: ParameterMode;
  source: ParameterSource;
  driven: boolean;
  diagnostic: RuntimeDiagnostic | null;
}

/** Enough digits to recognise the number, few enough to read in one line. */
const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;

/** The bounds as the manifest declares them — a range named is a range a user can check. */
function describeBounds(definition: ParameterDefinition): string {
  const range = numericRangeOf(definition);
  if (range === null) return "";
  if (range.min !== null && range.max !== null) return `${range.min}…${range.max}`;
  return range.max !== null ? `up to ${range.max}` : `from ${range.min}`;
}

function diag(
  severity: RuntimeDiagnostic["severity"],
  code: string,
  message: string,
  nodeId: string,
  suggestion?: string,
): RuntimeDiagnostic {
  return { severity, code, message, nodeId, ...(suggestion === undefined ? {} : { suggestion }) };
}

/**
 * §V108's fallback ladder: the active mode failed, so the slot's retained static value
 * stands in when the manifest accepts it, else the default. The ACTIVE mode is still
 * reported — the UI must show the expression square lit even while its value is broken.
 */
function fallback(
  node: GraphNode,
  key: string,
  definition: ParameterDefinition,
  slot: ParameterSlot,
  diagnostic: RuntimeDiagnostic,
): StoredResolution {
  const retained = staticBindingValue(slot);
  if (retained !== undefined && validateParameterValue(key, definition, retained, node.id) === null) {
    return { value: retained, mode: slot.mode, source: "static", driven: false, diagnostic };
  }
  return {
    value: defaultParameterValue(definition),
    mode: slot.mode,
    source: "default",
    driven: false,
    diagnostic,
  };
}

/** Per-resolution state: the visited set is the runtime bind-cycle backstop (§V110). */
/** One mapped parameter, as data (T286/§V287): the consumer's compile reads this. */
export interface ParameterMapBinding {
  readonly attribute: string;
  readonly channel?: string;
  readonly port?: string;
}

interface ResolveContext {
  node: GraphNode;
  options: ResolveParametersOptions;
  visited: Set<string>;
  /** Collector for map-mode bindings; absent on nested bind-ref resolution. */
  maps?: Map<string, ParameterMapBinding>;
}

function resolveStored(
  context: ResolveContext,
  key: string,
  definition: ParameterDefinition,
  stored: StoredParameter | undefined,
): StoredResolution {
  const { node } = context;
  if (stored === undefined) {
    return {
      value: defaultParameterValue(definition),
      mode: "static",
      source: "default",
      driven: false,
      diagnostic: null,
    };
  }

  if (!isParameterSlot(stored)) {
    const checked = checkAgainstManifest(key, definition, stored, node);
    return {
      value: checked.value,
      mode: "static",
      source: checked.diagnostic === null ? "static" : "default",
      driven: false,
      diagnostic: checked.diagnostic,
    };
  }

  const slot = stored;
  const binding = slot.bindings[slot.mode];
  if (binding === undefined || binding.kind !== slot.mode) {
    return fallback(
      node,
      key,
      definition,
      slot,
      diag(
        "warning",
        "parameter.slot.empty",
        `Parameter "${key}" is in ${slot.mode} mode but carries no ${slot.mode} payload.`,
        node.id,
        "Author the payload, or switch the mode back (§V108 keeps the old one).",
      ),
    );
  }

  switch (binding.kind) {
    case "static": {
      const checked = checkAgainstManifest(key, definition, binding.value, node);
      return {
        value: checked.value,
        mode: "static",
        source: checked.diagnostic === null ? "static" : "default",
        driven: false,
        diagnostic: checked.diagnostic,
      };
    }

    case "expression": {
      const evaluated = evaluateExpression(
        binding.source,
        expressionScope(context.options),
        context.options.nodes,
      );
      if (!evaluated.ok) {
        return fallback(
          node,
          key,
          definition,
          slot,
          diag(
            "warning",
            "parameter.expression",
            `Parameter "${key}" expression "${binding.source}" failed: ${evaluated.reason}`,
            node.id,
          ),
        );
      }
      const coerced = coerceExpressionResult(definition, evaluated.value);
      if (!coerced.ok) {
        return fallback(
          node,
          key,
          definition,
          slot,
          diag(
            "warning",
            "parameter.expression",
            `Parameter "${key}" expression "${binding.source}": ${coerced.message}.`,
            node.id,
          ),
        );
      }
      const checked = checkAgainstManifest(key, definition, coerced.value, node);
      if (checked.diagnostic !== null) return fallback(node, key, definition, slot, checked.diagnostic);
      return {
        value: checked.value,
        mode: "expression",
        source: "driven",
        driven: true,
        /**
         * T368 — the clamp is no longer mute. The value in effect IS the limit (pinning
         * beats snapping to a default for an expression grazing a bound), and that is
         * precisely why it needs saying: `time * 7` on a ±360 rotate is right at t=0 and
         * a stopped rotation from t≈51, and before this it produced no diagnostic at all.
         * The remedy is named, in this parameter's own numbers (§V288).
         */
        diagnostic:
          coerced.clamped === null
            ? null
            : diag(
                "warning",
                "parameter.expression.clamped",
                `Parameter "${key}" expression "${binding.source}" produced ${round4(coerced.clamped.produced)}, outside its range ${describeBounds(definition)}; the value in effect is clamped to ${coerced.clamped.limit}.`,
                node.id,
                rangeRemedy(binding.source, numericRangeOf(definition) ?? { min: null, max: null }) ??
                  undefined,
              ),
      };
    }

    case "bind": {
      const lookup = resolveBindRef(context, key, definition, binding.ref);
      if (!lookup.ok) {
        return fallback(
          node,
          key,
          definition,
          slot,
          diag(
            "warning",
            "parameter.bind",
            `Parameter "${key}" is bound to "${binding.ref}": ${lookup.message}`,
            node.id,
          ),
        );
      }
      const checked = checkAgainstManifest(key, definition, lookup.value, node);
      if (checked.diagnostic !== null) {
        return fallback(
          node,
          key,
          definition,
          slot,
          diag(
            "warning",
            "parameter.bind",
            `Parameter "${key}" is bound to "${binding.ref}", which does not fit it: ${checked.diagnostic.message}`,
            node.id,
          ),
        );
      }
      return { value: checked.value, mode: "bind", source: "driven", driven: true, diagnostic: null };
    }

    case "driven": {
      const resolver = context.options.channels;
      if (resolver === undefined) {
        /**
         * NO RESOLVER AT ALL is not "the channel is not attached" (T593, B121, §V338).
         *
         * The message below is a claim about the DOCUMENT: this parameter names a channel
         * and nothing in the project publishes it. Emitting it when the CALLER simply
         * brought no resolver states that claim about every driven parameter in every
         * document, which is exactly what `project.validate` did in every tab — an LFO
         * visibly driving a parameter was reported unattached, because the reader had no
         * way to look. An absence has to name what would make it present (§V338), so this
         * one names the missing reader instead of accusing the graph.
         */
        return fallback(
          node,
          key,
          definition,
          slot,
          diag(
            "info",
            "parameter.channels.unavailable",
            `Parameter "${key}" is driven by channel "${binding.channel}", but this context has no channel resolver, so nothing could be looked up and the retained value is in effect.`,
            node.id,
            "Channels are published by the running app. Resolve through the app's resolver (`CommandContext.channels`, `ResolveParametersOptions.channels`) to see the driven value; a headless caller has none.",
          ),
        );
      }
      const supplied = resolver(binding.channel, {
        node,
        key,
        definition,
        frame: context.options.frame,
      });
      if (supplied === undefined) {
        // Reserved, not broken (T203): the mode is declared now, its consumers are
        // Phase 2. Info severity — a project full of driven parameters with no device
        // attached is a normal state, not a wall of warnings.
        return fallback(
          node,
          key,
          definition,
          slot,
          diag(
            "info",
            "parameter.driven",
            `Parameter "${key}" is driven by channel "${binding.channel}", which is not attached; the retained value is in effect.`,
            node.id,
          ),
        );
      }
      /*
       * T628 (§V109, §V125): a channel delivers NUMBERS (an LFO, an audio feature), and
       * a pulse or boolean armed by one follows the SAME ≠0 rule an expression result
       * does — `coerceExpressionResult` is that rule's one home. Without this, a driven
       * pulse hit the boolean-trigger manifest check, fell back to its retained static
       * (always disarmed, §V124) and NEVER fired: an LFO wired to a reset was a wire
       * that did nothing, every unit suite green.
       */
      const armedKinds = definition.type === "pulse" || definition.type === "boolean";
      const value =
        armedKinds && typeof supplied === "number" && Number.isFinite(supplied)
          ? supplied !== 0
          : supplied;
      /*
       * B155 — a driven number PINS into its declared range, exactly as an expression
       * result does (T368), and for a harder reason: an expression's overshoot is
       * authored text the author can amend, but a channel's overshoot is a LIVE SIGNAL
       * (an audio band grazing its bound at a peak is the signal working, not a wrong
       * document). Before this, the overshoot went to `checkAgainstManifest` raw and
       * came back an ERROR — which snapped the value to the retained fallback, and,
       * because a structural compile resolves with the app's live channel resolver,
       * turned `plan.ok` false and blacked out the whole document whenever the compile
       * happened to land on a peak (E43: `gd1:high` at 1.06 on a 0…1 `amount`).
       * Validation of a document must not depend on what the audio was doing at the
       * instant of the compile.
       */
      const pinned =
        definition.type === "number" && typeof value === "number" && Number.isFinite(value)
          ? clampToDeclared(value, definition)
          : { value, clamped: null };
      const checked = checkAgainstManifest(key, definition, pinned.value, node);
      if (checked.diagnostic !== null) return fallback(node, key, definition, slot, checked.diagnostic);
      return {
        value: checked.value,
        mode: "driven",
        source: "driven",
        driven: true,
        diagnostic:
          pinned.clamped === null
            ? null
            : diag(
                "warning",
                "parameter.driven.clamped",
                `Parameter "${key}" is driven by channel "${binding.channel}", which produced ${round4(pinned.clamped.produced)}, outside its range ${describeBounds(definition)}; the value in effect is clamped to ${pinned.clamped.limit}.`,
                node.id,
                "Scale or offset the channel upstream if the clamp is not the intent.",
              ),
      };
    }

    case "map": {
      // T286 (§V287): a map has NO CPU value — it changes what the CONSUMER compiles.
      // Evaluation gets the retained static (§V108's corner-square, so the inspector,
      // the zero-frame compile and every non-point consumer keep working), the mapping
      // travels as DATA in `ResolvedParameters.maps`, and there is NO diagnostic here:
      // a mapped parameter is a normal state, and the consumer that cannot honour it
      // is the one that says so, by name, at compile (§V288).
      const retained = staticBindingValue(slot) ?? defaultParameterValue(definition);
      const checked = checkAgainstManifest(key, definition, retained, node);
      context.maps?.set(key, {
        attribute: binding.attribute,
        ...(binding.channel === undefined ? {} : { channel: binding.channel }),
        ...(binding.port === undefined ? {} : { port: binding.port }),
      });
      return { value: checked.value, mode: "map", source: "static", driven: false, diagnostic: null };
    }

    default: {
      const never: never = binding;
      void never;
      return fallback(
        node,
        key,
        definition,
        slot,
        diag("warning", "parameter.slot.unknown", `Parameter "${key}" uses an unknown mode.`, node.id),
      );
    }
  }
}

/**
 * A bind ref, resolved. `parent.*` goes through the injected resolver (§V81); anything
 * else is a sibling parameter on the same node — bare (`radius`, `color`) or a
 * component (`color.r`) — resolved through the SAME effective-value path, so a bind
 * reads what the inspector shows, expression siblings included.
 */
function resolveBindRef(
  context: ResolveContext,
  key: string,
  definition: ParameterDefinition,
  ref: string,
): BindLookupResult {
  void definition;
  if (ref.startsWith("parent.")) {
    const resolver = context.options.parentBind;
    if (resolver === undefined) {
      return { ok: false, message: "no parent scope is attached to this resolution (§V81)." };
    }
    return resolver(ref);
  }

  const schema = context.options.schema;
  if (schema === undefined) {
    return { ok: false, message: "the sibling schema is unavailable in this resolution." };
  }

  if (Object.hasOwn(schema, ref)) {
    if (ref === key) return { ok: false, message: "a parameter cannot bind to itself." };
    const target = resolveEffective(context, ref, schema[ref] as ParameterDefinition);
    if (!target.ok) return target;
    return target;
  }

  const parsed = parseComponentKey(ref);
  if (parsed !== null && Object.hasOwn(schema, parsed.base)) {
    const baseDefinition = schema[parsed.base] as ParameterDefinition;
    const names = componentNamesFor(baseDefinition);
    const index = names?.indexOf(parsed.component) ?? -1;
    if (names === null || index < 0) {
      return {
        ok: false,
        message: `"${parsed.base}" has no component "${parsed.component}"${
          names === null ? "" : ` (it has ${names.join(", ")})`
        }.`,
      };
    }
    const target = resolveEffective(context, parsed.base, baseDefinition);
    if (!target.ok) return target;
    const tuple = target.value;
    const component = Array.isArray(tuple) ? tuple[index] : undefined;
    if (typeof component !== "number") {
      return { ok: false, message: `"${parsed.base}" did not resolve to a numeric tuple.` };
    }
    return { ok: true, value: component };
  }

  const known = Object.keys(schema).sort();
  return {
    ok: false,
    message: `it names no parameter on this node${known.length === 0 ? "" : ` (it has ${known.join(", ")})`}.`,
  };
}

/** Full effective value of a sibling, compound assembly included, cycle-guarded. */
function resolveEffective(
  context: ResolveContext,
  key: string,
  definition: ParameterDefinition,
): BindLookupResult {
  if (context.visited.has(key)) {
    return {
      ok: false,
      message: `the bind chain is circular (through "${key}"); authoring should have refused it (§V110).`,
    };
  }
  context.visited.add(key);
  try {
    const names = componentNamesFor(definition);
    if (names === null) {
      const resolved = resolveStored(context, key, definition, context.node.parameters[key]);
      return { ok: true, value: resolved.value };
    }
    const compound = resolveCompound(context, key, definition, names);
    return { ok: true, value: compound.value };
  } finally {
    context.visited.delete(key);
  }
}

interface CompoundResolution extends StoredResolution {
  components: readonly ResolvedComponent[];
}

/**
 * Compound assembly (§V113): the bare key supplies the base tuple, then every stored
 * component slot overrides its channel. `color.g` carrying an expression while r, b, a
 * stay put is exactly this loop.
 */
function resolveCompound(
  context: ResolveContext,
  key: string,
  definition: ParameterDefinition,
  names: readonly string[],
): CompoundResolution {
  const base = resolveStored(context, key, definition, context.node.parameters[key]);
  const assembled: number[] = Array.isArray(base.value)
    ? [...(base.value as readonly number[])]
    : (defaultParameterValue(definition) as readonly number[]).slice();

  const components: ResolvedComponent[] = [];
  let driven = base.driven;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index] as string;
    const storedComponent = context.node.parameters[componentKey(key, name)];
    if (storedComponent === undefined) {
      components.push({
        name,
        mode: base.mode,
        value: assembled[index] ?? 0,
        slot: undefined,
        diagnostic: null,
      });
      continue;
    }
    const resolved = resolveStored(
      context,
      componentKey(key, name),
      componentDefinition(definition, name, index),
      storedComponent,
    );
    const value = typeof resolved.value === "number" ? resolved.value : (assembled[index] ?? 0);
    assembled[index] = value;
    driven = driven || resolved.driven;
    components.push({
      name,
      mode: resolved.mode,
      value,
      slot: isParameterSlot(storedComponent) ? storedComponent : undefined,
      diagnostic: resolved.diagnostic,
    });
  }

  return { ...base, value: assembled, driven, components };
}

export function resolveParameter(
  node: GraphNode,
  key: string,
  definition: ParameterDefinition,
  options: ResolveParametersOptions = {},
  /** T286: shared collector for map-mode bindings, threaded by resolveParameterSchema. */
  maps?: Map<string, ParameterMapBinding>,
): ResolvedParameter {
  const stored = node.parameters[key];
  const driver = options.drivers?.[key];

  if (driver !== undefined) {
    const driven = driver({
      node,
      key,
      definition,
      frame: options.frame,
    });
    if (driven !== undefined) {
      // A driver's output is still checked against the manifest: a bad driver must not
      // put a value in the graph the schema would have refused.
      const checked = checkAgainstManifest(key, definition, driven, node);
      return {
        key,
        definition,
        value: checked.value,
        stored,
        source: "driven",
        mode: "static",
        slot: isParameterSlot(stored) ? stored : undefined,
        driven: true,
        diagnostic: checked.diagnostic,
      };
    }
  }

  const context: ResolveContext = { node, options, visited: new Set([key]), ...(maps === undefined ? {} : { maps }) };
  const names = componentNamesFor(definition);

  if (names === null) {
    const resolved = resolveStored(context, key, definition, stored);
    return {
      key,
      definition,
      value: resolved.value,
      stored,
      source: resolved.source,
      mode: resolved.mode,
      slot: isParameterSlot(stored) ? stored : undefined,
      driven: resolved.driven,
      diagnostic: resolved.diagnostic,
    };
  }

  const compound = resolveCompound(context, key, definition, names);
  return {
    key,
    definition,
    value: compound.value,
    stored,
    source: compound.source,
    mode: compound.mode,
    slot: isParameterSlot(stored) ? stored : undefined,
    driven: compound.driven,
    components: compound.components,
    diagnostic: compound.diagnostic,
  };
}

/**
 * Effective parameters for a bare schema, in manifest order.
 *
 * Takes a `ParameterSchema` rather than a `NodeDefinition` because a component
 * instance's parameter page is the component's PUBLISHED definitions, which exist
 * before any node manifest does (§V80) — and one resolver is the point.
 */
export function resolveParameterSchema(
  node: GraphNode,
  schema: ParameterSchema,
  options: ResolveParametersOptions = {},
): ResolvedParameters {
  const entries: ResolvedParameter[] = [];
  const values: Record<string, ParameterValue> = {};
  const diagnostics: RuntimeDiagnostic[] = [];
  const maps = new Map<string, ParameterMapBinding>();
  const withSchema: ResolveParametersOptions =
    options.schema === undefined ? { ...options, schema } : options;

  for (const [key, parameter] of Object.entries(schema)) {
    const resolved = resolveParameter(node, key, parameter, withSchema, maps);
    entries.push(resolved);
    values[key] = evaluationValue(parameter, resolved.value);
    if (resolved.diagnostic !== null) diagnostics.push(resolved.diagnostic);
    for (const component of resolved.components ?? []) {
      if (component.diagnostic !== null) diagnostics.push(component.diagnostic);
    }
  }

  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  return {
    entries,
    get: (key: string) => byKey.get(key),
    values,
    maps: Object.fromEntries(maps),
    diagnostics,
  };
}

/**
 * The schema THIS node instance carries (T880). For almost every node it is the type's
 * static `parameters`; a `customWgsl` derives it from its own stored `source` (its shader's
 * `struct Params`), so a node's controls follow its shader. The static schema is the fallback
 * for every node without the hook and for the type-only contexts (palette, a fresh drop).
 */
export function effectiveParameterSchema(
  definition: NodeDefinition | undefined,
  stored: Readonly<Record<string, unknown>>,
): ParameterSchema {
  return definition?.parametersFor?.(stored) ?? definition?.parameters ?? {};
}

/**
 * Effective parameters of a node, in manifest order. An unknown node type (§V10
 * placeholder) resolves to nothing rather than guessing a schema.
 */
export function resolveParameters(
  node: GraphNode,
  definition: NodeDefinition | undefined,
  options: ResolveParametersOptions = {},
): ResolvedParameters {
  return resolveParameterSchema(node, effectiveParameterSchema(definition, node.parameters), options);
}
