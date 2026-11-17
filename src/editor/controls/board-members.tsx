import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useStore } from "zustand";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import {
  CUE_BACK_COMMAND,
  CUE_GO_COMMAND,
  CUE_LIST_NODE_TYPE,
  CUE_SET_STANDBY_COMMAND,
  PRESETS_NODE_TYPE,
  PRESET_RECALL_COMMAND,
  PRESET_STORE_COMMAND,
  bankViewOf,
  type BankView,
  morphProgress,
  morphRunning,
  nextCueName,
  nextPresetName,
  parseCueList,
  parseMorphRecords,
  parsePresetBank,
} from "@domain/presets/index.ts";
import { LAYER_NODE_TYPE, layerPicture, surfaceNameOf, switchesOnBoard, type BoardRect } from "@nodes/definitions/controls.ts";
import { refusalMessage, type CommandAnswer } from "@editor/inspector/command-refusal.ts";
import { ShareFill } from "@ui/primitives/share-fill.tsx";
import { boardFit, boardValueEm, cueListBoardLayout, cueListShowsCues, layerBoardLayout, presetStripGrid, type BoardCells } from "./board-fit.ts";
import { ControlWidget, type ControlWrite } from "./control-widget.tsx";
import { layerOpacityFader, setLayerOn } from "./layer-controls.ts";
import { usePresetCatalogue } from "./use-preset-catalogue.ts";
import styles from "./board-members.module.css";

/**
 * T1501b (§T1398b S6) — WHAT A BANK, A LAYER AND A CUE LIST DRAW ON A PANEL BOARD.
 *
 * These three join a board by name (`BOARD_NAMED_TYPES`, `controls.ts`) and are drawn here
 * wherever a board is: the Controls tab, the Panel node's canvas body and the edit
 * surface, from the one `panelBoard` derivation — so a strip on the canvas and the same
 * strip in the tab cannot show different presets.
 *
 * - a Presets BANK is a strip: one button per preset, the one recalled last lit, and a
 *   bar across the button being faded to while a morph runs. A press is `preset.recall`.
 *   T1527b: the strip ends in Store, which captures the bank's targets as a NEW preset
 *   under the next free name (`preset.store`) — never over one, so a stray press mid-show
 *   costs one undo and loses nothing; storing over a preset stays the inspector's. This
 *   file draws only the desk (Controls tab, Panel node body): the phone page draws its
 *   own strip with no Store, and its vet has no path to `preset.store` (§T1503b).
 * - a LAYER is a switch — on means not bypassed — and its opacity fader when the rect has
 *   room. The switch writes the STATE the press asked for (`setNodeUi { bypassed }`, the op
 *   the layer's own docblock names), never a flip, and nothing at all when the layer is
 *   already so: two presses of "off" leave it off, in one undo step. The fader writes
 *   `opacity` through the parameter editor like any slider — one undo group per drag —
 *   and a driven opacity is shown and refuses the drag. T1527b: the switch names the
 *   picture the layer shows — its Picture name, or "wired" when a wire feeds it (§B233).
 * - a CUE LIST is BACK and a large GO, with the current cue and the one standing by. A
 *   press is `cue.back` / `cue.go`, on THIS list. T1527b: three rows or taller, the cues
 *   themselves are listed between the two, a tap standing one by (`cue.setStandby`) —
 *   the phone's list (§T1503b) on the desk, by the same rule (`cueListShowsCues`).
 *
 * Everything goes through the bus, so each press is one audited patch and one undo. A
 * press the bus REFUSES (GO past the last cue, a preset with nothing left to apply) says
 * why on the item until the document moves or the next press — a button that silently
 * did nothing is the failure a performance surface cannot have.
 *
 * Sized like a board widget (`board-fit.ts`): type scales with the cell, and each part
 * says only what its share of the rect has room for.
 */

export interface BoardMemberProps {
  readonly node: GraphNode;
  readonly rect: BoardRect;
  readonly cells: BoardCells;
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  /** The parameter editor's write — the layer's fader drags through it. */
  readonly write: ControlWrite;
}

/** The hairline between an item's parts, in px — `gap: 1px` in `board-members.module.css`. */
const PART_GAP_PX = 1;
/** GO is the button a show is run from: half again the type of everything beside it. */
const GO_SCALE = 1.4;
/** No cue: nothing fired yet, or nothing left to fire. */
const NO_CUE = "—";
/** The strip's Store button (T1527b). */
const STORE_CAPTION = "Store";

const text = (stored: unknown): string => (typeof stored === "string" ? stored.trim() : "");
const px = (value: number): string => `${String(value)}px`;

interface Refused {
  readonly message: string;
  readonly revision: number;
}

/**
 * Runs a bus command from a press and keeps what it was refused with. The message stands
 * until the document moves (it was about the document as it then was) or the next press.
 */
function usePress(bus: LoomBus): { readonly refusal: string | null; readonly press: (run: () => Promise<CommandAnswer>) => void } {
  const [refused, setRefused] = useState<Refused | null>(null);
  const press = (run: () => Promise<CommandAnswer>): void => {
    void run().then((result) => {
      const message = refusalMessage(result);
      setRefused(message === null ? null : { message, revision: bus.store.getRevision() });
    });
  };
  return { refusal: refused !== null && refused.revision === bus.store.getRevision() ? refused.message : null, press };
}

function Refusal({ message }: { readonly message: string | null }) {
  if (message === null) return null;
  return (
    <span className={styles.refusal} role="alert" title={message} data-board-refusal>
      {message}
    </span>
  );
}

/** How often a running fade is re-read off the frame clock: ten a second, like the timeline's readout. */
export const MORPH_POLL_MS = 100;

/**
 * The fade a bank is running, as its strip shows it: which preset, and how far along —
 * read off the app's FRAME clock (`bus.frameClock`, the transport's absolute clock), so
 * the bar stops when the transport pauses and is absent where no frame loop runs. The
 * timer only decides how often to look; it measures nothing. It stops once the fade has.
 */
function useMorphFade(bus: LoomBus, morphs: unknown): { readonly preset: string; readonly progress: number } | null {
  const source = typeof morphs === "string" ? morphs : "";
  const newest = useMemo(() => {
    const records = parseMorphRecords(source);
    return records[records.length - 1];
  }, [source]);
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => {
    if (newest === undefined) {
      setProgress(null);
      return;
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = (): void => {
      const clock = bus.frameClock();
      const running = clock !== undefined && morphRunning(newest, clock);
      setProgress(running ? morphProgress(newest, clock.absTimeSeconds) : null);
      if (clock !== undefined && !running && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    timer = setInterval(tick, MORPH_POLL_MS);
    tick();
    return () => {
      if (timer !== null) clearInterval(timer);
    };
  }, [bus, newest]);
  return newest === undefined || progress === null ? null : { preset: newest.preset, progress };
}

/**
 * T1505b: `view` is set for a look's INSTANCE on the board — its presets are its
 * component's, its `current` and fades its own. No Store on that strip: a Store there
 * writes the component for every instance with no undo, which is the inspector's to do
 * deliberately, not a stray press mid-show.
 */
function PresetStrip({ node, rect, cells, bus, invocation, view, name }: BoardMemberProps & { readonly view?: BankView; readonly name?: string }) {
  const parsed = parsePresetBank((view?.bank ?? node).parameters["presets"]);
  const presets = parsed.ok ? parsed.bank.presets : [];
  const current = text(node.parameters[view?.currentKey ?? "current"]);
  const fade = useMorphFade(bus, node.parameters[view?.morphsKey ?? "morphs"]);
  const storable = view?.kind !== "instance";
  const { refusal, press } = usePress(bus);
  if (!parsed.ok) {
    return (
      <div className={styles.member} data-board-member={PRESETS_NODE_TYPE} data-control-node={node.id}>
        <span className={styles.empty} title={parsed.reason}>
          Presets unreadable
        </span>
      </div>
    );
  }
  // T1527b: Store sits after the presets — its own cell, the strip's last.
  const storeAs = nextPresetName(presets.map((preset) => preset.name));
  const grid = presetStripGrid(presets.length + (storable ? 1 : 0), rect.h);
  const buttonPx = (cells.widthOf(rect.w) - (grid.perRow - 1) * PART_GAP_PX) / grid.perRow;
  const longest = presets.reduce((widest, preset) => (preset.name.length > widest.length ? preset.name : widest), STORE_CAPTION);
  const fit = boardFit({ kind: "button", caption: longest, valueEm: 0, widthPx: buttonPx, cellPx: cells.cellPx });
  return (
    <div className={styles.member} data-board-member={PRESETS_NODE_TYPE} data-control-node={node.id}>
      <div
        className={styles.strip}
        style={{
          gridTemplateColumns: `repeat(${String(grid.perRow)}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${String(grid.rows)}, minmax(0, 1fr))`,
          fontSize: px(fit.fontPx),
        }}
        role="group"
        // T1593b: called by its role (`looks`). `name` is handed in for a look's instance,
        // whose kind is its component's name and so needs the catalogue to read.
        aria-label={`Presets of ${name ?? surfaceNameOf(node)}`}
      >
        {presets.map((preset) => {
          const fading = fade !== null && fade.preset === preset.name;
          return (
            <button
              key={preset.name}
              type="button"
              className={`${styles.press} ${current === preset.name ? styles.lit : ""}`}
              aria-pressed={current === preset.name}
              title={fading ? `${preset.name} — fading in` : preset.name}
              data-preset={preset.name}
              onClick={() => press(() => bus.execute(PRESET_RECALL_COMMAND, { nodeId: node.id, name: preset.name }, invocation))}
            >
              <span className={styles.name}>{preset.name}</span>
              {fading ? (
                <ShareFill className={styles.fade} end={fade.progress} data-morph-progress={fade.progress.toFixed(2)} />
              ) : null}
            </button>
          );
        })}
        {storable ? (
          <button
            type="button"
            className={`${styles.press} ${styles.store}`}
            title={`Store the targets as a new preset, ${storeAs}`}
            data-preset-store={storeAs}
            onClick={() => press(() => bus.execute(PRESET_STORE_COMMAND, { nodeId: node.id, name: storeAs }, invocation))}
          >
            <span className={styles.name}>{STORE_CAPTION}</span>
          </button>
        ) : null}
      </div>
      <Refusal message={refusal} />
    </div>
  );
}

function LayerStrip({ node, rect, cells, bus, invocation, write }: BoardMemberProps) {
  // T1593b: the strip is drawn as a layer, so its caption is the ROLE (`graphic`).
  const name = surfaceNameOf(node);
  const on = node.ui?.bypassed !== true;
  const layout = layerBoardLayout(rect);
  const width = cells.widthOf(rect.w);
  const partPx = layout === "beside" ? (width - PART_GAP_PX) / 2 : width;
  // The press writes a state, never a flip; the fader's range and driven-ness are the layer's own (`layer-controls.ts`).
  const setOn = (next: boolean): void => setLayerOn(bus, invocation, node.id, next);
  const fader = layerOpacityFader(bus, node);

  // T1527b: what the layer shows, beside its name when the rect has room — the phone's rule
  // (its switch names its picture except at the bare 2×1 switch, §T1526b); always on hover.
  const picture = useStore(bus.store, (state) => layerPicture(state.graph, node.id));
  const caption = layout === "switch" || picture === "" ? name : `${name} · ${picture}`;
  const switchFit = boardFit({ kind: "toggle", caption, valueEm: boardValueEm("toggle", {}), widthPx: partPx, cellPx: cells.cellPx });
  const faderFit = boardFit({ kind: "slider", caption: fader.caption, valueEm: boardValueEm("slider", fader), widthPx: partPx, cellPx: cells.cellPx });
  return (
    <div className={`${styles.member} ${styles.parts} ${styles[layout] ?? ""}`} data-board-member={LAYER_NODE_TYPE} data-layout={layout}>
      <div className={styles.part} style={{ fontSize: px(switchFit.fontPx) }} title={picture === "" ? undefined : `${name} shows ${picture}`} data-layer-picture={picture}>
        <ControlWidget
          nodeId={node.id}
          type="toggle"
          parameters={{ caption, on }}
          write={(_nodeId, entries) => setOn(entries["on"] === true)}
          size="board"
          showValue={switchFit.value}
        />
      </div>
      {layout === "switch" ? null : (
        <div className={styles.part} style={{ fontSize: px(faderFit.fontPx) }} data-layer-fader>
          <ControlWidget
            nodeId={node.id}
            type="slider"
            parameters={fader}
            write={(nodeId, entries, phase) => {
              const value = entries["value"];
              if (typeof value === "number") write(nodeId, { opacity: value }, phase);
            }}
            size="board"
            showValue={faderFit.value}
          />
        </div>
      )}
    </div>
  );
}

/**
 * T1771b — ANY OTHER NODE on a board is its on/off switch: on means not bypassed, the
 * Layer's own flag and the Layer's own write (`setLayerOn`: the state asked for, never a
 * flip). An effect then passes its input, a source goes silent, and a component instance
 * that is off is not inlined and costs nothing (§T1770b, §V1035). Captioned by the role of
 * its name, like every by-name member.
 */
function SwitchTile({ node, rect, cells, bus, invocation, name }: BoardMemberProps & { readonly name: string }) {
  const on = node.ui?.bypassed !== true;
  const fit = boardFit({ kind: "toggle", caption: name, valueEm: boardValueEm("toggle", {}), widthPx: cells.widthOf(rect.w), cellPx: cells.cellPx });
  return (
    <div className={`${styles.member} ${styles.parts}`} data-board-member="switch" data-switch-on={on ? "true" : "false"}>
      <div className={styles.part} style={{ fontSize: px(fit.fontPx) }}>
        <ControlWidget
          nodeId={node.id}
          type="toggle"
          parameters={{ caption: name, on }}
          write={(_nodeId, entries) => setLayerOn(bus, invocation, node.id, entries["on"] === true)}
          size="board"
          showValue={fit.value}
        />
      </div>
    </div>
  );
}

/**
 * T1527b — the cue list keeps its standby in view, as the phone's does (§T1526b): it
 * scrolls ITSELF, never the pane, and only when the standby MOVED — a list the performer
 * scrolled stays where they left it until the next GO or tap moves the standby.
 */
function useStandbyInView(next: string | null): RefObject<HTMLDivElement | null> {
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = list.current;
    if (element === null || next === null) return;
    const row = [...element.querySelectorAll<HTMLElement>("[data-cue]")].find((each) => each.dataset["cue"] === next);
    if (row === undefined) return;
    if (row.offsetTop < element.scrollTop) element.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > element.scrollTop + element.clientHeight) element.scrollTop = row.offsetTop + row.offsetHeight - element.clientHeight;
  }, [next]);
  return list;
}

function CueListPad({ node, rect, cells, bus, invocation }: BoardMemberProps) {
  const parsed = parseCueList(node.parameters["cues"]);
  const current = text(node.parameters["current"]);
  const position = { current, standby: text(node.parameters["standby"]), wrap: node.parameters["wrap"] === true };
  const next = parsed.ok ? nextCueName(parsed.list, position) : null;
  const { refusal, press } = usePress(bus);
  const layout = cueListBoardLayout(rect);
  const width = cells.widthOf(rect.w);
  const buttonsPx = layout === "beside" ? (width - PART_GAP_PX) / 2 : width;
  const backPx = (buttonsPx - PART_GAP_PX) / 3;
  const backFit = boardFit({ kind: "button", caption: "BACK", valueEm: 0, widthPx: backPx, cellPx: cells.cellPx });
  const goFit = boardFit({ kind: "button", caption: "GO", valueEm: 0, widthPx: (buttonsPx - PART_GAP_PX - backPx) / GO_SCALE, cellPx: cells.cellPx });
  const names = `${current === "" ? NO_CUE : current} ▸ ${next ?? NO_CUE}`;
  const namesFit = boardFit({ kind: "cues", caption: names, valueEm: 0, widthPx: buttonsPx, cellPx: cells.cellPx });
  const step = (command: typeof CUE_GO_COMMAND | typeof CUE_BACK_COMMAND) => () => press(() => bus.execute(command, { nodeId: node.id }, invocation));
  // T1527b: three rows or more, the cues themselves between the names and the buttons.
  const cues = cueListShowsCues(rect) && parsed.ok ? parsed.list.cues : null;
  const list = useStandbyInView(next);
  return (
    <div
      className={`${styles.member} ${styles.parts} ${styles[layout] ?? ""}`}
      style={cues === null ? undefined : { gridTemplateRows: `minmax(0, 1fr) minmax(0, ${String(rect.h - 2)}fr) minmax(0, 1fr)` }}
      data-board-member={CUE_LIST_NODE_TYPE}
      data-layout={layout}
      data-control-node={node.id}
    >
      {layout === "buttons" ? null : (
        <div className={styles.cueNames} style={{ fontSize: px(namesFit.fontPx) }} title={parsed.ok ? "The current cue ▸ the cue GO fires next" : parsed.reason}>
          <span className={styles.cueNow} data-cue-current>{current === "" ? NO_CUE : current}</span>
          <span className={styles.cueArrow} aria-hidden="true">▸</span>
          <span className={styles.cueNext} data-cue-standby>{next ?? NO_CUE}</span>
        </div>
      )}
      {cues === null ? null : (
        <div className={styles.cueList} style={{ fontSize: px(namesFit.fontPx) }} ref={list} role="group" aria-label={`Cues of ${surfaceNameOf(node)}`} data-cue-list>
          {cues.map((cue) => (
            <button
              key={cue.name}
              type="button"
              className={`${styles.press} ${styles.cue} ${cue.name === current ? styles.cueFired : ""} ${cue.name === next ? styles.cueStandby : ""}`}
              aria-pressed={cue.name === next}
              title={`Stand by ${cue.name} — GO fires it next`}
              data-cue={cue.name}
              onClick={() => press(() => bus.execute(CUE_SET_STANDBY_COMMAND, { nodeId: node.id, cue: cue.name }, invocation))}
            >
              <span className={styles.name}>{cue.name}</span>
              {cue.note === undefined || cue.note === "" ? null : <span className={styles.cueNote}>{cue.note}</span>}
            </button>
          ))}
        </div>
      )}
      <div className={styles.cueButtons}>
        <button type="button" className={styles.press} style={{ fontSize: px(backFit.fontPx) }} title="BACK — fires the cue before the current one" onClick={step(CUE_BACK_COMMAND)}>
          BACK
        </button>
        <button type="button" className={`${styles.press} ${styles.go}`} style={{ fontSize: px(goFit.fontPx * GO_SCALE) }} title="GO — fires the standby cue" onClick={step(CUE_GO_COMMAND)}>
          GO
        </button>
      </div>
      <Refusal message={refusal} />
    </div>
  );
}

const MEMBERS: Readonly<Record<string, (props: BoardMemberProps) => ReturnType<typeof PresetStrip>>> = {
  [PRESETS_NODE_TYPE]: PresetStrip,
  [LAYER_NODE_TYPE]: LayerStrip,
  [CUE_LIST_NODE_TYPE]: CueListPad,
};

/** The board item for a bank, a layer or a cue list; `null` for any other node type. */
export function BoardMember(props: BoardMemberProps) {
  // T1541b: a look's presets are its COMPONENT's, and a Store or Delete on the instance
  // changes the catalogue, not the document — so the strip re-reads on the catalogue too.
  const catalogue = usePresetCatalogue(props.bus);
  const Member = MEMBERS[props.node.type];
  if (Member !== undefined) return <Member {...props} />;
  // T1505b: a look's instance on the board by name is its bank — the strip, from its component.
  const view = bankViewOf(props.node, catalogue);
  if (view?.kind === "instance") return <PresetStrip {...props} view={view} name={surfaceNameOf(props.node, catalogue)} />;
  // T1771b: anything else a board names is its on/off switch (an instance only once the catalogue can say it is no look).
  return switchesOnBoard(props.node, catalogue) ? <SwitchTile {...props} name={surfaceNameOf(props.node, catalogue)} /> : null;
}
