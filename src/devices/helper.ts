/**
 * HOW A HUMAN STARTS THE DEVICE HELPER, WRITTEN ONCE (T1103, §V39/§V288).
 *
 * ## Why this constant exists at all
 *
 * Seven refusals across three hooks and the device client tell the user the same thing:
 * nothing is attached, here is the command. They said it seven times in seven spellings, and
 * the command they name is `pnpm mcp:serve` — which is why the owner read "Person Mask needs
 * `pnpm mcp:serve`" as "Person Mask needs an agent protocol". It does not. It needs a local
 * process, because a page cannot spawn an Apple Vision worker, cannot open a UDP socket and
 * cannot open TCP to a laser DAC.
 *
 * ONE process serves both: the MCP server an agent talks to over stdio, and the device bridge
 * this tab talks to over loopback. They share a port, a pairing code and a listener
 * (`@/mcp/bridge-host.ts`), and only one of them is an agent thing. The script is still named
 * for the half that shipped first; T1103 left that name alone deliberately (renaming a
 * documented command is the owner's call) and fixed the SENTENCES instead, from here.
 *
 * When that script is renamed, this is the line that changes, and every refusal follows.
 */

/** The literal command. One place, because it is expected to be renamed. */
export const DEVICE_HELPER_COMMAND = "pnpm mcp:serve";

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
  `start ${DEVICE_HELPER_NAME} with \`${DEVICE_HELPER_COMMAND}\` and enter its pairing code ` +
  "in the agent panel's Connections section";
