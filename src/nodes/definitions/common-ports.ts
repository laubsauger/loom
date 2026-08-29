import type { PortType } from "../../domain/types/ports.ts";

/**
 * The 4-channel float colour texture almost every core node reads and/or writes (§V13).
 * A shared constant so two ports declared with it compare exactly equal by shape, and so
 * the catalogue track (K) has one obvious place to reuse it instead of re-typing the
 * literal (T15 established pattern, §P wave 3 note "K reuses I paths").
 */
export const RGBA_TEXTURE: PortType = { kind: "texture2d", sample: "float", channels: 4 };
