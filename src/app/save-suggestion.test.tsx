// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectFile } from "@domain/project/index.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { writeTextFile } from "./project-io.ts";
import type { WritableTextFile } from "./project-io.ts";
import { useProject } from "./use-project.ts";

/**
 * THE NAME A SAVE OFFERS (T697).
 *
 * The owner: "if we open an existing file or load one we should suggest the filename to be
 * saved to be along the lines of that one, if it already exists we should maybe add a
 * running number to it".
 *
 * ## Why both paths are gated, separately
 *
 * `project-io.ts` has two of them on purpose (T43/T139): `showSaveFilePicker` where it
 * exists, and a download blob for Firefox and Safari — a first-class path, not an error
 * case, and the one a majority of users are on. They are different code, they carry the
 * suggestion in different fields (`suggestedName` versus an anchor's `download`), and a
 * test covering only the picker would leave the busier half unproven.
 *
 * ## What is NOT claimed
 *
 * The running number counts names THIS SESSION WROTE, and nothing else. A browser cannot
 * enumerate a directory, so "the file already exists" is not a question the app can
 * answer — see `nextProjectFileName`, where that limit is argued. The last test here pins
 * the honest half of it: a name we merely OPENED is offered back unchanged, because we
 * never wrote it and pretending otherwise would hand the user `bloom-2` beside a `bloom`
 * they are still working on.
 */

afterEach(cleanup);

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

const PROJECT: Omit<WritableTextFile, "fileName"> = {
  text: "{}",
  mime: "application/json",
  pickerTypes: [{ description: "Shaderloom project", accept: { "application/json": [".loom.json"] } }],
};

describe("the suggestion reaches BOTH save paths (T43/T139)", () => {
  it("hands the picker the name as its suggestedName", async () => {
    let offered: string | undefined;
    const outcome = await writeTextFile(
      { ...PROJECT, fileName: "bloom-2.loom.json" },
      {
        globals: {
          showSaveFilePicker: async (options) => {
            offered = options.suggestedName;
            return {
              name: "bloom-2.loom.json",
              createWritable: async () => ({ write: async () => {}, close: async () => {} }),
            };
          },
        },
      },
    );

    expect(offered).toBe("bloom-2.loom.json");
    expect(outcome).toEqual({ kind: "saved", fileName: "bloom-2.loom.json", method: "picker" });
  });

  it("hands the download fallback the same name", async () => {
    // No `showSaveFilePicker` at all: Firefox and Safari, and the reason this path is not
    // an error case. The suggestion has to survive the branch, or half the users get a
    // file named after the project while the other half get the file they opened.
    const downloaded: string[] = [];
    const outcome = await writeTextFile(
      { ...PROJECT, fileName: "bloom-2.loom.json" },
      { globals: {}, download: (file) => downloaded.push(file.fileName) },
    );

    expect(downloaded).toEqual(["bloom-2.loom.json"]);
    expect(outcome).toEqual({ kind: "saved", fileName: "bloom-2.loom.json", method: "download" });
  });
});

/**
 * The round trip the owner described, driven through the hook that sequences it.
 *
 * `useProject` is where the opened name and the written names live, so this is the only
 * level at which "open a file, then save twice" is a statement about the product rather
 * than about a helper. Both save paths are run through the same script: the assertion is
 * on what was OFFERED, which is the thing the user sees in the dialog.
 */
describe("open a file, then save twice", () => {
  function mount(runtime: AppRuntime, offered: string[], usePicker: boolean) {
    return renderHook(() =>
      useProject(runtime, {
        flushAutosave: async () => {},
        onDocumentLoaded: () => {},
        // A real, loadable project: `open` only records the name it came from once the
        // load SUCCEEDS, which is the same rule that keeps a bad file from renaming the
        // session (§V10).
        read: async () => ({
          kind: "opened",
          fileName: "bloom.loom.json",
          text: buildProjectFile({ document: runtime.projectDocument() }).text,
        }),
        write: async (file) => {
          offered.push(file.fileName);
          // The two paths differ only in which field carries the name; both report the
          // name that was actually written, and this stands in for either.
          return {
            kind: "saved",
            fileName: file.fileName,
            method: usePicker ? "picker" : "download",
          };
        },
      }),
    );
  }

  for (const usePicker of [true, false]) {
    it(`suggests the opened file, then counts up (${usePicker ? "picker" : "download"} path)`, async () => {
      const runtime = newRuntime();
      const offered: string[] = [];
      const { result } = mount(runtime, offered, usePicker);

      // `openText` carries the name the picker reported, which is the restore path; the
      // picker route sets the same field from `read()` above.
      await act(async () => {
        await runtime.bus.execute("project.open", {}, runtime.invocation);
      });
      await act(async () => {
        await runtime.bus.execute("project.save", { saveAs: false }, runtime.invocation);
      });
      await act(async () => {
        await runtime.bus.execute("project.save", { saveAs: false }, runtime.invocation);
      });

      // The first save offers the file the project came FROM — not `Untitled.loom.json`
      // off the document's name, which is what it did before T697 and what made a user
      // retype their filename on every save. The second offers a fresh one, because by
      // then this session HAS written the first.
      expect(offered).toEqual(["bloom.loom.json", "bloom-2.loom.json"]);
      expect(result.current.fileName).toBe("bloom-2.loom.json");
    });
  }

  it("does not count up a file it only opened", async () => {
    // The honest boundary. Opening `bloom.loom.json` and saving once must offer
    // `bloom.loom.json` — we have not written it, so there is no collision we know of,
    // and the OS dialog is what asks about the one we do not.
    const runtime = newRuntime();
    const offered: string[] = [];
    mount(runtime, offered, true);

    await act(async () => {
      await runtime.bus.execute("project.open", {}, runtime.invocation);
    });
    await act(async () => {
      await runtime.bus.execute("project.save", { saveAs: false }, runtime.invocation);
    });

    expect(offered).toEqual(["bloom.loom.json"]);
  });
});
