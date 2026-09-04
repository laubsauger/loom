/**
 * WHICH document the app boots into, and nothing else (see `use-starter-project.ts` for
 * the when and the why).
 *
 * Its own module, with NO imports, for one reason: the name has to be readable from a
 * headless gate. `use-starter-project.ts` reaches the browser catalogue through
 * `@editor/library`, which pulls React components in, so a node-environment test that
 * wanted to compile the starter could not import the constant from there —
 * `starter-document.test.ts` compiles the file through the real example runner and would
 * have had to name it a second time to do it. A second name is a second thing to change.
 */

/**
 * E6 Displacement Stack.
 *
 * Six nodes — checker, noise, level, transform, displace, output — that MOVE on frame one
 * and put an obvious slider behind every visible effect. Three properties are load-bearing
 * and each is asserted rather than asserted-in-prose:
 *
 *  1. **No permission prompt, no download.** Nothing here reaches a camera, microphone,
 *     audio device or inference model, and the bytes are already in the app chunk.
 *     Gated by `starter-boot.test.tsx`.
 *  2. **It compiles CLEAN.** Not "it loads" — a document with any compiler error puts the
 *     app in the stale-plan state where the viewer keeps moving and shows the last good
 *     program, so a new user's first boot would look like it worked and be a lie.
 *     Gated by `starter-document.test.ts`.
 *  3. **It is one of the shipped examples**, so §V88's "the app reads the bytes the runner
 *     gates on" covers it and it cannot drift into a shape a save would never produce.
 */
export const STARTER_EXAMPLE_FILE = "E6-Displacement-Stack.loom.json";
