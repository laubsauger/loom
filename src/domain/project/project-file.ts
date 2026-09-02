import type { GraphComponentDefinition } from "../types/components.ts";
import type { ProjectDocument } from "../types/graph.ts";
import { serializeComponentLibrary } from "../components/schemas.ts";
import { serializeProjectDocument } from "./serialize.ts";

/**
 * The `.loom.json` file itself (T43, §C "save").
 *
 * Locked format: ONE file, plus external `AssetReference`s. No bundle, no sidecar — a
 * project the user can mail to somebody is Phase 2.
 *
 * Component definitions live OUTSIDE `GraphDocument` (they are referenced by instances,
 * never copied into them — §V79), so "one file" means the library rides at the document
 * root under `componentLibrary`. It is written from the live registry on every save and
 * lifted straight back out on load, so it can never be a stale copy of a catalogue that
 * has moved on. An empty library writes no key at all, which keeps a component-free
 * project byte-identical to what earlier builds wrote.
 *
 * Everything here is a string in and a string out. Choosing a file, showing a picker and
 * writing bytes is composition-root work (File System Access, download fallback) —
 * nothing in `src/domain` touches the DOM.
 */

export const PROJECT_FILE_EXTENSION = ".loom.json";
export const PROJECT_FILE_MIME = "application/json";
/** The `types` entry for a File System Access `showSaveFilePicker` call. */
export const PROJECT_FILE_PICKER_TYPE = {
  description: "Loom project",
  accept: { [PROJECT_FILE_MIME]: [PROJECT_FILE_EXTENSION] },
} as const;

/** Root key the component library is written under. See the note above. */
export const COMPONENT_LIBRARY_KEY = "componentLibrary";

export interface BuildProjectFileInput {
  document: ProjectDocument;
  /** The live catalogue, normally `components.all()`. Omit for a project with none. */
  components?: readonly GraphComponentDefinition[];
  /** Stamped into `updatedAt`. Injected so a save is testable and deterministic. */
  now?: () => string;
}

export interface ProjectFile {
  fileName: string;
  contentType: string;
  text: string;
  /** The exact document the text encodes, including the refreshed `updatedAt`. */
  document: ProjectDocument;
}

/**
 * Builds the bytes of a save. Pure: it decides nothing about where they go.
 *
 * `updatedAt` is refreshed here rather than by the caller so that every writer — manual
 * save, autosave, export — stamps it the same way.
 */
export function buildProjectFile(input: BuildProjectFileInput): ProjectFile {
  const now = input.now ?? (() => new Date().toISOString());
  const document: ProjectDocument = { ...input.document, updatedAt: now() };
  const components = input.components ?? [];
  const root =
    components.length === 0
      ? document
      : { ...document, [COMPONENT_LIBRARY_KEY]: serializeComponentLibrary(components) };

  return {
    fileName: projectFileName(document.name),
    contentType: PROJECT_FILE_MIME,
    text: serializeProjectDocument(root as ProjectDocument),
    document,
  };
}

/** A filesystem-safe suggestion for a save picker. Never empty. */
export function projectFileName(projectName: string): string {
  const base = projectName
    .trim()
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 64);
  return `${base === "" ? "untitled" : base}${PROJECT_FILE_EXTENSION}`;
}

/**
 * THE NEXT NAME TO OFFER, GIVEN THE ONES WE KNOW WE HAVE WRITTEN (T697).
 *
 * The owner asked for two things: a save should suggest the file the project came FROM,
 * and it should not silently offer to overwrite. The first is the caller's job — it holds
 * the opened name. This is the second.
 *
 * ## The honest limit, which is the whole design
 *
 * **A browser cannot enumerate a directory.** There is no API that answers "is there
 * already a `bloom.loom.json` next to the one I am about to write", and there is no way to
 * get one without asking the user to grant a directory handle they never asked to grant.
 * So `taken` is not "files on disk". It is **the names this session has actually written**
 * — a fact we own outright — and the suffix means exactly that and nothing more.
 *
 * That distinction is the reason this takes a set instead of doing the check itself. A
 * function that went looking for the answer would have to guess, and a confident `-2` on a
 * name that was free is worse than no suffix at all: the user ends up with `bloom-2` and
 * `bloom-3` and no `bloom`, and cannot tell which is current. Neither path is left
 * unprotected by the gap, because both have a real collision handler underneath — the OS
 * dialog on the picker path, and the browser's own `bloom (1).loom.json` on the download
 * path. This is a courtesy on top of those, not a substitute for them.
 *
 * ## Suffixing
 *
 * The number goes before the extension, and an existing `-2` is replaced rather than
 * appended to, so saving four times gives `-2`, `-3`, `-4` rather than `-2-2-2`. The scan
 * is bounded by the set's own size: there cannot be more collisions than there are names.
 */
export function nextProjectFileName(fileName: string, taken: ReadonlySet<string>): string {
  if (!taken.has(fileName)) return fileName;
  const extension = fileName.endsWith(PROJECT_FILE_EXTENSION) ? PROJECT_FILE_EXTENSION : "";
  const stem = fileName.slice(0, fileName.length - extension.length).replace(/-\d+$/, "");
  for (let counter = 2; counter <= taken.size + 2; counter += 1) {
    const candidate = `${stem}-${String(counter)}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${String(taken.size + 2)}${extension}`;
}

export interface DetachedLibrary {
  /** The document without the library key, so it round-trips through the store cleanly. */
  document: ProjectDocument;
  /** Raw value found at the library key, or undefined. Validated by the loader. */
  raw: unknown;
}

/** Lifts the component library back off the document root. */
export function detachComponentLibrary(document: ProjectDocument): DetachedLibrary {
  const record = document as unknown as Record<string, unknown>;
  if (!(COMPONENT_LIBRARY_KEY in record)) return { document, raw: undefined };
  const { [COMPONENT_LIBRARY_KEY]: raw, ...rest } = record;
  return { document: rest as unknown as ProjectDocument, raw };
}
