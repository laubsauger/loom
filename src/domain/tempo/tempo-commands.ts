import { z } from "zod";
import type { LoomBus } from "../commands/bus.ts";
import { NO_INPUT } from "../commands/input-schema.ts";
import { TEMPO_SOURCES, type TempoSourceKind } from "../types/frame.ts";
import { projectTempoSource, TEMPO_RESYNC_COMMAND, TEMPO_TAP_COMMAND, type ProjectTempo } from "./project-tempo.ts";
import { BPM_MAX, BPM_MIN } from "./tap-tempo.ts";

/**
 * T1785b — the project tempo's four verbs, on the bus (§V29, §V52), so the transport bar,
 * the keymap, a Panel, the phone and an agent all reach one code path.
 *
 * The BPM and the source are document state and are written through `applySettings`, the
 * primitive `project.setSettings` uses: one revision and one undo entry each. The beat's
 * PHASE is the session's (`ProjectTempo`), so `tempo.tap` and `tempo.resync` move it and
 * store nothing for it. All four are `app` commands: they name no node of a document.
 */
declare module "../types/commands.ts" {
  interface CommandMap {
    /** Set the project tempo in beats per minute (20..999). */
    "tempo.set": { input: { bpm: number }; output: TempoCommandOutput };
    /**
     * One tap. The tap lands on the nearest beat (the latest tap sets the phase); from the
     * second tap on, the tempo is the median of the last tap intervals and is stored as the
     * project tempo. A gap of two seconds starts a new count.
     */
    "tempo.tap": { input: Record<string, never>; output: TempoCommandOutput & { taps: number } };
    /** Resync the downbeat: beat zero of bar zero is now. */
    "tempo.resync": { input: Record<string, never>; output: TempoCommandOutput };
    /** Choose what drives the beat clock: `manual`, `audio` or `midiClock`. */
    "tempo.setSource": { input: { source: TempoSourceKind }; output: TempoCommandOutput };
  }
}

export interface TempoCommandOutput {
  /** The tempo in effect after the command. */
  bpm: number;
  source: TempoSourceKind;
  /** The source is delivering (always for `manual`); false means the last tempo is held. */
  locked: boolean;
}

const NO_TEMPO: TempoCommandOutput = { bpm: 0, source: "manual", locked: false };

export function registerTempoCommands(bus: LoomBus, tempo: ProjectTempo): void {
  if (bus.hasCommand("tempo.set")) return;

  const output = (): TempoCommandOutput => {
    const { bpm, source, locked } = tempo.snapshot();
    return { bpm, source, locked };
  };

  bus.registerCommand({
    name: "tempo.set",
    inSession: "app",
    inputSchema: z.object({ bpm: z.number().min(BPM_MIN).max(BPM_MAX) }).strict(),
    description: "Set the project tempo in beats per minute. Expressions read it as bpm, beat, beatphase, beatpulse, bar and barphase.",
    handler: (input, context) => {
      // To a hundredth: what a field shows, and what a file should hold of a typed number.
      const applied = context.applySettings({ label: "Set tempo", patch: { bpm: Math.round(input.bpm * 100) / 100 } });
      return { status: "applied", revision: applied.revision, ...(applied.undoGroupId === undefined ? {} : { undoGroupId: applied.undoGroupId }), output: context.dryRun ? { ...output(), bpm: input.bpm } : output() };
    },
    rejectionOutput: () => NO_TEMPO,
  });

  bus.registerCommand({
    name: TEMPO_TAP_COMMAND,
    inSession: "app",
    inputSchema: NO_INPUT,
    description: "Tap the tempo. The tap lands on the nearest beat; from the second tap the project tempo is the median of the last tap intervals.",
    handler: (_input, context) => {
      if (context.dryRun) return { status: "applied", revision: context.store.getRevision(), output: { ...output(), taps: 0 } };
      const tapped = tempo.tap();
      let revision = context.store.getRevision();
      let undoGroupId: string | undefined;
      if (tapped.bpm !== null) {
        const applied = context.applySettings({ label: "Tap tempo", patch: { bpm: tapped.bpm } });
        revision = applied.revision;
        undoGroupId = applied.undoGroupId;
      }
      return { status: "applied", revision, ...(undoGroupId === undefined ? {} : { undoGroupId }), output: { ...output(), taps: tapped.taps } };
    },
    rejectionOutput: () => ({ ...NO_TEMPO, taps: 0 }),
  });

  bus.registerCommand({
    name: TEMPO_RESYNC_COMMAND,
    inSession: "app",
    inputSchema: NO_INPUT,
    description: "Resync the downbeat: beat zero of bar zero is now.",
    handler: (_input, context) => {
      if (!context.dryRun) tempo.resync();
      return { status: "applied", revision: context.store.getRevision(), output: output() };
    },
    rejectionOutput: () => NO_TEMPO,
  });

  bus.registerCommand({
    name: "tempo.setSource",
    inSession: "app",
    inputSchema: z.object({ source: z.enum(TEMPO_SOURCES) }).strict(),
    description: "Choose what drives the beat clock: manual (the project tempo, typed or tapped), audio (the detected tempo while it is confident) or midiClock (MIDI clock in).",
    handler: (input, context) => {
      const before = projectTempoSource(context.store.getSettings());
      // Leaving a follower for manual KEEPS the tempo it was holding: the project tempo
      // becomes the one that was playing, in the same undo entry as the switch.
      const keep = input.source === "manual" && before !== "manual" ? { bpm: Math.round(tempo.snapshot().bpm * 10) / 10 } : {};
      const applied = context.applySettings({ label: "Set tempo source", patch: { tempoSource: input.source, ...keep } });
      return { status: "applied", revision: applied.revision, ...(applied.undoGroupId === undefined ? {} : { undoGroupId: applied.undoGroupId }), output: context.dryRun ? { ...output(), source: input.source } : output() };
    },
    rejectionOutput: () => NO_TEMPO,
  });
}
