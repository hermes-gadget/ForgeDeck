import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type UIEvent } from "react";
import {
  AlertTriangle, ArrowDown, Bot, BrainCircuit, ChevronRight, CircleStop, Code2, Command, Folder, LayoutGrid,
  ListPlus, LoaderCircle, Pause, Play, RefreshCw, Send, Server, Settings2, ShieldCheck, Sparkles, Target,
  TerminalSquare, X
} from "lucide-react";
import { api } from "../../api/client";
import { useThreadLiveState } from "../../state/thread-store";
import type { SessionOperation } from "../session-actions/SessionActionDialog";
import type { ClaudeModelOption, CodexModel, SessionSettings, Thread, ThreadItem } from "../../types";

const LazyReactMarkdown = lazy(() => import("react-markdown"));
const SAFE_PROTOCOLS = new Set(["http", "https", "mailto"]);
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LABELS: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum", ultra: "Ultra" };
const SLASH_COMMANDS: AssistSuggestion[] = [
  { id: "compact", label: "/compact", description: "Compact the session context", insert: "/compact", kind: "command" },
  { id: "goal", label: "/goal", description: "Set or manage a persistent task goal", insert: "/goal ", kind: "command" },
  { id: "stop", label: "/stop", description: "Stop the active turn", insert: "/stop", kind: "command" },
  { id: "rename", label: "/rename", description: "Rename this session", insert: "/rename ", kind: "command" },
  { id: "archive", label: "/archive", description: "Archive this session", insert: "/archive", kind: "command" },
  { id: "mention", label: "/mention", description: "Autocomplete a workspace file", insert: "@", kind: "command" }
];

export type AssistSuggestion = { id: string; label: string; description: string; insert: string; kind: "command" | "file" | "directory" };

type ChatProps = {
  thread: Thread;
  loading: boolean;
  models: CodexModel[];
  claudeModels: ClaudeModelOption[];
  settings: SessionSettings;
  onSettings: (settings: SessionSettings) => void;
  onRefresh: () => Promise<unknown>;
  onSessionAction: (operation: SessionOperation) => void;
  onError: (error: unknown) => void;
};

const AUTO_FOLLOW_THRESHOLD = 16;

/** Keeps a specific scroll viewport pinned until that viewport, rather than a nested child, is scrolled away. */
export function useStickyBottom<T extends HTMLElement>(contentVersion: unknown) {
  const scrollerRef = useRef<T>(null);
  const followingRef = useRef(true);
  const previousVersion = useRef<unknown>(undefined);
  const hasContentVersion = useRef(false);
  const [isFollowing, setIsFollowing] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);

  const updateFollowing = useCallback((following: boolean) => {
    followingRef.current = following;
    setIsFollowing(following);
    if (following) setUnseenCount(0);
  }, []);

  const onScroll = useCallback((event: UIEvent<T>) => {
    // React scroll events do not normally bubble, but this guard keeps scrollable
    // command output and diffs from changing the state of their parent viewport.
    if (event.target !== event.currentTarget) return;
    updateFollowing(isAtBottom(event.currentTarget));
  }, [updateFollowing]);

  const jumpToLatest = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    updateFollowing(isAtBottom(element));
  }, [updateFollowing]);

  useEffect(() => {
    if (hasContentVersion.current && Object.is(previousVersion.current, contentVersion)) return;
    const initialContent = !hasContentVersion.current;
    hasContentVersion.current = true;
    previousVersion.current = contentVersion;
    if (!followingRef.current) {
      if (!initialContent) setUnseenCount((count) => count + 1);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const element = scrollerRef.current;
      if (element && followingRef.current) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [contentVersion]);

  return { scrollerRef, isFollowing, unseenCount, onScroll, jumpToLatest };
}

export function AutoFollowIndicator({ isFollowing, unseenCount, onJump, compact = false }: { isFollowing: boolean; unseenCount: number; onJump: () => void; compact?: boolean }) {
  const unseenLabel = `${unseenCount} new ${unseenCount === 1 ? "update" : "updates"}`;
  return <div className={`auto-follow-indicator ${compact ? "compact" : ""} ${isFollowing ? "following" : "paused"}`}>
    <span className="sr-only" role="status" aria-atomic="true">{isFollowing ? "At latest. Auto-follow is on." : "New transcript updates are available. Auto-follow is paused."}</span>
    <button type="button" tabIndex={isFollowing ? -1 : 0} onClick={onJump} aria-label={isFollowing ? "At latest; auto-follow is on" : `Jump to latest; ${unseenLabel}`}>
      <ArrowDown size={compact ? 11 : 14} /><span>{isFollowing ? "At latest" : "Jump to latest"}</span>{!isFollowing && <b aria-hidden="true">{unseenCount > 99 ? "99+" : unseenCount}</b>}
    </button>
  </div>;
}

export function RecoveryNotice({ onLoad, onError, compact = false }: { onLoad: () => Promise<unknown>; onError: (error: unknown) => void; compact?: boolean }) {
  const [loading, setLoading] = useState(false);
  const load = async () => {
    if (loading) return;
    setLoading(true);
    try { await onLoad(); } catch (error) { onError(error); } finally { setLoading(false); }
  };
  return <div className={`recovery-notice ${compact ? "compact" : ""}`} role="status">
    <AlertTriangle size={compact ? 11 : 14} />
    <span>{compact ? "Live output was shortened." : "Some live output was omitted from this bounded recovery snapshot."}</span>
    <button type="button" disabled={loading} onClick={() => void load()}>{loading ? <LoaderCircle className="spin" size={12} /> : <RefreshCw size={12} />}{compact ? "Full detail" : "Load full session detail"}</button>
  </div>;
}

function isAtBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= AUTO_FOLLOW_THRESHOLD;
}

/** Announces state transitions without exposing rapidly changing transcript text to a live region. */
export function useActivityAnnouncement(running: boolean, providerName: string): string {
  const previousRunning = useRef<boolean | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (previousRunning.current === null) {
      previousRunning.current = running;
      return;
    }
    if (previousRunning.current === running) return;
    previousRunning.current = running;
    setAnnouncement(running ? `${providerName} started working.` : `${providerName} finished the current turn.`);
  }, [providerName, running]);
  return announcement;
}

/** Chat subscribes to only its own thread's live snapshot. */
export const Chat = memo(function Chat({ thread, loading, models, claudeModels, settings, onSettings, onRefresh, onSessionAction, onError }: ChatProps) {
  const live = useThreadLiveState(thread.id);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const assist = useComposerAssist(text, setText, thread.cwd);
  const claude = thread.backend === "claude";
  const spark = thread.sessionClass === "spark";
  const providerName = claude ? "Claude" : spark ? "Spark" : "Codex";
  const selectedModel = models.find((model) => model.model === settings.model);
  const effortOptions = claude ? CLAUDE_EFFORTS : spark ? ["high"] : selectedModel?.supportedReasoningEfforts.map((option) => option.reasoningEffort) || [];
  const settingsValid = claude ? claudeModels.some((model) => model.model === settings.model) && effortOptions.includes(settings.effort)
    : spark ? settings.model === "gpt-5.3-codex-spark" && settings.effort === "high"
    : Boolean(selectedModel && effortOptions.includes(settings.effort));
  const effectiveStatus = live.status || thread.status;
  const runningTurn = useMemo(() => [...thread.turns].reverse().find((turn) => turn.status === "inProgress"), [thread.turns]);
  const running = effectiveStatus.type === "active" || Boolean(runningTurn);
  const activityAnnouncement = useActivityAnnouncement(running, providerName);
  const historyItems = useMemo(() => thread.turns.flatMap((turn) => turn.items), [thread.turns]);
  const historyIds = useMemo(() => new Set(historyItems.map((item) => item.id).filter(Boolean)), [historyItems]);
  const streamingText = useMemo(() => Object.entries(live.agentText).filter(([id]) => !historyIds.has(id)), [historyIds, live.agentText]);
  const immediateItems = useMemo(() => unseenLiveItems(historyItems, Object.values(live.items)).filter((item) => !(item.type === "agentMessage" && item.id && live.agentText[item.id])), [historyItems, live.agentText, live.items]);
  const contentVersion = useMemo(() => ({ immediateItems, toolOutput: live.toolOutput, streamingText, turns: thread.turns }), [immediateItems, live.toolOutput, streamingText, thread.turns]);
  const autoFollow = useStickyBottom<HTMLDivElement>(contentVersion);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || sending || !settingsValid) return;
    const outgoing = text.trim();
    setText("");
    setSending(true);
    try {
      const result = await executeComposerText(thread, outgoing, settings, running);
      if (!result.sent) { setText(result.replacement); return; }
      await onRefresh();
    } catch (error) {
      setText(outgoing);
      onError(error);
    } finally {
      setSending(false);
    }
  };

  const changeModel = (modelId: string) => {
    const model = models.find((candidate) => candidate.model === modelId);
    if (model && !claude && !spark) onSettings({ ...settings, model: model.model, effort: model.defaultReasoningEffort });
  };

  return <div className="chat-layout">
    <span className="sr-only" role="status" aria-atomic="true">{activityAnnouncement}</span>
    <div className="transcript-shell">
    <div className="transcript" ref={autoFollow.scrollerRef} onScroll={autoFollow.onScroll} role="region" aria-label="Session transcript" aria-busy={running}>
      {live.truncated && <RecoveryNotice onLoad={onRefresh} onError={onError} />}
      {loading && <div className="transcript-loading"><LoaderCircle className="spin" /> Loading session history…</div>}
      {!loading && !thread.turns.length && <div className="empty-chat"><h2>Waiting for the first message</h2><p>Type a task below. The session keeps running on this host if you close the tab.</p></div>}
      {thread.turns.map((turn) => <TurnView key={turn.id} turn={turn} thread={thread} liveToolOutput={live.toolOutput} />)}
      {withKeys(immediateItems).map(({ item, key }) => <ItemView key={key} item={item} thread={thread} liveOutput={item.id ? live.toolOutput[item.id] : undefined} />)}
      {streamingText.map(([id, value]) => value && <div className="message agent live" key={id}><div className="message-avatar"><ProviderIcon thread={thread} size={16} /></div><div className="message-body"><div className="message-meta">{providerName} <span>working now</span></div><Markdown>{value}</Markdown><span className="typing-cursor" /></div></div>)}
      {running && !streamingText.some(([, value]) => Boolean(value)) && <div className="thinking-line"><LoaderCircle className="spin" size={17} /><span>{providerName} is working</span><i /><i /><i /></div>}
    </div>
    <AutoFollowIndicator isFollowing={autoFollow.isFollowing} unseenCount={autoFollow.unseenCount} onJump={autoFollow.jumpToLatest} />
    </div>
    <div className="composer-zone">
      {thread.policyWarnings && thread.policyWarnings.length > 0 && <div className="policy-warning-banner" role="status"><AlertTriangle size={15} /><div><strong>Policy warning</strong>{thread.policyWarnings.map((warning) => <span key={warning}>{warning}</span>)}</div></div>}
      {thread.goal && <GoalBar thread={thread} onRefresh={onRefresh} onError={onError} />}
      {live.queue.length > 0 && <div className="queue-strip"><div><ListPlus size={14} /><strong>{live.queue.length} queued</strong><span>Runs automatically after the current turn</span></div><div>{live.queue.map((entry, index) => <div className="queue-entry" key={entry.id}><b>{index + 1}</b><span>{entry.text}</span><button onClick={() => void api(`/api/threads/${thread.id}/queue/${entry.id}`, { method: "DELETE" }).catch(onError)} aria-label={`Remove queued task ${index + 1}`}><X size={13} /></button></div>)}</div></div>}
      <form className="composer" onSubmit={submit}>
        <ComposerAssist suggestions={assist.suggestions} activeIndex={assist.activeIndex} onChoose={assist.choose} />
        <label className="sr-only" htmlFor={`composer-${thread.id}`}>Task for {providerName}</label>
        <textarea id={`composer-${thread.id}`} value={text} onChange={(event) => setText(event.target.value)} placeholder={running ? `Queue the next task while ${providerName} works…` : `Give ${providerName} a task…`} rows={3} onKeyDown={(event) => { if (assist.onKeyDown(event)) return; if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <div className="composer-footer"><div className="model-controls">
          <label><ProviderIcon thread={thread} size={14} /><span className="sr-only">Model</span><select value={settings.model} disabled={claude || spark} onChange={(event) => changeModel(event.target.value)}>{claude ? claudeModels.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>) : spark ? <option value="gpt-5.3-codex-spark">GPT-5.3 Codex Spark</option> : models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}</select></label>
          <label><BrainCircuit size={14} /><span className="sr-only">Reasoning effort</span><select value={settings.effort} disabled={spark} onChange={(event) => onSettings({ ...settings, effort: event.target.value })}>{effortOptions.map((effort) => <option key={effort} value={effort}>{EFFORT_LABELS[effort] || effort}</option>)}</select></label>
          <PolicyButton thread={thread} running={running} onRefresh={onRefresh} onError={onError} />
        </div><div className="composer-actions">{running && <button type="button" className="stop-button" onClick={() => onSessionAction("stop")}><CircleStop size={16} /> Stop</button>}<button className={`send-button ${running ? "queue" : ""}`} disabled={!text.trim() || sending || !settingsValid}>{sending ? <LoaderCircle className="spin" size={17} /> : running ? <ListPlus size={16} /> : <Send size={16} />}<span>{running ? "Queue" : "Send"}</span></button></div></div>
        {!settingsValid && <p className="form-error" role="alert">The saved model or effort is no longer available. Choose a supported replacement before sending.</p>}
      </form>
      <p className="persistence-note"><Server size={12} />Safe to close this tab — work continues on the host.</p>
    </div>
  </div>;
});

export function CompactItem({ item, thread, liveOutput }: { item: ThreadItem; thread: Thread; liveOutput?: string }) {
  const providerName = providerLabel(thread);
  if (item.type === "userMessage") return <div className="compact-message user"><div>{userText(item)}</div><span>YOU</span></div>;
  if (item.type === "agentMessage") return <div className="compact-message agent"><span><ProviderIcon thread={thread} size={12} /></span><div><Markdown>{item.text || ""}</Markdown></div></div>;
  if (item.type === "reasoning") return <details className="compact-reasoning"><summary><BrainCircuit size={12} />Reasoning</summary><p>{item.summary?.join("\n")}</p></details>;
  if (item.type === "plan") return <div className="compact-tool plan"><LayoutGrid size={13} /><span><strong>Plan updated</strong><small>{truncate(item.text || "", 140)}</small></span></div>;
  if (item.type === "commandExecution") return <details className={`compact-tool ${item.status || ""}`} open={item.status === "inProgress"}><summary><TerminalSquare size={13} /><span><strong>Command</strong><small>{item.command}</small></span><em>{item.status}</em></summary>{(item.aggregatedOutput || liveOutput) && <pre>{truncate(item.aggregatedOutput || liveOutput || "", 20_000)}</pre>}</details>;
  if (item.type === "fileChange") return <details className={`compact-tool ${item.status || ""}`} open><summary><Code2 size={13} /><span><strong>File changes</strong><small>{item.changes?.length || 0} updates</small></span><em>{item.status}</em></summary><DiffView changes={item.changes || []} compact /></details>;
  return <details className={`compact-tool ${String(item.status || "completed")}`}><summary><Command size={13} /><span><strong>{item.tool ? String(item.tool) : toolLabel(item.type)}</strong><small>{item.server ? String(item.server) : `${providerName} tool`}</small></span><em>{String(item.status || "completed")}</em></summary><pre>{safeJson(item.result || item.error || item.arguments || item)}</pre></details>;
}

export function PolicyButton({ thread, running, onRefresh, onError, compact = false }: { thread: Thread; running: boolean; onRefresh: () => void | Promise<unknown>; onError: (error: unknown) => void; compact?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  if (thread.backend === "claude") {
    const mode = thread.claudePermissionMode || "default";
    return <button type="button" className={`policy-button ${mode === "bypassPermissions" ? "yolo" : "workspace"} ${compact ? "compact" : ""}`} disabled aria-label={`Claude permission mode: ${mode}`}><ShieldCheck size={compact ? 11 : 13} /><span>{mode === "plan" ? "PLAN" : mode === "bypassPermissions" ? "YOLO" : mode === "acceptEdits" ? "EDITS" : compact ? "SAFE" : "Workspace"}</span></button>;
  }
  const yolo = thread.policy === "yolo";
  const updatePolicy = async (nextYolo: boolean) => {
    if (running || pending) return;
    setPending(true);
    try {
      await api(`/api/threads/${thread.id}/policy`, { method: "PATCH", body: JSON.stringify({ yolo: nextYolo }) });
      await onRefresh();
      setConfirming(false);
    } catch (error) { onError(error); }
    finally { setPending(false); }
  };
  return <>
    <button type="button" className={`policy-button ${yolo ? "yolo" : "workspace"} ${compact ? "compact" : ""}`} disabled={running || pending} onClick={() => { if (yolo) void updatePolicy(false); else setConfirming(true); }} aria-label={yolo ? "Switch to workspace-write permissions" : "Enable YOLO permissions"}><ShieldCheck size={compact ? 11 : 13} /><span>{yolo ? "YOLO" : compact ? "SAFE" : "Workspace"}</span></button>
    {confirming && <PermissionConfirmation pending={pending} onConfirm={() => void updatePolicy(true)} onClose={() => setConfirming(false)} />}
  </>;
}

function PermissionConfirmation({ pending, onConfirm, onClose }: { pending: boolean; onConfirm: () => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pendingRef.current) onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); previouslyFocused?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onClose(); }}>
    <div ref={dialogRef} className="permission-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="permission-confirm-title" aria-describedby="permission-confirm-description">
      <ShieldCheck size={23} /><h2 id="permission-confirm-title">Enable YOLO permissions?</h2>
      <p id="permission-confirm-description">Future turns in this session will have full system access and run without approval prompts.</p>
      <div><button ref={cancelRef} type="button" className="secondary-button" disabled={pending} onClick={onClose}>Cancel</button><button type="button" className="primary-button danger" disabled={pending} onClick={onConfirm}>{pending ? <LoaderCircle className="spin" size={14} /> : null}Enable YOLO</button></div>
    </div>
  </div>;
}

const TurnView = memo(function TurnView({ turn, thread, liveToolOutput }: { turn: Thread["turns"][number]; thread: Thread; liveToolOutput: Readonly<Record<string, string>> }) {
  return <div className={`turn ${turn.status}`}>{withKeys(turn.items).map(({ item, key }) => <ItemView key={key} item={item} thread={thread} liveOutput={item.id ? liveToolOutput[item.id] : undefined} />)}{turn.status === "failed" && <div className="turn-error">{turn.error?.message || "This turn failed."}</div>}</div>;
}, (previous, next) => previous.turn === next.turn && previous.thread === next.thread
  && previous.turn.items.every((item) => !item.id || previous.liveToolOutput[item.id] === next.liveToolOutput[item.id]));

const ItemView = memo(function ItemView({ item, thread, liveOutput }: { item: ThreadItem; thread: Thread; liveOutput?: string }) {
  const providerName = providerLabel(thread);
  if (item.type === "userMessage") return <div className="message user"><div className="message-body"><div className="message-meta">You</div><p>{userText(item)}</p></div><div className="message-avatar">YOU</div></div>;
  if (item.type === "agentMessage") return <div className="message agent"><div className="message-avatar"><ProviderIcon thread={thread} size={16} /></div><div className="message-body"><div className="message-meta">{providerName}</div><Markdown>{item.text || ""}</Markdown></div></div>;
  if (item.type === "reasoning") return <details className="reasoning-item"><summary><BrainCircuit size={15} />Reasoning <ChevronRight size={14} /></summary><div>{item.summary?.map((part, index) => <Markdown key={index}>{part}</Markdown>)}</div></details>;
  if (item.type === "commandExecution") return <details className="tool-item" open={item.status === "inProgress"}><summary><TerminalSquare size={15} /><span><strong>Command</strong><code>{item.command}</code></span><em className={item.status}>{item.status}</em></summary>{(item.aggregatedOutput || liveOutput) && <pre>{truncate(item.aggregatedOutput || liveOutput || "", 100_000)}</pre>}</details>;
  if (item.type === "fileChange") return <details className="tool-item" open><summary><Code2 size={15} /><span><strong>Files changed</strong><code>{item.changes?.length || 0} updates</code></span><em className={item.status}>{item.status}</em></summary><DiffView changes={item.changes || []} /></details>;
  if (item.type === "plan") return <div className="plan-item"><LayoutGrid size={15} /><Markdown>{item.text || ""}</Markdown></div>;
  if (["contextCompaction", "enteredReviewMode", "exitedReviewMode"].includes(item.type)) return null;
  return <details className="tool-item generic-tool"><summary><Sparkles size={15} /><span><strong>{item.tool ? String(item.tool) : toolLabel(item.type)}</strong><code>{item.server ? String(item.server) : `${providerName} activity`}</code></span><em className={String(item.status || "completed")}>{String(item.status || "completed")}</em></summary><pre>{safeJson(item.result || item.error || item.arguments || item)}</pre></details>;
});

function DiffView({ changes, compact = false }: { changes: Array<Record<string, unknown>>; compact?: boolean }) {
  return <div className={`diff-view ${compact ? "compact" : ""}`}>{changes.map((change, index) => {
    const path = String(change.path || change.file || `File ${index + 1}`);
    const diff = String(change.diff || change.unified_diff || "");
    const lines = diff.split("\n");
    const additions = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
    const deletions = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
    const visible = lines.slice(0, compact ? 120 : 400);
    return <section className="diff-file" key={`${path}-${index}`}><header><Code2 size={12} /><strong>{path}</strong><em><b>+{additions}</b><i>-{deletions}</i></em></header>{diff ? <pre>{visible.map((line, lineIndex) => <span className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "remove" : line.startsWith("@@") ? "hunk" : "context"} key={lineIndex}>{line || " "}</span>)}{visible.length < lines.length && <span>… {lines.length - visible.length} more lines</span>}</pre> : <div className="diff-empty">Diff content unavailable</div>}</section>;
  })}</div>;
}

function GoalBar({ thread, onRefresh, onError }: { thread: Thread; onRefresh: () => Promise<unknown>; onError: (error: unknown) => void }) {
  const goal = thread.goal!;
  const run = async (args: string) => { try { await api(`/api/threads/${thread.id}/command`, { method: "POST", body: JSON.stringify({ command: "goal", args }) }); await onRefresh(); } catch (error) { onError(error); } };
  return <div className={`goal-bar ${goal.status}`}><span className="goal-icon"><Target size={14} /></span><div><span><strong>Goal</strong><em>{goal.status}</em></span><p>{goal.objective}</p></div><div className="goal-actions"><button type="button" onClick={() => void run(goal.status === "paused" ? "resume" : "pause")} aria-label={goal.status === "paused" ? "Resume goal" : "Pause goal"}>{goal.status === "paused" ? <Play size={13} /> : <Pause size={13} />}</button><button type="button" onClick={() => { const objective = window.prompt("Goal objective", goal.objective); if (objective?.trim()) void run(objective.trim()); }} aria-label="Edit goal"><Settings2 size={13} /></button><button type="button" onClick={() => void run("clear")} aria-label="Clear goal"><X size={13} /></button></div></div>;
}

export function useComposerAssist(text: string, setText: (value: string) => void, cwd: string) {
  const [files, setFiles] = useState<AssistSuggestion[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const slashMatch = text.match(/^\/([^\s]*)$/);
  const mentionMatch = text.match(/(?:^|\s)@([^\s@]*)$/);
  const mentionQuery = mentionMatch?.[1];
  useEffect(() => {
    if (mentionQuery === undefined) { setFiles([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<{ data: Array<{ name: string; relativePath: string; type: "file" | "directory" }> }>(`/api/files?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(mentionQuery)}`, { signal: controller.signal })
        .then((response) => setFiles(response.data.map((entry) => ({ id: `${entry.type}:${entry.relativePath}`, label: entry.relativePath, description: entry.type, insert: entry.relativePath, kind: entry.type }))))
        .catch((error) => { if (error.name !== "AbortError") setFiles([]); });
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [cwd, mentionQuery]);
  const suggestions = useMemo(() => dismissedFor === text ? [] : slashMatch ? SLASH_COMMANDS.filter((item) => item.id.startsWith(slashMatch[1].toLowerCase())) : mentionMatch ? files : [], [dismissedFor, files, mentionMatch, slashMatch, text]);
  useEffect(() => setActiveIndex(0), [suggestions.length, text]);
  const choose = (suggestion: AssistSuggestion) => { setText(suggestion.kind === "command" ? suggestion.insert : text.replace(/(^|\s)@[^\s@]*$/, `$1@${suggestion.insert}${suggestion.kind === "directory" ? "/" : " "}`)); setDismissedFor(null); };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!suggestions.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length); return true; }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) { event.preventDefault(); choose(suggestions[activeIndex] || suggestions[0]); return true; }
    if (event.key === "Escape") { event.preventDefault(); setDismissedFor(text); return true; }
    return false;
  };
  return { suggestions, activeIndex, choose, onKeyDown };
}

export function ComposerAssist({ suggestions, activeIndex, onChoose, compact = false }: { suggestions: AssistSuggestion[]; activeIndex: number; onChoose: (suggestion: AssistSuggestion) => void; compact?: boolean }) {
  if (!suggestions.length) return null;
  return <div className={`composer-assist ${compact ? "compact" : ""}`}>{suggestions.slice(0, compact ? 6 : 10).map((suggestion, index) => <button type="button" className={index === activeIndex ? "active" : ""} key={suggestion.id} onMouseDown={(event) => event.preventDefault()} onClick={() => onChoose(suggestion)}><span>{suggestion.kind === "command" ? <Command size={13} /> : suggestion.kind === "directory" ? <Folder size={13} /> : <Code2 size={13} />}</span><strong>{suggestion.label}</strong><small>{suggestion.description}</small><kbd>{index === activeIndex ? "Tab" : ""}</kbd></button>)}</div>;
}

export async function executeComposerText(thread: Thread, outgoing: string, settings: SessionSettings, running: boolean): Promise<{ sent: boolean; replacement: string }> {
  const slash = parseSlashCommand(outgoing);
  if (slash?.command === "mention") return { sent: false, replacement: "@" };
  if (slash) return { sent: await executeSlashCommand(thread, slash), replacement: outgoing };
  await api(`/api/threads/${thread.id}/${running ? "queue" : "messages"}`, {
    method: "POST",
    body: JSON.stringify({ text: outgoing, model: settings.model, reasoningEffort: settings.effort })
  });
  return { sent: true, replacement: "" };
}

function Markdown({ children }: { children: string }) { return <Suspense fallback={<span>{children}</span>}><LazyReactMarkdown urlTransform={safeMarkdownUrl}>{children}</LazyReactMarkdown></Suspense>; }
function safeMarkdownUrl(value: string) { const normalized = value.trim().replace(/[\u0000-\u001F\u007F\s]/g, ""); const scheme = /^([a-z][a-z\d+.-]*):/i.exec(normalized)?.[1]?.toLowerCase(); return scheme && !SAFE_PROTOCOLS.has(scheme) ? "" : value; }
function ProviderIcon({ thread, size }: { thread: Thread; size: number }) { return thread.backend === "claude" ? <BrainCircuit size={size} color="var(--color-provider-claude)" /> : thread.sessionClass === "spark" ? <Sparkles size={size} color="var(--color-provider-spark)" /> : <Bot size={size} color="var(--color-provider-codex)" />; }
function providerLabel(thread: Thread) { return thread.backend === "claude" ? "Claude" : thread.sessionClass === "spark" ? "Spark" : "Codex"; }
function parseSlashCommand(value: string) { const match = value.match(/^\/([a-z-]+)(?:\s+([\s\S]+))?$/i); return match ? { command: match[1].toLowerCase(), args: match[2]?.trim() || null } : null; }
async function executeSlashCommand(thread: Thread, slash: { command: string; args: string | null }) { let args = slash.args; if (slash.command === "goal" && (!args || args === "set")) { const objective = window.prompt("Goal objective", thread.goal?.objective || ""); if (!objective?.trim()) return false; args = objective.trim(); } await api(`/api/threads/${thread.id}/command`, { method: "POST", body: JSON.stringify({ ...slash, args }) }); return true; }
function userText(item: ThreadItem) { return item.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") || ""; }
function toolLabel(type: string) { return type.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase()); }
function truncate(value: string, limit: number) { return value.length > limit ? `${value.slice(0, limit)}\n…[output truncated]` : value; }
function safeJson(value: unknown) { try { return truncate(JSON.stringify(value, null, 2), 100_000); } catch { return "[unserializable output]"; } }
function withKeys(items: ThreadItem[]) { const counts = new Map<string, number>(); return items.map((item) => { const fingerprint = item.id || `${item.type}:${item.text || item.command || ""}`; const count = counts.get(fingerprint) || 0; counts.set(fingerprint, count + 1); return { item, key: `${fingerprint}:${count}` }; }); }
function messageFingerprint(item: ThreadItem) { return item.type === "agentMessage" ? `agent:${(item.text || "").trim()}` : item.type === "userMessage" ? `user:${userText(item).trim()}` : null; }
function unseenLiveItems(history: ThreadItem[], live: ThreadItem[]) { const ids = new Set(history.map((item) => item.id).filter(Boolean)); const fingerprints = new Set(history.map(messageFingerprint).filter(Boolean)); return live.filter((item) => !(item.id && ids.has(item.id)) && !fingerprints.has(messageFingerprint(item))); }
