import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, CircleStop, LayoutGrid, LoaderCircle, RotateCcw, Trash2, X } from "lucide-react";

export type SessionOperation = "stop" | "remove" | "archive" | "delete";

export type SessionActionTarget = {
  id: string;
  title: string;
  running: boolean;
  queued: number;
  onBoard: boolean;
  archived: boolean;
};

export type SessionActionResult = {
  threadId: string;
  status: "succeeded" | "failed" | "skipped";
  message: string;
};

export type SessionActionRequest = {
  operation: SessionOperation;
  threadIds: string[];
};

const SESSION_OPERATIONS: Record<SessionOperation, {
  label: string;
  shortLabel: string;
  description: string;
  unavailable?: string;
}> = {
  stop: {
    label: "Stop current turn",
    shortLabel: "Stop turn",
    description: "Interrupt current work without removing the session. Queued tasks stay queued and may run next."
  },
  remove: {
    label: "Remove from board",
    shortLabel: "Remove",
    description: "Hide the session from its board. Work, queue, history, and archive state are unchanged."
  },
  archive: {
    label: "Archive session",
    shortLabel: "Archive",
    description: "Stop current work, clear queued tasks, and move the session to the archive while preserving its history."
  },
  delete: {
    label: "Delete permanently",
    shortLabel: "Delete",
    description: "Permanently erase session data.",
    unavailable: "ForgeDeck's backend currently supports archive only; it has no permanent-delete operation."
  }
};

const OPERATION_ICONS = {
  stop: CircleStop,
  remove: LayoutGrid,
  archive: Archive,
  delete: Trash2
};

type SessionActionDialogProps = {
  request: SessionActionRequest;
  targets: SessionActionTarget[];
  onRun: (operation: SessionOperation, targets: SessionActionTarget[]) => Promise<SessionActionResult[]>;
  onUndoRemove: (threadIds: string[]) => void;
  onClose: () => void;
};

export function SessionActionDialog({ request, targets: providedTargets, onRun, onUndoRemove, onClose }: SessionActionDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(false);
  const [operation, setOperation] = useState(request.operation);
  const [targets] = useState(providedTargets);
  const [pending, setPending] = useState(false);
  const [results, setResults] = useState<SessionActionResult[] | null>(null);
  const [undone, setUndone] = useState(false);
  pendingRef.current = pending;
  const definition = SESSION_OPERATIONS[operation];
  const runningCount = targets.filter((target) => target.running).length;
  const queuedCount = targets.reduce((total, target) => total + target.queued, 0);
  const affectedCount = operation === "stop" ? runningCount
    : operation === "remove" ? targets.filter((target) => target.onBoard).length
      : operation === "archive" ? targets.filter((target) => !target.archived).length
        : 0;
  const unavailable = definition.unavailable
    || (operation === "stop" && !runningCount ? "None of these sessions has a running turn." : null)
    || (operation === "remove" && !targets.some((target) => target.onBoard) ? "None of these sessions is currently on a board." : null)
    || (operation === "archive" && !targets.some((target) => !target.archived) ? "These sessions are already archived." : null);
  const successfulRemovalIds = useMemo(() => operation === "remove" && results
    ? results.filter((result) => result.status === "succeeded").map((result) => result.threadId)
    : [], [operation, results]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingRef.current) onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); previouslyFocused?.focus(); };
  }, [onClose]);

  const chooseOperation = (next: SessionOperation) => {
    if (pending) return;
    setOperation(next);
    setResults(null);
    setUndone(false);
  };

  const run = async () => {
    if (pending || unavailable || !affectedCount) return;
    setPending(true);
    setResults(null);
    try {
      setResults(await onRun(operation, targets));
    } catch (error) {
      setResults(targets.map((target) => ({
        threadId: target.id,
        status: "failed",
        message: error instanceof Error ? error.message : String(error)
      })));
    } finally {
      setPending(false);
    }
  };

  const undoRemoval = () => {
    if (!successfulRemovalIds.length || undone) return;
    onUndoRemove(successfulRemovalIds);
    setUndone(true);
  };

  const resultById = new Map(results?.map((result) => [result.threadId, result]));
  const failedCount = results?.filter((result) => result.status === "failed").length || 0;

  return <div className="modal-backdrop session-action-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
    <div ref={dialogRef} className="session-action-dialog" role="dialog" aria-modal="true" aria-labelledby="session-action-title" aria-describedby="session-action-description">
      <header className="session-action-header">
        <div><span className="eyebrow">Session actions</span><h2 id="session-action-title">What should change?</h2></div>
        <button ref={closeRef} type="button" className="icon-button" disabled={pending} onClick={onClose} aria-label="Close session actions"><X size={18} /></button>
      </header>
      <div className="session-action-body">
        <div className="session-operation-list" aria-label="Session operations">
          {(Object.keys(SESSION_OPERATIONS) as SessionOperation[]).map((candidate) => {
            const candidateDefinition = SESSION_OPERATIONS[candidate];
            const Icon = OPERATION_ICONS[candidate];
            return <button type="button" key={candidate} className={`${operation === candidate ? "selected" : ""} ${candidate === "delete" ? "danger" : ""}`} disabled={pending} onClick={() => chooseOperation(candidate)} aria-pressed={operation === candidate}>
              <Icon size={16} /><span><strong>{candidateDefinition.label}</strong><small>{candidateDefinition.description}</small></span>
            </button>;
          })}
        </div>
        <section className="session-action-preview">
          <h3>{definition.label}</h3>
          <p id="session-action-description">{definition.description}</p>
          <div className="session-impact-summary">
            <span><strong>{targets.length}</strong> selected</span>
            <span className={runningCount ? "warning" : ""}><strong>{runningCount}</strong> running</span>
            <span className={queuedCount && operation === "archive" ? "warning" : ""}><strong>{queuedCount}</strong> queued</span>
          </div>
          {unavailable && <div className="session-action-unavailable" role="status">{unavailable}</div>}
          <ul className="session-target-list">
            {targets.map((target) => {
              const result = resultById.get(target.id);
              return <li key={target.id} className={result ? `result-${result.status}` : ""}>
                <span><strong>{target.title}</strong><small>{target.running ? "Running turn" : "Idle"}{target.queued ? ` · ${target.queued} queued` : ""}{target.archived ? " · Archived" : ""}</small></span>
                {pending ? <LoaderCircle className="spin" size={14} aria-label="Pending" /> : result ? <em>{result.message}</em> : null}
              </li>;
            })}
          </ul>
          {results && <div className={`session-action-result ${failedCount ? "has-failures" : ""}`} role="status">
            {failedCount ? `${failedCount} of ${results.length} session action${results.length === 1 ? "" : "s"} failed. Review each session above.` : undone ? "Board removal undone." : operation === "archive" ? "Archive was accepted for every affected session." : "Action completed for every affected session."}
          </div>}
        </section>
      </div>
      <footer className="session-action-footer">
        <span>{pending ? `Running ${definition.shortLabel.toLowerCase()}…` : results ? "Results are shown per session." : `${affectedCount} session${affectedCount === 1 ? "" : "s"} will be affected.`}</span>
        {successfulRemovalIds.length > 0 && !undone && <button type="button" className="secondary-button" disabled={pending} onClick={undoRemoval}><RotateCcw size={14} />Undo removal</button>}
        <button type="button" className="secondary-button" disabled={pending} onClick={onClose}>{results ? "Done" : "Cancel"}</button>
        {!results && <button type="button" className={`primary-button ${operation === "archive" || operation === "delete" ? "danger" : ""}`} disabled={pending || Boolean(unavailable) || !affectedCount} onClick={() => void run()}>{pending ? <LoaderCircle className="spin" size={15} /> : null}{definition.shortLabel}</button>}
      </footer>
    </div>
  </div>;
}
