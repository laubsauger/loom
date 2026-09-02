/**
 * AN OSC ADDRESS *IS* A CHANNEL NAME (T942 tier 3) — the spelling, once.
 *
 * ## The finding this file is the whole of
 *
 * `ValueEvaluateContext.channels?: (name: string) => number | undefined` was built for
 * `analyze` and takes ARBITRARY STRING NAMES; `channelIn` reads one by exact name with a
 * fallback. An OSC address is an arbitrary string name. So OSC ingress needs no new port
 * type, no compiler change and no new seam — the helper publishes readings under
 * `osc:<address>` and the value graph already knows how to read them. `oscIn` is a
 * projection of that through a list of learned addresses, exactly as `midiIn` is a
 * projection of `midi:<port>:<control>` through a list of learned controls (§T959).
 *
 * Three surfaces must spell a name identically or a learned address reads its rest value
 * forever, silently: the helper that publishes, the node that reads, and the inspector
 * that learns. So the spelling lives here, once, the way `midi-mapping.ts` holds MIDI's.
 *
 * ## THE ADDRESS IS ATTACKER-CONTROLLABLE TEXT (the plan's §7.4, made executable)
 *
 * Anything on this machine that can address a UDP port can choose these strings, so the
 * three named hazards are answered here rather than assumed away:
 *
 *  - **`:` is the value graph's own `name:channel` separator.** An address containing one
 *    would read as three levels where there are two, so an address containing `:` is
 *    REFUSED at the decoder — never published, never learnable. Same discipline as
 *    `decodeMidiMessage` dropping an unsupported message: nothing at all, rather than
 *    something odd.
 *  - **An unbounded stream of novel addresses is an unbounded map.** `OSC_CHANNEL_CAP`
 *    bounds the published set, and the cap being HIT is reported rather than swallowed
 *    (§V469) — an iPhone spraying accelerometer data is the ordinary case, not an attack.
 *  - **A name is looked up in a Map, never interpreted.** Nothing here builds a path, a
 *    node reference or a selector out of an address.
 *
 * ## MULTI-ARGUMENT MESSAGES TAKE A SLASH INDEX
 *
 * `/pad/xy 0.2 0.8` publishes `osc:/pad/xy/0` and `osc:/pad/xy/1`, because a positional
 * argument has no name to take. Deliberately a slash and not a colon, for the reason
 * above. Argument 0 is ALSO published under the bare address, so `/synth/cutoff 0.7`
 * answers to `osc:/synth/cutoff` — the common one-argument case reads the way a person
 * writes it, and the indexed form stays available for a sender that adds an argument
 * later without every binding breaking.
 */

/** The namespace the helper publishes under. Checked by the resolver, never assumed. */
export const OSC_CHANNEL_PREFIX = "osc:";

/**
 * The largest number of distinct addresses one subscription will publish.
 *
 * Not a guess about hardware: TouchOSC's accelerometer page alone sends three addresses at
 * the device's sample rate, and a poorly-configured sender can walk an address space. 512
 * is far past any hand-built control surface and small enough that the map is bounded.
 * Hitting it is REPORTED — see the module note.
 */
export const OSC_CHANNEL_CAP = 512;

/**
 * Is this an address we will publish under?
 *
 * OSC 1.0 requires a leading `/`; the rest is this codebase's rule. The refused characters
 * are the ones that mean something ELSE somewhere the name travels — `:` in the value
 * graph's addressing, whitespace and control characters in every surface that renders a
 * name as a token.
 */
export function isPublishableOscAddress(address: string): boolean {
  if (!address.startsWith("/")) return false;
  if (address.length > 255) return false;
  /* Written as ESCAPES rather than as the bytes themselves: a raw control byte in a
     source file makes the whole file read as BINARY to grep and rg, and this repo has
     a gate about exactly that. The runtime value is identical. */
  // eslint-disable-next-line no-control-regex
  return !/[\s:#*,?[\]{}]|[\u0000-\u001f\u007f]/.test(address);
}

/** The published channel name for argument `index` of a message sent to `address`. */
export function oscChannelName(address: string, index: number): string {
  return index === 0
    ? `${OSC_CHANNEL_PREFIX}${address}`
    : `${OSC_CHANNEL_PREFIX}${address}/${String(index)}`;
}

/**
 * Every channel one decoded message publishes.
 *
 * Argument 0 publishes twice — bare and indexed — for the reason in the module note. A
 * non-finite argument (a string, a blob, an OSC `N`) publishes NOTHING: it held its
 * position through the decoder so the arguments after it are numbered correctly, and a
 * value the value graph cannot carry must be absent rather than zero (§V353's rule read
 * the other way round — deterministic silence is not a blind number).
 */
export function oscMessageReadings(
  address: string,
  args: readonly number[],
): readonly (readonly [string, number])[] {
  if (!isPublishableOscAddress(address)) return [];
  const readings: Array<readonly [string, number]> = [];
  args.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    readings.push([oscChannelName(address, index), value]);
    if (index === 0) readings.push([`${OSC_CHANNEL_PREFIX}${address}/0`, value]);
  });
  return readings;
}
