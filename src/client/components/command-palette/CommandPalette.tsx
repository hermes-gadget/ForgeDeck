import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  Archive, ChevronLeft, ChevronRight, CircleStop, FlaskConical, GitCompareArrows, LayoutGrid, MessageSquareText, Moon, Plus, Search, Sparkles, Sun, X
} from "lucide-react";
import type { SidebarView } from "../sidebar/Sidebar";

type CommandPaletteSession = {
  id: string;
  title: string;
  cwd: string;
  category?: string | null;
  tags?: string[];
};

type CommandPaletteProps = {
  sessions: readonly CommandPaletteSession[];
  selectedTitle: string | null;
  canStop: boolean;
  canArchive: boolean;
  theme: "dark" | "light";
  modifierLabel: string;
  onClose: () => void;
  onNew: () => void;
  onSelectSession: (threadId: string) => void;
  onStop: () => void;
  onArchive: () => void;
  onNavigate: (view: SidebarView) => void;
  onNavigateRelative: (direction: -1 | 1) => void;
  onToggleTheme: () => void;
};

type PaletteCommand = {
  id: string;
  group: "Actions" | "Navigate" | "Sessions";
  label: string;
  description?: string;
  keywords: string;
  shortcut?: string;
  icon: ComponentType<{ size?: number }>;
  enabled: boolean;
  run: () => void;
};

export function CommandPalette({
  sessions, selectedTitle, canStop, canArchive, theme, modifierLabel, onClose, onNew, onSelectSession, onStop, onArchive,
  onNavigate, onNavigateRelative, onToggleTheme
}: CommandPaletteProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const commands = useMemo<PaletteCommand[]>(() => [
    {
      id: "new-session", group: "Actions", label: "Create new session", description: "Launch a standard coding session",
      keywords: "new create launch session", shortcut: `${modifierLabel}N`, icon: Plus, enabled: true, run: onNew
    },
    {
      id: "stop-session", group: "Actions", label: "Stop current session", description: selectedTitle || "Select a session first",
      keywords: "stop interrupt turn current session", icon: CircleStop, enabled: canStop, run: onStop
    },
    {
      id: "archive-session", group: "Actions", label: "Close and archive current session", description: selectedTitle || "Select a session first",
      keywords: "close archive current session", shortcut: `${modifierLabel}W`, icon: Archive, enabled: canArchive, run: onArchive
    },
    {
      id: "previous-section", group: "Navigate", label: "Previous section", description: "Cycle workspace tabs",
      keywords: "previous back tab section navigate", shortcut: `${modifierLabel}[`, icon: ChevronLeft, enabled: true, run: () => onNavigateRelative(-1)
    },
    {
      id: "next-section", group: "Navigate", label: "Next section", description: "Cycle workspace tabs",
      keywords: "next forward tab section navigate", shortcut: `${modifierLabel}]`, icon: ChevronRight, enabled: true, run: () => onNavigateRelative(1)
    },
    {
      id: "session-workspace", group: "Navigate", label: "Go to Session workspace", description: "Open the selected session",
      keywords: "session workspace chat navigate section", icon: MessageSquareText, enabled: true, run: () => onNavigate("session")
    },
    {
      id: "control-center", group: "Navigate", label: "Go to Control Center", description: "Monitor standard sessions",
      keywords: "control center board navigate section", icon: LayoutGrid, enabled: true, run: () => onNavigate("control")
    },
    {
      id: "spark-board", group: "Navigate", label: "Go to SparkBoard", description: "Monitor Spark sessions",
      keywords: "spark board navigate section", icon: Sparkles, enabled: true, run: () => onNavigate("spark")
    },
    {
      id: "model-compare", group: "Navigate", label: "Go to Model compare", description: "Branch one prompt across multiple models",
      keywords: "compare comparison diff judge score models navigate section", icon: GitCompareArrows, enabled: true, run: () => onNavigate("compare")
    },
    {
      id: "eval-lab", group: "Navigate", label: "Go to Eval lab", description: "Run versioned model comparisons",
      keywords: "eval evaluation score models blueprint navigate section", icon: FlaskConical, enabled: true, run: () => onNavigate("evals")
    },
    {
      id: "archive", group: "Navigate", label: "Go to Archive", description: "Review archived sessions and retention",
      keywords: "archive retention closed sessions navigate section", icon: Archive, enabled: true, run: () => onNavigate("archive")
    },
    {
      id: "toggle-theme", group: "Actions", label: `Use ${theme === "dark" ? "light" : "dark"} theme`, description: "Toggle the interface theme",
      keywords: "toggle theme dark light appearance", icon: theme === "dark" ? Sun : Moon, enabled: true, run: onToggleTheme
    },
    ...sessions.map((session): PaletteCommand => ({
      id: `session-${session.id}`, group: "Sessions", label: session.title, description: session.cwd,
      keywords: `${session.title} ${session.cwd} ${session.category || ""} ${(session.tags || []).join(" ")} ${session.id}`,
      icon: MessageSquareText, enabled: true, run: () => onSelectSession(session.id)
    }))
  ], [canArchive, canStop, modifierLabel, onArchive, onNavigate, onNavigateRelative, onNew, onSelectSession, onStop, onToggleTheme, selectedTitle, sessions, theme]);

  const filtered = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return commands;
    return commands.filter((command) => {
      const haystack = `${command.label} ${command.description || ""} ${command.keywords}`.toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [commands, query]);
  const selectableIndexes = useMemo(() => filtered.flatMap((command, index) => command.enabled ? [index] : []), [filtered]);
  const activeCommand = filtered[activeIndex];

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => {
      const previousFocus = previousFocusRef.current;
      window.requestAnimationFrame(() => {
        if (!document.querySelector("[aria-modal='true']")) previousFocus?.focus();
      });
    };
  }, []);

  useEffect(() => {
    setActiveIndex((current) => filtered[current]?.enabled ? current : selectableIndexes[0] ?? 0);
  }, [filtered, selectableIndexes]);

  const invoke = (command: PaletteCommand | undefined) => {
    if (!command?.enabled) return;
    onClose();
    command.run();
  };

  const move = (direction: -1 | 1) => {
    if (!selectableIndexes.length) return;
    const currentPosition = selectableIndexes.indexOf(activeIndex);
    const nextPosition = currentPosition < 0
      ? direction > 0 ? 0 : selectableIndexes.length - 1
      : (currentPosition + direction + selectableIndexes.length) % selectableIndexes.length;
    setActiveIndex(selectableIndexes[nextPosition]);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") { event.preventDefault(); onClose(); return; }
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); move(1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); move(-1); return; }
    if (event.key === "Home") { event.preventDefault(); setActiveIndex(selectableIndexes[0] ?? 0); return; }
    if (event.key === "End") { event.preventDefault(); setActiveIndex(selectableIndexes.at(-1) ?? 0); return; }
    if (event.key === "Enter") { event.preventDefault(); invoke(activeCommand); return; }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])")];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return <div className="modal-backdrop command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className="command-palette" role="dialog" aria-modal="true" aria-labelledby="command-palette-title" onKeyDown={handleKeyDown}>
      <h2 id="command-palette-title" className="sr-only">Command palette</h2>
      <div className="command-palette-search">
        <Search size={18} aria-hidden="true" />
        <input ref={inputRef} role="combobox" aria-expanded="true" aria-controls="command-palette-list" aria-autocomplete="list"
          aria-label="Search sessions and commands" aria-activedescendant={activeCommand ? `command-option-${activeCommand.id}` : undefined} value={query}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }} placeholder="Search sessions and commands…" />
        <kbd>{modifierLabel}K</kbd>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close command palette" title="Close command palette (Escape)"><X size={17} /></button>
      </div>
      <div id="command-palette-list" className="command-palette-list" role="listbox" aria-label="Commands">
        {filtered.map((command, index) => {
          const Icon = command.icon;
          const firstInGroup = index === 0 || filtered[index - 1].group !== command.group;
          return <div className="command-palette-row" key={command.id}>
            {firstInGroup && <div className="command-palette-group" aria-hidden="true">{command.group}</div>}
            <button id={`command-option-${command.id}`} type="button" role="option" tabIndex={-1} aria-selected={index === activeIndex}
              aria-disabled={!command.enabled} className={`${index === activeIndex ? "active" : ""} ${!command.enabled ? "disabled" : ""}`}
              onMouseEnter={() => { if (command.enabled) setActiveIndex(index); }} onClick={() => invoke(command)}>
              <span className="command-palette-icon"><Icon size={16} /></span>
              <span className="command-palette-copy"><strong>{command.label}</strong>{command.description && <small>{command.description}</small>}</span>
              {command.shortcut && <kbd>{command.shortcut}</kbd>}
            </button>
          </div>;
        })}
        {!filtered.length && <div className="command-palette-empty" role="status">No matching sessions or commands</div>}
      </div>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Run</span><span><kbd>Esc</kbd> Close</span></footer>
    </div>
  </div>;
}
