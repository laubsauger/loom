import { useEffect, useState } from "react";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { ProjectSettings } from "@domain/types/graph.ts";
import { ProjectSettingsDialog } from "./project-settings.tsx";
import { registerProjectSettingsCommand } from "./settings-command.ts";

/**
 * Mounts the project settings dialog and answers `ui.openSettings` (T359, §V307).
 *
 * The same shape as `HelpHost`: the open flag is not document state, so it lives here and
 * the command reaches it through the holder. One of these, once. The top bar's settings
 * button executes the command rather than calling `setOpen`, so the button, `mod+,` and
 * the palette entry are three doors onto one route (§V78, §V52).
 */

export interface ProjectSettingsHostProps {
  bus: ShaderloomBus;
  /** The live settings view off the store (§V177), not a snapshot. */
  settings: ProjectSettings;
  /** One field at a time — a partial patch through `project.setSettings` (§V29). */
  onChange: (patch: Partial<ProjectSettings>, label: string) => void;
}

export function ProjectSettingsHost({ bus, settings, onChange }: ProjectSettingsHostProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const holder = registerProjectSettingsCommand(bus);
    const handlers = {
      open(): void {
        setOpen(true);
      },
    };
    holder.current = handlers;
    return () => {
      if (holder.current === handlers) holder.current = null;
    };
  }, [bus]);

  return (
    <ProjectSettingsDialog
      settings={settings}
      onChange={onChange}
      open={open}
      onOpenChange={setOpen}
    />
  );
}
