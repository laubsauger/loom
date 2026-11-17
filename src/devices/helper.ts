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

/**
 * The flag that opens the TERMINAL door (T1263).
 *
 * OPT-IN, and the flag is the opt-in: whoever pairs with the helper's socket then holds a
 * shell as the user, so the door is not built unless the person who started the process
 * said so on its own command line. Named here for the same reason the other flag is —
 * the refusal, the pane's hint and the startup line all say it. Combines with
 * `HELPER_DEVICES_ONLY_FLAG` (devices and a shell, no agent server); `--devices-only`
 * alone stays shell-free.
 */
export const HELPER_TERMINAL_FLAG = "--terminal";

/**
 * The flag that opens EVERY door in one word (T1343b).
 *
 * The owner's ask was *"a way where we can just start an ALL-INCLUSIVE helper … so that we
 * don't have to remember all the different flags"*, and the answer is one command — but NOT
 * a new default, because of what the flags being folded in ARE. `--terminal` spawns shells;
 * the export grant lets an attached agent read rendered pixels and readback buffers. Those
 * are security grants wearing convenience's clothes. Turning them on for a BARE invocation
 * would silently widen what "start the helper" means for everyone who already runs it,
 * including anyone with it in a script — so `--all` is one thing to remember and still an
 * affirmative act, and `DEVICE_HELPER_COMMAND` alone keeps meaning exactly what it meant.
 *
 * Named here for the same reason the other two flags are, and `helper.test.ts` enforces it.
 */
export const HELPER_ALL_FLAG = "--all";

/**
 * The flag that ARMS the PHONE door (T1396b).
 *
 * The first door on the LAN rather than loopback, so it gets the terminal's treatment and
 * one step more: the flag only BUILDS the door; nothing listens until the paired editor
 * asks, and it closes when that editor goes. It is deliberately NOT folded into
 * `HELPER_ALL_FLAG`: `--all` means "every door on this machine", and this one reaches past
 * the machine — the owner approved it as opt-in per session, which a one-word convenience
 * that already exists in people's scripts would quietly undo.
 */
export const HELPER_PHONE_FLAG = "--phone";

/** The literal command. One place, because it is expected to be renamed. */
export const DEVICE_HELPER_COMMAND = `pnpm ${HELPER_SCRIPT}`;

/** The command that also opens the terminal door (T1263). */
export const DEVICE_HELPER_TERMINAL_COMMAND = `${DEVICE_HELPER_COMMAND} ${HELPER_TERMINAL_FLAG}`;

/** The one-command form: device bridge, agent server, terminal and export grant (T1343b). */
export const DEVICE_HELPER_ALL_COMMAND = `${DEVICE_HELPER_COMMAND} ${HELPER_ALL_FLAG}`;

/** The command that arms the phone door (T1396b). Not implied by `--all`. */
export const DEVICE_HELPER_PHONE_COMMAND = `${DEVICE_HELPER_COMMAND} ${HELPER_PHONE_FLAG}`;

/**
 * The flag that TAKES THE BRIDGE from another Loom helper (T1773b).
 *
 * The bridge port is one constant and the first helper to bind it holds it, so a helper an
 * agent session started hours ago leaves the one a person starts at a terminal without a
 * listener of its own. This flag stops that process and binds. It opens no door and grants
 * nothing; it is on the command line because ending another session's process is an act a
 * person chooses, never a default.
 */
export const HELPER_FORCE_FLAG = "--force";

/** The command that takes the bridge over (T1773b). */
export const DEVICE_HELPER_FORCE_COMMAND = `${DEVICE_HELPER_COMMAND} ${HELPER_FORCE_FLAG}`;

/** Who holds the bridge port, as far as the operating system would say (T1773b). */
export interface BridgeHolderDescription {
  readonly pid: number;
  /** The holder's command line, or "" when it could not be read. */
  readonly command: string;
  /** Whether that process was verified to be a Loom helper. */
  readonly loom: boolean;
}

function holderName(holder: BridgeHolderDescription): string {
  const command = holder.command === "" ? "command line unreadable" : holder.command;
  return `PID ${holder.pid} (${holder.loom ? "a Loom helper" : "NOT a Loom helper"}: ${command})`;
}

/**
 * T1773b — what a helper that lost the bind adds to that news: who holds the port and the
 * one command that takes it. `null` holder means the platform could not name it.
 */
export function bridgeHeldRemedy(port: number, holder: BridgeHolderDescription | null): string {
  if (holder === null) {
    return `Port ${port} is held by a process this platform could not identify. Stop it by hand to get a pairing code from this helper.`;
  }
  if (!holder.loom) {
    return `Port ${port} is held by ${holderName(holder)}. \`${HELPER_FORCE_FLAG}\` will not stop a process that is not Loom's; stop it by hand to get a pairing code from this helper.`;
  }
  return (
    `Port ${port} is held by ${holderName(holder)}. The doors this command line asked for are NOT open while it holds the bridge. ` +
    `Add \`${HELPER_FORCE_FLAG}\` (\`${DEVICE_HELPER_FORCE_COMMAND}\`, with your other flags) to stop that process and get a pairing code from this one.`
  );
}

/** T1773b — the one line that says another session lost its bridge, and how. */
export function bridgeTakenOver(port: number, holder: BridgeHolderDescription, signal: "SIGTERM" | "SIGKILL"): string {
  return `\`${HELPER_FORCE_FLAG}\`: stopped ${holderName(holder)} with ${signal}; it held port ${port}, and whatever session started it has lost its bridge. This helper takes the port now.`;
}

/** T1773b — why `--force` stopped nothing and this helper did not start. */
export function bridgeForceRefused(
  port: number,
  holder: BridgeHolderDescription | null,
  why: "notLoom" | "unidentified" | "survived",
): string {
  if (holder === null || why === "unidentified") {
    return `\`${HELPER_FORCE_FLAG}\` could not identify the process that holds port ${port} on this platform, so nothing was stopped and nothing was started. Stop it by hand.`;
  }
  if (why === "survived") {
    return `\`${HELPER_FORCE_FLAG}\` sent SIGTERM and then SIGKILL to ${holderName(holder)} and it is still running, so port ${port} is still held. Nothing was started.`;
  }
  return `\`${HELPER_FORCE_FLAG}\` refused: port ${port} is held by ${holderName(holder)}, and only a Loom helper is ever stopped. Nothing was stopped and nothing was started.`;
}

/**
 * T1778b — THE PAIRING CODE AS A BLOCK A PERSON CANNOT MISS.
 *
 * The code used to arrive inside a sentence inside a paragraph of startup text, and it is
 * the one thing the reader came for. The entry points print this block after everything
 * else, and again whenever the code that works changes. Letters are spaced for reading;
 * the Connections field ignores spaces, so the line can be pasted as it is.
 *
 * `holderPid` set means the code belongs to ANOTHER helper, the one that holds the port
 * (T921's proxy case). `emphasis` is for a terminal only: the caller passes false for a
 * pipe or under `NO_COLOR`, and the block then carries no escape sequence.
 */
export function pairingCodeBlock(options: {
  /** Named in full, not `code`: T1641b's census reads an object's `code` as a diagnostic code. */
  readonly pairingCode: string;
  readonly port: number;
  readonly holderPid?: number | null;
  readonly emphasis: boolean;
}): string {
  const rule = "  ========================================";
  const whose =
    options.holderPid === undefined
      ? `this helper, port ${options.port}`
      : `the helper that holds port ${options.port}${options.holderPid === null ? "" : `, PID ${options.holderPid}`}`;
  const spaced = options.pairingCode.split("").join(" ");
  const code = options.emphasis ? `\u001b[1;7m  ${spaced}  \u001b[0m` : spaced;
  return [
    "",
    rule,
    `  LOOM PAIRING CODE (${whose})`,
    "",
    `      ${code}`,
    "",
    "  Enter it in Loom: agent panel, Connections.",
    rule,
    "",
    "",
  ].join("\n");
}

/**
 * T1396b — WHAT `--phone` DID AT STARTUP, WHICH IS NOT MUCH, SAID SO.
 *
 * The flag arms a door that opens later, from the editor, so the line a person reads when
 * the helper starts must not read as "your controls are now on the wifi". It names what
 * will be reachable once opened, by whom, and when it shuts again.
 */
export const HELPER_PHONE_BANNER =
  "Phone door ARMED, not open: nothing listens on the network until the paired Loom tab " +
  "opens it. Then phones on this wifi that scan its QR code may move the controls that tab " +
  "published, and nothing else; it closes when the tab closes it or goes away.";

/**
 * T1396b — the answer a page gets when it asks to open a door this helper does not have.
 * Here and not in the bridge because it names the command (T1110).
 */
export const PHONE_DOOR_UNAVAILABLE =
  "this Loom helper was started without the phone door, so no phone can reach this session. " +
  `Restart it as \`${DEVICE_HELPER_PHONE_COMMAND}\` to open one from the editor.`;

/**
 * The command for someone who wants NOTHING to do with agents (T1111).
 *
 * The owner's sentence was "plug in a laser without running an agent server". This is that
 * sentence as a command: no MCP server, no tool surface, no GPU — one listener, one door,
 * and the same pairing code.
 */
export const DEVICE_HELPER_DEVICES_ONLY_COMMAND = `${DEVICE_HELPER_COMMAND} ${HELPER_DEVICES_ONLY_FLAG}`;

/**
 * WHAT `--all` OPENED, SAID OUT LOUD AT STARTUP (T1343b, §V985/§V986's family).
 *
 * The one-command form is precisely the one whose user did NOT enumerate the doors, so this
 * line is where they learn what is now reachable: a grant the user cannot see is a grant
 * they cannot revoke. It names the two grants in terms of the capability rather than the
 * flag, because the reader who typed `--all` never typed `--terminal` and will not recognise
 * it — "shells as you" and "reads pixels and readback buffers" are what they can act on.
 *
 * The last clause is the revocation: dropping the flag is how you close the last two doors,
 * and the sentence has to say so or the banner is a notice with no exit.
 *
 * Printed by `serveStdio`'s entry point on stderr, beside `terminalDoorBanner` — which still
 * prints its own shell/cwd/user line, because only the door itself knows those.
 */
export const HELPER_ALL_BANNER =
  `Started with \`${HELPER_ALL_FLAG}\`: device bridge (OSC, laser, Apple Vision), agent ` +
  "server on stdio, TERMINAL (a paired Loom tab may open shells as you), and the EXPORT " +
  "GRANT (an attached agent may read rendered pixels and readback buffers). " +
  `\`${DEVICE_HELPER_COMMAND}\` on its own opens the first two and neither of the last two. ` +
  `The PHONE door is not among them — it reaches past this machine; add \`${HELPER_PHONE_FLAG}\` for it.`;

/**
 * WHY `--all --devices-only` IS REFUSED BY NAME (T1343b).
 *
 * One flag is ADDITIVE and the other is SUBTRACTIVE, so there is no reading of the pair that
 * is not a guess about which the person meant. Precedence would pick one silently and start
 * a helper with a door set nobody asked for — and at least one of those doors is a shell.
 * So the contradiction is named and nothing starts, the shape `PREVIEW_ORBIT_RIGS` and
 * T1311b(a)'s camera contract both use: refuse, say which two, say what to type instead.
 */
export const HELPER_ALL_DEVICES_ONLY_REFUSAL =
  `\`${HELPER_ALL_FLAG}\` and \`${HELPER_DEVICES_ONLY_FLAG}\` contradict each other: one opens ` +
  "every door, the other closes all but the device bridge. Nothing was started. Run " +
  `\`${DEVICE_HELPER_ALL_COMMAND}\` for everything, or ` +
  `\`${DEVICE_HELPER_DEVICES_ONLY_COMMAND}\` for devices with no agent server and no shell.`;

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

/**
 * What the terminal pane says when there is no shell to show (T1263).
 *
 * The one sentence, here rather than in the pane, for the reason `helper.test.ts`
 * enforces: it names the command. Two cases share it because they need the same action —
 * no helper paired at all, and a helper paired that was started without the flag — and
 * the pane prefixes which of the two it is.
 */
export const TERMINAL_PANE_HINT = "Shells come from the local helper.";

/**
 * T1284b — the pane shows the command as a COMMAND, not inside a sentence.
 *
 * The one-paragraph version read as prose and buried the only thing a reader has to type.
 * These three exports are the same information as three parts the pane can lay out: what
 * to run, what to do next, and where the long version lives. The command still comes from
 * here, which is what `helper.test.ts` enforces (T1110).
 */
export const TERMINAL_PANE_RUN = DEVICE_HELPER_TERMINAL_COMMAND;
export const TERMINAL_PANE_THEN = "Pair it in Agent \u2192 Connections.";

/**
 * B213 — WHAT A PANE IS TOLD WHEN NOTHING IS PAIRED WITH THIS TAB.
 *
 * The refusal used to be built at the call site as `"No local helper is paired with this
 * tab: " + TERMINAL_PANE_HINT + "."`, from the day `TERMINAL_PANE_HINT` was a long
 * instructional sentence. T1284b cut that constant down to the fragment above and gave
 * the pane's IDLE state the command separately — and left this refusal reading "…with
 * this tab: Shells come from the local helper.." Double period, and no command in sight,
 * for the one reader who is furthest from a working shell.
 *
 * So the refusal is composed HERE, from the same three parts the idle state lays out,
 * and the client interpolates it whole. Same rule as every other sentence in this file:
 * the command is spelled once, and a rename moves every place that says it.
 */
export const TERMINAL_UNPAIRED_REFUSAL =
  `No local helper is paired with this tab. Run \`${TERMINAL_PANE_RUN}\`. ${TERMINAL_PANE_THEN}`;

/**
 * Where the long version lives — the README's helper section (T1284b).
 *
 * T1344b pointed it at the section it always named. Until then the README had no helper
 * section and this anchored on `#osc`, the nearest thing — so a terminal pane's "read more"
 * sent the reader to a page about UDP. The README now opens with the helper, its flags and
 * the terminal door, which is what a pane with no shell needs the reader to find.
 */
export const HELPER_DOCS_URL = "https://github.com/laubsauger/loom#the-local-helper";

/**
 * B232 — WHY A MODEL DOWNLOAD FAILED WHEN NO HELPER IS PAIRED, AND WHAT TO DO ABOUT IT.
 *
 * Some model hosts send no `Access-Control-Allow-Origin` (RVM's GitHub release asset), so
 * the page cannot fetch them at all and the helper fetches them instead (Node has no
 * CORS). This is the failure reason the download row shows as its `detail`, so it is ONE
 * sentence inside §V852's 80-character detail budget — and it names the command, which is
 * why it lives here (T1110).
 */
export const MODEL_NEEDS_HELPER = `Needs the local helper: run \`${DEVICE_HELPER_COMMAND}\` and pair it in Connections.`;
