import type { PortType } from "../../domain/types/ports.ts";

/**
 * The 4-channel float colour texture almost every core node reads and/or writes (§V13).
 * A shared constant so two ports declared with it compare exactly equal by shape, and so
 * the catalogue track (K) has one obvious place to reuse it instead of re-typing the
 * literal (T15 established pattern, §P wave 3 note "K reuses I paths").
 */
export const RGBA_TEXTURE: PortType = { kind: "texture2d", sample: "float", channels: 4 };

/**
 * The 4-channel float texture whose values are MEASUREMENTS, not light (§V56, §V57c,
 * T768): uv fields, displacement offsets, coverage masks, camera depth. On an INPUT it
 * means "read as data, accept any source space — nothing here converts"; on an OUTPUT it
 * means "nothing downstream may display-decode this", and §V13 refuses it into a colour
 * input outright. One constant so every member of the data family compares exactly equal
 * by shape, the same reason RGBA_TEXTURE above exists.
 */
export const DATA_TEXTURE: PortType = { kind: "texture2d", sample: "float", channels: 4, space: "data" };

/**
 * The value-graph port (§V179): a CPU-side channel bag, never a texture.
 *
 * Here rather than in one family's module because two now declare it — the CHOP set and
 * the value SOURCES (T325) — and §V19 compares ports by shape. One constant is how the
 * two families stay wirable to each other by construction instead of by coincidence.
 */
export const VALUE_PORT: PortType = { kind: "value" };

/**
 * How many texture inputs one node's shader may bind (T226, T235).
 *
 * WebGPU guarantees only 16 sampled textures per shader stage, and a variadic node binds
 * one per connected edge. Eight leaves half that budget for the shared frame block and for
 * whatever a pass needs alongside its inputs — and past eight inputs on a single node, a
 * graph reads better as two nodes anyway. Shared so the two variadic nodes cannot drift
 * into disagreeing about the same hardware limit.
 */
export const MAX_TEXTURE_INPUTS = 8;
