import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { UniformValues } from "../backend/plan.ts";
import { previewUniforms } from "./debug-effects.ts";
import { DEFAULT_PREVIEW_ORBIT, orbitUniforms } from "./orbit.ts";
import { buildPreviewProgram, previewPassId } from "./program.ts";
import { createPreviewScheduler } from "./schedule.ts";
import type { PreviewScheduler } from "./schedule.ts";
import { createTileAtlas } from "./tile-atlas.ts";
import type { TileAtlas } from "./tile-atlas.ts";
import { previewKey } from "./types.ts";
import type {
  AllocatedPreview,
  PreviewCompositeTile,
  PreviewFrameCommand,
  PreviewProgram,
  PreviewRect,
  PreviewRequest,
  PreviewRuntimeHost,
  PreviewSchedule,
  PreviewUniformUpdate,
} from "./types.ts";

/**
 * The preview system (T34).
 *
 * One object the editor drives per display frame. It owns the scheduler's refresh clocks and
 * the tile atlas, and it is the only thing that talks to the presentation host.
 *
 * TWO PHASES, because the host's two methods live on opposite sides of §V8:
 *
 *  - `plan()` may allocate — it builds tile targets and preview pipelines — so the backend
 *    guards `setPreviewProgram` with `assertOutsideFrame` and it MUST be called before the
 *    frame is opened. (`backend.loop(onFrame)` runs `onFrame` with a frame already open, so
 *    calling `plan()` in there throws `FrameEncodingViolation` by design, not by accident.)
 *  - `present()` never allocates and works inside or outside an open frame, exactly like
 *    `backend.render()`.
 *
 * `update()` does both and is therefore an outside-the-frame call: fine for a standalone
 * tick, wrong inside `loop()`. The split is not a workaround for the guard — it IS the §V8
 * boundary, made impossible to cross by accident.
 *
 * Deliberately not a React store and deliberately not a subscriber to the document. Preview
 * pixels and per-frame decisions never enter the document store and never re-render the node
 * tree (§V16); node-facing STATUS (is this preview live, why is it suspended) goes out on the
 * existing `NodeRuntimeStore` channel, which is already coalesced to <= 10 Hz.
 */

export interface PreviewSystemOptions {
  /** `backend.previewHost(canvas)` returns exactly this, plus a `dispose()` the caller owns. */
  readonly host: PreviewRuntimeHost;
  /** Tile budget — the maximum number of live previews (§V28). */
  readonly capacity: number;
}

export interface PreviewSystemFrame {
  /**
   * The previews that exist right now. AUTHORITATIVE (§V28a): an empty array means nothing is
   * previewing, never "carry on with whatever was live last frame". Deriving this list from
   * visibility is the composition root's job, and it must pass every visible preview rather
   * than relying on a union with anything else.
   */
  readonly requests: ReadonlyArray<PreviewRequest>;
  readonly frame: FrameEvaluationInput;
  /** The shared surface's rect in CSS px (usually origin 0,0) and its device pixel ratio. */
  readonly surface: PreviewRect;
  readonly devicePixelRatio: number;
  readonly previewFps: number;
  readonly previewLongEdge: number;
}

export interface PreviewSystemResult {
  readonly schedule: PreviewSchedule;
  readonly program: PreviewProgram;
  readonly command: PreviewFrameCommand;
  /** True when the program changed this frame and the host was asked to rebuild. */
  readonly programChanged: boolean;
}

export interface PreviewSystem {
  readonly capacity: number;
  /**
   * Schedule, build and hand the program to the host. Allocates, so it must run OUTSIDE frame
   * encoding (§V8). Returns the command `present()` should be given.
   */
  plan(input: PreviewSystemFrame): PreviewSystemResult;
  /** Encode refreshes and composite. Never allocates; safe inside an open frame. */
  present(command: PreviewFrameCommand): void;
  /** `plan()` then `present()`. Outside-the-frame convenience for a standalone tick. */
  update(input: PreviewSystemFrame): PreviewSystemResult;
  /** Drop every tile and refresh clock — device loss, project load, pane close (§V23). */
  reset(): void;
}

export function createPreviewSystem(options: PreviewSystemOptions): PreviewSystem {
  const scheduler: PreviewScheduler = createPreviewScheduler({ capacity: options.capacity });
  const atlas: TileAtlas = createTileAtlas({ capacity: options.capacity });
  let lastSignature: string | null = null;
  /**
   * B118: the lens values last PUSHED per pass, serialized. The program's signature
   * excludes uniform values by construction (§V5), so a lens change rebuilds nothing —
   * which means the values must travel by PUSH on the per-frame command, or they are
   * recomputed forever and uploaded never. Cleared on a rebuild: a carried effect keeps
   * its old uniform block, so everything active re-pushes over whatever carried.
   */
  const lastPushed = new Map<string, string>();

  const held = (entry: AllocatedPreview): boolean => atlas.get(previewKey(entry.ref)) !== undefined;

  function plan(input: PreviewSystemFrame): PreviewSystemResult {
    const schedule = scheduler.select(input.requests, {
      frame: input.frame,
      surface: input.surface,
      devicePixelRatio: input.devicePixelRatio,
      previewFps: input.previewFps,
      previewLongEdge: input.previewLongEdge,
    });

    // Allocation follows the REQUEST set, not per-frame visibility (§V142, B13). A preview the
    // user just panned off screen keeps its tile until the pool needs it for one that is
    // drawing, so a camera move asks the host to rebuild nothing at all — and a rebuild is not
    // a private cost, because the host reinstalls the whole program and every preview goes
    // black for the frame. Active previews come first: they win a slot under pressure.
    // A collapsed node is excluded — it has no preview area, so there is no tile to size.
    const holding = schedule.suspended.filter((entry) => entry.reason !== "collapsed");
    // Among previews that are only holding a tile, whoever already has a slot keeps it:
    // reshuffling the pool between two previews that are both off screen is churn nobody
    // asked for. The sort is stable, so the rest stay in request order.
    holding.sort((a, b) => Number(held(b)) - Number(held(a)));

    const allocated: AllocatedPreview[] = [...schedule.active, ...holding];
    const program = buildPreviewProgram(allocated, atlas);
    const programChanged = program.signature !== lastSignature;
    if (programChanged) {
      lastSignature = program.signature;
      options.host.setPreviewProgram(program);
      lastPushed.clear();
    }

    /*
     * B176: the SYNTHESIZED passes' own uniform values, as the PROGRAM states them.
     *
     * Read off the built program rather than off `request.synthesis.passes`, because the
     * two are not the same numbers: `buildPreviewProgram` restates `pointSize` against the
     * granted tile (T952), and pushing the request's nominal value would undo that on the
     * first uniform-only edit. One source, so a rewrite added there travels by construction.
     */
    const programUniforms = new Map<string, UniformValues>();
    for (const pass of program.passes) {
      const values = "uniforms" in pass ? pass.uniforms : undefined;
      if (values !== undefined) programUniforms.set(pass.id, values);
    }

    const refresh: string[] = [];
    const composite: PreviewCompositeTile[] = [];
    const uniforms: PreviewUniformUpdate[] = [];
    for (const entry of schedule.active) {
      const key = previewKey(entry.ref);
      const tile = atlas.get(key);
      if (tile === undefined) continue;
      const passId = previewPassId(key);
      // B118: the lens travels by VALUE on this command, and a change forces a refresh
      // even off-cadence — an exposure nudge that waited for the next due tick would
      // read as a dead control at low preview fps, which is the bug this fixes.
      const values = previewUniforms(entry.request.view);
      const serialized = JSON.stringify(values);
      let changed = lastPushed.get(passId) !== serialized;
      if (changed) {
        lastPushed.set(passId, serialized);
        uniforms.push({ passId, values });
      }
      /*
       * B176 + T561 — THE SYNTHESIS PASSES' VALUES, ON THE SAME PUSH SEAM AS THE LENS.
       *
       * §V521 gives a synthesized preview its OWN passes with their OWN uniforms, which the
       * main plan does not carry — so `backend.updateUniforms`, which resolves against the
       * main program, cannot reach them. And `program.signature` excludes uniform values by
       * construction (§V5), so a uniform-only edit rebuilds nothing and reinstalls nothing.
       * Both halves are correct and together they left NO PATH AT ALL: a colour edit updated
       * the render output and the tile went on drawing the previous compile's numbers, until
       * some later STRUCTURAL edit happened to reinstall the program and silently repair it.
       * That is why the owner met it only when they changed a colour twice in a row.
       *
       * Keyed on the pass carrying uniforms, never on a list of kinds: camera, light,
       * geometry, material, projector and pointset are covered because they are synthesized,
       * not because they are enumerated — a seventh kind is covered the day it compiles.
       *
       * T561's inspection orbit is folded in here rather than pushed separately, and the
       * ORDER is the reason: the orbit OVERRIDES the descriptor's baked `viewProjection`, so
       * a separate later push would be reverted by this one on the very next edit — and its
       * own dedup would then skip re-pushing, because the orbit itself had not moved. One
       * merged block per pass, one dedup key, precedence by construction.
       */
      const orbitBasis = entry.request.synthesis?.orbit;
      const orbitValues =
        orbitBasis === undefined
          ? undefined
          : orbitUniforms(orbitBasis, entry.request.orbit ?? DEFAULT_PREVIEW_ORBIT);
      const synthesisValues = new Map<string, UniformValues>();
      for (const synthPass of entry.request.synthesis?.passes ?? []) {
        const values = programUniforms.get(synthPass.id);
        if (values !== undefined) synthesisValues.set(synthPass.id, values);
      }
      if (orbitValues !== undefined && orbitBasis !== undefined) {
        for (const orbitPassId of orbitBasis.passIds) {
          synthesisValues.set(orbitPassId, { ...synthesisValues.get(orbitPassId), ...orbitValues });
        }
      }
      for (const [synthPassId, synthValues] of synthesisValues) {
        const synthSerialized = JSON.stringify(synthValues);
        if (lastPushed.get(synthPassId) === synthSerialized) continue;
        lastPushed.set(synthPassId, synthSerialized);
        uniforms.push({ passId: synthPassId, values: synthValues });
        changed = true;
      }
      if (entry.due || changed) {
        // T563: a synthesized preview re-renders its source target first — the splat or
        // stock scene draws, in descriptor order, then the lens pass samples the result.
        // Encode order is THIS list's order; the program's pass array is sorted for the
        // signature and never encodes.
        for (const synthPass of entry.request.synthesis?.passes ?? []) refresh.push(synthPass.id);
        refresh.push(passId);
      }
      // Every active tile composites every frame, due or not: a pan moves the destination
      // rect without changing a single pixel inside the tile.
      composite.push({ ref: entry.ref, resourceId: tile.resourceId, dest: entry.request.rect });
    }

    const command: PreviewFrameCommand = {
      refresh,
      composite,
      uniforms,
      surface: { size: [input.surface.width, input.surface.height], dpr: input.devicePixelRatio },
    };

    return { schedule, program, command, programChanged };
  }

  function present(command: PreviewFrameCommand): void {
    options.host.presentPreviews(command);
  }

  return {
    capacity: options.capacity,
    plan,
    present,

    update(input: PreviewSystemFrame): PreviewSystemResult {
      const result = plan(input);
      present(result.command);
      return result;
    },

    reset(): void {
      scheduler.reset();
      atlas.reset();
      lastSignature = null;
      lastPushed.clear();
    },
  };
}
