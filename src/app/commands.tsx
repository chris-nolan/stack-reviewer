// Command registry: screens register context-specific commands while mounted (`useCommands`),
// and one global palette (see Palette.tsx) lists them next to the app-wide ones.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isMac, shortcut } from "../lib/shortcuts";

export type CommandGroup = "Actions" | "Layers" | "Files" | "Stacks" | "Go to";
export const GROUP_ORDER: CommandGroup[] = ["Actions", "Layers", "Files", "Stacks", "Go to"];

export type Command = {
  id: string;
  title: string;
  group: CommandGroup;
  /** Secondary text, shown dimmed after the title (repo, directory…). */
  hint?: string;
  /** Keyboard shortcut label, e.g. "j" or "⌘K". */
  shortcut?: string;
  /** Extra text to match against. */
  keywords?: string;
  /** Highlight as the current item (current layer or file). */
  current?: boolean;
  run: () => void;
};

type Registry = {
  register: (getter: () => Command[]) => () => void;
  collect: () => Command[];
  open: boolean;
  setOpen: (o: boolean) => void;
};

const Ctx = createContext<Registry | null>(null);

export function CommandsProvider({ children }: { children: ReactNode }) {
  const getters = useRef(new Set<() => Command[]>());
  const [open, setOpen] = useState(false);
  const value = useMemo<Registry>(
    () => ({
      register: (g) => {
        getters.current.add(g);
        return () => void getters.current.delete(g);
      },
      collect: () => [...getters.current].flatMap((g) => g()),
      open,
      setOpen,
    }),
    [open],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function useRegistry(): Registry {
  const r = useContext(Ctx);
  if (!r) throw new Error("useCommands outside CommandsProvider");
  return r;
}

/** Register commands while the calling component is mounted. The list is read when the palette opens, so closures stay current. */
export function useCommands(commands: Command[]) {
  const { register } = useRegistry();
  const ref = useRef(commands);
  ref.current = commands;
  useEffect(() => register(() => ref.current), [register]);
}

export function usePalette() {
  const { open, setOpen } = useRegistry();
  return { open, openPalette: () => setOpen(true), closePalette: () => setOpen(false), toggle: () => setOpen(!open) };
}

export function useCollectCommands(): () => Command[] {
  return useRegistry().collect;
}

export { isMac };
export const PALETTE_SHORTCUT = shortcut("K");
