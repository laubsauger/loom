# Shipped-example precision audit

Initial read-only inventory, 2026-09-10, followed by the T1310 implementation below. This supports the example portion of the [performance/native-inference plan](performance-and-native-inference-plan.md); it is not approval to downgrade every texture.

## T1310 implementation results

E5 Kaleidoscope and E7 LFO Dissolve now use sRGB8. E11 Gradient Remap uses sRGB8 for colour while its Noise palette-coordinate field explicitly stays RGBA16F. The all-eight-bit E11 trial failed the image gate: up to 11 display-byte levels of difference because its 2.6x palette mapping magnified field quantization. Keeping that field float reduces the maximum to one byte level.

The real headless backend compares the original float settings against the candidate at deterministic times 0, 1, 2, 3 and 4 seconds, then replays the candidate on a fresh device byte-identically. E5 retains its 2048² processing chain; its current Output is project-sized 1280×720, unlike the older author comment. E7's one-second and three-second frames are verified as pure checker and pure Noise, so its LFO is genuinely running rather than retaining a static crossfade. All three final outputs remain 1280×720.

| Example | Planned texture bytes, float | Planned texture bytes, candidate | Maximum display-byte difference | Mean absolute difference per RGBA byte, across tested frames |
| --- | ---: | ---: | ---: | ---: |
| E5 | 141,590,528 | 70,795,264 | 2 | 0.0701–0.0815 |
| E7 | 29,491,200 | 14,745,600 | 1 | 0–0.1329 |
| E11 | 29,491,200 | 18,432,000 | 1 | 0.0781–0.0852 |
| E6 (T1312) | 44,236,800 | 33,177,600 | 1 | 0.0019–0.0022 |

T1312 applies the same test to the fresh-open E6 starter. Checker, Displace and Output use sRGB8; Noise explicitly remains RGBA16F, inherited by Level and Transform. Every target remains 1280×720. Its generated DisplacementStack component carries the explicit field override so embedding it in an eight-bit project cannot quantize that branch. E5's Kaleidoscope component host follows its source's sRGB8 setting without changing the component definition.

These are allocation savings and measured image differences, not GPU speedup claims. Only the four named example files and the two named starter files were regenerated through the existing generator functions. Broader inventory and deferred routes below remain the original audit, not completed migrations.

## Result

Start the migration trial with E5 Kaleidoscope, E7 LFO Dissolve, and E11 Gradient Remap. They are short, bounded-colour chains without feedback, HDR gain, or custom texture payloads. They remain **candidates**, not visually verified replacements: linear 8-bit storage can visibly quantize dark gradients even when every value is in `[0, 1]`.

E4 Bloom already demonstrates the intended mixed-precision architecture: an `rgba8unorm` project with six explicit `rgba16float` overrides. Preserve that executable contract. Several other examples require float for reasons invisible in a thumbnail: signed distance, small simulation increments, metric depth hidden in alpha, or keypoint coordinates.

Implementation is deferred until the compiler/default-format owner has settled format inheritance and colour-space semantics. In particular, this audit makes no changes to the concurrently edited Gray–Scott shader/E24 surface. Recheck the worktree and claims before adopting any row below.

## Measured inventory

Counts are from shipped JSON, including embedded component definitions where noted; these are serialized node records, **not compiled live nodes or GPU allocations**.

| Scope | Files | Project working formats | Node records, including embedded definitions | Explicit node format overrides | Files containing custom WGSL | Files containing Feedback |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| `examples/*.loom.json` | 58 | 57 × `rgba16float`; 1 × `rgba8unorm` | 1,219 | 13 | 18 | 15 |
| `examples/components/*.loom.json` | 10 | 9 × `rgba16float`; 1 × `rgba8unorm` | 126 | 6 | 2 | 1 |

The shared authoring helper explicitly supplies `rgba16float` in [builders.ts](../src/examples/documents/builders.ts). Changing only the application's new-project default therefore will not update shipped examples. Conversely, changing this helper globally would change almost every example on regeneration, including the sensitive ones below. Prefer per-example settings changes and explicit float islands first.

The 13 overrides in example files are six in E4; `state` in each of E2, E24, E32; `velocity` in E12; and `mix`, `spread`, `trail` in E54. All are fixed `rgba16float`. The six starter overrides are in Bloom.

## Evidence that blocks blanket conversion

- **E2/E24/E32 simulation state:** E2's authoring comments explain that Gray–Scott increments are approximately `1e-3`, below one linear UNORM8 quantum (`1/255`). Pinning the feedback target alone is insufficient proof: advection, custom kernel, packing, and feedback input must all retain the necessary precision. See [reaction-diffusion.ts](../src/examples/documents/reaction-diffusion.ts), [audio-rd.ts](../src/examples/documents/audio-rd.ts), and [pasture.ts](../src/examples/documents/pasture.ts).
- **E12 signed velocity:** the velocity field stores signed displacement, explicitly documented and pinned in [fluid.ts](../src/examples/documents/fluid.ts). UNORM cannot represent negative values. Dye history is a separate precision decision, not permission to downgrade velocity.
- **E26, despite having no custom shader or feedback:** Circle publishes signed distance; Level divides by `0.011`; Limit folds the resulting range with `zigzag`. Clamping before that fold destroys the rings. Preserve the `rings → gain → wrap` computation until range has actually been reduced; the palette/display branch is a separate candidate. See [interference.ts](../src/examples/documents/interference.ts).
- **E57 hidden depth:** [forest.wgsl.ts](../src/examples/shaders/forest.wgsl.ts) writes distance in metres to alpha and its DOF shader consumes that alpha as depth. UNORM clamps depths beyond one metre. Preserve the Forest-to-DOF payload independently of whether the final opaque colour frame can be 8-bit.
- **E44/E47/E48 model data:** depth reconstruction and pose/keypoint consumers use textures as numbers, not merely pictures. Preserve the live inference output, deterministic stand-in, switches, component boundaries, and data consumers as one checked path. A correctly allocated model scratch texture does not prove its subsequent blit or switch preserves precision.
- **E4 HDR:** its threshold is `1.1`, after Level creates highlights above one. The six float overrides are part of the demonstration, not historical clutter. [bloom.ts](../src/examples/documents/bloom.ts) also documents why explicit lower clamping is needed before additive compositing.
- **8-bit linear is not 8-bit sRGB:** SPEC V603 records a byte-encoded frame marker disappearing in a linear 8-bit intermediate. SPEC V497/V694 records negative Level outputs changing compositing behaviour. Do not silently rely on new UNORM clamping as a fix for either contract. Shader arithmetic precision, numeric payload range, and colour storage encoding are separate decisions.

## Complete example routing

Every shipped example appears once. “Review” means retain the current format until the named question has been tested; it does **not** assert that the entire example inherently needs float. Point-buffer arithmetic is not downgraded merely by selecting an 8-bit colour target.

| Examples and exact author sources | Route | Reason / first boundary to test |
| --- | --- | --- |
| E5 [Kaleidoscope](../src/examples/documents/kaleidoscope.ts) | SDR trial | Bounded colour ramp and sampling-only transforms; inspect dark ramps and moving seams at its actual 2048² override. |
| E7 [LFO Dissolve](../src/examples/documents/lfo-dissolve.ts) | SDR trial | Noise/checker crossfade; test the full LFO cycle. |
| E11 [Gradient Remap](../src/examples/documents/gradient-remap.ts) | SDR trial | Noise indexes a bounded palette; protect palette colour/transfer semantics and inspect dark bands. |
| E2 [Reaction Diffusion](../src/examples/documents/reaction-diffusion.ts), E24 [Audio Reaction Diffusion](../src/examples/documents/audio-rd.ts), E32 [Pasture](../src/examples/documents/pasture.ts) | Float islands required | Full simulation loops; review display, feedback-glow and audio-reactive branches independently. |
| E4 [Bloom](../src/examples/documents/bloom.ts) | Existing mixed precision | Keep its six float overrides and existing 8-bit project. |
| E12 [Fluid](../src/examples/documents/fluid.ts) | Float island required | Signed velocity loop; test dye decay separately. |
| E26 [Interference](../src/examples/documents/interference.ts) | Float island required | Signed distance and large pre-fold gain. |
| E44 [Sounding](../src/examples/documents/sounding.ts), E47 [Hologram](../src/examples/documents/hologram.ts), E48 [Marionette](../src/examples/documents/marionette.ts) | Float data paths required | Depth and pose outputs, stand-ins, selectors, and reconstruction paths. |
| E57 [Forest](../src/examples/documents/forest.ts) | Float island required | Metric depth packed into alpha before DOF; evaluate final colour separately. |
| E1 [Feedback Echo](../src/examples/documents/feedback-echo.ts), E9 [Ember](../src/examples/documents/ember.ts), E29 [Descent](../src/examples/documents/descent.ts), E31 [Corona](../src/examples/documents/corona.ts), E35 [Nova Torus](../src/examples/documents/nova-torus.ts), E40 [Wake](../src/examples/documents/wake.ts), E49 [Lissajous](../src/examples/documents/lissajous.ts), E50 [Galvo](../src/examples/documents/galvo.ts), E64 [Relay](../src/examples/documents/relay.ts) | Preserve/review temporal | Repeated feedback quantization may change decay, persistence and accumulation. First pin loop precision, then trial non-loop display textures. Relay also reads image analysis into control. |
| E54 [Quorum](../src/examples/documents/quorum.ts) | Preserve explicit float island | Keep `mix`, `spread`, `trail`; feedback and point/render consumers need temporal proof. |
| E8 [Slit Scan](../src/examples/documents/slit-scan.ts) | Review history/display split | Ordinary colour history may become 8-bit without repeated feedback arithmetic, but its final Add can exceed one. Check history fill/wrap and final highlight appearance separately. |
| E14 [Self-Regulating Bloom](../src/examples/documents/self-regulating-bloom.ts), E55 [Reactor](../src/examples/documents/reactor.ts) | Preserve/review HDR islands | Gain, cutoff, blur, additive glow and, in E14, image analysis/control. Reactor's lower-clamp node allows highs up to eight. |
| E13 [Prism](../src/examples/documents/prism.ts), E30 [Nave](../src/examples/documents/nave.ts), E33 [Obol](../src/examples/documents/obol.ts), E34 [Lidar](../src/examples/documents/lidar.ts), E37 [Sirocco](../src/examples/documents/sirocco.ts), E38 [Sigil](../src/examples/documents/sigil.ts), E39 [Rosette](../src/examples/documents/rosette.ts), E41 [Cinder](../src/examples/documents/cinder.ts) | Preserve/review render/glow | Rendered or generated colour enters gain/blur/add chains; inspect pre-tone-map range. Lidar also has feedback and texture-to-attribute data. |
| E3 [Animated Noise Field](../src/examples/documents/animated-noise-field.ts), E6 [Displacement Stack](../src/examples/documents/displacement-stack.ts) | Review range | Level may emit negatives/highs before displacement; establish intended clipping location before default conversion. |
| E10 [Instanced Torus](../src/examples/documents/instanced-torus.ts), E16 [Murmuration](../src/examples/documents/murmuration.ts), E20 [Gooeyball](../src/examples/documents/gooeyball.ts), E25 [Stage](../src/examples/documents/stage.ts), E28 [Sundial](../src/examples/documents/sundial.ts), E36 [Facade](../src/examples/documents/facade.ts), E42 [Current](../src/examples/documents/current.ts), E63 [Skin](../src/examples/documents/skin.ts) | Review render/data boundaries | Separate colour-target savings from point/attribute computation; verify lighting and material headroom. Gooeyball uses texture-to-attribute; Skin consumes texture-derived points. |
| E27 [Relief](../src/examples/documents/relief.ts) | Review numeric image path | Texture-to-attribute and Analyze consume the processed image; grading precision can alter geometry/control, not just colour. |
| E43 [Splice](../src/examples/documents/splice.ts), E45 [Pulse](../src/examples/documents/pulse.ts), E46 [Lantern](../src/examples/documents/lantern.ts) | Review custom/render range | Inspect custom shader contracts and composite/render output before choosing storage. Custom WGSL alone is not evidence of a float requirement. |
| E51 [Chorus](../src/examples/documents/chorus.ts), E52 [Presence](../src/examples/documents/presence.ts), E53 [Two Cuts](../src/examples/documents/two-cuts.ts) | Review masks/compositing | Segmentation/matte edge quality, live model path, and gain/composites. Binary/class masks need not use float, but soft mattes need an explicit precision policy and edge tests. |
| E56 [Vesper](../src/examples/documents/vesper.ts), E66 [Meter](../src/examples/documents/meter.ts) | Review grade/control-driven range | Video/shape colour is a candidate; check Level and audio-driven brightness across the supported control range. |
| E58 [Alembic](../src/examples/documents/alembic.ts), E59 [Vault](../src/examples/documents/vault.ts), E60 [Snarl](../src/examples/documents/snarl.ts), E61 [Skein](../src/examples/documents/skein.ts), E62 [Rake](../src/examples/documents/rake.ts) | Review, promising final-colour trial | Shared [Alembic shader](../src/examples/shaders/alembic.wgsl.ts) ends with a `tanh` colour shoulder and opaque alpha, not exposed simulation state. Check dark palette precision and exposure variants before retaining float by habit. |

## Starter components

All ten starter sources are authored in [starter-components.ts](../src/examples/starter-components.ts); several reuse example documents. The `.loom.json` files include a host/test project as well as the component definition. A host working format is not a portable guarantee when the definition is embedded in a differently configured project.

| Starter | Proposed treatment |
| --- | --- |
| `Kaleidoscope` | Follow E5 SDR trial; test both the host and an instance in an 8-bit project. |
| `Bloom` | Preserve all six float overrides; it is already a mixed-precision example. |
| `DepthCut`, `DepthPoints` | Preserve incoming depth/data precision across component boundaries. The output mask may separately be an 8-bit candidate. |
| `FeedbackEcho` | Keep feedback precision until long-run decay tests pass. |
| `DisplacementStack` | Follow E6 range review. |
| `MediaGrade` | Preserve grading headroom through Level/Hue operations until its explicit final clamp; its author comments specifically warn against clipping before hue rotation. |
| `TimeGrid` | Audit custom texture payloads and slit-scan mapping/history separately; do not infer ordinary video semantics from the final picture. |
| `AudioLevel`, `AudioAnalysis` | Value-domain analysis is not a colour-texture-format optimization. Trial the host image/grade separately; verify embedded instances. |

## Migration handoff and acceptance

1. Resolve the storage-encoding contract first: `rgba8unorm` linear versus sRGB storage with linear shader math are not visually interchangeable. Neither can carry arbitrary signed/HDR numeric data.
2. Begin with the three SDR candidates, using per-example author settings. Do not change `builders.settings()` or all starter defaults as the first step. Preserve old saved projects' explicit format choices.
3. For each mixed graph, assert **compiled** formats at every node in the float island, including feedback ingress, custom outputs, switches and embedded components. Existing project settings and a source-node override alone are not proof.
4. Compare real browser/headless rendered output at representative frames and resolutions, with colour-aware conversion. Extend through feedback decay, history fill/wrap, audio extrema, live inference, and model-unavailable stand-ins where applicable. Treat visual-baseline changes as deliberate review, not automatic rebaselining.
5. Update format assumptions in tests. For example, [laser-claims.gpu.test.ts](../src/examples/laser-claims.gpu.test.ts) explicitly interprets working-format bytes as half floats. After a format change, use format-aware conversion or explicitly retain the float contract under test; do not reinterpret new bytes using old strides.
6. Regenerate only the approved named example using the command below; run its concept/pixel tests plus the repository validation ladder. Existing entry points include [sync.test.ts](../src/examples/sync.test.ts), [runner.test.ts](../src/examples/runner.test.ts), [temporal.test.ts](../src/examples/temporal.test.ts), the E2/E4/E12/E26 concept tests, [reaction-diffusion-claims.gpu.test.ts](../src/examples/reaction-diffusion-claims.gpu.test.ts), and [forest-claims.gpu.test.ts](../src/examples/forest-claims.gpu.test.ts).
7. Starter regeneration rewrites the complete starter set; coordinate that separately. E47, E51 and E66 also embed starter definitions, so verify their generated output when changing the corresponding component.

```bash
node --import ./src/tooling/alias-hooks.ts src/examples/build-examples.ts --only Kaleidoscope
```

No application test suite or GPU benchmark was run for this documentation-only audit. Inventory counts were computed from the generated files; range/payload findings were checked against their author sources and shaders. None of the proposed downgrades has yet been visually accepted or benchmarked.

## Reproduce the inventory

Run from the repository root. This reads files only. Nested component definitions are counted as authored records, without multiplying them by instance count.

```bash
node --input-type=module <<'JS'
import { readFileSync, readdirSync } from 'node:fs';
for (const dir of ['examples', 'examples/components']) {
  const files = readdirSync(dir).filter(name => name.endsWith('.loom.json'));
  const formats = {}, custom = new Set(), feedback = new Set();
  let nodes = 0, overrides = 0;
  for (const file of files) {
    const document = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
    const format = document.settings.workingFormat;
    formats[format] = (formats[format] || 0) + 1;
    function visit(value) {
      if (!value || typeof value !== 'object') return;
      if (value.nodes) for (const node of Object.values(value.nodes)) {
        if (!node.type) continue;
        nodes++;
        if (node.format) overrides++;
        if (node.type === 'customWgsl') custom.add(file);
        if (node.type === 'feedback') feedback.add(file);
      }
      for (const [key, child] of Object.entries(value)) {
        if (key !== 'nodes') {
          if (Array.isArray(child)) child.forEach(visit);
          else visit(child);
        }
      }
    }
    visit(document);
  }
  console.log({ dir, files: files.length, formats, nodes, overrides,
    customWgslFiles: custom.size, feedbackFiles: feedback.size });
}
JS
```
