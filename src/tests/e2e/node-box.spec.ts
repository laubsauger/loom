import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { nodeBox, previewAspectOf } from "@domain/graph/node-box.ts";
import { EXAMPLE_DOCUMENTS } from "../../examples/documents.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { APP_VIEWPORT } from "./app.ts";

/**
 * THE SIZE MODEL IS PINNED TO THE REAL DOM (T460, §V389, §V339).
 *
 * `src/domain/graph/node-box.ts` predicts a node's rendered box from its definition and
 * the document, and `src/examples/layout.test.ts` gates every shipped example on it. That
 * gate is worth exactly as much as the model: if the CSS moves and the arithmetic does
 * not, the gate goes green while the examples overlap — which is the bug it exists to
 * catch, one level up. A model nobody measures is a guess with a docstring.
 *
 * jsdom paints nothing (§V339), so this cannot live in the jsdom suite. It lives here,
 * where a real browser lays real nodes out, and it compares the model's numbers against
 * MEASURED ones for the same shipped documents. Change `node-view.module.css` and this
 * goes red naming every node that drifted.
 *
 * `offsetWidth`/`offsetHeight` rather than `boundingBox()`, deliberately: React Flow
 * scales the viewport with a CSS transform, so a bounding box is screen pixels at
 * whatever zoom the fit landed on, while the offset pair is the node's own graph-space
 * box — the space positions are authored in and the space the model predicts.
 *
 * No GPU needed (see `app.ts` on what this environment has): a node's chrome is the same
 * size whether or not its preview ever receives pixels.
 */

test.use({ viewport: { width: APP_VIEWPORT.width, height: APP_VIEWPORT.height } });

/**
 * Chosen for the KINDS they contain rather than for coverage theatre: E25 carries
 * cameras, lights, materials, geometry and pointsets; E24 the whole value family and the
 * caches; E20 surfaces and kernels; E1 the plain texture chain. Between them they reach
 * every branch in `nodeHasPreview` and both port-row counts the model can produce.
 */
const EXAMPLES = ["E1 Feedback", "E20 Gooeyball", "E24 Audio", "E25 Stage"] as const;

const registry = createNodeRegistry(allNodeDefinitions).view();

function modelledBoxes(prefix: string): Record<string, { width: number; height: number }> {
  const document = EXAMPLE_DOCUMENTS.find((candidate) => candidate.name.startsWith(prefix));
  if (document === undefined) throw new Error(`no shipped example named ${prefix}`);
  return Object.fromEntries(
    Object.values(document.graph.nodes).map((node) => {
      const box = nodeBox(node, registry.get(node.type), previewAspectOf(document.settings));
      return [node.id, { width: box.width, height: box.height }];
    }),
  );
}

async function openExample(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name: "examples" }).click();
  await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  // Opening over a dirty document asks first. That prompt is a shipped path, not a bug,
  // so it is answered rather than suppressed.
  const confirm = page.getByRole("button", { name: "Open", exact: true });
  if ((await confirm.count()) > 0) await confirm.click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
}

test("the derived node box is the box the browser renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("graph-canvas")).toBeVisible();

  for (const prefix of EXAMPLES) {
    await openExample(page, prefix);
    const expected = modelledBoxes(prefix);

    await expect
      .poll(async () => Object.keys(await measure(page)).length, {
        message: `${prefix} never rendered its nodes`,
      })
      .toBe(Object.keys(expected).length);

    // Compared as ONE object so a failure lists every node that drifted, not the first.
    expect(await measure(page), `${prefix}: the DOM and node-box.ts disagree`).toEqual(expected);
  }
});

function measure(page: Page): Promise<Record<string, { width: number; height: number }>> {
  return page.$$eval(".react-flow__node", (nodes) =>
    Object.fromEntries(
      nodes.map((node) => [
        node.getAttribute("data-id") ?? "?",
        { width: (node as HTMLElement).offsetWidth, height: (node as HTMLElement).offsetHeight },
      ]),
    ),
  );
}
