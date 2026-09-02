import { buildProjectFile, type ProjectFile } from "../domain/project/index.ts";
import { STARTER_COMPONENT_TIMESTAMP, buildStarterComponents } from "./starter-components.ts";
import { createComponentSystem } from "../domain/components/registry.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import type { ComponentRegistryView } from "../domain/components/index.ts";

/**
 * T956: the starter library as a registry VIEW, for harness renders of examples that
 * INSTANCE a component (the hologram). Authored through the real commands like
 * everything else; cached, because the authoring is deterministic.
 */
let starterView: Promise<ComponentRegistryView> | undefined;
export function starterComponentsView(): Promise<ComponentRegistryView> {
  starterView ??= (async () => {
    const { components } = createComponentSystem(createNodeRegistry(allNodeDefinitions).view());
    for (const built of await buildStarterComponents()) components.register(built.definition);
    return components.view();
  })();
  return starterView;
}

/**
 * The exact bytes each starter component ships as (T190, §V94).
 *
 * Same reasoning as `example-files.ts`, one invariant along: §V88 requires an example to
 * be a real file, and §V94 requires a shipped component to be a real SAVE. `buildProjectFile`
 * is the save path — it is what writes `componentLibrary` at the document root — so
 * routing the starter set through it is what stops a shipped component being a privileged
 * format that no user's save could produce.
 *
 * One file per component, not one library file for all five, because a component is a
 * thing you hand to somebody. Each file is a whole project: the component's definition in
 * `componentLibrary`, and a graph that instantiates it between a source and an Output. The
 * second half is not decoration — it is what `component-sync.test.ts` compiles, so a
 * starter component that cannot render fails the build the way a broken example does
 * (§V89).
 *
 * Pure: writing is `build-examples.ts`, checking is `component-sync.test.ts`.
 */
export async function buildStarterComponentFiles(): Promise<readonly ProjectFile[]> {
  const built = await buildStarterComponents();
  return built.map((component) =>
    buildProjectFile({
      document: component.document,
      components: [component.definition],
      now: () => STARTER_COMPONENT_TIMESTAMP,
    }),
  );
}
