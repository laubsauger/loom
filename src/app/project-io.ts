import {
  PROJECT_FILE_MIME,
  PROJECT_FILE_PICKER_TYPE,
  type ProjectFile,
} from "@domain/project/index.ts";

/**
 * Browser file I/O for `.loom.json` (T43, T139).
 *
 * `src/domain/project` is a string in, string out: it decides what the bytes ARE and
 * nothing about where they go, because nothing in `src/domain` may touch the DOM. This
 * module is the other half — the composition root's, since choosing a file is a
 * capability the user grants by gesture and only the app has a window to ask in.
 *
 * Two paths on purpose. File System Access (`showSaveFilePicker`) is the good one: it
 * remembers the handle, so the second save overwrites the file the user picked instead
 * of dropping `project (3).loom.json` into Downloads. Firefox and Safari do not have it,
 * and a creative tool that cannot save on half the browsers is not a tool, so the
 * download-blob fallback is a first-class path rather than an error message.
 *
 * Every failure here is REPORTED, never thrown: a save that quietly does nothing is the
 * exact failure §Rule 8 is about. The one outcome that is not a failure is the user
 * pressing Cancel in the picker — `cancelled` says so, and no diagnostic is raised.
 */

/** Minimal File System Access surface. `lib.dom` does not declare it (TS 5.7). */
interface FileSystemWritable {
  /** Bytes as well as text: T433 writes an encoded mp4 through this same ladder. */
  write(data: string | Blob | BufferSource): Promise<void>;
  close(): Promise<void>;
}
interface SaveFileHandle {
  readonly name?: string;
  createWritable(): Promise<FileSystemWritable>;
}
interface OpenFileHandle {
  getFile(): Promise<File>;
}
interface FilePickerTypeSpec {
  readonly description: string;
  readonly accept: Readonly<Record<string, readonly string[]>>;
}
interface FilePickerGlobals {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: readonly FilePickerTypeSpec[];
  }) => Promise<SaveFileHandle>;
  showOpenFilePicker?: (options: {
    multiple?: boolean;
    types?: readonly FilePickerTypeSpec[];
  }) => Promise<readonly OpenFileHandle[]>;
}

function pickers(): FilePickerGlobals {
  return globalThis as unknown as FilePickerGlobals;
}

/** The picker's `types` entry, widened from the domain constant's literal shape. */
const PICKER_TYPES: readonly FilePickerTypeSpec[] = [
  {
    description: PROJECT_FILE_PICKER_TYPE.description,
    accept: PROJECT_FILE_PICKER_TYPE.accept as Readonly<Record<string, readonly string[]>>,
  },
];

/** The user pressing Cancel is not an error, so it gets its own outcome. */
export type SaveOutcome =
  | { readonly kind: "saved"; readonly fileName: string; readonly method: "picker" | "download" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly reason: string };

export type OpenOutcome =
  | { readonly kind: "opened"; readonly fileName: string; readonly text: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly reason: string };

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface WriteProjectOptions {
  /** Test seam. Defaults to the real pickers / a real anchor click. */
  readonly globals?: FilePickerGlobals;
  readonly download?: (file: WritableTextFile) => void;
}

/**
 * What actually goes to disk.
 *
 * A `Uint8Array` over any backing buffer becomes one over a plain `ArrayBuffer`, which is
 * what both a `Blob` part and a writable stream require. Copying rather than asserting:
 * the assertion would be a claim about every future caller's allocator, and this runs once
 * per saved file.
 */
function payloadOf(file: WritableTextFile): string | Uint8Array<ArrayBuffer> {
  return typeof file.text === "string" ? file.text : new Uint8Array(file.text);
}

/** Downloads the bytes. The last resort, and the only path Firefox and Safari have. */
function downloadTextFile(file: WritableTextFile): void {
  const blob = new Blob([payloadOf(file)], { type: file.mime });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.fileName;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoked on the next turn: revoking synchronously races the navigation the click
    // just started, and the download silently produces an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * A named blob destined for the user's disk. `ProjectFile` is one; T452's audio feature
 * track is another; T433's rendered range is the third, and it is the one that stopped
 * these all being text.
 *
 * `text` therefore takes BYTES as well as a string, and widening it is deliberate where a
 * second `writeBinaryFile` beside it would have been easier: the picker-then-download
 * ladder, the cancel-is-not-a-failure rule and the never-throw rule are exactly what T452
 * moved here to be written once, and duplicating the ladder for a second payload type is
 * how three artifacts end up with three different behaviours on the browsers that lack a
 * picker. Both `Blob` and `FileSystemWritableFileStream.write` already accept either, so
 * nothing below had to learn a second shape.
 */
export interface WritableTextFile {
  readonly fileName: string;
  /** Text for a document, bytes for an encoded artifact (T433's mp4). */
  readonly text: string | Uint8Array;
  readonly mime: string;
  /** What the save picker offers to filter by. */
  readonly pickerTypes: readonly FilePickerTypeSpec[];
}

export const PROJECT_PICKER_TYPES = PICKER_TYPES;

/**
 * The ONE way a file leaves this app (T452 ruling (c)).
 *
 * Everything above is about `.loom.json` because that was the only file there was. It is
 * not: a recorded feature track is an artifact of the same kind as a saved project and a
 * rendered sequence, and giving each its own save path is how three of them end up with
 * three different behaviours on Safari. So the picker-then-download ladder, the
 * cancel-is-not-a-failure rule and the never-throw rule live HERE, once, and
 * `writeProjectFile` is the first caller rather than the owner.
 */
export async function writeTextFile(
  file: WritableTextFile,
  options: WriteProjectOptions = {},
): Promise<SaveOutcome> {
  const globals = options.globals ?? pickers();
  const showSaveFilePicker = globals.showSaveFilePicker;

  if (typeof showSaveFilePicker === "function") {
    try {
      const handle = await showSaveFilePicker({
        suggestedName: file.fileName,
        types: file.pickerTypes,
      });
      const writable = await handle.createWritable();
      await writable.write(payloadOf(file));
      await writable.close();
      return { kind: "saved", fileName: handle.name ?? file.fileName, method: "picker" };
    } catch (error) {
      if (isAbort(error)) return { kind: "cancelled" };
      // A picker that exists but refuses (permission denied, a sandboxed frame) must not
      // lose the user's work — fall through to the download path.
      return downloadFallback(file, options, describe(error));
    }
  }

  return downloadFallback(file, options, null);
}

export async function writeProjectFile(
  file: ProjectFile,
  options: WriteProjectOptions = {},
): Promise<SaveOutcome> {
  return writeTextFile(
    { fileName: file.fileName, text: file.text, mime: PROJECT_FILE_MIME, pickerTypes: PICKER_TYPES },
    options,
  );
}

function downloadFallback(
  file: WritableTextFile,
  options: WriteProjectOptions,
  pickerError: string | null,
): SaveOutcome {
  const download = options.download ?? downloadTextFile;
  try {
    download(file);
    return { kind: "saved", fileName: file.fileName, method: "download" };
  } catch (error) {
    const reason = describe(error);
    return {
      kind: "failed",
      reason: pickerError === null ? reason : `${pickerError}; the download fallback also failed: ${reason}`,
    };
  }
}

export interface ReadProjectOptions {
  readonly globals?: FilePickerGlobals;
  /** Test seam for the `<input type="file">` path. */
  readonly pickFile?: () => Promise<File | null>;
}

/** `<input type="file">`, the fallback where `showOpenFilePicker` does not exist. */
function pickFileWithInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".loom.json,application/json";
    input.style.display = "none";
    // There is no "cancelled" event on a file input in any browser, so a cancelled
    // dialog simply never resolves this promise. That is fine — nothing is awaiting it
    // in a way that blocks, and the element is removed on the next successful pick.
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0] ?? null;
        input.remove();
        resolve(file);
      },
      { once: true },
    );
    document.body.append(input);
    input.click();
  });
}

export async function readProjectFile(options: ReadProjectOptions = {}): Promise<OpenOutcome> {
  const globals = options.globals ?? pickers();
  const showOpenFilePicker = globals.showOpenFilePicker;

  try {
    if (typeof showOpenFilePicker === "function") {
      const handles = await showOpenFilePicker({ multiple: false, types: PICKER_TYPES });
      const handle = handles[0];
      if (handle === undefined) return { kind: "cancelled" };
      const file = await handle.getFile();
      return { kind: "opened", fileName: file.name, text: await file.text() };
    }

    const file = await (options.pickFile ?? pickFileWithInput)();
    if (file === null) return { kind: "cancelled" };
    return { kind: "opened", fileName: file.name, text: await file.text() };
  } catch (error) {
    if (isAbort(error)) return { kind: "cancelled" };
    return { kind: "failed", reason: describe(error) };
  }
}
