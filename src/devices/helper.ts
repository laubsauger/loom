/**
 * HOW A HUMAN STARTS THE LOCAL HELPER, WRITTEN ONCE (T1103, T1110, §V39/§V288).
 *
 * ## Why this constant exists at all
 *
 * Seven refusals across three hooks and the device client tell the user the same thing:
 * nothing is attached, here is the command. They said it seven times in seven spellings, and
 * the command they named was `pnpm mcp:serve` — which is why the owner read "Person Mask needs
 * `pnpm mcp:serve`" as "Person Mask needs an agent protocol". It does not. It needs a local
 * process, because a page cannot spawn an Apple Vision worker, cannot open a UDP socket and
 * cannot open TCP to a laser DAC.
 *
 * ONE process serves both doors: the MCP server an agent talks to over stdio, and the device
 * bridge this tab talks to over loopback. They share a port, a pairing code and a listener
 * (`@/mcp/bridge-host.ts`), and only one of them is an agent thing. T1103 fixed the SENTENCES
 * from here and left the script named for the half that shipped first; **T1110 renamed the
 * script to match** — `pnpm helper`, because the process is one local helper with two doors.
 *
 * `mcp:serve` survives in `package.json` as an alias for one release, so a config or a habit
 * that names it keeps working; nothing in the product says it any more.
 *
 * When the script is renamed again, THIS is the line that changes, and every refusal, every
 * node description, every OSC status hint and the help panel's terminal line all follow —
 * T1110 finished that job, which T1103 had only claimed: `osc-status.ts` and four node
 * definitions still held their own spelling of the old command.
 */

/**
 * The `package.json` script, without `pnpm`.
 *
 * Owned HERE rather than in `@/mcp/client-config.ts` because of the direction the dependency
 * has to run (§V901): the MCP folder may import the devices folder and never the reverse, and
 * the script starts BOTH doors. `client-config.ts` reads it from here.
 */
export const HELPER_SCRIPT = "helper";

/**
 * The flag that opens the DEVICE door alone (T1111).
 *
 * Named here for the same reason the command is: the refusals, the help panel and the host's
 * own banner all say it, and a flag spelled twice is a flag that will be renamed once.
 */
export const HELPER_DEVICES_ONLY_FLAG = "--devices-only";

/** The literal command. One place, because it is expected to be renamed. */
export const DEVICE_HELPER_COMMAND = `pnpm ${HELPER_SCRIPT}`;

/**
 * The command for someone who wants NOTHING to do with agents (T1111).
 *
 * The owner's sentence was "plug in a laser without running an agent server". This is that
 * sentence as a command: no MCP server, no tool surface, no GPU — one listener, one door,
 * and the same pairing code.
 */
export const DEVICE_HELPER_DEVICES_ONLY_COMMAND = `${DEVICE_HELPER_COMMAND} ${HELPER_DEVICES_ONLY_FLAG}`;

/**
 * What the helper is, in the fewest words that stop the wrong inference.
 *
 * Used INSIDE a longer sentence the caller writes, because each refusal has its own subject
 * (a laser that cannot arm, a mask that is empty, an OSC send that went nowhere) and §V288
 * wants the refusal to name ITS OWN cause, not a generic one.
 */
export const DEVICE_HELPER_NAME = "Loom's local device helper";

/**
 * The full "how to start it" clause, for the refusals that have room for it.
 *
 * Names the process, the command and the door in that order — what it is, how to start it,
 * where to pair it — because a refusal that names only the command sends the reader to a
 * terminal and leaves them there (T533's finding, applied to the device half).
 */
export const DEVICE_HELPER_START =
  `start ${DEVICE_HELPER_NAME} with \`${DEVICE_HELPER_COMMAND}\` (or ` +
  `\`${DEVICE_HELPER_DEVICES_ONLY_COMMAND}\` for devices and no agent server) and enter its ` +
  "pairing code in the agent panel's Connections section";
