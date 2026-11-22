/**
 * COLOUR MAPS for looking at a single value — a depth map most of all (owner 2026-11-22:
 * "a different default theme for the depth map coloring in preview … red to blue ones that
 * seem easier to identify").
 *
 * Display only. Nothing here touches what a node renders: a Depth node still publishes grey
 * data that Displace reads. These colour the PREVIEW of that data (the node's tile, the photo
 * surface's depth view), the way every depth tool shows its output.
 *
 * ONE table, read by both renderers: the WGSL below is generated from it, and `colormapRgb`
 * evaluates the same numbers on the CPU, so the GPU preview and the photo surface's canvas
 * cannot disagree about what Turbo is.
 *
 * Every map runs LOW → HIGH. A depth map is near-bright, so near is the high end: red in
 * Turbo and Spectral, yellow in Viridis and Inferno. Outputs are display-referred sRGB.
 *
 * Sources:
 *  - Turbo: Anton Mikhailov's polynomial approximation, Google, Apache-2.0
 *    (https://ai.googleblog.com/2019/08/turbo-improved-rainbow-colormap-for.html).
 *  - Viridis, Inferno: Matt Zucker's degree-6 polynomial fits of the matplotlib maps, CC0
 *    (https://www.shadertoy.com/view/WlfXRN).
 *  - Spectral: ColorBrewer's 11-class Spectral, Cynthia Brewer, Apache-2.0, reversed so blue
 *    is low and red is high.
 */

type Polynomial = { readonly kind: "polynomial"; readonly coefficients: readonly (readonly [number, number, number])[] };
type Stops = { readonly kind: "stops"; readonly stops: readonly (readonly [number, number, number])[] };

export const COLORMAPS = [
  {
    id: "turbo", label: "Turbo", title: "Rainbow, blue far to red near",
    curve: { kind: "polynomial", coefficients: [
      [0.13572138, 0.09140261, 0.1066733],
      [4.6153926, 2.19418839, 12.64194608],
      [-42.66032258, 4.84296658, -60.58204836],
      [132.13108234, -14.18503333, 110.36276771],
      [-152.94239396, 4.27729857, -89.90310912],
      [59.28637943, 2.82956604, 27.34824973],
    ] } satisfies Polynomial,
  },
  {
    id: "spectral", label: "Spectral", title: "Blue far through yellow to red near",
    curve: { kind: "stops", stops: [
      [0x5e, 0x4f, 0xa2], [0x32, 0x88, 0xbd], [0x66, 0xc2, 0xa5], [0xab, 0xdd, 0xa4], [0xe6, 0xf5, 0x98], [0xff, 0xff, 0xbf],
      [0xfe, 0xe0, 0x8b], [0xfd, 0xae, 0x61], [0xf4, 0x6d, 0x43], [0xd5, 0x3e, 0x4f], [0x9e, 0x01, 0x42],
    ].map(([r, g, b]) => [r! / 255, g! / 255, b! / 255] as const) } satisfies Stops,
  },
  {
    id: "viridis", label: "Viridis", title: "Perceptually even, purple far to yellow near",
    curve: { kind: "polynomial", coefficients: [
      [0.2777273272234177, 0.005407344544966578, 0.3340998053353061],
      [0.1050930431085774, 1.404613529898575, 1.384590162594685],
      [-0.3308618287255563, 0.214847559468213, 0.09509516302823659],
      [-4.634230498983486, -5.799100973351585, -19.33244095627987],
      [6.228269936347081, 14.17993336680509, 56.69055260068105],
      [4.776384997670288, -13.74514537774601, -65.35303263337234],
      [-5.435455855934631, 4.645852612178535, 26.3124352495832],
    ] } satisfies Polynomial,
  },
  {
    id: "inferno", label: "Inferno", title: "Perceptually even, black far to yellow near",
    curve: { kind: "polynomial", coefficients: [
      [0.0002189403691192265, 0.001651004631001012, -0.01948089843709184],
      [0.1065134194856116, 0.5639564367884091, 3.932712388889277],
      [11.60249308247187, -3.972853965665698, -15.9423941062914],
      [-41.70399613139459, 17.43639888205313, 44.35414519872813],
      [77.162935699427, -33.40235894210092, -81.80730925738993],
      [-71.31942824499214, 32.62606426397723, 73.20951985803202],
      [25.13112622477341, -12.24266895238567, -23.07032500287172],
    ] } satisfies Polynomial,
  },
] as const;

export type ColormapId = (typeof COLORMAPS)[number]["id"];
export const COLORMAP_IDS: readonly ColormapId[] = COLORMAPS.map((map) => map.id);

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * A map's colour at `t` in [0, 1], display-referred sRGB in [0, 1]. Values outside are
 * clamped first, as the shader does. Evaluated in f64 on the CPU; the GPU evaluates the same
 * polynomial in f32, which differs far below an 8-bit step.
 */
export function colormapRgb(id: ColormapId, t: number): readonly [number, number, number] {
  const map = COLORMAPS.find((entry) => entry.id === id);
  if (map === undefined) throw new Error(`Unknown colour map: ${id}`);
  const x = clamp01(Number.isFinite(t) ? t : 0);
  const curve = map.curve as Polynomial | Stops;
  if (curve.kind === "polynomial") {
    const out = [0, 0, 0];
    for (let channel = 0; channel < 3; channel += 1) {
      // Horner, highest power first — the shader's order.
      let value = 0;
      for (let power = curve.coefficients.length - 1; power >= 0; power -= 1) value = value * x + curve.coefficients[power]![channel]!;
      out[channel] = clamp01(value);
    }
    return [out[0]!, out[1]!, out[2]!];
  }
  const position = x * (curve.stops.length - 1);
  const segment = Math.min(curve.stops.length - 2, Math.floor(position));
  const weight = position - segment;
  const low = curve.stops[segment]!;
  const high = curve.stops[segment + 1]!;
  return [low[0] + (high[0] - low[0]) * weight, low[1] + (high[1] - low[1]) * weight, low[2] + (high[2] - low[2]) * weight];
}

/** The 1-based index a shader selects a map by; 0 is "no map". */
export function colormapIndex(id: ColormapId | "none"): number {
  return id === "none" ? 0 : COLORMAP_IDS.indexOf(id) + 1;
}

const f = (value: number): string => {
  const text = String(value);
  return /[.e]/.test(text) ? text : `${text}.0`;
};
const vec = ([r, g, b]: readonly [number, number, number]): string => `vec3f(${f(r)}, ${f(g)}, ${f(b)})`;

function mapBodyWgsl(curve: Polynomial | Stops): string {
  if (curve.kind === "polynomial") {
    const terms = [...curve.coefficients].reverse();
    let expression = vec(terms[0]!);
    for (const term of terms.slice(1)) expression = `(${expression}) * x + ${vec(term)}`;
    return `return clamp(${expression}, vec3f(0.0), vec3f(1.0));`;
  }
  const last = curve.stops.length - 1;
  return `const stops = array<vec3f, ${curve.stops.length}>(${curve.stops.map(vec).join(", ")});
    let position = x * ${f(last)};
    let segment = min(u32(floor(position)), ${last - 1}u);
    return mix(stops[segment], stops[segment + 1u], position - f32(segment));`;
}

/**
 * `fn colormap(index: u32, t: f32) -> vec3f` — sRGB, `t` clamped; index 0 (or unknown) is
 * grey, `vec3f(t)`, which a caller only reaches by asking for no map. The tables are `const`
 * (a `var<private>` table is copied per invocation on Metal).
 */
export const COLORMAP_WGSL = `${COLORMAPS.map((map, index) => `fn colormap${index + 1}(x: f32) -> vec3f {
    ${mapBodyWgsl(map.curve as Polynomial | Stops)}
}`).join("\n\n")}

fn colormap(index: u32, t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0);
  switch (index) {
${COLORMAPS.map((_, index) => `    case ${index + 1}u: { return colormap${index + 1}(x); }`).join("\n")}
    default: { return vec3f(x); }
  }
}`;
