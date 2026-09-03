import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cx } from "@ui/cx.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { nodeHasAnimatedParameters } from "@domain/channels/graph-channels.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { TextureFormat } from "@domain/types/node-definition.ts";
import { ParameterControl } from "@ui/controls/parameter-control.tsx";
import { CodeField } from "@editor/shader-editor/index.ts";
import type { ControlVariant } from "@ui/controls/control-row.tsx";
import { NodeIdentity } from "@ui/primitives/node-identity.tsx";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "@ui/primitives/tabs.tsx";
import { CommonReadout, CommonSection } from "./common-section.tsx";
import { ConnectionsSection } from "./connections-section.tsx";
import { connectionModel } from "./connections.ts";
import { AudioSection, audioSectionParameters } from "./audio-section.tsx";
import { WebcamSection, webcamSectionParameters } from "./webcam-section.tsx";
import { MidiSection, midiSectionParameters } from "./midi-section.tsx";
import { LaserSection, laserSectionParameters } from "./laser-section.tsx";
import { LASER_OUT_TYPE } from "@nodes/definitions/laser-out.ts";
import type { MidiSectionSurface } from "./midi-section.tsx";
import { DEFAULT_GROUP, groupParameters } from "./parameter-groups.ts";
import { createParameterEditor } from "./parameter-editor.ts";
import type { ParameterEditor } from "./parameter-editor.ts";
import { parseComponentNodeType } from "@domain/components/component-type.ts";
import type { ComponentRegistryView } from "@domain/components/index.ts";
import { resolveParameters } from "./parameter-resolver.ts";
import { createNodeReferenceReader } from "@domain/parameters/index.ts";
import { resolveNodeFormat, resolveNodeSize } from "./resolution.ts";
import type { FormatContext, InputResolution, ResolutionContext } from "./resolution.ts";
import styles from "./inspector.module.css";

/**
 * Inspector pane (T38).
 *
 * Manifest-driven end to end: the pane renders whatever the node definition declares,
 * grouped as the definition groups it, using the shared control kit. There is no
 * per-node inspector code anywhere in the editor, which is what makes a node package
 * that lands later — or one an agent authors — fully editable the moment it registers.
 *
 * Reads come through `resolveParameters` (the single parameter read path); writes go
 * through the command bus via `ParameterEditor` (§V29). The pane never touches the
 * store, and never mutates a node object.
 *
 * ## Pages, not one long scroll (T269, §V174)
 *
 * TD's model: a node has PAGES and the inspector shows one at a time. Parameters is the
 * first tab and the default; Common is its own. Stacking both on one page put a
 * resolution and a format — set once per node, revisited almost never — across the top
 * third of the panel, ahead of the controls the panel was opened for. Common is chrome;
 * parameters are the work; the top of the panel goes to the work.
 *
 * What does NOT go behind the tab is the resolved readout. "1280 × 720 · rgba16float" is
 * the fact you check constantly, and it moves as a consequence of edits made elsewhere —
 * rewire an input and an inheriting node's size changes under you. So it rides in the
 * header as one compact line, visible from either tab, instead of two rows and a box.
 */

export interface InspectorProjectSettings {
  outputResolution: { width: number; height: number };
  workingFormat: TextureFormat;
  limits?: { maxResolution?: number };
}

export interface InspectorProps {
  bus: LoomBus;
  /** Actor/project/capabilities for every command the pane sends (§V30). Memoise it. */
  context: InvocationContext;
  nodeId: NodeId | null;
  settings: InspectorProjectSettings;
  /** Compiler diagnostics; the Common section surfaces the format ones (§V51). */
  diagnostics?: readonly RuntimeDiagnostic[];
  /** Device capability report (§V12), used to flag unsupported formats. */
  capabilities?: { formats: readonly TextureFormat[] } | undefined;
  /**
   * Resolved size/format per input port, when the compiler has reported them. Without
   * it the Common section falls back to the project size and says so.
   */
  inputResolutions?: readonly InputResolution[];
  /** Injectable for tests; otherwise the pane owns its editor. */
  editor?: ParameterEditor;
  /** T601: the component catalogue, so an instance's Common page offers its preview source. */
  components?: ComponentRegistryView;
  /**
   * T434(b)/T432: the session's audio capture status, for the Audio section shown on
   * audio nodes. Absent = no session capture wiring (tests, embeds) — section hidden.
   */
  audioStatus?: () => { kind: "idle" | "live" | "error"; message?: string };
  /**
   * T942: the session's ONE Web MIDI access, for the MIDI section shown on `midiIn`.
   * Absent = no session MIDI wiring (tests, embeds) — section hidden, exactly as the
   * Audio one is. NEVER a fabricated stand-in: a picker over an access nobody holds
   * would learn nothing and say nothing about why.
   */
  midi?: MidiSectionSurface;
  /**
   * T950: the laser SESSION surface for `laserOut` nodes — connect/arm/disarm/e-stop
   * and the helper's measured state. Absent = no session wiring (tests, embeds):
   * section hidden, exactly as Audio's and MIDI's are. Arming is session state and
   * never document state (G1), which is why it is a SURFACE and not a parameter.
   */
  laser?: import("./laser-section.tsx").LaserSectionSurface;
  variant?: ControlVariant;
  /**
   * The channel resolver a `driven` parameter reads through (B46, T374, §V61).
   *
   * §V61 has one read path and this pane is on it — but `resolveParameters` only answers
   * a driven slot when it is GIVEN a resolver, and nothing in the editor ever passed one.
   * So every driven parameter in the panel fell back to its retained static and reported
   * "channel lfo1 is not attached" while the LFO drove it in the plan. B8 with the sides
   * swapped, and B8's ruling is that the answer is one resolver, not two.
   *
   * It is the compile's own (`useGraphCompile().channels`), passed down, so the panel
   * cannot disagree with the plan. Optional because a caller that has no value graph —
   * a component editor, a test of the layout — should show §V108's retained value rather
   * than be forced to fabricate a resolver, which is the state that shipped.
   */
  channels?: ChannelResolver;
  /**
   * T893 — reads the LAST RENDERED frame. A ref read, never a subscription (§V16), and
   * the same accessor `TimelineReadout` samples.
   *
   * With it, a driven or expression parameter's field shows what is ON SCREEN instead of
   * the zero-frame resolution it showed since B46 (B95 caught the same lie from the other
   * end: a kernel slot reading 0.00 while the LFO's own preview read 1.62). Absent — a
   * component editor, a test of the layout, any caller with no frame loop — the panel
   * behaves exactly as it did: §V44's deterministic zero frame.
   *
   * A FUNCTION, deliberately. Passing the frame itself would put whoever owns it on a
   * per-frame render path and re-render this pane's whole ancestry sixty times a second,
   * which is §T714's measured disaster with a different trigger.
   */
  latestFrame?: (() => FrameInputs | null) | undefined;
}

/** §V16: <= 10 Hz. Shared with `TimelineReadout`'s cap, for the same reason. */
export const LIVE_VALUE_INTERVAL_MS = 100;

/**
 * T893 — the live frame, sampled at <=10 Hz, and ONLY while something here animates.
 *
 * §V16 has both halves of this: per-frame state does not enter the document store, and a
 * UI metric refreshes at most ten times a second. So nothing is pushed at us — we pull,
 * on an interval, from the ref the frame loop already keeps.
 *
 * Three things keep this from becoming §T714:
 *
 *  - `reader` is undefined when the selected node has no animated parameter, so a static
 *    node — the overwhelming case — installs no timer and re-renders zero times.
 *  - the state bump is skipped when the frame INDEX has not moved, so a paused transport
 *    costs one render and then nothing, however long the panel stays open.
 *  - only this pane re-renders. There is no context write and no store write, so nothing
 *    outside the inspector can be re-rendered by a frame advancing.
 */
function useLiveFrame(
  reader: (() => FrameInputs | null) | undefined,
  intervalMs: number,
): FrameEvaluationInput | null {
  const [frame, setFrame] = useState<FrameEvaluationInput | null>(null);
  const seen = useRef<number | null>(null);

  useEffect(() => {
    if (reader === undefined) {
      // Nothing animates here: drop whatever was last sampled so the panel falls back to
      // the retained resolution rather than freezing on the last live number it saw.
      seen.current = null;
      setFrame(null);
      return;
    }
    const tick = (): void => {
      const inputs = reader();
      if (inputs === null) return;
      if (seen.current === inputs.frame.frameIndex) return;
      seen.current = inputs.frame.frameIndex;
      setFrame(inputs.frame);
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, reader]);

  return frame;
}

export function Inspector({
  bus,
  context,
  nodeId,
  settings,
  diagnostics,
  capabilities,
  inputResolutions,
  editor: providedEditor,
  variant = "inspector",
  channels,
  latestFrame,
  audioStatus,
  midi,
  laser,
  components,
}: InspectorProps) {
  const graph = useSyncExternalStore<GraphDocument>(
    bus.store.subscribe,
    bus.store.getGraph,
    bus.store.getGraph,
  );

  /**
   * The editor's lifetime is the MOUNT's, not a memo cell's (B10, T218).
   *
   * This used to be `useMemo(create, [bus, context])` paired with an effect cleanup
   * that called `dispose()`. React is free to run an effect's cleanup and then mount
   * the same component again WITHOUT re-rendering it — StrictMode's development
   * mount→unmount→mount check does precisely that, and so does a pane being re-docked.
   * The memo cell survived (its deps never changed), so the pane went on using an
   * editor whose coalescer was permanently disposed. A disposed coalescer drops every
   * `schedule` on the floor, which is exactly and only the `"live"` path: `"commit"`
   * sends immediately. Result in the shipped app: an 80px drag showed one value and
   * jumped on release, and §V5's uniform-only fast path was unreachable from the UI.
   *
   * Owning it through a ref that the effect REBUILDS when it finds it empty ties the
   * editor to the mount. `revive` exists because the remount does not re-render on its
   * own: the handlers already on screen still close over the disposed editor.
   */
  const ownedRef = useRef<ParameterEditor | null>(null);
  const [, revive] = useState(0);

  if (providedEditor === undefined && ownedRef.current === null) {
    ownedRef.current = createParameterEditor({ bus, context });
  }

  useEffect(() => {
    if (providedEditor !== undefined) return;
    if (ownedRef.current === null) {
      ownedRef.current = createParameterEditor({ bus, context });
      revive((generation) => generation + 1);
    }
    return () => {
      ownedRef.current?.dispose();
      ownedRef.current = null;
    };
  }, [bus, context, providedEditor]);

  const editor = providedEditor ?? ownedRef.current;

  const node = nodeId === null ? undefined : graph.nodes[nodeId];
  const definition = node === undefined ? undefined : bus.registry.get(node.type);

  /*
   * T893 — sampled ABOVE the early return, because a hook may not be conditional. The
   * PREDICATE carries the condition instead: a node with no expression, driven or bind
   * slot hands `useLiveFrame` no reader, and it installs nothing.
   */
  const liveFrame = useLiveFrame(
    latestFrame !== undefined && node !== undefined && nodeHasAnimatedParameters(node)
      ? latestFrame
      : undefined,
    LIVE_VALUE_INTERVAL_MS,
  );

  if (node === undefined || editor === null) {
    return (
      <div className={styles.empty}>
        <span>No node selected</span>
        <span className={styles.type}>Select a node to edit its parameters</span>
      </div>
    );
  }

  /**
   * T316/§V148/§V61 — the panel reads `op('other').par.key` through the SAME reader the
   * compiler uses, built from the same document.
   *
   * Not an enhancement: without it the plan would carry the referenced value and this
   * panel would show §V108's fallback for the same parameter. That is B8 exactly, with
   * the sides swapped — and B8 is on record as having cost a day precisely because both
   * halves looked correct in isolation.
   */
  /**
   * B46/T901 — the reader's `base` is NOT optional decoration, and omitting it was the bug.
   *
   * `op('pulse1').chan.value` is read INSIDE the reader (`node-references.ts`), off
   * `options.base.channels`, and a referenced parameter that is itself an expression
   * resolves off `options.base.frame`. Neither of those is `ResolveParametersOptions` — the
   * reader is a closure built before the resolve, so the `channels` and `frame` handed to
   * `resolveParameters` never reach it. Built with no `base`, this panel answered every
   * `.chan` read with "this context has no channel resolver", fell back to §V108's retained
   * static, and froze the field on it — at every frame, on every node type — while the plan
   * (which builds its reader WITH a base, `validate.ts`) animated correctly.
   *
   * That is B8's shape for the third time (T593 was the second): one read path, two ways of
   * calling it, and the panel disagreeing with the picture. So the frame is a PARAMETER of
   * this builder rather than a field spread on afterwards — the one thing that means "at
   * which moment" cannot now be set on the resolve and forgotten on the reader.
   */
  const readOptionsAt = (frame?: FrameEvaluationInput) => {
    const base = {
      ...(channels === undefined ? {} : { channels }),
      ...(frame === undefined ? {} : { frame }),
    };
    return {
      nodes: createNodeReferenceReader({
        graph,
        schemaOf: (target) => effectiveParameterSchema(bus.registry.get(target.type), target.parameters),
        base,
      }),
      ...base,
    };
  };
  const readOptions = readOptionsAt();

  /**
   * B46 — the RETAINED read, deliberately with NO `frame`.
   *
   * A frameless read is §V44's deterministic zero frame, which `useValueGraph` answers
   * from a throwaway session keyed on the document revision. This is what the mode panel,
   * the detach seed and every write are built from, and it must stay frameless: §V108's
   * retained number is what flipping back to Constant restores, so a momentary sample may
   * never land in that seat. The panel shows the resolved value at t=0 and, crucially,
   * stops claiming the channel is unattached when it is.
   */
  const resolved = resolveParameters(node, definition, readOptions);

  /**
   * T893 — the LIVE read, the same call with the last rendered frame, for DISPLAY only.
   *
   * ⚠ The comment that stood here said a live frame "would make a stateful stage advance
   * because a panel re-rendered — a Lag jumping every time you drag a node". THAT IS NOT
   * TRUE OF THIS RESOLVER, and the difference is the whole fix. `useValueGraph`'s resolver
   * branches on the frame: WITHOUT one it evaluates a throwaway session (which is what
   * that warning is about, and it is right), WITH one it returns `latest.current` — a
   * SNAPSHOT of the frame the loop already evaluated, evaluating nothing. §V155's "never
   * twice per frame" rule is what makes it a snapshot, so a reader cannot advance it. The
   * backstop below it, `graphChannelResolver`, is a pure function of values and frame by
   * §V143. So the cost of asking is a lookup, not a step.
   *
   * ONE read path, not two (§V61, B8): the same function, the same options, differing by
   * the one field that means "at which moment" — exactly how the structural compile and
   * the per-frame compile already relate to each other. A second resolver here is the bug
   * B8 recorded, and this is deliberately not one.
   */
  const live = liveFrame === null ? null : resolveParameters(node, definition, readOptionsAt(liveFrame));

  /*
   * T994 — the device sections and the generic groups were TWO CONTROLS ON ONE
   * DOCUMENT FIELD: the styled picker, and a raw id text box directly below it that
   * the picker would silently disagree with. Each section now CLAIMS the keys it
   * presents (a claim, not a hide-list here — the next section added carries its own
   * claim or leaves its duplicate visible, which is the failure that gets noticed),
   * and the claim applies only while the section actually renders: with the section's
   * surface absent (an embed, a test), the generic control comes back rather than
   * leaving the field uneditable. The booleans are shared with the JSX below so the
   * claim and the render cannot drift.
   */
  const showsAudioSection =
    audioStatus !== undefined && (node.type === "audioIn" || node.type === "audioFileIn");
  const showsWebcamSection = node.type === "webcam";
  const showsMidiSection = midi !== undefined && node.type === "midiIn";
  // The CONSTANT, not the literal: §T1005's tripwire reads an emitting type's literal
  // in session code as an unregistered pump's tell, and this section is a surface.
  const showsLaserSection = laser !== undefined && node.type === LASER_OUT_TYPE;
  const presentedBySections = new Set<string>([
    ...(showsAudioSection ? audioSectionParameters(node.type as "audioIn" | "audioFileIn") : []),
    ...(showsWebcamSection ? webcamSectionParameters() : []),
    ...(showsMidiSection ? midiSectionParameters() : []),
    ...(showsLaserSection ? laserSectionParameters() : []),
  ]);
  const groups = groupParameters(
    resolved.entries.filter((entry) => !presentedBySections.has(entry.key)),
  );

  const inputs: readonly InputResolution[] =
    inputResolutions ??
    (definition?.inputs ?? []).map((port) => ({
      portId: port.id,
      label: port.label,
      connected: Object.values(graph.edges).some(
        (edge) => edge.target.nodeId === node.id && edge.target.portId === port.id,
      ),
    }));

  const resolutionContext: ResolutionContext = {
    project: settings.outputResolution,
    inputs,
    ...(settings.limits?.maxResolution === undefined
      ? {}
      : { maxResolution: settings.limits.maxResolution }),
  };
  const formatContext: FormatContext = {
    projectFormat: settings.workingFormat,
    inputs,
    ...(capabilities === undefined ? {} : { supported: capabilities.formats }),
  };
  // Resolved here as well as inside CommonSection: both are pure functions of the same
  // inputs, and passing the answer down would couple the header to the section's shape
  // for no gain. The section resolves what its own controls need; this is the readout.
  const resolvedSize = resolveNodeSize(node.resolution, definition?.resolutionPolicy, resolutionContext);
  const resolvedFormat = resolveNodeFormat(node.format, definition?.formatPolicy, formatContext);

  /*
   * T601: a component instance's Common page states and edits which INNER node the
   * preview shows. The default entry NAMES the node it falls back to (§V499 — with
   * several outputs nothing is silently first), and every inner node is offered:
   * TD lets you view an internal operator while debugging.
   */
  const previewChoices = (() => {
    if (components === undefined) return undefined;
    const ref = parseComponentNodeType(node.type);
    if (ref === null) return undefined;
    const definitionOf = components.get(ref.componentId, ref.version);
    if (definitionOf === undefined) return undefined;
    const fallback = definitionOf.outputs[0]?.nodeId;
    const fallbackNode = fallback === undefined ? undefined : definitionOf.graph.nodes[fallback];
    const inner = Object.values(definitionOf.graph.nodes)
      .map((entry) => ({ value: entry.id as string, label: entry.label ?? entry.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const current =
      typeof node.ui?.componentPreview === "string" &&
      definitionOf.graph.nodes[node.ui.componentPreview as NodeId] !== undefined
        ? node.ui.componentPreview
        : "";
    return {
      current,
      choices: [
        {
          value: "",
          label: `Default — ${fallbackNode?.label ?? fallback ?? "first output"}`,
        },
        ...inner,
      ],
    };
  })();

  /*
   * T1049 — TD's connections overview, on the Common page at the owner's instruction
   * ("to keep Parameters clean"). ABOVE the resolution and format rows: those are set once
   * and revisited almost never, while "what is wired to this" is the glance — the same
   * argument T269 used to put the parameters above Common in the first place.
   */
  const connectionsSection = (
    <ConnectionsSection
      nodeId={node.id}
      model={connectionModel(graph, bus.registry, node.id)}
      editor={editor}
    />
  );

  const commonSection = (
    <CommonSection
      nodeId={node.id}
      {...(previewChoices === undefined ? {} : { componentPreview: previewChoices })}
      definition={definition}
      resolution={node.resolution}
      format={node.format}
      resolutionContext={resolutionContext}
      formatContext={formatContext}
      {...(diagnostics === undefined ? {} : { diagnostics })}
      editor={editor}
      variant={variant}
    />
  );

  /*
   * T434(b)/T432: the audio nodes get a capture section — status plus, for the mic
   * node, the device picker. Keyed on the node TYPE the capture hook itself keys on.
   */
  const audioSection =
    showsAudioSection && (node.type === "audioIn" || node.type === "audioFileIn") ? (
      <AudioSection
        nodeId={node.id}
        nodeType={node.type}
        device={typeof resolved.values["device"] === "string" ? (resolved.values["device"] as string) : ""}
        status={audioStatus()}
        editor={editor}
      />
    ) : null;

  /* T810: the webcam gets its camera picker the way the mic got its device picker —
     keyed on the node TYPE the media hook itself keys on. */
  const webcamSection =
    showsWebcamSection && node.type === "webcam" ? (
      <WebcamSection
        nodeId={node.id}
        device={typeof resolved.values["device"] === "string" ? (resolved.values["device"] as string) : ""}
        editor={editor}
      />
    ) : null;

  /* T942: the controller gets its learn table and its ONE honest sentence about why there
     is no MIDI — keyed on the node TYPE, as the mic and camera sections are. */
  /* T950: the laser session controls, on the node (§T948) — connect/arm/e-stop plus
     the helper's measured state. host/maxPps stay ordinary parameters below. */
  const laserSection = showsLaserSection && laser !== undefined ? (
    <LaserSection
      nodeId={node.id}
      host={typeof resolved.values["host"] === "string" ? (resolved.values["host"] as string) : ""}
      maxPps={typeof resolved.values["maxPps"] === "number" ? (resolved.values["maxPps"] as number) : 0}
      laser={laser}
    />
  ) : null;

  const midiSection =
    showsMidiSection && node.type === "midiIn" ? (
      <MidiSection
        nodeId={node.id}
        device={typeof resolved.values["device"] === "string" ? (resolved.values["device"] as string) : ""}
        mapping={typeof resolved.values["mapping"] === "string" ? (resolved.values["mapping"] as string) : ""}
        midi={midi}
        editor={editor}
      />
    ) : null;

  const parameterSections =
    groups.length === 0 ? (
      // §V91: name the STATE, not the pane's purpose. A node with no parameters is a
      // normal thing (Output, Null) and the panel should say so rather than sit blank.
      <p className={styles.emptyPage}>No parameters</p>
    ) : (
      groups.map((group) => (
        <section className={styles.section} key={group.name} aria-label={group.name}>
          {/* T498: the DEFAULT group draws no heading — the tab above it already says
              Parameters, and the same word twice, stacked, was the owner's "odd" spot.
              Named groups (Shape, Colour) keep theirs; the aria-label keeps the section
              addressable either way. */}
          {group.name === DEFAULT_GROUP ? null : (
            <div className={styles.sectionHeader}>
              <span>{group.name}</span>
              <span className={styles.sectionRule} aria-hidden />
            </div>
          )}
          {group.entries.map((entry) => (
            // data-parameter-key lets the context menu resolve which parameter was
            // right-clicked (§V78). The control kit itself stays menu-agnostic.
            <div key={entry.key} data-parameter-key={entry.key}>
              <ParameterControl
                parameterKey={entry.key}
                definition={entry.definition}
                value={entry.value}
                /*
                 * T893: what is on screen right now, when it differs. Display only — the
                 * line above stays the retained resolution, which is what the mode panel
                 * seeds from and what a detach restores (§V108). Undefined for a static
                 * parameter and for every caller with no frame loop, so those rows render
                 * byte for byte as they did.
                 */
                {...(live === null ? {} : { liveValue: live.get(entry.key)?.value })}
                variant={variant}
                driven={entry.driven}
                // §V146 (B14): the node itself says when one of its parameters cannot
                // affect the output — Noise's Time Speed on a 2D type is the case that
                // named the bug. The predicate reads the node's EFFECTIVE values, so a
                // type driven by an expression dims the same parameters a typed one does.
                inactive={entry.definition.inactiveWhen?.(resolved.values) ?? null}
                slot={entry.slot}
                {...(entry.components === undefined ? {} : { components: entry.components })}
                diagnostic={entry.diagnostic}
                // §V114: whatever the control hands over — a mode envelope, or all four
                // channels of a colour — goes out as ONE patch, so a colour pick stays one
                // undo entry.
                // §V124: a pulse writes nothing to the document, so it travels its own
                // path — one command, audited, never undoable, never saved.
                onPulse={(key) => editor.pulse(node.id, key)}
                // T492: the REAL editor for a code-valued parameter, injected here
                // because the control kit cannot import CodeMirror. One editor (T356):
                // the same component the code pane mounts, at inspector-row size.
                codeField={(props) => <CodeField {...props} />}
                onStoredChange={(entries, phase) => editor.setStored(node.id, entries, phase)}
                onChange={(value, phase) => editor.setParameter(node.id, entry.key, value, phase)}
              />
            </div>
          ))}
        </section>
      ))
    );

  const unknownNotice =
    definition === undefined ? (
      <p className={styles.placeholder}>
        Unknown node type “{node.type}”. Its parameters are preserved but cannot be edited
        until the package that defines it is installed (§V10).
      </p>
    ) : null;

  const header = (
    <>
      {/*
        T954 — the NAME is the prominent half, the machine type is a quiet badge, and
        the type is said ONCE. This header used to read `definition.title` bold, then
        `node.type` beside it (the same fact in machine form), then `node.id` dim and
        far right: the one thing saying WHICH node this is was the smallest, dimmest
        and furthest from the eye, and it was inverted from the graph node header the
        user had just clicked from.

        §B170: ids are EDGE ADDRESSES and labels are NAMES, so the name is `label ?? id`
        — a node carrying a label shows it, and only a label-less legacy node (E14's
        `sway`) falls back to the id it is addressed by.
      */}
      <header className={styles.header}>
        <NodeIdentity
          name={node.label ?? node.id}
          type={node.type}
          nameClassName={styles.title}
          typeClassName={styles.type}
          nameTitle={node.label ?? node.id}
          typeTitle={`${definition?.title ?? node.type} — this node's type`}
        />
      </header>
      <CommonReadout size={resolvedSize} format={resolvedFormat} compact />
    </>
  );

  // A node-embedded inspector is a dense strip, not a paged panel: it keeps the flat
  // layout it always had, and only the pane grows tabs.
  if (variant === "node") {
    return (
      <div className={styles.inspector} data-node-id={node.id} data-keymap-context="inspector">
        {header}
        {unknownNotice}
        {/* The device sections come FIRST: they are the controls, and the parameter
            groups below them hold the RESULT — a midiIn's `mapping` is the JSON the learn
            table writes, and reading the output above the thing that produces it is
            backwards. */}
        {audioSection}
        {webcamSection}
        {midiSection}
        {laserSection}
        {parameterSections}
        {connectionsSection}
        {commonSection}
      </div>
    );
  }

  return (
    <div className={styles.inspector} data-node-id={node.id} data-keymap-context="inspector">
      {header}
      {unknownNotice}
      <TabsRoot className={cx(styles.pages, styles.pages)} defaultValue="parameters">
        <TabsList className={cx(styles.pageList, styles.pageList)} aria-label="Node pages">
          <TabsTrigger value="parameters">Parameters</TabsTrigger>
          <TabsTrigger value="common">Common</TabsTrigger>
        </TabsList>
        <TabsContent className={cx(styles.page, styles.page)} value="parameters">
          {/* Controls above the result they write — see the node variant above. */}
          {audioSection}
          {webcamSection}
          {midiSection}
          {laserSection}
          {parameterSections}
        </TabsContent>
        <TabsContent className={cx(styles.page, styles.page)} value="common">
          {connectionsSection}
          {commonSection}
        </TabsContent>
      </TabsRoot>
    </div>
  );
}

