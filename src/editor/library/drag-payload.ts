import type { PortId } from "@domain/types/ids.ts";

/**
 * The drag payload the library puts on the clipboard-ish `DataTransfer`, and the graph
 * canvas reads on drop (T39).
 *
 * Kept in its own module, free of React, so the canvas track can parse a drop without
 * importing the library pane. The payload is data only — a node TYPE and, when the drag
 * started from a port, the port it should be wired to. The canvas decides the position
 * and issues the patch; the library never mutates anything (§V29).
 */

export const NODE_DRAG_MIME = "application/x-shaderloom-node";

export interface NodeDragPayload {
  type: string;
  /** Set when the drag began from a port: the port on the NEW node to connect. */
  connectTo?: { portId: PortId; direction: "input" | "output" };
}

/** Minimal structural view of `DataTransfer`, so this is testable without a DOM. */
export interface DragDataCarrier {
  setData: (format: string, data: string) => void;
  getData: (format: string) => string;
}

export function writeNodeDragPayload(carrier: DragDataCarrier, payload: NodeDragPayload): void {
  carrier.setData(NODE_DRAG_MIME, JSON.stringify(payload));
  // Plain text so dropping into an editor or a chat gives something meaningful.
  carrier.setData("text/plain", payload.type);
}

/** Parses a drop. Returns null for anything that is not one of our payloads. */
export function readNodeDragPayload(carrier: DragDataCarrier): NodeDragPayload | null {
  const raw = carrier.getData(NODE_DRAG_MIME);
  if (raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const type = (parsed as { type?: unknown }).type;
    if (typeof type !== "string" || type === "") return null;
    const connectTo = (parsed as { connectTo?: unknown }).connectTo;
    if (typeof connectTo === "object" && connectTo !== null) {
      const portId = (connectTo as { portId?: unknown }).portId;
      const direction = (connectTo as { direction?: unknown }).direction;
      if (typeof portId === "string" && (direction === "input" || direction === "output")) {
        return { type, connectTo: { portId, direction } };
      }
    }
    return { type };
  } catch {
    // A foreign drag (a file, a URL, another app) is not an error — it is not ours.
    return null;
  }
}
