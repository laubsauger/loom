import { readPointsInput, type ReadPointsInput } from "../schemas.ts";
import { failed, ok } from "../tool-support.ts";
import type { AgentTool, PointsWindowData } from "../types.ts";

/**
 * `read_points` (T125, §I.tools, §V48, §V16).
 *
 * Windowed point-attribute readback: an agent debugging a simulation needs NUMBERS, not
 * only pixels — "what is point 4017's velocity on this frame" is unanswerable from a
 * render. The window is bounded (≤256 points per call) and the underlying export path
 * is throttled to ≤10Hz; the whole buffer never leaves the app in one call.
 *
 * Like every readback tool it goes THROUGH the export interface (the injected `points`
 * port — there is no backend import in this directory, §V48) and needs the `export`
 * grant: attribute values leaving the app for the calling model is exactly what that
 * capability class gates, file or no file (§V38).
 *
 * The CPU RNG mirrors (`pointRandReference`, T120) are this tool's oracle: an agent can
 * predict what a seeded kernel SHOULD have produced for a point and compare.
 */
export const readPoints: AgentTool<ReadPointsInput, PointsWindowData> = {
  name: "read_points",
  title: "Read points",
  description:
    "Read a bounded window of one point attribute (≤256 points) from a point-producing node. Returns numbers in slot order; identity is the id attribute's value, not the slot.",
  kind: "read",
  inputSchema: readPointsInput,
  requires: { ports: ["points"] },
  capabilities: ["export"],
  mutates: false,
  async run(input, runtime) {
    const port = runtime.ports.points;
    if (port === undefined) {
      return failed<PointsWindowData>(
        "read_points",
        "points.unavailable",
        "No points readback is attached to this session.",
      );
    }
    try {
      const window = await port.read({
        nodeId: input.nodeId,
        ...(input.attribute === undefined ? {} : { attribute: input.attribute }),
        ...(input.start === undefined ? {} : { start: input.start }),
        ...(input.count === undefined ? {} : { count: input.count }),
      });
      return ok<PointsWindowData>("read_points", window);
    } catch (error) {
      // Throttle refusals, unknown nodes and unknown attributes all arrive here as
      // messages — data for the caller, never a throw out of the surface (§V66).
      return failed<PointsWindowData>(
        "read_points",
        "points.readFailed",
        error instanceof Error ? error.message : String(error),
      );
    }
  },
};

export const pointsTools: readonly AgentTool[] = [readPoints] as readonly AgentTool[];
