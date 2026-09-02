import { useEffect, useState } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { ExpressionScope } from "@domain/expressions/index.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { HelpSection } from "./command.ts";
import { registerHelpCommand } from "./command.ts";
import { HelpPanel } from "./help-panel.tsx";

/**
 * Mounts the help panel and answers `ui.openHelp` (T200).
 *
 * The panel's open state is not document state — it produces no patch, makes no undo
 * entry and never reaches a file (§V16) — so it lives here, and the command reaches it
 * through the holder rather than through the store. One of these, once, inside the
 * `KeymapProvider` whose resolved keymap the shortcuts tab reads.
 */

export interface HelpHostProps {
  bus: LoomBus;
  /** The installed catalogue — `registry.list()`. */
  nodes: readonly NodeDefinition[];
  /** The scope a parameter expression sees (§V71). */
  scope?: ExpressionScope;
}

export function HelpHost({ bus, nodes, scope }: HelpHostProps) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<HelpSection>("shortcuts");

  useEffect(() => {
    const holder = registerHelpCommand(bus);
    const handlers = {
      open(requested: HelpSection | undefined): HelpSection {
        const next = requested ?? "shortcuts";
        setSection(next);
        setOpen(true);
        return next;
      },
    };
    holder.current = handlers;
    return () => {
      if (holder.current === handlers) holder.current = null;
    };
  }, [bus]);

  return (
    <HelpPanel
      open={open}
      onOpenChange={setOpen}
      section={section}
      onSectionChange={setSection}
      nodes={nodes}
      {...(scope === undefined ? {} : { scope })}
    />
  );
}
