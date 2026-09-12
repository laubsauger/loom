import type { ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { GraphCanvasContext } from "./canvas-context.ts";
import type { GraphCanvasContextValue } from "./canvas-context.ts";

/**
 * The two providers a node or edge component needs to render outside a laid-out
 * `<ReactFlow>`. Split out of `testing.tsx` by T1315b: that module is scaffolding whose
 * other exports are plain functions, and a component sharing a module with them is the
 * mixed module react-refresh/only-export-components is about.
 */

export interface CanvasFixtureProps {
  value: GraphCanvasContextValue;
  children: ReactNode;
}

export function CanvasFixture({ value, children }: CanvasFixtureProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvasContext.Provider value={value}>{children}</GraphCanvasContext.Provider>
    </ReactFlowProvider>
  );
}
