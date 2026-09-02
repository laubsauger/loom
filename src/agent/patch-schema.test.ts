import { describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { Actor } from "@domain/types/commands.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import { graphPatchOperationSchema as domainSchema } from "@domain/types/schemas.ts";
import { createAgentToolSurface, type AgentToolSurface } from "./surface.ts";
import { graphPatchOperationSchema as agentSchema } from "./schemas.ts";

/**
 * The agent boundary validates the SAME operations as the document, and differs only
 * where it means to (T309, §V39, §V35).
 *
 * §V39 says an adapter is transport plus schema with zero app-logic duplication. A second
 * hand-maintained copy of the operation union was app logic duplicated: six operations
 * from four tasks reached the document and never reached here, so an agent could not
 * resize a node, reorder a variadic input, or touch a group — and no test noticed, because
 * each copy was internally consistent.
 *
 * The shape now has one definition. What is left here is one POLICY, and these tests are
 * the difference between a policy and an accident: the boundary is strictly narrower than
 * the domain, in exactly one stated way.
 */

const SAMPLES: Record<string, unknown> = {
  setNodeSize: { op: "setNodeSize", nodeId: "n1", size: { width: 320, height: 240 } },
  reorderEdges: { op: "reorderEdges", nodeId: "n1", portId: "in", edgeIds: ["e1", "e2"] },
  setViewport: { op: "setViewport", viewport: { x: 0, y: 0, zoom: 1 } },
  removeGroups: { op: "removeGroups", groupIds: ["g1"] },
};

describe("the agent patch schema is the domain schema (T309)", () => {
  it("accepts the operations that used to exist in the document and not at this boundary", () => {
    for (const [name, sample] of Object.entries(SAMPLES)) {
      expect(agentSchema.safeParse(sample).success, name).toBe(true);
    }
  });

  it("carries the document's parameter envelope, so an agent can set a MODE (§V107)", () => {
    // The old copy took a bare `ParameterValue`, so an agent could write a number and
    // could not write the expression that produces one — a mode users are told every
    // parameter has (§V107) and that the patch operation has carried since T202.
    const parsed = agentSchema.safeParse({
      op: "setParameters",
      nodeId: "n1",
      parameters: {
        amount: {
          mode: "expression",
          bindings: { expression: { kind: "expression", source: "sin(time)" } },
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("still refuses a created ref an agent minted itself (§V35)", () => {
    // The one deliberate narrowing. `applyGraphPatch` reads a bare ref as "create this
    // exact id", which is legitimate for a migration restoring known ids and is not
    // legitimate for an agent: chosen ids can collide with, or impersonate, entities it
    // did not create.
    const bare = { op: "addNode", ref: "a", type: "solid", position: { x: 0, y: 0 } };
    expect(agentSchema.safeParse(bare).success).toBe(false);
    // ...and the DOMAIN still allows it, so this is a boundary rule and not a shape the
    // agent copy quietly imposed on everyone.
    expect(domainSchema.safeParse(bare).success).toBe(true);

    const temp = { ...bare, ref: "$a" };
    expect(agentSchema.safeParse(temp).success).toBe(true);
  });

  it("applies that rule to every operation that CREATES something, not just to nodes", () => {
    // `addGroup` mints an id the same way `addNode` does. The old copy did not carry
    // `addGroup` at all, so the rule had never been asked the question.
    const group = {
      op: "addGroup",
      ref: "g1",
      label: "Lighting",
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    };
    expect(agentSchema.safeParse(group).success).toBe(false);
    expect(agentSchema.safeParse({ ...group, ref: "$g" }).success).toBe(true);
  });

  it("REACHES the document, not just the parser (§V193)", async () => {
    // A schema that accepts an operation and a surface that lands it are two different
    // claims, and this project has shipped the first without the second three times
    // (B12, T264, B23). So the newly-admitted operation is driven through the real tool
    // surface and asserted on the DOCUMENT.
    const store = createGraphStore({
      ids: createSequentialIdFactory("n"),
      now: () => "2026-08-30T00:00:00.000Z",
    });
    const { bus } = createDomainBus({ store, registry: createTestRegistry().view() });
    const surface: AgentToolSurface = createAgentToolSurface({
      bus,
      actor: { kind: "agent", id: "claude" } satisfies Actor,
      projectId: "project-1",
      now: () => 1_000,
    });

    const added = await surface.callTool("apply_graph_patch", {
      baseRevision: store.view.getRevision(),
      operations: [{ op: "addNode", ref: "$n", type: "test.solid", position: { x: 0, y: 0 } }],
    });
    expect(added.status).toBe("ok");
    const nodeId = Object.keys(store.view.getGraph().nodes)[0] as string;

    const resized = await surface.callTool("apply_graph_patch", {
      baseRevision: store.view.getRevision(),
      operations: [{ op: "setNodeSize", nodeId, size: { width: 320, height: 240 } }],
    });
    expect(resized.status).toBe("ok");
    expect(store.view.getGraph().nodes[nodeId]?.size).toEqual({ width: 320, height: 240 });
  });

  it("lets `set_parameters` set a MODE, not only a value (T314, §V107, §V215)", async () => {
    // The asymmetry T309 left behind: `apply_graph_patch` shares the document's operation
    // schema and took the mode envelope, while the tool actually NAMED for setting
    // parameters took a bare value. So an agent could write a number, and could not write
    // the expression that produces one, depending on which door it used.
    const store = createGraphStore({
      ids: createSequentialIdFactory("n"),
      now: () => "2026-08-30T00:00:00.000Z",
    });
    const { bus } = createDomainBus({ store, registry: createTestRegistry().view() });
    const surface: AgentToolSurface = createAgentToolSurface({
      bus,
      actor: { kind: "agent", id: "claude" } satisfies Actor,
      projectId: "project-1",
      now: () => 1_000,
    });

    const added = await surface.callTool("add_node", { type: "test.blur" });
    expect(added.status).toBe("ok");
    const nodeId = Object.keys(store.view.getGraph().nodes)[0] as string;

    const set = await surface.callTool("set_parameters", {
      nodeId,
      parameters: {
        radius: {
          mode: "expression",
          bindings: { expression: { kind: "expression", source: "time * 2" } },
        },
      },
    });
    expect(set.status).toBe("ok");
    expect(store.view.getGraph().nodes[nodeId]?.parameters["radius"]).toEqual({
      mode: "expression",
      bindings: { expression: { kind: "expression", source: "time * 2" } },
    });

    // A bare value still works — this widened the envelope, it did not replace it. What a
    // bare value MEANS changed with §B166/§T895: over a slot it is a VALUE EDIT (the number
    // a user types into the field), so it updates the retained STATIC binding and leaves
    // every inactive payload standing (§V108). It used to overwrite the whole envelope,
    // which is how a round trip through Constant destroyed a user's expression. The agent
    // door and the inspector's door must not differ on that — this is the agent's copy of
    // `slot-retention.test`'s promise, and asserting the bare `12` back would re-assert the
    // exact defect §B166 fixed.
    const plain = await surface.callTool("set_parameters", { nodeId, parameters: { radius: 12 } });
    expect(plain.status).toBe("ok");
    expect(store.view.getGraph().nodes[nodeId]?.parameters["radius"]).toEqual({
      mode: "expression",
      bindings: {
        expression: { kind: "expression", source: "time * 2" },
        static: { kind: "static", value: 12 },
      },
    });

    // …and onto a parameter with no envelope at all, a bare value is still just the value.
    const second = await surface.callTool("add_node", { type: "test.blur" });
    expect(second.status).toBe("ok");
    const plainNodeId = Object.keys(store.view.getGraph().nodes).find((id) => id !== nodeId) as string;
    const bare = await surface.callTool("set_parameters", { nodeId: plainNodeId, parameters: { radius: 7 } });
    expect(bare.status).toBe("ok");
    expect(store.view.getGraph().nodes[plainNodeId]?.parameters["radius"]).toBe(7);
  });

  it("cannot move the human's camera without a grant (T315, §V38)", async () => {
    // T309 made `setViewport` reachable for an agent along with the rest of the union,
    // and flagged that as a decision rather than a conclusion. This is the answer: the
    // SHAPE is shared, and the AUTHORITY is not. Every other operation in the union is an
    // ordinary document edit — undoable, audited, actor-stamped, and ungated on purpose,
    // because gating edits trains a user to approve by reflex. This one takes the screen
    // away from the person using the app.
    const store = createGraphStore({
      ids: createSequentialIdFactory("n"),
      now: () => "2026-08-30T00:00:00.000Z",
    });
    const { bus } = createDomainBus({ store, registry: createTestRegistry().view() });
    const claude: Actor = { kind: "agent", id: "claude" };
    const surface: AgentToolSurface = createAgentToolSurface({
      bus,
      actor: claude,
      projectId: "project-1",
      now: () => 1_000,
    });

    const refused = await surface.callTool("apply_graph_patch", {
      baseRevision: store.view.getRevision(),
      operations: [{ op: "setViewport", viewport: { x: 10, y: 20, zoom: 2 } }],
    });
    // `rejected`, not `error`: the denial travels the ordinary patch-rejection channel,
    // so the agent is told WHICH capability it lacks and can act on that, rather than
    // being handed an opaque failure.
    expect(refused.status).toBe("rejected");
    expect(JSON.stringify(refused)).toContain("capability.denied");
    expect(store.view.getGraph().viewport).toBeUndefined();

    // ...and it is a GRANT, not a wall: the same call succeeds once a person has said so.
    // Nothing the agent sends can produce this — the grant store is bus-owned and the
    // tool schemas are `.strict()`, so a fabricated `capabilities` field is rejected
    // rather than ignored (§V38, §V67).
    bus.grants.grant(claude, "viewportControl");
    const allowed = await surface.callTool("apply_graph_patch", {
      baseRevision: store.view.getRevision(),
      operations: [{ op: "setViewport", viewport: { x: 10, y: 20, zoom: 2 } }],
    });
    expect(allowed.status).toBe("ok");
    expect(store.view.getGraph().viewport).toEqual({ x: 10, y: 20, zoom: 2 });
  });

  it("is narrower than the domain and never wider", () => {
    // The property that makes "one shape, one policy" checkable rather than asserted:
    // anything this boundary accepts, the document accepts too. A future refinement that
    // accidentally widened the boundary would fail here.
    const accepted = [
      ...Object.values(SAMPLES),
      { op: "addNode", ref: "$a", type: "solid", position: { x: 1, y: 2 } },
      { op: "moveNodes", positions: { n1: { x: 1, y: 2 } } },
      { op: "setNodeLabel", nodeId: "n1", label: null },
    ];
    for (const sample of accepted) {
      if (!agentSchema.safeParse(sample).success) continue;
      expect(domainSchema.safeParse(sample).success, JSON.stringify(sample)).toBe(true);
    }
  });
});
