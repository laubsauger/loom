import { useRef } from "react";
import { PICTURE_FILE_ACCEPT, PICTURE_FILE_TAKES } from "@domain/media/picture-file.ts";
import { cx } from "../cx.ts";
import { curvePolyline } from "./curve-polyline.ts";
import type { CurvePoint } from "./curve-polyline.ts";
import styles from "./controls.module.css";

/**
 * Curve and asset parameters (T37).
 *
 * Both are read-only in v1, deliberately and visibly:
 *  - curve editing belongs with keyframes and expressions, which §C defers (doc §8.2);
 *  - the asset registry and loader nodes are Phase 2 (§C scope, doc §33).
 *
 * They still render, because the inspector is manifest-driven: a definition may declare
 * either type today, and a control set that silently skipped an unknown parameter would
 * hide part of the node from the user.
 */

export interface CurveFieldProps {
  label: string;
  value: readonly CurvePoint[];
}

export function CurveField({ label, value }: CurveFieldProps) {
  const points = curvePolyline(value);
  return (
    <div className={styles.curve}>
      <svg
        className={styles.curvePlot}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label} curve, ${value.length} point${value.length === 1 ? "" : "s"}`}
      >
        {points === "" ? null : <polyline className={styles.curveLine} points={points} />}
      </svg>
      <span className={styles.meta}>
        {value.length} point{value.length === 1 ? "" : "s"} · read-only in v1
      </span>
    </div>
  );
}

export interface AssetFieldProps {
  label: string;
  value: string | null;
  kind: string;
  /** Absent = read-only display (the pre-T434 stub behaviour). */
  onPick?: (url: string, fileName: string) => void;
}

/**
 * What the file dialog offers, keyed by the parameter's declared KIND.
 *
 * T1223 — the owner's first symptom lived here: *"If I click Choose File I can only select
 * movie files… I can't even select an image as of now."* `movieFileIn` declared kind
 * `video`, so the dialog offered `video/*` and nothing else, while the node's own
 * description claimed it played stills. `picture` is the "either" kind (§domain/media/
 * picture-file.ts owns the list); `audio`, `video` and `image` are untouched, deliberately
 * — widening one of those would let a JPEG into an audio slot.
 */
const ASSET_ACCEPT: Readonly<Record<string, string>> = {
  audio: "audio/*",
  video: "video/*",
  image: "image/*",
  picture: PICTURE_FILE_ACCEPT,
};

/**
 * What a slot takes, in words, for the tooltip — the one place someone CHOOSING a file
 * reads before they open the dialog. `picture` says it because "no picture bound" alone
 * does not tell you an EXR will be refused (T1223, §V403).
 */
const ASSET_TAKES: Readonly<Record<string, string>> = {
  picture: PICTURE_FILE_TAKES,
};

/** A bound object URL's display name: the picked file's name survives in the fragment. */
function assetDisplayName(value: string): string {
  const hash = value.indexOf("#");
  if (hash >= 0 && hash < value.length - 1) return decodeURIComponent(value.slice(hash + 1));
  return value.length > 42 ? `…${value.slice(-40)}` : value;
}

/**
 * T434: a REAL file picker — `movieFileIn` and `audioFileIn` share it.
 *
 * The picked file becomes an object URL, session-scoped: it plays now and dies with the
 * page, and the meta line SAYS so instead of letting a reloaded project fail mysteriously
 * (§V288). Durable assets are still their own phase; the picker existing does not
 * pretend otherwise. The file's name rides the URL fragment so the field can display
 * something a human recognises.
 */
export function AssetField({ label, value, kind, onPick }: AssetFieldProps) {
  const input = useRef<HTMLInputElement | null>(null);
  const takes = ASSET_TAKES[kind];
  return (
    <div
      className={cx(styles.asset, "nodrag")}
      aria-label={label}
      role="group"
      /*
        T543: the session-only caveat lives HERE ALONE. Inline it fought the filename
        for one row's width and all three parts ellipsized ("no audio bo… [choose…] ·
        this session …") — the same crammed-chrome disease T498 treated. The caveat is
        true and worth saying once; the tooltip says it at every width, and the
        filename gets the row.
      */
      title={
        value === null || value === ""
          ? `No ${kind} bound. A picked file lasts for this session only.${takes === undefined ? "" : ` ${takes}`}`
          : `${assetDisplayName(value)} — this session only`
      }
    >
      <span className={styles.assetName}>
        {value === null || value === "" ? `no ${kind} bound` : assetDisplayName(value)}
      </span>
      {onPick === undefined ? (
        <span className={styles.meta}>· read-only</span>
      ) : (
        <>
          <button
            type="button"
            className={styles.assetPick}
            onClick={() => input.current?.click()}
          >
            choose…
          </button>
          <input
            ref={input}
            type="file"
            accept={ASSET_ACCEPT[kind] ?? undefined}
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file === undefined) return;
              const url = `${URL.createObjectURL(file)}#${encodeURIComponent(file.name)}`;
              onPick(url, file.name);
              event.currentTarget.value = "";
            }}
          />
        </>
      )}
    </div>
  );
}
