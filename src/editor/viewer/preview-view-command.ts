import { useEffect, useMemo } from "react";
// v16-allow-command-bus: registers `preview.setView`/`preview.resetView`, which make no patch
// and open no undo group — the lens is session state, not document state.
import type { LoomBus } from "@domain/commands/bus.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { PREVIEW_LENSES } from "@runtime/previews/index.ts";
import type { PreviewLens, PreviewLensKind } from "@runtime/previews/index.ts";
import { previewViewStoreFor } from "./preview-view-store.ts";
import type { PreviewViewStore } from "./preview-view-store.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";

/**
 * `preview.setView` / `preview.resetView` — the ONE way a preview's lens changes (T336).
 *
 * The node info popup's buttons do not call the store; they execute these, exactly as the
 * shortcut a keymap binds later and the palette entry an agent picks will. That is §V78's
 * shape — one command behind every route — applied before there are three routes rather than
 * after, which is the only time it is cheap.
 *
 * Like `ui.showNodeInfo`, this lives in the editor rather than `src/domain/commands`, because
 * there is nothing for the bus's apply primitive to write: a lens is not document state, so
 * these produce no patch, open no undo group and leave the revision alone. What they DO return
 * is the resolved lens, so a caller — human, keyboard or agent — can read back what it set.
 *
 * §V70a/§V255: this reaches the PREVIEW path only. Nothing here can touch the present blit,
 * which stays a raw copy, and no amount of widening this command should change that.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Set part of one node's preview lens. Every field is optional and only the named ones
     * change, so "isolate green" and "one stop up" are separate acts on the same lens rather
     * than two commands that each reset the other's half.
     *
     * `nodeId` omitted means the current target — the selected node — which is what a bare
     * keypress or a palette entry means.
     */
    "preview.setView": {
      input: {
        nodeId?: NodeId;
        lens?: PreviewLensKind;
        exposureStops?: number;
        tonemap?: boolean;
      };
      output: { nodeId: NodeId | null; view: PreviewLens | null };
    };
    /** Back to the plain picture: no isolation, no exposure, no tonemap. */
    "preview.resetView": {
      input: { nodeId?: NodeId };
      output: { nodeId: NodeId | null; view: PreviewLens | null };
    };
  }
}

export const SET_PREVIEW_VIEW_COMMAND = "preview.setView";
export const RESET_PREVIEW_VIEW_COMMAND = "preview.resetView";

/**
 * Exposure is clamped, not validated-and-rejected: ±8 stops already covers every real HDR
 * inspection, and a slip that asks for 400 should show a picture rather than an error. A
 * non-finite value is a different thing — §V66 — and never reaches the store.
 */
export const MAX_EXPOSURE_STOPS = 8;

/** Whoever knows what "the current node" means while a surface is mounted. */
export interface PreviewViewTargetHolder {
  current: NodeId | null;
}

export function previewViewTargetFor(bus: LoomBus): PreviewViewTargetHolder {
  return commandHolder<NodeId>(bus, `${SET_PREVIEW_VIEW_COMMAND}#target`);
}

function isLensKind(value: unknown): value is PreviewLensKind {
  return PREVIEW_LENSES.some((kind) => kind === value);
}

function clampStops(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_EXPOSURE_STOPS, Math.min(MAX_EXPOSURE_STOPS, value));
}

/**
 * Registers both commands on the bus. Idempotent — the bus has no unregister and React mounts
 * more than once — and safe to call from any surface that needs them, since the store and the
 * target holder are resolved from the bus rather than captured here.
 */
export function registerPreviewViewCommands(bus: LoomBus): PreviewViewStore {
  const store = previewViewStoreFor(bus);
  if (bus.hasCommand(SET_PREVIEW_VIEW_COMMAND)) return store;
  const target = previewViewTargetFor(bus);

  bus.registerCommand({
    name: SET_PREVIEW_VIEW_COMMAND,
    description: "Set a node preview's lens — isolate a channel, change exposure, tonemap.",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const nodeId = input.nodeId ?? target.current ?? undefined;

      if (nodeId === undefined || context.graph.nodes[nodeId] === undefined) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: nodeId === undefined ? ("info" as const) : ("warning" as const),
              code: nodeId === undefined ? "preview.noTarget" : "preview.unknownNode",
              message:
                nodeId === undefined
                  ? "Nothing is selected, so there is no preview to set a lens on."
                  : `No node "${nodeId}" in the graph.`,
              ...(nodeId === undefined ? {} : { nodeId }),
            },
          ],
          output: { nodeId: null, view: null },
        };
      }

      if (input.lens !== undefined && !isLensKind(input.lens)) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: "warning" as const,
              code: "preview.unknownLens",
              message: `"${String(input.lens)}" is not a preview lens. Expected one of ${PREVIEW_LENSES.join(", ")}.`,
              nodeId,
            },
          ],
          output: { nodeId: null, view: null },
        };
      }

      const patch: Partial<PreviewLens> = {
        ...(input.lens === undefined ? {} : { lens: input.lens }),
        ...(input.exposureStops === undefined
          ? {}
          : { exposureStops: clampStops(input.exposureStops) }),
        ...(input.tonemap === undefined ? {} : { tonemap: input.tonemap }),
      };

      // §V36 — a dry run answers what WOULD happen and changes nothing.
      if (context.dryRun) {
        return {
          status: "applied",
          revision,
          output: { nodeId, view: { ...store.get(nodeId), ...patch } },
        };
      }

      return { status: "applied", revision, output: { nodeId, view: store.set(nodeId, patch) } };
    },
    rejectionOutput: () => ({ nodeId: null, view: null }),
  });

  bus.registerCommand({
    name: RESET_PREVIEW_VIEW_COMMAND,
    description: "Reset a node preview's lens back to the plain picture.",
    handler: (input, context) => {
      const revision = context.store.getRevision();
      const nodeId = input.nodeId ?? target.current ?? undefined;

      if (nodeId === undefined || context.graph.nodes[nodeId] === undefined) {
        return {
          status: "rejected",
          revision,
          diagnostics: [
            {
              severity: nodeId === undefined ? ("info" as const) : ("warning" as const),
              code: nodeId === undefined ? "preview.noTarget" : "preview.unknownNode",
              message:
                nodeId === undefined
                  ? "Nothing is selected, so there is no preview to reset."
                  : `No node "${nodeId}" in the graph.`,
              ...(nodeId === undefined ? {} : { nodeId }),
            },
          ],
          output: { nodeId: null, view: null },
        };
      }

      if (!context.dryRun) store.reset(nodeId);
      return { status: "applied", revision, output: { nodeId, view: store.get(nodeId) } };
    },
    rejectionOutput: () => ({ nodeId: null, view: null }),
  });

  return store;
}

/**
 * What the graph pane calls: the store to read lenses from, with both commands registered and
 * the "current target" kept pointed at the selection while the pane is mounted.
 *
 * The pane is the right owner because it is the surface that actually SHOWS previews — a
 * lens command with no preview anywhere would be a control that does nothing (§V90).
 */
export function usePreviewViews(
  bus: LoomBus,
  selection: readonly NodeId[],
): PreviewViewStore {
  const store = useMemo(() => registerPreviewViewCommands(bus), [bus]);
  const selected = selection.length === 1 ? selection[0] : undefined;

  useEffect(() => {
    // Exactly one selected node is a target; a multi-selection is not, because a lens applies
    // to one picture and silently picking the first would be a guess.
    const holder = previewViewTargetFor(bus);
    holder.current = selected ?? null;
    return () => {
      if (holder.current === (selected ?? null)) holder.current = null;
    };
  }, [bus, selected]);

  return store;
}
