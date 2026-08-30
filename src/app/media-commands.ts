import { useEffect, useRef } from "react";

import type { ShaderloomBus } from "@domain/commands/bus.ts";

/**
 * The two MEDIA PULSES, registered (T493, §V125, §V123).
 *
 * `cuePulse` and `reload` are pulse parameters, and a pulse names a bus COMMAND rather
 * than a handler — so the node definition stays headless and serializable, the same verb
 * is reachable from the menu, an agent and an EXPRESSION (`onset > 0.8` cues the track),
 * and nothing in the catalogue has to know what a `<video>` is.
 *
 * They are registered UNCONDITIONALLY, next to the transport commands and for the same
 * reason (B48/T392): a command that only exists once some other subsystem came up is a
 * button that silently does nothing on the machines where it did not. Both handlers refuse
 * BY NAME when there is nothing behind them (§V288) — which is also the honest answer for
 * "you pulsed Cue on a node whose file has not loaded", the case §V369 says must not look
 * like success.
 *
 * ## Why reload is not "set the URL again"
 *
 * The file parameter holds a session object URL. Re-opening it is what re-decodes, and
 * that is STRUCTURAL: the element is torn down and rebuilt, which is exactly what the
 * capture and media hooks already do when the URL changes. So reload asks THEM, through
 * this registry, rather than writing a patch that pretends the document changed.
 */

declare module "@domain/types/commands.ts" {
  interface CommandMap {
    "media.cue": {
      input: { nodeIds?: readonly string[] };
      output: { cued: number };
    };
    "media.reload": {
      input: { nodeIds?: readonly string[] };
      output: { reloaded: number };
    };
  }
}

/**
 * What a media hook offers the two commands. Registered per node id, so the movie hook and
 * the audio hook publish into ONE table and neither command has to know which door a node
 * came through.
 */
export interface MediaControl {
  /** Jump to the cue point (free-run only; under the timeline lock there is nothing to move). */
  cue(): void;
  /** Re-open the file from source. */
  reload(): void;
}

export interface MediaControlRegistry {
  register(nodeId: string, control: MediaControl): () => void;
  get(nodeId: string): MediaControl | undefined;
  ids(): readonly string[];
}

export function createMediaControlRegistry(): MediaControlRegistry {
  const controls = new Map<string, MediaControl>();
  return {
    register(nodeId, control) {
      controls.set(nodeId, control);
      return () => {
        if (controls.get(nodeId) === control) controls.delete(nodeId);
      };
    },
    get: (nodeId) => controls.get(nodeId),
    ids: () => [...controls.keys()].sort(),
  };
}

function run(
  registry: MediaControlRegistry,
  nodeIds: readonly string[] | undefined,
  verb: "cue" | "reload",
): { count: number; missing: readonly string[] } {
  const wanted = nodeIds ?? registry.ids();
  const missing: string[] = [];
  let count = 0;
  for (const nodeId of wanted) {
    const control = registry.get(nodeId);
    if (control === undefined) {
      missing.push(nodeId);
      continue;
    }
    control[verb]();
    count += 1;
  }
  return { count, missing };
}

export function useMediaCommands(bus: ShaderloomBus, registry: MediaControlRegistry): void {
  const registryRef = useRef(registry);
  registryRef.current = registry;

  useEffect(() => {
    // `hasCommand`, not a ref: `registerCommand` THROWS on a duplicate, and a ref only
    // knows what THIS component instance did. Two App mounts sharing one bus — which is
    // what an integration test does — would take the second one down on a name that is
    // already there. Asking the bus is the question that actually has the answer.
    if (bus.hasCommand("media.cue")) return;

    bus.registerCommand({
      name: "media.cue",
      description: "Jump a media node's playhead to its cue point.",
      handler: (input) => {
        const { count, missing } = run(registryRef.current, input.nodeIds, "cue");
        if (count === 0) {
          return {
            status: "rejected",
            output: { cued: 0 },
            diagnostics: [
              {
                severity: "error",
                code: "media.notLoaded",
                message:
                  missing.length > 0
                    ? `No loaded media for ${[...missing].sort().join(", ")}.`
                    : "No media node has a file loaded.",
                ...(missing.length === 1 && missing[0] !== undefined ? { nodeId: missing[0] } : {}),
                suggestion:
                  "Choose a file on the node first; a cue on a node that has not loaded has nowhere to go (§V369).",
              },
            ],
          };
        }
        return { status: "applied", output: { cued: count }, diagnostics: [] };
      },
    });

    bus.registerCommand({
      name: "media.reload",
      description: "Re-open a media node's file from source.",
      handler: (input) => {
        const { count, missing } = run(registryRef.current, input.nodeIds, "reload");
        if (count === 0) {
          return {
            status: "rejected",
            output: { reloaded: 0 },
            diagnostics: [
              {
                severity: "error",
                code: "media.notLoaded",
                message:
                  missing.length > 0
                    ? `No loaded media for ${[...missing].sort().join(", ")}.`
                    : "No media node has a file loaded.",
                ...(missing.length === 1 && missing[0] !== undefined ? { nodeId: missing[0] } : {}),
                suggestion: "Choose a file on the node first.",
              },
            ],
          };
        }
        return { status: "applied", output: { reloaded: count }, diagnostics: [] };
      },
    });
  }, [bus]);
}
