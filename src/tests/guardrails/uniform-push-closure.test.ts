import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════
 * §B176 / §V814 — A §V5 SIGNATURE THAT EXCLUDES VALUES OWES A PATH THAT CARRIES THEM
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *
 * §V5 says a uniform-value change must not rebuild a pipeline, and the mechanism is a
 * STRUCTURE KEY that excludes uniform values by construction — `passStructureKey` and
 * `resourceStructureKey` in `runtime/backend/plan.ts`. Anything gated on such a key is
 * therefore blind to values ON PURPOSE, and that is only half a design. The other half is
 * a PUSH: some path that carries the new values to the GPU without the rebuild.
 *
 * ## The defect this closes, twice over
 *
 * §B118: the preview LENS was recomputed every tick and handed to a program object nobody
 *        ever uploaded. Exposure, mask and tonemap had never reached the GPU.
 * §B176: the same file, the same shape, the SYNTHESIZED passes. §V521 gives a synthesized
 *        preview its own passes with their own uniforms, which the main plan does not carry
 *        — so `backend.updateUniforms`, which resolves against the main program, could not
 *        reach them, and the signature gate meant nothing reinstalled them either. A colour
 *        edit updated the render output while the tile went on drawing the previous
 *        compile, until some later structural edit silently repaired it.
 *
 * Both times the two halves were individually correct and nobody owned the join. That is
 * §V814's family: a second consumer of a decision that only ever had one.
 *
 * ## Why this gate is NOT keyed on the recompile classification
 *
 * The obvious guess — "fail when a new consumer of `RecompileWork` appears without handling
 * both outcomes" — would NOT have caught §B176, and it is worth saying why. The preview
 * system never reads the classification at all. `classifyEdit` was right, `isValuesOnly` was
 * right, and `use-graph-compile.ts` acted on both outcomes correctly. The consumer that was
 * missed is a consumer of the PLAN'S UNIFORM VALUES, not of the classification, and it is
 * identified by the thing it does: it gates an install on a key that drops those values.
 * So the key is the SHAPE (§V819), and the census below is over that shape.
 *
 * ## When this test fails
 *
 * A new file computes a §V5 structure key. Say what it gates, and name the path by which
 * values reach the GPU for it — and make sure that path exists, because the ledger's
 * `pushSite` is CHECKED, not merely written down. If the answer is "there is no push", that
 * is §B176 again and the fix is the push, not an entry.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../..");
const REPO = resolve(SRC, "..");

/** The §V5 structure keys: the ONE identity definition (§V62d, T144), excluding values. */
const STRUCTURE_KEYS = ["passStructureKey", "resourceStructureKey"];

/**
 * A declared push, checked in two cheap ways that do not rot on a refactor.
 *
 * Deliberately NOT a literal-expression match. The first draft of this gate asserted the
 * exact push statement and went red on an added type cast — and §V817 is this project's own
 * record of what a guard that fires on a non-defect costs: it teaches the operator that
 * firing means proceed. So `carries` names the push API the module must still be built on,
 * and `provenBy` names the BEHAVIOURAL gate that proves values actually arrive. The strong
 * claim belongs in a test that renders the consequence, not in a substring.
 */
interface PushPath {
  readonly file: string;
  /** API tokens the push module is built on. Stable across formatting and renames of locals. */
  readonly carries: readonly string[];
  /** The test that proves the values arrive. Must exist. */
  readonly provenBy: string;
}

interface Ledger {
  /** What the signature computed here GATES. */
  readonly gates: string;
  /**
   * How values reach the GPU for that thing without a rebuild — checked, not asserted.
   * `null` for a file that does not gate an install of its own.
   */
  readonly pushSite: PushPath | null;
}

const SIGNATURE_SITES: Readonly<Record<string, Ledger>> = {
  "src/runtime/backend/plan.ts": {
    gates:
      "THE DEFINITION. `passStructureKey` and `resourceStructureKey` are where §V5's " +
      "exclusion of uniform VALUES actually lives; every entry below is a caller of these.",
    pushSite: null,
  },

  "src/compiler/compile.ts": {
    gates:
      "the MAIN plan's `resourceSignatures` / `passSignatures`, and through them " +
      "`isUniformOnlyChange` — which is how `classify-revision.ts`'s `uniform-update` is " +
      "VERIFIED against the real plans rather than trusted (T308, §V5).",
    pushSite: {
      file: "src/app/animate-parameters.ts",
      // The push itself, and the assertion that guards it: values-only or nothing.
      carries: ["updateUniforms", "isUniformOnlyChange"],
      provenBy: "src/app/animate-parameters.test.ts",
    },
  },

  "src/runtime/previews/program.ts": {
    gates:
      "the PREVIEW program's signature — the host reinstalls only when it changes (§V8), so " +
      "everything a preview pass carries as a VALUE is invisible to installation by design: " +
      "the lens block (§B118), the SYNTHESIZED passes' own blocks (§B176, §V521) and the " +
      "inspection orbit (§T561).",
    pushSite: {
      file: "src/runtime/previews/system.ts",
      carries: ["PreviewUniformUpdate", "uniforms.push("],
      // §B176's whole content: the lens and the orbit were pushed and the synthesized passes
      // were not, so the door existed and one consumer had no key to it. A substring cannot
      // tell those apart — this gate can, per kind.
      provenBy: "src/runtime/previews/synthesis-uniform-update.test.ts",
    },
  },

  "src/runtime/backend/vgpu/vgpu-backend.ts": {
    gates:
      "not an install of its own: the CONSUMER side, comparing per-entry keys to decide which " +
      "GPU objects survive a `compile` (§V62b, T143). It is also where both pushes above land " +
      "— `updateUniforms` for the main program, `presentPreviews`'s `command.uniforms` for a " +
      "preview host — so a value path that reaches here reaches the device.",
    pushSite: {
      file: "src/runtime/backend/vgpu/vgpu-backend.ts",
      carries: ["updateUniforms", "command.uniforms"],
      provenBy: "src/runtime/backend/vgpu/vgpu-backend.test.ts",
    },
  },
};

function productFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) productFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Every PRODUCT file that computes a §V5 structure key.
 *
 * Tests are excluded deliberately: a test computes a key to assert what it excludes, and it
 * installs nothing on a device, so it owes no push. Product code is the whole population
 * that can ship a picture that never updates.
 */
function signatureSites(): string[] {
  const pattern = new RegExp(`\\b(${STRUCTURE_KEYS.join("|")})\\b`);
  return productFiles(SRC)
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(REPO, path))
    .sort();
}

describe("§B176 — every §V5 signature site declares how VALUES reach the GPU", () => {
  const sites = signatureSites();

  it("names no signature site that is not in the ledger", () => {
    const unlisted = sites.filter((file) => SIGNATURE_SITES[file] === undefined);
    expect(
      unlisted,
      "a file computes a structure key that EXCLUDES uniform values (§V5) and does not say " +
        "how values reach the GPU for the thing it gates. That is §B118 and §B176 both: two " +
        "correct halves and no path between them, which ships as a picture that updates " +
        "everywhere except here. Add it to SIGNATURE_SITES with its push path — or, if there " +
        "is no push, build the push.",
    ).toEqual([]);
  });

  it("keeps no ledger entry for a site that no longer computes one (§V458)", () => {
    const stale = Object.keys(SIGNATURE_SITES).filter((file) => !sites.includes(file));
    expect(
      stale,
      "SIGNATURE_SITES names a file that no longer computes a structure key. A ledger nobody " +
        "prunes becomes a permanent excuse for a defect that no longer exists — strike it.",
    ).toEqual([]);
  });

  it("proves every declared push path, and its proving gate, still exists", () => {
    const broken: string[] = [];
    for (const [file, entry] of Object.entries(SIGNATURE_SITES)) {
      const push = entry.pushSite;
      if (push === null) continue;
      const target = resolve(REPO, push.file);
      if (!existsSync(target)) {
        broken.push(`${file} -> ${push.file} (missing)`);
      } else {
        const source = readFileSync(target, "utf8");
        for (const token of push.carries) {
          if (!source.includes(token)) broken.push(`${file} -> ${push.file} no longer uses \`${token}\``);
        }
      }
      // A push nobody renders the consequence of is §B118 waiting to happen again.
      if (!existsSync(resolve(REPO, push.provenBy))) {
        broken.push(`${file} -> proving gate ${push.provenBy} is gone`);
      }
    }
    expect(
      broken,
      "a declared value-push path is gone. The signature site it belongs to is now gated on a " +
        "key that drops uniform values with nothing carrying them — §B176's exact state.",
    ).toEqual([]);
  });

  /**
   * NON-VACUITY. A walk that found nothing, or a pattern that matched nothing, would make
   * all three gates above pass by being empty — the one failure a closure test cannot have.
   */
  it("is reading the repo it claims to read", () => {
    expect(sites).toContain("src/runtime/previews/program.ts");
    expect(sites).toContain("src/compiler/compile.ts");
    expect(sites.length).toBeGreaterThanOrEqual(Object.keys(SIGNATURE_SITES).length);
  });
});
