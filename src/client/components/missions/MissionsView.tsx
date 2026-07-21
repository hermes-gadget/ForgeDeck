import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowRight, CheckCircle2, Circle, GitBranch, LoaderCircle, PauseCircle, Pencil, Play, Plus, RefreshCw, Save, Trash2, X, XCircle
} from "lucide-react";
import { api } from "../../api/client";
import type { AgentBlueprintManifest, Mission, MissionNodeRun } from "../../types";

type MissionsViewProps = { onError: (error: unknown) => void };

type EditorNode = {
  key: string;
  id: string;
  name: string;
  blueprintId: string;
  blueprintVersion: number | null;
  dependsOn: string;
  inputMapping: string;
  outputMapping: string;
};

export function MissionsHeader() {
  return <div className="control-header mission-header">
    <div className="control-header-icon"><GitBranch size={18} /></div>
    <div><strong>Mission graphs</strong><span>Versioned, sequential agent workflows</span></div>
  </div>;
}

export function MissionsView({ onError }: MissionsViewProps) {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [blueprints, setBlueprints] = useState<AgentBlueprintManifest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState("");
  const [editorId, setEditorId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nodes, setNodes] = useState<EditorNode[]>([]);
  const [runInputs, setRunInputs] = useState("{}");
  const [workspace, setWorkspace] = useState("");

  const selected = useMemo(
    () => missions.find((mission) => mission.id === selectedId) || missions[0] || null,
    [missions, selectedId]
  );

  const load = useCallback(async (signal?: AbortSignal, quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true);
    try {
      const [missionResponse, blueprintResponse] = await Promise.all([
        api<{ data: Mission[] }>("/api/missions", { signal }),
        api<{ data: AgentBlueprintManifest[] }>("/api/blueprints?limit=200", { signal })
      ]);
      setMissions(missionResponse.data);
      setBlueprints(blueprintResponse.data);
      setSelectedId((current) => current && missionResponse.data.some((mission) => mission.id === current)
        ? current
        : missionResponse.data[0]?.id || null);
      setMessage("");
    } catch (error) {
      if ((error as { name?: unknown })?.name !== "AbortError") {
        setMessage(error instanceof Error ? error.message : "Missions could not be loaded.");
        onError(error);
      }
    } finally {
      quiet ? setRefreshing(false) : setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const hasActiveRun = missions.some((mission) => mission.latestRun && (mission.state === "pending" || mission.state === "running"));
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = window.setInterval(() => void load(undefined, true), 1_500);
    return () => clearInterval(timer);
  }, [hasActiveRun, load]);

  const defaultNode = useCallback((index: number): EditorNode => {
    const blueprint = blueprints[0];
    return editorNodeFromBlueprint(blueprint, index);
  }, [blueprints]);

  const beginCreate = () => {
    setEditorId(null);
    setName("");
    setDescription("");
    setNodes([defaultNode(0)]);
    setMessage("");
    setEditorOpen(true);
  };

  const beginVersion = (mission: Mission) => {
    setEditorId(mission.id);
    setName(mission.name);
    setDescription(mission.description);
    setNodes(mission.nodes.map((node) => ({
      key: crypto.randomUUID(),
      id: node.id,
      name: node.name,
      blueprintId: node.blueprintId,
      blueprintVersion: node.blueprintVersion,
      dependsOn: node.dependsOn.join(", "),
      inputMapping: JSON.stringify(node.inputMapping, null, 2),
      outputMapping: JSON.stringify(node.outputMapping, null, 2)
    })));
    setMessage("");
    setEditorOpen(true);
  };

  const closeEditor = () => {
    if (saving) return;
    setEditorOpen(false);
    setNodes([]);
  };

  const updateNode = (key: string, update: Partial<EditorNode>) => {
    setNodes((current) => current.map((node) => node.key === key ? { ...node, ...update } : node));
  };

  const chooseBlueprint = (key: string, blueprintId: string) => {
    const blueprint = blueprints.find((candidate) => candidate.id === blueprintId);
    setNodes((current) => current.map((node, index) => node.key === key
      ? { ...editorNodeFromBlueprint(blueprint, index), key, id: node.id, name: node.name }
      : node));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage("");
    try {
      const payload = {
        ...(editorId ? { id: editorId } : {}),
        name,
        description,
        nodes: nodes.map((node) => ({
          id: node.id,
          name: node.name || node.id,
          blueprintId: node.blueprintId,
          ...(node.blueprintVersion ? { blueprintVersion: node.blueprintVersion } : {}),
          dependsOn: node.dependsOn.split(",").map((value) => value.trim()).filter(Boolean),
          inputMapping: parseObject(node.inputMapping, `Input mapping for ${node.id || "node"}`),
          outputMapping: parseStringMap(node.outputMapping, `Output mapping for ${node.id || "node"}`)
        }))
      };
      const response = await api<{ mission: Mission }>("/api/missions", { method: "POST", body: JSON.stringify(payload) });
      await load(undefined, true);
      setSelectedId(response.mission.id);
      setEditorOpen(false);
      setNodes([]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Mission could not be saved.");
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  const run = async () => {
    if (!selected || running) return;
    setRunning(true);
    setMessage("");
    try {
      const inputs = parsePrimitiveMap(runInputs, "Mission inputs");
      const response = await api<{ mission: Mission }>(`/api/missions/${encodeURIComponent(selected.id)}/run`, {
        method: "POST",
        body: JSON.stringify({ inputs, ...(workspace.trim() ? { workspace: workspace.trim() } : {}) })
      });
      setMissions((current) => current.map((mission) => mission.id === response.mission.id ? response.mission : mission));
      setRunInputs("{}");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Mission could not be started.");
      onError(error);
    } finally {
      setRunning(false);
    }
  };

  const remove = async () => {
    if (!selected || deleting || !window.confirm(`Delete mission “${selected.name}” and its run history?`)) return;
    setDeleting(true);
    setMessage("");
    try {
      await api(`/api/missions/${encodeURIComponent(selected.id)}`, { method: "DELETE" });
      await load(undefined, true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Mission could not be deleted.");
      onError(error);
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return <div className="mission-view"><div className="mission-empty"><LoaderCircle className="spin" size={26} />Loading missions…</div></div>;

  return <div className="mission-view">
    <div className="mission-toolbar">
      <div><strong>Missions</strong><span>{missions.length} graph{missions.length === 1 ? "" : "s"}</span></div>
      <span>
        <button className="icon-button" onClick={() => void load(undefined, true)} disabled={refreshing} aria-label="Refresh missions"><RefreshCw className={refreshing ? "spin" : ""} size={15} /></button>
        <button className="mission-primary" onClick={beginCreate} disabled={!blueprints.length}><Plus size={15} />New mission</button>
      </span>
    </div>
    {message && <div className="mission-message" role="alert">{message}<button onClick={() => setMessage("")} aria-label="Dismiss error"><X size={14} /></button></div>}
    {!blueprints.length && <div className="mission-message">Create an agent blueprint before defining a mission.</div>}
    {editorOpen && <MissionEditor
      id={editorId}
      name={name}
      description={description}
      nodes={nodes}
      blueprints={blueprints}
      saving={saving}
      onName={setName}
      onDescription={setDescription}
      onNode={updateNode}
      onBlueprint={chooseBlueprint}
      onAdd={() => setNodes((current) => [...current, defaultNode(current.length)])}
      onRemove={(key) => setNodes((current) => current.filter((node) => node.key !== key))}
      onClose={closeEditor}
      onSubmit={submit}
    />}
    <div className="mission-layout">
      <nav className="mission-list" aria-label="Missions">
        {missions.map((mission) => <button key={mission.id} className={mission.id === selected?.id ? "selected" : ""} onClick={() => setSelectedId(mission.id)}>
          <MissionStateIcon state={mission.state} />
          <span><strong>{mission.name}</strong><small>v{mission.version} · {mission.nodes.length} node{mission.nodes.length === 1 ? "" : "s"}</small></span>
          <em className={`mission-state ${mission.state}`}>{mission.state}</em>
        </button>)}
        {!missions.length && <div className="mission-empty compact"><GitBranch size={26} /><strong>No missions yet</strong><span>Define a DAG from your agent blueprints.</span></div>}
      </nav>
      {selected ? <section className="mission-detail">
        <header>
          <div><span className={`mission-state ${selected.state}`}>{selected.state}</span><h2>{selected.name}</h2><small>Version {selected.version}</small></div>
          <span>
            <button onClick={() => beginVersion(selected)} disabled={selected.state === "running" || Boolean(selected.latestRun && selected.state === "pending")}><Pencil size={14} />New version</button>
            <button className="danger" onClick={() => void remove()} disabled={deleting || selected.state === "running" || Boolean(selected.latestRun && selected.state === "pending")}>{deleting ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}Delete</button>
          </span>
        </header>
        {selected.description && <p className="mission-description">{selected.description}</p>}
        <MissionProgress mission={selected} />
        <MissionGraph mission={selected} />
        <div className="mission-run-form">
          <label><span>Mission inputs <small>JSON values referenced by mission mappings</small></span><textarea value={runInputs} onChange={(event) => setRunInputs(event.target.value)} spellCheck={false} /></label>
          <label><span>Workspace <small>Optional default for current-workspace blueprints</small></span><input value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="/absolute/path/to/workspace" /></label>
          <button onClick={() => void run()} disabled={running || selected.state === "running" || Boolean(selected.latestRun && selected.state === "pending")}>{running ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}Run mission</button>
        </div>
      </section> : <section className="mission-detail empty"><GitBranch size={34} /><h2>Select or create a mission</h2></section>}
    </div>
  </div>;
}

function MissionEditor({ id, name, description, nodes, blueprints, saving, onName, onDescription, onNode, onBlueprint, onAdd, onRemove, onClose, onSubmit }: {
  id: string | null;
  name: string;
  description: string;
  nodes: EditorNode[];
  blueprints: AgentBlueprintManifest[];
  saving: boolean;
  onName: (value: string) => void;
  onDescription: (value: string) => void;
  onNode: (key: string, update: Partial<EditorNode>) => void;
  onBlueprint: (key: string, blueprintId: string) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return <form className="mission-editor" onSubmit={onSubmit}>
    <header><div><strong>{id ? "Create mission version" : "Define mission"}</strong><span>{id ? `A new immutable version of ${id}` : "Add nodes in a valid dependency order"}</span></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close mission editor"><X size={16} /></button></header>
    <div className="mission-fields">
      <label><span>Name</span><input value={name} onChange={(event) => onName(event.target.value)} maxLength={100} required /></label>
      <label><span>Description</span><input value={description} onChange={(event) => onDescription(event.target.value)} maxLength={1_000} /></label>
    </div>
    <div className="mission-node-editor">
      {nodes.map((node, index) => <fieldset key={node.key}>
        <legend><span>Node {index + 1}</span><button type="button" onClick={() => onRemove(node.key)} disabled={nodes.length === 1} aria-label={`Remove node ${index + 1}`}><Trash2 size={13} /></button></legend>
        <label><span>Node ID</span><input value={node.id} onChange={(event) => onNode(node.key, { id: event.target.value })} placeholder={`node_${index + 1}`} required /></label>
        <label><span>Label</span><input value={node.name} onChange={(event) => onNode(node.key, { name: event.target.value })} placeholder="Human-readable label" /></label>
        <label><span>Blueprint</span><select value={node.blueprintId} onChange={(event) => onBlueprint(node.key, event.target.value)} required>{blueprints.map((blueprint) => <option key={blueprint.id} value={blueprint.id}>{blueprint.name} · v{blueprint.version}</option>)}</select></label>
        <label><span>Depends on <small>Comma-separated node IDs</small></span><input value={node.dependsOn} onChange={(event) => onNode(node.key, { dependsOn: event.target.value })} placeholder="analyze, test" /></label>
        <label className="mission-code-field"><span>Input mapping <small>Blueprint variable → value source</small></span><textarea value={node.inputMapping} onChange={(event) => onNode(node.key, { inputMapping: event.target.value })} spellCheck={false} /></label>
        <label className="mission-code-field"><span>Output mapping <small>Name → text, threadId, or artifacts path</small></span><textarea value={node.outputMapping} onChange={(event) => onNode(node.key, { outputMapping: event.target.value })} spellCheck={false} /></label>
      </fieldset>)}
    </div>
    <footer><button type="button" onClick={onAdd}><Plus size={14} />Add node</button><span><button type="button" onClick={onClose}>Cancel</button><button className="mission-primary" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}{id ? "Create version" : "Save mission"}</button></span></footer>
  </form>;
}

function MissionProgress({ mission }: { mission: Mission }) {
  const run = mission.latestRun;
  if (!run) return <div className="mission-progress"><span><Circle size={14} /><strong>Not run</strong></span><small>All nodes are pending.</small></div>;
  const completed = run.nodes.filter((node) => node.state === "completed").length;
  return <div className="mission-progress">
    <span><MissionStateIcon state={run.state} /><strong>{completed} of {run.nodes.length} nodes complete</strong></span>
    <progress max={Math.max(1, run.nodes.length)} value={completed} aria-label={`${completed} of ${run.nodes.length} mission nodes complete`} />
    <small>{run.error || `Run ${run.id.slice(0, 8)} · updated ${relativeTime(run.updatedAt)}`}</small>
  </div>;
}

function MissionGraph({ mission }: { mission: Mission }) {
  const runByNode = new Map((mission.latestRun?.nodes || []).map((node) => [node.nodeId, node]));
  return <div className="mission-graph" aria-label={`${mission.name} dependency graph`}>
    {mission.nodes.map((node) => {
      const run = runByNode.get(node.id);
      return <div className="mission-graph-step" key={node.id}>
        {node.dependsOn.length > 0 && <div className="mission-edges">{node.dependsOn.map((dependency) => <span key={dependency}><code>{dependency}</code><i /><ArrowRight size={13} /><code>{node.id}</code></span>)}</div>}
        <article className={run?.state || "pending"}>
          <MissionNodeStateIcon state={run?.state || "pending"} />
          <div><strong>{node.name}</strong><span><code>{node.id}</code> · {node.blueprintId} v{node.blueprintVersion}</span></div>
          <em>{run?.state || "pending"}</em>
          {run?.threadId && <small title={run.threadId}>session {run.threadId.slice(0, 16)}</small>}
          {run?.error && <small className="error">{run.error}</small>}
        </article>
      </div>;
    })}
  </div>;
}

function MissionStateIcon({ state }: { state: Mission["state"] }) {
  if (state === "running" || state === "pending") return <LoaderCircle className={state === "running" ? "spin" : ""} size={15} />;
  if (state === "completed") return <CheckCircle2 size={15} />;
  if (state === "failed") return <XCircle size={15} />;
  return <PauseCircle size={15} />;
}

function MissionNodeStateIcon({ state }: { state: MissionNodeRun["state"] }) {
  if (state === "running") return <LoaderCircle className="spin" size={17} />;
  if (state === "completed") return <CheckCircle2 size={17} />;
  if (state === "failed") return <XCircle size={17} />;
  return <Circle size={17} />;
}

function editorNodeFromBlueprint(blueprint: AgentBlueprintManifest | undefined, index: number): EditorNode {
  const inputMapping = Object.fromEntries((blueprint?.definition.variables || [])
    .filter((variable) => !variable.secret && variable.required && variable.default === undefined)
    .map((variable) => [variable.name, { source: "mission", key: variable.name.toLocaleLowerCase() }]));
  return {
    key: crypto.randomUUID(),
    id: `node_${index + 1}`,
    name: blueprint?.name || `Node ${index + 1}`,
    blueprintId: blueprint?.id || "",
    blueprintVersion: blueprint?.version || null,
    dependsOn: index > 0 ? `node_${index}` : "",
    inputMapping: JSON.stringify(inputMapping, null, 2),
    outputMapping: JSON.stringify({ text: "text" }, null, 2)
  };
}

function parseObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${label} must be valid JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

function parseStringMap(value: string, label: string): Record<string, string> {
  const parsed = parseObject(value, label);
  if (Object.values(parsed).some((candidate) => typeof candidate !== "string")) throw new Error(`${label} values must be strings`);
  return parsed as Record<string, string>;
}

function parsePrimitiveMap(value: string, label: string): Record<string, string | number | boolean> {
  const parsed = parseObject(value, label);
  if (Object.values(parsed).some((candidate) => !["string", "number", "boolean"].includes(typeof candidate))) {
    throw new Error(`${label} values must be strings, numbers, or booleans`);
  }
  return parsed as Record<string, string | number | boolean>;
}

function relativeTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  return `${Math.floor(elapsed / 3_600_000)}h ago`;
}
