import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { CompiledNodeDescription, NodeCompileContext } from "../../domain/types/node-definition.ts";
import type { CameraPayload, LightPayload } from "../../domain/types/scene.ts";
import type { BufferBindingDescriptor, BufferWritePassDescriptor, DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import {
  LIGHT_CONE_EVERYWHERE,
  LIGHT_LIVE_BINDING,
  LIGHT_NO_CONE,
  LIGHT_RECORDS_BINDING,
  LIGHT_SET_BINDING,
  LIGHT_SOURCE_PREFIX,
  LIGHT_TABLE_BINDING,
  LIGHT_TABLE_HEADER_WORDS,
  LIGHT_WORKGROUP,
  lightGatherWgsl,
  lightGridWgsl,
  lightResolveWgsl,
  lightTableHeader,
} from "../shaders/scene-lights.wgsl.ts";
import type { PointAttributeType } from "../../points/attributes.ts";
import type { NodeCompileInputs } from "./compile-context.ts";
import { readValueInputs } from "./compile-context.ts";
import { packedGroups } from "./instance-records.ts";
import { LIGHT_RECORD_WORDS, MAX_LIGHT_SLOTS, lightGridDimensions, lightNamedStorage, lightRecordStorage, lightTableStorage, namedLightCapacity } from "./light-records.ts";
import { readNumber, readVector } from "./parameter-readers.ts";
import { resolveColorMap, resolveScalarMap } from "./points.ts";

/**
 * T1589b — LIGHTS FROM A POINTSET, the two nodes' halves
 * (docs/lights-from-pointset-design-2026-10-06.md, sections 3 and 4).
 *
 * `compileLightPoints` is the LIGHT in Points mode: it resolves its pointset into records,
 * once a frame, and publishes them. `lightTablePlan` is the RENDER: it writes its named
 * Lights that do not cast as records of its own (T1623b), gathers them and the records of
 * every Light in Points mode it lists into one table, and builds the grid over its own
 * view. Both live here so that `scene.ts` holds a call to each and nothing else of the path.
 */

/** The parameters of a Light that take a per-point attribute in Map mode, in Points mode. */
export const LIGHT_POINT_MAPS = ["color", "intensity", "position", "range", "direction", "orient", "cone"] as const;

/** A Light's Type as its rows carry it (`scene-lights.wgsl.ts`, the record's kind). */
export const lightKindNumber = (kind: unknown): number => (kind === "spot" ? 2 : kind === "point" ? 1 : 0);

const refusal = (nodeId: string, code: string, message: string, suggestion: string): CompiledNodeDescription => ({
  passes: [],
  diagnostics: [{ severity: "error", code, message: `Node "${nodeId}": ${message}`, nodeId, suggestion }],
});

/**
 * A map this Light cannot honour, refused BY NAME (§V288): a parameter that takes no map, or
 * any map at all on a Light in Single mode, which has no points to read one from. A map that
 * was quietly dropped would leave the retained value lighting the scene and look authored.
 */
export function lightMapRefusal(
  nodeId: string,
  parameterMaps: NodeCompileInputs["parameterMaps"],
  pointsMode: boolean,
): CompiledNodeDescription | undefined {
  const mapped = Object.keys(parameterMaps).sort();
  if (mapped.length === 0) return undefined;
  const takes = (LIGHT_POINT_MAPS as readonly string[]).map((key) => `"${key}"`).join(", ");
  if (!pointsMode) {
    return {
      passes: [],
      diagnostics: mapped.map((key) => ({
        severity: "error" as const,
        code: "node.parameter.map",
        message: `Node "${nodeId}": ${key} is in map mode, but this Light is one light (Mode: Single) and has no points to read a per-point value from.`,
        nodeId,
        suggestion: `Set Mode to Points and wire a pointset to Points (a Light then maps ${takes}), or switch ${key} back to Constant.`,
      })),
    };
  }
  const unhonoured = mapped.filter((key) => !(LIGHT_POINT_MAPS as readonly string[]).includes(key));
  if (unhonoured.length === 0) return undefined;
  return {
    passes: [],
    diagnostics: unhonoured.map((key) => ({
      severity: "error" as const,
      code: "node.parameter.map",
      message: `Node "${nodeId}": ${key} is in map mode, but a Light in Points mode maps only ${takes}.`,
      nodeId,
      suggestion: "Switch it back to Constant, or drive it through the value graph instead.",
    })),
  };
}

/**
 * A SPOT THAT SHINES AS A POINT LIGHT SAYS SO (T1589b slice 2, T1623b slice 3).
 *
 * A spot is a kind of ROW of a Render's light table: a Light in Points mode, and a Light in
 * Single mode that does not cast, are rows, and their cone is the walk's. Two things are not
 * rows yet, and take no cone:
 *
 *  - A CASTING Light in Single mode is still a block of the lit shader (it goes with T1623b
 *    slices 4 and 5): `lightSpotUnbuilt`, said by the Light.
 *  - A draw of primitive instances, points or beams has no table yet (slice 7) and still
 *    reads every Light in Single mode as a block: `lightSpotDraw`, said by the Render, for
 *    each such draw a spot lights.
 *
 * In both the spot shines as a point light from its Position, in every direction.
 *
 * A WARNING, never a refusal. Type is a value: the plan and every text are the same whichever
 * it says, so nothing here is decided by it. It is in the compile's diagnostics, which the
 * Problems pane and the headless server both read, by the node's name. The compile runs on
 * every revision, so an authored Type: Spot is said from the edit that makes it; a Type
 * DRIVEN to Spot between revisions is not, because a values-only frame keeps no node's
 * diagnostics (`frame-compile.ts`, T1646b).
 */
export function lightSpotUnbuilt(nodeId: string): RuntimeDiagnostic {
  return {
    severity: "warning",
    code: "node.scene.lightSpot",
    message: `Node "${nodeId}": Type is Spot and Cast Shadows is on, and a casting Light has no cone yet. It shines as a Point light from Position, in every direction: Cone, Cone Softness and Direction are not read.`,
    nodeId,
    suggestion: "Turn Cast Shadows off (a spot that does not cast has its cone), or set Type to Point. A casting spot takes its cone when casting Lights become rows of the Render's light table.",
  };
}
export function lightSpotDraw(nodeId: string, geometry: string, mode: string, spots: ReadonlyArray<string>): RuntimeDiagnostic {
  return {
    severity: "warning",
    code: "node.scene.lightSpot",
    message: `Node "${nodeId}": geometry "${geometry}" is drawn as ${mode === "instances" ? "primitive instances" : mode}, which a Spot (${spots.map((name) => `"${name}"`).join(", ")}) lights as a Point light from its Position, in every direction: its cone is read by Surface geometry and mesh instances only.`,
    nodeId,
    suggestion: "Draw it as a Surface or as mesh instances (Shape: Mesh), or leave the spot out of this Render's Lights.",
  };
}

/**
 * T1623b — HOW MANY ROWS MAY REACH EVERY PIXEL BEFORE THE RENDER SAYS SO.
 *
 * A directional light and a light with no Range are shaded by every lit pixel: no grid can
 * leave them out. Measured 2026-10-06 on the lit draw alone (a PBR floor filling 7680 x 4320,
 * a fixed reference pass beside every frame): each such row costs 0.21 of the reference
 * there, which is 0.036 ms of this machine's GPU for a Surface that fills a 1920 x 1080
 * frame. At 32 rows that is 1.1 ms, a fifteenth of a frame at 60 Hz, for one lit layer; a
 * pointset's rows cost about 1.6 times that (they are walked by the loop that tests every
 * row's kind and cone). A light with a Range costs only where it reaches.
 */
export const LIGHT_EVERYWHERE_ABOVE = 32;

/**
 * The Light in POINTS mode: one light at every point of the Points input.
 *
 * `light` is the node's own values as the Single path reads them (colour in linear space,
 * intensity, range, falloff): the resolve pass takes them as uniforms, so a breathing
 * Intensity or a driven Range is a write, never a rebuild (§V5). What is structural is which
 * attributes are mapped, and whether the pointset is counted.
 */
export function compileLightPoints(request: {
  readonly nodeId: string;
  readonly points: NodeCompileInputs["inputs"][string] | undefined;
  readonly parameters: NodeCompileInputs["parameters"];
  readonly parameterMaps: NodeCompileInputs["parameterMaps"];
  readonly light: LightPayload["light"];
  /** T1719b: the Light's own row at another frame, for the value function this returns. */
  readonly lightAt?: (context: NodeCompileContext) => LightPayload["light"];
}): CompiledNodeDescription {
  const { nodeId, parameters, parameterMaps, light } = request;
  const pointset = request.points?.pointset;
  if (pointset === undefined) {
    return refusal(
      nodeId,
      "node.scene.lightPoints",
      "Mode: Points repeats this light at every point of the Points input, and no pointset arrives on it.",
      "Wire a pointset to Points (a Point Grid, a Point Kernel, a Resample along a curve), or set Mode back to Single.",
    );
  }
  const position = resolveColorMap(nodeId, parameterMaps["position"], pointset, "points", "position", "vec3f");
  if ("refusal" in position) return position.refusal;
  const place = position.map ?? pointset.pairs["position"];
  if (place === undefined || (position.map === undefined && place.type !== "vec3f")) {
    return refusal(
      nodeId,
      "node.scene.lightPoints",
      "the Points input carries no vec3f `position`, and a light stands at its point's position.",
      "Keep position through any kernel before the Light, or map Position to the vec3f attribute that holds each light's place.",
    );
  }
  const color = resolveColorMap(nodeId, parameterMaps["color"], pointset, "points", "color");
  if ("refusal" in color) return color.refusal;
  const intensity = resolveScalarMap(nodeId, parameterMaps["intensity"], pointset, "points", "intensity");
  if ("refusal" in intensity) return intensity.refusal;
  const range = resolveScalarMap(nodeId, parameterMaps["range"], pointset, "points", "range");
  if ("refusal" in range) return range.refusal;
  /* The way each light travels: a vec3f in place of Direction, a quaternion in place of Orient. */
  const direction = resolveColorMap(nodeId, parameterMaps["direction"], pointset, "points", "direction", "vec3f");
  if ("refusal" in direction) return direction.refusal;
  const orient = resolveColorMap(nodeId, parameterMaps["orient"], pointset, "points", "orient");
  if ("refusal" in orient) return orient.refusal;
  const cone = resolveScalarMap(nodeId, parameterMaps["cone"], pointset, "points", "cone");
  if ("refusal" in cone) return cone.refusal;

  const records = lightRecordStorage(nodeId, pointset.capacity);
  const sources = packedGroups();
  /* `resolveScalarMap` hands back an f32 or a float vector with its channel, and nothing else. */
  const scalar = (map: NonNullable<typeof intensity.map>) => ({
    ...sources.read(map, map.type as PointAttributeType),
    ...(map.channel === undefined ? {} : { channel: map.channel }),
  });
  const placeRead = sources.read(place, "vec3f");
  const colorRead = color.map === undefined ? undefined : sources.read(color.map, "vec4f");
  const intensityRead = intensity.map === undefined ? undefined : scalar(intensity.map);
  const rangeRead = range.map === undefined ? undefined : scalar(range.map);
  const directionRead = direction.map === undefined ? undefined : sources.read(direction.map, "vec3f");
  const orientRead = orient.map === undefined ? undefined : sources.read(orient.map, "vec4f");
  const coneRead = cone.map === undefined ? undefined : scalar(cone.map);
  /* T1719b: the pass's numbers and the payload, from resolved values over the structure above;
     the compile fills them through these and a values-only frame asks them again. */
  const uniformsAt = (values: NodeCompileInputs["parameters"], at: LightPayload["light"]): NonNullable<DispatchPassDescriptor["uniforms"]> => {
    const turn = readVector(values as never, "orient", [0, 0, 0, 1]);
    return {
      color: [at.color[0], at.color[1], at.color[2], at.intensity],
      /* The Type is a value of the row (T1623b): a set of suns, of lamps and of spots are one text. */
      shape: [Math.max(0, readNumber(values, "range", 0)), at.falloff === "inverseSquare" ? 1 : 0, lightKindNumber(values["kind"]), 0],
      aim: [at.direction[0], at.direction[1], at.direction[2], 0],
      orient: [turn[0] ?? 0, turn[1] ?? 0, turn[2] ?? 0, turn[3] ?? 1],
      cone: [readNumber(values, "cone", 60), readNumber(values, "coneSoftness", 0.4), 0, 0],
      count: pointset.capacity,
    };
  };
  const payloadAt = (values: NodeCompileInputs["parameters"], at: LightPayload["light"]): LightPayload => ({
    kind: "light",
    /* A pointset's lights cast no shadow (the casting few are Lights in Single mode, T1622b). */
    light: { ...at, shadows: false },
    points: {
      records: records.resourceId,
      capacity: pointset.capacity,
      /* T1623b: a sun, and a placed light whose Range is 0 with no attribute to scale it. */
      always: lightKindNumber(values["kind"]) === 0 || (Math.max(0, readNumber(values, "range", 0)) === 0 && rangeRead === undefined),
    },
  });
  const pass: DispatchPassDescriptor = {
    kind: "dispatch",
    id: `${nodeId}:lights:resolve`,
    shader: lightResolveWgsl({
      groups: sources.count,
      place: placeRead,
      ...(colorRead === undefined ? {} : { color: colorRead }),
      ...(intensityRead === undefined ? {} : { intensity: intensityRead }),
      ...(rangeRead === undefined ? {} : { range: rangeRead }),
      ...(directionRead === undefined ? {} : { direction: directionRead }),
      ...(orientRead === undefined ? {} : { orient: orientRead }),
      ...(coneRead === undefined ? {} : { cone: coneRead }),
      ...(pointset.count === undefined ? {} : { counted: true }),
    }),
    entryPoint: "main",
    workgroups: [Math.ceil(pointset.capacity / LIGHT_WORKGROUP), 1, 1],
    buffers: [
      { binding: LIGHT_RECORDS_BINDING, resourceId: records.resourceId },
      ...(pointset.count === undefined ? [] : [{ binding: LIGHT_LIVE_BINDING, resourceId: pointset.count.buffer }]),
      ...sources.bindings(LIGHT_SOURCE_PREFIX),
    ],
    uniforms: uniformsAt(parameters, light),
    uniformBinding: "params",
    nodeId,
  };
  const lightAt = request.lightAt;
  return {
    passes: [pass],
    scratch: [records.scratch],
    scene: { out: payloadAt(parameters, light) },
    ...(lightAt === undefined
      ? {}
      : {
          values: (next: NodeCompileContext) => {
            const values = readValueInputs(next).parameters;
            const at = lightAt(next);
            return { passes: [{ uniforms: uniformsAt(values, at) }], scene: { out: payloadAt(values, at) } };
          },
        }),
  } as CompiledNodeDescription;
}

/* ------------------------------------------------------------------------------------ */
/* The Render's half                                                                     */
/* ------------------------------------------------------------------------------------ */

/** One pointset Light a Render lists: the node, for a sentence that names it, its records, and its place in the Render's Lights. */
export interface PointLightSource {
  readonly nodeId: string;
  readonly points: NonNullable<LightPayload["points"]>;
  /** Which Light of the Render's Lights this is, counted from 0 in list order: every row of its set carries it. */
  readonly number: number;
}

/** T1623b: a Light in Single mode that does not cast. One row of the Render's table. */
export interface NamedLight {
  readonly nodeId: string;
  readonly light: LightPayload["light"];
  /** Its place in the Render's Lights, counted from 0: its row's source number. */
  readonly number: number;
}

/**
 * T1623b — A NAMED LIGHT AS ONE RECORD: the sixteen floats of a row, as a Light in Points
 * mode resolves them on the GPU for each of its points (`lightResolveWgsl`), computed here
 * from the Light's own values, and which walk of the lit draw the row is for
 * (`NamedLightWalk`). A light of no intensity, a sun or a spot with no way to shine and a
 * spot of no cone are off. A spot whose Cone is every direction has no cone, and is walked
 * as the point light it is.
 *
 * THE ROW HOLDS THE NUMBERS THE BLOCK IT REPLACES READ, where a float can: a sun's direction
 * as authored and its colour times intensity as one float product. Normalising the direction
 * here, in doubles, moved it by the last bit of a float from what the shader's own
 * `normalize` gives, and a glossy lobe (its denominator is a difference of near-equal
 * numbers) showed that as up to two steps of a half float in a shipped picture (E77,
 * measured; with the direction as authored the picture differs from main's by what B260's
 * guard alone moves).
 */
export function namedLightRecord(light: LightPayload["light"], number: number): { readonly record: number[]; readonly walk: NamedLightWalk } {
  const kind = light.spot !== undefined ? 2 : light.type === "point" ? 1 : 0;
  const placed = kind > 0;
  const travels = kind !== 1;
  const length = Math.hypot(light.direction[0], light.direction[1], light.direction[2]);
  const cone = light.spot?.cone ?? 0;
  const lit = light.intensity > 0 && (length > 0 || !travels) && (kind !== 2 || cone > 0);
  const range = !lit ? -1 : placed ? Math.max(0, light.range) : 0;
  const every = kind !== 2 || cone >= LIGHT_CONE_EVERYWHERE;
  const half = (cone * Math.PI) / 360;
  const softness = Math.min(1, Math.max(0, light.spot?.softness ?? 0));
  /* A spot's aim is a unit vector: its cone is measured against it. A directional row's is
     written AS AUTHORED, at any length: every reader of a sun's aim normalises it (the light
     block does), so the direction a fragment shades by is the bits the uniform row carried. */
  const scale = kind === 0 ? 1 : length > 0 ? 1 / length : 0;
  /* Colour times intensity as the lit shader multiplied its two uniform rows: each rounded
     to a float, then one float product (`Math.fround`), not a product of doubles rounded once. */
  const intensity = Math.fround(Math.max(0, light.intensity));
  const tone = (channel: 0 | 1 | 2): number => Math.fround(Math.fround(light.color[channel]) * intensity);
  return {
    record: [
      light.position[0],
      light.position[1],
      light.position[2],
      range,
      tone(0),
      tone(1),
      tone(2),
      light.falloff === "inverseSquare" ? 1 : 0,
      light.direction[0] * scale,
      light.direction[1] * scale,
      light.direction[2] * scale,
      every ? LIGHT_NO_CONE.outer : Math.cos(half),
      every ? LIGHT_NO_CONE.inner : Math.cos(half * (1 - softness)),
      kind,
      0,
      number,
    ],
    walk: !lit ? "off" : kind === 0 ? "suns" : range > 0 ? "grid" : every ? "points" : "general",
  };
}

/**
 * Which walk of the lit draw a named Light's row is for (`lightTableWalkWgsl`): the loop of
 * the directional rows, the loop of the point rows with no Range, the loop of the rows of
 * any kind that reach every pixel (a spot with a cone and no Range), its range's cells, or
 * none. A VALUE: the Render orders its named rows by it every frame.
 */
export type NamedLightWalk = "suns" | "points" | "general" | "grid" | "off";

type BufferScratch = { readonly kind: "buffer"; readonly key: string; readonly stride: number; readonly capacity: number };

export interface LightTablePlan {
  /**
   * The table's values (its header, the named rows), a gather a set, then the grid: emitted
   * before anything draws the colour (T1604b). The two value passes encode nothing.
   */
  readonly passes: Array<DispatchPassDescriptor | BufferWritePassDescriptor>;
  /** The table, and the buffer the named Lights' rows are written into. */
  readonly scratch: BufferScratch[];
  /** The one buffer a lit draw binds for the lights. */
  readonly buffer: BufferBindingDescriptor;
  /** The rows a lit draw carries: the grid, the lens and the depth row. */
  readonly uniforms: Readonly<Record<string, number[]>>;
  /** What the Render says with its plan: more rows reach every pixel than `LIGHT_EVERYWHERE_ABOVE`. */
  readonly warnings: RuntimeDiagnostic[];
}

/**
 * The Render's light table and its passes, or the refusal that names what does not fit.
 *
 * WHAT THE TABLE HOLDS, in the order its rows stand this frame:
 *
 *   the pointset Lights whose points reach every pixel   } rows of any kind: one loop that
 *   the named spots with a cone and no Range             } tests each row's kind and cone
 *   the named point lights with no Range                 } a loop written for them
 *   the named directional lights                         } a loop written for them
 *   the other named Lights (a Range, or off)             } found through the grid's cells,
 *   the pointset Lights whose points have a range        } or by nothing
 *
 * The first three runs are the ALWAYS-WALKED rows (`lightTableWalkWgsl` says why they are
 * three). Which run a Light is in, is a VALUE (its Type, its Range, its Cone), so where a
 * set stands is a value too: each gather pass is handed the row its set starts at, and the
 * header says where each run ends. The STRUCTURE is the room: the named Lights' step, and
 * every slot of every pointset. Adding a named Light inside a step, taking one out,
 * re-ordering the list, changing a Type or a Range: all of them writes.
 *
 * THE NAMED ROWS OF ONE RUN STAND IN THE RENDER'S LIST ORDER (a filter of the list, never a
 * sort), so the order lights are summed in follows the list and nothing else.
 *
 * `surface` is the size in pixels of what the lit draws render into (twice the output under
 * SSAA): a fragment finds its tile from its own pixel. The grid itself is a share of the
 * picture and does not know the size.
 */
export function lightTablePlan(request: {
  readonly nodeId: string;
  readonly named: ReadonlyArray<NamedLight>;
  readonly sources: ReadonlyArray<PointLightSource>;
  readonly resolution: readonly [number, number];
  readonly surface: readonly [number, number];
  readonly camera: CameraPayload;
  readonly viewProjection: ArrayLike<number>;
}): LightTablePlan | { readonly diagnostics: RuntimeDiagnostic[] } {
  const { nodeId, named, sources, camera } = request;
  const refuse = (code: string, message: string, suggestion: string): { diagnostics: RuntimeDiagnostic[] } => ({
    diagnostics: [{ severity: "error", code, message: `Node "${nodeId}": ${message}`, nodeId, suggestion }],
  });
  const namedRoom = namedLightCapacity(named.length);
  const slots = namedRoom + sources.reduce((total, source) => total + source.points.capacity, 0);
  if (slots > MAX_LIGHT_SLOTS) {
    return refuse(
      "node.scene.lightCapacity",
      `its light table would hold ${slots} rows, and it holds at most ${MAX_LIGHT_SLOTS}: ${namedRoom} kept for its ${named.length} Light${named.length === 1 ? "" : "s"} in Single mode that do not cast, and every point of capacity of its Lights in Points mode, lit or not (${sources.map((source) => `"${source.nodeId}" ${source.points.capacity}`).join(", ") || "none"}).`,
      "Lower the capacity of the pointsets that feed the Lights in Points mode to the lights they need, or list fewer Lights.",
    );
  }
  const grid = lightGridDimensions(request.resolution);
  const table = lightTableStorage(nodeId, slots, grid);
  const rows = lightNamedStorage(nodeId, namedRoom);
  const tableBuffer: BufferBindingDescriptor = { binding: LIGHT_TABLE_BINDING, resourceId: table.resourceId };

  /* The named rows, by the walk each is for; each class in list order. */
  const records = named.map((entry) => ({ ...namedLightRecord(entry.light, entry.number), nodeId: entry.nodeId }));
  const walkedBy = (walk: NamedLightWalk): typeof records => records.filter((entry) => entry.walk === walk);
  const everyNamed = [...walkedBy("general"), ...walkedBy("points"), ...walkedBy("suns")];
  const ordered = [...everyNamed, ...records.filter((entry) => entry.walk === "grid" || entry.walk === "off")];
  /* Where each set stands this frame. */
  const everySets = sources.filter((source) => source.points.always);
  const rangedSets = sources.filter((source) => !source.points.always);
  const base = new Map<PointLightSource, number>();
  let next = 0;
  for (const source of everySets) {
    base.set(source, next);
    next += source.points.capacity;
  }
  const namedAt = next;
  next += named.length;
  const general = namedAt + walkedBy("general").length;
  const points = general + walkedBy("points").length;
  const always = namedAt + everyNamed.length;
  for (const source of rangedSets) {
    base.set(source, next);
    next += source.points.capacity;
  }
  const live = next;

  /* The camera, as the grid needs it. The depth of a place is read off the view-projection the
     draws use: its w row for a perspective camera, its z row scaled back to distance for an
     orthographic one. The half-extents are the ambient occlusion resolve's own. */
  const matrix = request.viewProjection;
  const row = (index: number): number[] => [0, 1, 2, 3].map((column) => matrix[column * 4 + index] ?? 0);
  const near = Math.max(camera.near, 1e-6);
  const far = Math.max(camera.far, near * 1.001);
  const depthRow = camera.ortho
    ? row(2).map((value, index) => value * (camera.far - camera.near) + (index === 3 ? camera.near : 0))
    : row(3);
  const aspect = request.resolution[0] / Math.max(request.resolution[1], 1);
  const tanHalf = Math.tan((camera.fovDeg * Math.PI) / 360);
  const orthoHalf = Math.max(camera.orthoHeight, 1e-6) / 2;
  const halfExtents = camera.ortho ? [orthoHalf * aspect, orthoHalf] : [tanHalf * aspect, tanHalf];
  const gridRow = [grid[0], grid[1], grid[2], camera.ortho ? 1 : 0];

  /* ONE text for every gather: what differs is the set it binds and three values. */
  const gather = (index: number, set: string, room: number, source: number[]): DispatchPassDescriptor => ({
    kind: "dispatch",
    id: `${nodeId}:lights:gather:${index}`,
    shader: lightGatherWgsl(),
    entryPoint: "main",
    workgroups: [Math.ceil(room / LIGHT_WORKGROUP), 1, 1],
    buffers: [tableBuffer, { binding: LIGHT_SET_BINDING, resourceId: set }],
    uniforms: { source },
    uniformBinding: "params",
    nodeId,
  });
  const header: BufferWritePassDescriptor = {
    kind: "write",
    id: `${nodeId}:lights:header`,
    nodeId,
    resourceId: table.resourceId,
    offset: 0,
    row: Array.from({ length: LIGHT_TABLE_HEADER_WORDS }, () => "u32" as const),
    capacity: 1,
    values: { rows: lightTableHeader({ regionRows: slots, words: table.words, cells: table.cellsAt, always, rows: live, general, points }), count: 1 },
  };
  const namedRows: BufferWritePassDescriptor = {
    kind: "write",
    id: `${nodeId}:lights:named`,
    nodeId,
    resourceId: rows.resourceId,
    offset: 0,
    row: Array.from({ length: LIGHT_RECORD_WORDS }, () => "f32" as const),
    capacity: namedRoom,
    values: { rows: ordered.flatMap((entry) => entry.record), count: ordered.length },
  };
  const build: DispatchPassDescriptor = {
    kind: "dispatch",
    id: `${nodeId}:lights:grid`,
    shader: lightGridWgsl(),
    entryPoint: "main",
    workgroups: [Math.ceil(table.cells / LIGHT_WORKGROUP), 1, 1],
    buffers: [tableBuffer],
    uniforms: {
      viewProjection: Array.from(matrix),
      depthRow,
      lens: [halfExtents[0] as number, halfExtents[1] as number, near, far],
      grid: gridRow,
    },
    uniformBinding: "params",
    nodeId,
  };
  return {
    passes: [
      header,
      namedRows,
      /* The named rows carry their own Lights' numbers; a pointset's take their Light's here. */
      gather(0, rows.resourceId, namedRoom, [namedAt, named.length, 0, 0]),
      ...sources.map((source, index) => gather(index + 1, source.points.records, source.points.capacity, [base.get(source) ?? 0, source.points.capacity, source.number, 0])),
      build,
    ],
    scratch: [table.scratch, rows.scratch],
    buffer: tableBuffer,
    uniforms: {
      lightGrid: gridRow,
      lightLens: [request.surface[0], request.surface[1], near, far],
      lightDepth: depthRow,
    },
    warnings: everywhereWarning(nodeId, [
      ...everySets.map((source) => ({ nodeId: source.nodeId, rows: source.points.capacity })),
      ...everyNamed.map((entry) => ({ nodeId: entry.nodeId, rows: 1 })),
    ]),
  };
}

/**
 * The Render's remark when more of its rows reach every pixel than `LIGHT_EVERYWHERE_ABOVE`,
 * by its own name and the Lights' (§V288). For what is AUTHORED: the compile of a revision
 * says it; a Range driven to 0 between revisions is not said (T1646b). A pointset counts
 * every point of its capacity, as the table does.
 */
function everywhereWarning(nodeId: string, lights: ReadonlyArray<{ readonly nodeId: string; readonly rows: number }>): RuntimeDiagnostic[] {
  const rows = lights.reduce((total, light) => total + light.rows, 0);
  if (rows <= LIGHT_EVERYWHERE_ABOVE) return [];
  const sets = lights.filter((light) => light.rows > 1);
  const single = lights.length - sets.length;
  const from = [...sets.map((light) => `"${light.nodeId}" ${light.rows}`), ...(single === 0 ? [] : [`${single} Light${single === 1 ? "" : "s"} in Single mode`])].join(", ");
  return [
    {
      severity: "warning",
      code: "node.scene.lightEverywhere",
      message: `Node "${nodeId}": ${rows} of its lights reach every pixel (directional lights, and point and spot lights with no Range): ${from}. Every lit pixel shades each of them, where a light with a Range is shaded only where it reaches; past ${LIGHT_EVERYWHERE_ABOVE} that is a cost worth knowing.`,
      nodeId,
      suggestion: "Give the point and spot lights a Range (their light then ends there), or list fewer of them.",
    },
  ];
}
