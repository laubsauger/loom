/**
 * UI kit surface for the other tracks.
 * `src/ui/controls/**` (parameter control kit) is owned separately and is not
 * re-exported here.
 */
export { cx } from "./cx.ts";
export { PORT_FAMILY_VAR, portFamilyColor, portTypeColor } from "./ports.ts";
export { useReducedMotion } from "./hooks/use-reduced-motion.ts";

export { Button } from "./primitives/button.tsx";
export type { ButtonProps } from "./primitives/button.tsx";

export {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from "./primitives/tooltip.tsx";
export type { TooltipContentProps, TooltipProps } from "./primitives/tooltip.tsx";

export {
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverHeader,
  PopoverRoot,
  PopoverTrigger,
} from "./primitives/popover.tsx";
export type { PopoverContentProps } from "./primitives/popover.tsx";

export { TabBadge, TabsContent, TabsList, TabsRoot, TabsTrigger } from "./primitives/tabs.tsx";
export type {
  TabBadgeProps,
  TabsContentProps,
  TabsListProps,
  TabsRootProps,
  TabsTriggerProps,
} from "./primitives/tabs.tsx";

export {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuTrigger,
} from "./primitives/context-menu.tsx";
export type { ContextMenuContentProps, ContextMenuItemProps } from "./primitives/context-menu.tsx";

export {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogRoot,
  DialogTitle,
  DialogTrigger,
} from "./primitives/dialog.tsx";
export type { DialogContentProps } from "./primitives/dialog.tsx";
