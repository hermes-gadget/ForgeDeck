import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Bot, Check, ChevronRight, Copy, FileText, Folder, FolderOpen, History, LoaderCircle, LockKeyhole, ShieldCheck, Sparkles, X } from "lucide-react";
import { api, apiErrorFromPayload, ApiError } from "../../api/client";
import { readLaunchPreferences, rememberLaunch, type LastSessionSetup } from "../../state/preferences";
import { MODEL_PRESETS } from "../../../shared/contracts";
import type {
  AgentBlueprintManifest,
  BlueprintVariableValue,
  Bootstrap,
  ModelPreset,
  SessionSettings,
  Thread,
  ThreadSessionMetadata,
  WorkspaceLeaseMode,
  WorkspaceLeaseStatus
} from "../../types";

export type SessionClass = "standard" | "spark";
type SessionBackend = "codex";
type DirectoryResponse = {
  path: string | null;
  parent: string | null;
  leaseStatus?: WorkspaceLeaseStatus | null;
  entries: Array<{ name: string; path: string; leaseStatus?: WorkspaceLeaseStatus }>;
};
type SessionOperationResource = {
  id: string;
  status: "pending" | "running" | "compensating" | "retrying" | "succeeded" | "failed";
  result: { thread?: Thread; metadata?: ThreadSessionMetadata; sessionMetadata?: ThreadSessionMetadata } | null;
  error: unknown;
  links: { self: string };
};

const SPARK_MODEL = "gpt-5.3-codex-spark";
const EFFORT_LABELS: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum", ultra: "Ultra" };
const MODEL_PRESET_IDS: ModelPreset[] = ["quick", "balanced", "deep"];
const MODEL_PRESET_DESCRIPTIONS: Record<ModelPreset, string> = {
  quick: "Routine and lightweight work",
  balanced: "Everyday coding and analysis",
  deep: "Complex, reasoning-heavy tasks"
};

type NewSessionModalProps = {
  bootstrap: Bootstrap;
  sessionClass?: SessionClass;
  quickStart?: boolean;
  recentThreads?: Thread[];
  onClose: () => void;
  onCreated: (thread: Thread, requested: SessionSettings, sessionClass: SessionClass) => Promise<void>;
  onError: (error: unknown) => void;
};

const QUICK_START_PROMPT = "Explore this workspace, explain its structure, and suggest the three most useful next tasks. Do not make changes yet.";

export function NewSessionModal({ bootstrap, sessionClass = "standard", quickStart = false, recentThreads = [], onClose, onCreated, onError }: NewSessionModalProps) {
  const spark = sessionClass === "spark";
  const defaultModel = bootstrap.models.data.find((candidate) => candidate.isDefault) || bootstrap.models.data[0];
  const launchPreferences = useRef(readLaunchPreferences()).current;
  const historicalSetup = launchPreferences?.lastSession || sessionSetupFromThread(recentThreads[0]);
  const rememberedProvider: SessionBackend = "codex";
  const rememberedModel = validRememberedModel(historicalSetup, rememberedProvider, bootstrap)
    ? historicalSetup!.model
    : defaultModel?.model || "";
  const rememberedEffort = validRememberedEffort(rememberedModel, historicalSetup?.effort, bootstrap)
    ? historicalSetup!.effort
    : bootstrap.models.data.find((candidate) => candidate.model === rememberedModel)?.defaultReasoningEffort || "medium";
  const rememberedPreset = !spark && rememberedProvider === "codex" && validRememberedPreset(historicalSetup, bootstrap)
    ? historicalSetup!.preset || null
    : null;
  const initialWorkspace = useRef(launchPreferences?.lastWorkspace || historicalSetup?.workspace || recentThreads[0]?.cwd || null).current;
  const recentWorkspaces = mergeRecentWorkspaces(launchPreferences?.recentWorkspaces.map((item) => item.path) || [], recentThreads.map((thread) => thread.cwd));
  const dialogRef = useRef<HTMLFormElement>(null);
  const initialFocusRef = useRef<HTMLInputElement>(null);
  const browseController = useRef<AbortController | null>(null);
  const createRequestRef = useRef<{ body: string; idempotencyKey: string } | null>(null);
  const busyRef = useRef(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [prompt, setPrompt] = useState(quickStart ? QUICK_START_PROMPT : "");
  const backend: SessionBackend = "codex";
  const [model, setModel] = useState(spark ? SPARK_MODEL : rememberedModel);
  const [effort, setEffort] = useState(spark ? "high" : rememberedEffort);
  const [preset, setPreset] = useState<ModelPreset | null>(rememberedPreset);
  const [yolo, setYolo] = useState(false);
  const [leaseMode, setLeaseMode] = useState<WorkspaceLeaseMode>(quickStart ? "read-only" : "exclusive");
  const [browser, setBrowser] = useState<DirectoryResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [blueprints, setBlueprints] = useState<AgentBlueprintManifest[]>([]);
  const [blueprintSearch, setBlueprintSearch] = useState("");
  const [selectedBlueprintId, setSelectedBlueprintId] = useState("");
  const [blueprintEnvironment, setBlueprintEnvironment] = useState("local");
  const [blueprintVariables, setBlueprintVariables] = useState<Record<string, BlueprintVariableValue>>({});
  const [saveAsBlueprint, setSaveAsBlueprint] = useState(false);
  const [blueprintName, setBlueprintName] = useState("");
  const [busy, setBusy] = useState(false);
  busyRef.current = busy;
  const selectedCodexModel = bootstrap.models.data.find((candidate) => candidate.model === model);
  const effortOptions = spark ? ["high"] : selectedCodexModel?.supportedReasoningEfforts.map((option) => option.reasoningEffort) || [];
  const selectedBlueprint = blueprints.find((blueprint) => blueprint.id === selectedBlueprintId) || null;
  const validVariables = !selectedBlueprint || selectedBlueprint.definition.variables.every((variable) => {
    if (variable.secret || !variable.required || variable.default !== undefined) return true;
    const value = blueprintVariables[variable.name];
    return value !== undefined && value !== "";
  });
  const validSettings = Boolean(model && effort && effortOptions.includes(effort) && validVariables);

  const browse = useCallback(async (target?: string, quiet = false): Promise<boolean> => {
    browseController.current?.abort();
    const controller = new AbortController();
    browseController.current = controller;
    const query = target ? `?path=${encodeURIComponent(target)}` : "";
    try {
      const response = await api<DirectoryResponse>(`/api/directories${query}`, { signal: controller.signal });
      if (!controller.signal.aborted) setBrowser(response);
      return !controller.signal.aborted;
    } catch (error) {
      if ((error as Error).name !== "AbortError" && !quiet) onError(error);
      return false;
    }
  }, [onError]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const query = blueprintSearch ? `?search=${encodeURIComponent(blueprintSearch)}` : "";
      void api<{ data: AgentBlueprintManifest[] }>(`/api/blueprints${query}`, { signal: controller.signal })
        .then((response) => setBlueprints((current) => {
          const active = current.find((blueprint) => blueprint.id === selectedBlueprintId);
          return active && !response.data.some((blueprint) => blueprint.id === active.id) ? [active, ...response.data] : response.data;
        }))
        .catch((error) => { if ((error as Error).name !== "AbortError") onError(error); });
    }, blueprintSearch ? 180 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [blueprintSearch, onError, selectedBlueprintId]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initialFocusRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    void (async () => {
      if (initialWorkspace && await browse(initialWorkspace, true)) setSelectedPath(initialWorkspace);
      else await browse();
    })();
    return () => {
      browseController.current?.abort();
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [browse, initialWorkspace, onClose]);

  const chooseWorkspace = useCallback(async (path: string) => {
    setSelectedPath(null);
    if (await browse(path)) setSelectedPath(path);
  }, [browse]);

  const cloneLastSession = () => {
    if (!historicalSetup) return;
    const provider: SessionBackend = "codex";
    const nextModel = validRememberedModel(historicalSetup, provider, bootstrap)
      ? historicalSetup.model
      : defaultModel?.model || "";
    const nextEffort = validRememberedEffort(nextModel, historicalSetup.effort, bootstrap)
      ? historicalSetup.effort
      : bootstrap.models.data.find((candidate) => candidate.model === nextModel)?.defaultReasoningEffort || "medium";
    setModel(nextModel);
    setEffort(nextEffort);
    setPreset(provider === "codex" && validRememberedPreset(historicalSetup, bootstrap) ? historicalSetup.preset || null : null);
    setName(historicalSetup.name);
    setCategory(historicalSetup.category);
    setTags(historicalSetup.tags.join(", "));
    setPrompt("");
    setYolo(false);
    setLeaseMode("exclusive");
    setSelectedBlueprintId("");
    setBlueprintVariables({});
    void chooseWorkspace(historicalSetup.workspace);
  };

  const chooseLeaseMode = (next: WorkspaceLeaseMode) => {
    setLeaseMode(next);
    if (next === "read-only") {
      setYolo(false);
    }
  };

  const choosePreset = (next: ModelPreset | null) => {
    setPreset(next);
    if (!next) return;
    const target = MODEL_PRESETS[next];
    setModel(target.model);
    setEffort(target.effort);
  };

  const chooseBlueprint = (id: string) => {
    setSelectedBlueprintId(id);
    const blueprint = blueprints.find((candidate) => candidate.id === id);
    if (!blueprint) {
      setBlueprintVariables({});
      return;
    }
    const definition = blueprint.definition;
    setModel(definition.model.model);
    setEffort(definition.model.effort || "medium");
    setPreset(definition.model.preset || null);
    setPrompt(definition.promptTemplate);
    setYolo(definition.approvals.mode === "never");
    setBlueprintVariables(Object.fromEntries(definition.variables.flatMap((variable) => variable.default === undefined ? [] : [[variable.name, variable.default]])));
    if (definition.workspace.selector === "fixed" && definition.workspace.value) {
      setSelectedPath(definition.workspace.value);
      void browse(definition.workspace.value);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedPath || !validSettings) return;
    const requested = {
      model: spark ? SPARK_MODEL : model,
      reasoningEffort: spark ? "high" : effort,
      ...(!spark && preset ? { preset } : {})
    };
    setBusy(true);
    try {
      let blueprint = selectedBlueprint;
      if (saveAsBlueprint) {
        const approvalMode = yolo ? "never" : "on-request";
        const response = await api<{ blueprint: AgentBlueprintManifest }>("/api/blueprints", {
          method: "POST",
          body: JSON.stringify({
            name: blueprintName.trim() || name.trim() || prompt.trim().split("\n", 1)[0]?.slice(0, 100) || "Agent blueprint",
            description: category.trim() ? `Session blueprint for ${category.trim()}` : "",
            definition: {
              promptTemplate: prompt,
              role: selectedBlueprint?.definition.role || "Agent",
              workspace: { selector: "fixed", value: selectedPath },
              model: { backend: spark ? "codex" : backend, routing: "fixed", model: requested.model, effort: requested.reasoningEffort, ...(preset ? { preset } : {}) },
              tools: selectedBlueprint?.definition.tools || { enable: [], disable: [] },
              knowledge: selectedBlueprint?.definition.knowledge || [],
              completionGates: selectedBlueprint?.definition.completionGates || [],
              approvals: { mode: approvalMode, requiredFor: selectedBlueprint?.definition.approvals.requiredFor || [] },
              variables: selectedBlueprint?.definition.variables || []
            }
          })
        });
        blueprint = response.blueprint;
      }
      const requestBody = JSON.stringify({
        cwd: selectedPath, ...requested, name, category, leaseMode,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean), prompt,
        provider: spark ? "codex" : backend, sessionClass,
        ...(blueprint ? {
          blueprintId: blueprint.id,
          blueprintVersion: blueprint.version,
          blueprintEnvironment: blueprintEnvironment.trim() || "local",
          blueprintVariables
        } : {}),
        yolo
      });
      const previousRequest = createRequestRef.current;
      const idempotencyKey = previousRequest?.body === requestBody ? previousRequest.idempotencyKey : crypto.randomUUID();
      createRequestRef.current = { body: requestBody, idempotencyKey };
      const accepted = await api<{ operation: SessionOperationResource }>("/api/threads", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: requestBody
      });
      const operation = await waitForSessionOperation(accepted.operation);
      if (operation.status === "failed") {
        createRequestRef.current = null;
        throw apiErrorFromPayload(operation.error);
      }
      const result = operation.result;
      const thread = result?.thread;
      if (!thread) throw new Error("Session creation completed without a thread resource");
      const metadata = thread.sessionMetadata || thread.metadata || result?.sessionMetadata || result?.metadata;
      rememberLaunch({
        workspace: selectedPath,
        provider: spark ? "codex" : backend,
        model: requested.model,
        effort: requested.reasoningEffort,
        ...(!spark && preset ? { preset } : {}),
        name,
        category,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean)
      });
      await onCreated(
        metadata ? { ...thread, sessionMetadata: metadata } : thread,
        { model: requested.model, effort: requested.reasoningEffort },
        sessionClass
      );
      createRequestRef.current = null;
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) createRequestRef.current = null;
      onError(error);
    } finally {
      setBusy(false);
    }
  };

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form ref={dialogRef} className="new-modal" role="dialog" aria-modal="true" aria-labelledby="new-session-title" onSubmit={submit}>
      <div className="modal-header"><div><span className={`eyebrow ${spark ? "spark" : ""}`}>{spark ? "Spark session" : "New session"}</span><h2 id="new-session-title">{quickStart ? "Workspace tour" : spark ? "Launch a quick task" : "Launch settings"}</h2></div><div className="modal-header-actions">{historicalSetup && !spark && <button type="button" className="clone-session-button" onClick={cloneLastSession} title="Copy the last session's workspace, model, and organization"><Copy size={14} />Clone last session</button>}<button type="button" className="icon-button" onClick={onClose} aria-label="Close new session dialog"><X size={19} /></button></div></div>
      <div className="new-grid">
        <section className="directory-picker" aria-label="Workspace directory"><div className="section-label"><FolderOpen size={15} />Workspace directory</div>{recentWorkspaces.length > 0 && <div className="recent-workspaces"><span><History size={13} />Recent workspaces</span><div>{recentWorkspaces.map((path) => <button type="button" key={path} className={selectedPath === path ? "selected" : ""} onClick={() => void chooseWorkspace(path)} title={path}><Folder size={13} /><span>{workspaceName(path)}</span></button>)}</div></div>}<div className="path-bar"><button type="button" disabled={!browser?.parent} onClick={() => { if (browser?.parent) void browse(browser.parent); }} aria-label="Browse parent directory"><ArrowLeft size={15} /></button><span title={browser?.path || "Workspace roots"}>{browser?.path || "Available roots"}</span></div><div className="folder-list">{!browser && <LoaderCircle className="spin" />}{browser?.entries.map((entry) => <button type="button" key={entry.path} onClick={() => { setSelectedPath(entry.path); void browse(entry.path); }} className={selectedPath === entry.path ? "selected" : ""}><Folder size={16} /><span>{entry.name}</span>{entry.leaseStatus && entry.leaseStatus.state !== "available" && <em className={`directory-lease ${entry.leaseStatus.state}`}><LockKeyhole size={10} />{entry.leaseStatus.state}</em>}<ChevronRight size={15} /></button>)}{browser && !browser.entries.length && <div className="folder-empty">No child directories</div>}</div><button type="button" className={`select-directory ${browser?.path && selectedPath === browser.path ? "chosen" : ""}`} disabled={!browser?.path} onClick={() => setSelectedPath(browser!.path)}>{selectedPath === browser?.path ? <Check size={16} /> : <FolderOpen size={16} />}{selectedPath === browser?.path ? "Selected" : "Use this directory"}</button>{browser?.leaseStatus && browser.leaseStatus.state !== "available" && <small className={`workspace-lease-status ${browser.leaseStatus.state}`}><LockKeyhole size={11} />{browser.leaseStatus.state} lease held by {browser.leaseStatus.leases.length} session{browser.leaseStatus.leases.length === 1 ? "" : "s"}</small>}</section>
        <section className="launch-settings">
          <div className="blueprint-picker">
            <div className="section-label"><Bot size={15} />Agent blueprint <i>optional</i></div>
            <input value={blueprintSearch} onChange={(event) => setBlueprintSearch(event.target.value)} placeholder="Search local blueprints…" aria-label="Search agent blueprints" />
            <select value={selectedBlueprintId} onChange={(event) => chooseBlueprint(event.target.value)} aria-label="Agent blueprint">
              <option value="">Configure from scratch</option>
              {blueprints.map((blueprint) => <option key={blueprint.id} value={blueprint.id}>{blueprint.name} · v{blueprint.version}</option>)}
            </select>
            {selectedBlueprint && <small>{selectedBlueprint.description || `Immutable version ${selectedBlueprint.version}`}</small>}
          </div>
          <label className="field"><span>Session name <i>optional</i></span><input ref={initialFocusRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="Uses the first task line automatically" maxLength={100} /></label>
          <div className="organization-fields"><label className="field"><span>Category <i>optional</i></span><input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="e.g. Product" maxLength={50} /></label><label className="field"><span>Tags <i>comma-separated</i></span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="bug, release" /></label></div>
          <div className="field"><span>Workspace lease</span><div className="effort-grid"><button type="button" className={leaseMode === "exclusive" ? "selected" : ""} onClick={() => chooseLeaseMode("exclusive")} aria-pressed={leaseMode === "exclusive"}><LockKeyhole size={12} /> Exclusive editing</button><button type="button" className={leaseMode === "read-only" ? "selected" : ""} onClick={() => chooseLeaseMode("read-only")} aria-pressed={leaseMode === "read-only"}><FileText size={12} /> Read-only inspection</button></div><small>{leaseMode === "exclusive" ? "Blocks other sessions from using this workspace while the agent works." : "Can share the workspace with other read-only inspection sessions."}</small></div>
          {!spark && <div className="field model-preset-field"><span>Model preset <i>optional</i></span><div className="model-preset-grid" role="group" aria-label="Model preset"><button type="button" className={!preset ? "selected" : ""} onClick={() => choosePreset(null)} aria-pressed={!preset}><strong>Manual</strong><small>Choose model and effort below</small></button>{MODEL_PRESET_IDS.map((id) => { const target = MODEL_PRESETS[id]; const available = modelPresetAvailable(id, bootstrap); return <button type="button" key={id} disabled={!available} className={preset === id ? "selected" : ""} onClick={() => choosePreset(id)} aria-pressed={preset === id} title={available ? `${target.model} · ${target.effort}` : `${target.model} with ${target.effort} effort is unavailable`}><strong>{target.label}</strong><small>{MODEL_PRESET_DESCRIPTIONS[id]}</small><code>{target.model} · {EFFORT_LABELS[target.effort] || target.effort}</code></button>; })}</div><small>Presets are transparent fixed mappings; they do not route dynamically.</small></div>}
          <label className="field"><span>Model</span><select value={model} disabled={spark} onChange={(event) => { const nextModel = event.target.value; setPreset(null); setModel(nextModel); const next = bootstrap.models.data.find((candidate) => candidate.model === nextModel); if (next) setEffort(next.defaultReasoningEffort); }}>{spark ? <option value={SPARK_MODEL}>GPT-5.3 Codex Spark</option> : bootstrap.models.data.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>)}</select><small>{spark ? "Fast, lightweight Codex model locked for SparkBoard tasks." : selectedCodexModel?.description}</small></label>
          <div className="field"><span>Thinking amount</span><div className="effort-grid">{effortOptions.map((option) => <button type="button" key={option} className={effort === option ? "selected" : ""} onClick={() => { setPreset(null); setEffort(option); }} aria-pressed={effort === option}>{EFFORT_LABELS[option] || option}</button>)}</div>{!validSettings && <small role="alert">Choose a model and one of its supported reasoning levels.</small>}</div>
          <label className="field prompt-field"><span>First task <i>optional</i></span><textarea value={prompt} disabled={Boolean(selectedBlueprint)} onChange={(event) => setPrompt(event.target.value)} placeholder="Start the session with a task, or leave it waiting…" rows={4} />{selectedBlueprint && <small>The immutable blueprint template is resolved when the session launches.</small>}</label>
          {selectedBlueprint && <div className="blueprint-variables">
            <label className="field"><span>Environment</span><input value={blueprintEnvironment} onChange={(event) => setBlueprintEnvironment(event.target.value)} maxLength={100} placeholder="local" /></label>
            {selectedBlueprint.definition.variables.map((variable) => variable.secret
              ? <div className="blueprint-secret" key={variable.name}><ShieldCheck size={13} /><span>{variable.name}<small>Resolved at runtime from ${`{${variable.name}}`}; no credential is stored.</small></span></div>
              : variable.type === "boolean"
                ? <label className="blueprint-boolean" key={variable.name}><input type="checkbox" checked={Boolean(blueprintVariables[variable.name] ?? variable.default)} onChange={(event) => setBlueprintVariables((current) => ({ ...current, [variable.name]: event.target.checked }))} /><span>{variable.name}{variable.required ? " *" : ""}<small>{variable.description}</small></span></label>
                : <label className="field" key={variable.name}><span>{variable.name}{variable.required ? " *" : ""}</span><input type={variable.type === "number" ? "number" : "text"} value={String(blueprintVariables[variable.name] ?? variable.default ?? "")} onChange={(event) => setBlueprintVariables((current) => {
                  const next = { ...current };
                  if (!event.target.value) delete next[variable.name];
                  else next[variable.name] = variable.type === "number" ? Number(event.target.value) : event.target.value;
                  return next;
                })} /><small>{variable.description}</small></label>)}
          </div>}
          <div className="save-blueprint">
            <label><input type="checkbox" checked={saveAsBlueprint} onChange={(event) => setSaveAsBlueprint(event.target.checked)} /><span>Save these settings as a new blueprint</span></label>
            {saveAsBlueprint && <input value={blueprintName} onChange={(event) => setBlueprintName(event.target.value)} maxLength={100} placeholder="Blueprint name (uses session name if blank)" />}
          </div>
        </section>
      </div>
      <div className="modal-footer"><label className={`yolo-toggle ${yolo ? "enabled" : ""}`}><input type="checkbox" disabled={leaseMode === "read-only"} checked={yolo} onChange={(event) => setYolo(event.target.checked)} /><span className="toggle-track"><i /></span><span>{leaseMode === "read-only" ? "Read-only sandbox" : yolo ? "YOLO mode" : "Workspace-write sandbox"}<small>{leaseMode === "read-only" ? "Inspection only while the lease is active" : yolo ? "No approvals · full system access" : "Approvals appear in ForgeDeck"}</small></span></label><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!selectedPath || !validSettings || busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}Launch {spark ? "Spark session" : "session"}</button></div>
    </form>
  </div>;
}

function sessionSetupFromThread(thread?: Thread): LastSessionSetup | null {
  if (!thread?.cwd) return null;
  const metadata = thread.sessionMetadata || thread.metadata || thread.settings;
  const model = metadata?.model || thread.model || thread.blueprintModelConfiguration?.model;
  const effort = metadata?.reasoningEffort || metadata?.effort || thread.reasoningEffort || thread.effort || thread.blueprintModelConfiguration?.effort;
  const preset = metadata?.preset || thread.preset || thread.blueprintModelConfiguration?.preset || undefined;
  if (!model || !effort) return null;
  return {
    workspace: thread.cwd,
    provider: "codex",
    model,
    effort,
    ...(preset ? { preset } : {}),
    name: thread.name || "",
    category: thread.category || "",
    tags: thread.tags || []
  };
}

function validRememberedModel(setup: LastSessionSetup | null | undefined, provider: SessionBackend, bootstrap: Bootstrap): boolean {
  if (!setup || setup.provider !== provider) return false;
  return bootstrap.models.data.some((candidate) => candidate.model === setup.model);
}

function validRememberedEffort(model: string, effort: string | undefined, bootstrap: Bootstrap): boolean {
  if (!effort) return false;
  return bootstrap.models.data.find((candidate) => candidate.model === model)?.supportedReasoningEfforts.some((candidate) => candidate.reasoningEffort === effort) === true;
}

function validRememberedPreset(setup: LastSessionSetup | null | undefined, bootstrap: Bootstrap): boolean {
  if (!setup?.preset || setup.provider !== "codex") return false;
  const target = MODEL_PRESETS[setup.preset];
  return setup.model === target.model && setup.effort === target.effort && modelPresetAvailable(setup.preset, bootstrap);
}

function modelPresetAvailable(preset: ModelPreset, bootstrap: Bootstrap): boolean {
  const target = MODEL_PRESETS[preset];
  return bootstrap.models.data.find((candidate) => candidate.model === target.model)
    ?.supportedReasoningEfforts.some((candidate) => candidate.reasoningEffort === target.effort) === true;
}

function mergeRecentWorkspaces(remembered: string[], sessionWorkspaces: string[]): string[] {
  return [...new Set([...remembered, ...sessionWorkspaces].filter(Boolean))].slice(0, 5);
}

function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

async function waitForSessionOperation(initial: SessionOperationResource): Promise<SessionOperationResource> {
  let operation = initial;
  while (operation.status !== "succeeded" && operation.status !== "failed") {
    await new Promise((resolve) => setTimeout(resolve, 750));
    operation = (await api<{ operation: SessionOperationResource }>(operation.links.self, { timeoutMs: 30_000 })).operation;
  }
  return operation;
}
