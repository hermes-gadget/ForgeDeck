import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { CheckCircle2, FlaskConical, LoaderCircle, Play, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import { api } from "../../api/client";
import type { AgentBlueprintManifest, Bootstrap, EvalModel, EvalRequest, EvalRun } from "../../types";

type EvalLabProps = {
  bootstrap: Bootstrap;
  onOpenSession: (threadId: string) => void;
  onError: (error: unknown) => void;
};

export function EvalHeader() {
  return <div className="eval-header"><span><FlaskConical size={17} /></span><div><strong>Eval lab</strong><small>Versioned model and blueprint scoring</small></div></div>;
}

export function EvalLab({ bootstrap, onOpenSession, onError }: EvalLabProps) {
  const [evaluations, setEvaluations] = useState<EvalRun[]>([]);
  const [blueprints, setBlueprints] = useState<AgentBlueprintManifest[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const selected = evaluations.find((evaluation) => evalKey(evaluation) === selectedKey) || evaluations[0] || null;

  const refresh = useCallback(async () => {
    const response = await api<{ data: EvalRun[] }>("/api/evals?limit=200");
    setEvaluations(response.data);
    setSelectedKey((current) => current && response.data.some((evaluation) => evalKey(evaluation) === current)
      ? current
      : response.data[0] ? evalKey(response.data[0]) : null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void Promise.all([
      api<{ data: EvalRun[] }>("/api/evals?limit=200", { signal: controller.signal }),
      api<{ data: AgentBlueprintManifest[] }>("/api/blueprints?limit=200", { signal: controller.signal })
    ]).then(([evalResponse, blueprintResponse]) => {
      if (controller.signal.aborted) return;
      setEvaluations(evalResponse.data);
      setBlueprints(blueprintResponse.data);
      setSelectedKey(evalResponse.data[0] ? evalKey(evalResponse.data[0]) : null);
    }).catch((error) => { if (error.name !== "AbortError") onError(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [onError]);

  const running = evaluations.some((evaluation) => evaluation.status === "queued" || evaluation.status === "running");
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void refresh().catch(onError), 2_000);
    return () => clearInterval(timer);
  }, [onError, refresh, running]);

  const run = async (request: EvalRequest) => {
    setSaving(true);
    try {
      const response = await api<{ eval: EvalRun }>("/api/evals", { method: "POST", body: JSON.stringify(request) });
      setEvaluations((current) => [response.eval, ...current]);
      setSelectedKey(evalKey(response.eval));
      setFormOpen(false);
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  const rerun = () => {
    if (!selected) return;
    void run({
      evalId: selected.id,
      name: selected.name,
      blueprintId: selected.blueprint.id,
      blueprintVersion: selected.blueprint.version,
      variables: selected.variables,
      workspace: selected.workspace,
      models: selected.results.map((result) => result.model),
      successCriteria: selected.successCriteria
    });
  };

  return <div className="eval-lab">
    <div className="eval-toolbar">
      <div><strong>Local eval history</strong><span>{evaluations.length} version{evaluations.length === 1 ? "" : "s"}</span></div>
      <div><button type="button" onClick={() => void refresh().catch(onError)} aria-label="Refresh evals"><RefreshCw size={14} /></button><button type="button" className="primary" onClick={() => setFormOpen(true)} disabled={!blueprints.length}><Play size={14} />Run new eval</button></div>
    </div>
    {formOpen && <EvalForm bootstrap={bootstrap} blueprints={blueprints} saving={saving} onSubmit={run} onClose={() => setFormOpen(false)} />}
    <div className="eval-layout">
      <aside className="eval-list" aria-label="Eval history">
        {loading && <div className="eval-empty"><LoaderCircle className="spin" size={18} />Loading evals…</div>}
        {!loading && !evaluations.length && <div className="eval-empty"><FlaskConical size={21} />No evals yet. Run a blueprint across a few models.</div>}
        {evaluations.map((evaluation) => <button type="button" key={evalKey(evaluation)} className={evalKey(evaluation) === (selected ? evalKey(selected) : null) ? "active" : ""} onClick={() => setSelectedKey(evalKey(evaluation))}>
          <EvalStateIcon evaluation={evaluation} />
          <span><strong>{evaluation.name}</strong><small>{evaluation.blueprint.name} · v{evaluation.version} · {formatDate(evaluation.createdAt)}</small></span>
          <b>{evaluation.results.length}</b>
        </button>)}
      </aside>
      <main className="eval-detail">
        {selected ? <>
          <header><div><span className={`eval-status ${selected.status}`}>{selected.status}</span><h2>{selected.name} <small>v{selected.version}</small></h2><p>{selected.blueprint.name} v{selected.blueprint.version} · <code>{selected.workspace}</code></p></div><button type="button" onClick={rerun} disabled={saving || selected.status === "queued" || selected.status === "running"}><RotateCcw size={14} />Run as v{selected.version + 1}</button></header>
          <div className="eval-definition"><div><span>Prompt snapshot</span><p>{selected.prompt}</p></div><div><span>Success criteria</span><p>{criteriaSummary(selected)}</p></div></div>
          <div className="eval-results-wrap"><table className="eval-results"><thead><tr><th>Model</th><th>Result</th><th>Time</th><th>Tokens</th><th>Criteria</th><th>Session</th></tr></thead><tbody>
            {selected.results.map((result, index) => <tr key={`${result.model.provider}:${result.model.model}:${index}`}>
              <td><strong>{result.model.model}</strong><small>{result.model.provider}{result.model.reasoningEffort ? ` · ${result.model.reasoningEffort}` : ""}</small></td>
              <td><span className={`result-state ${result.status}`}>{result.status === "running" ? <LoaderCircle className="spin" size={13} /> : result.status === "passed" ? <CheckCircle2 size={13} /> : result.status === "failed" || result.status === "error" ? <XCircle size={13} /> : null}{result.status}</span>{result.error && <small title={result.error}>{result.error}</small>}</td>
              <td>{result.durationMs === null ? "—" : formatDuration(result.durationMs)}</td>
              <td>{result.totalTokens ? result.totalTokens.toLocaleString() : "—"}</td>
              <td>{result.score ? <details><summary>{result.score.criteria.filter((criterion) => criterion.passed).length}/{result.score.criteria.length}</summary><ul>{result.score.criteria.map((criterion) => <li key={criterion.criterion} className={criterion.passed ? "passed" : "failed"}>{criterion.passed ? "✓" : "×"} {criterion.criterion}</li>)}</ul></details> : "—"}</td>
              <td>{result.threadId ? <button type="button" className="eval-session-link" onClick={() => onOpenSession(result.threadId!)}>{result.threadId.slice(0, 8)}</button> : "—"}</td>
            </tr>)}
          </tbody></table></div>
          {selected.results.some((result) => result.output) && <section className="eval-output"><h3>Model output</h3>{selected.results.filter((result) => result.output).map((result) => <details key={`${result.model.provider}:${result.model.model}`}><summary>{result.model.model}</summary><pre>{result.output}</pre></details>)}</section>}
        </> : !loading && <div className="eval-empty large"><FlaskConical size={28} />Run an eval to compare models.</div>}
      </main>
    </div>
  </div>;
}

function EvalForm({ bootstrap, blueprints, saving, onSubmit, onClose }: {
  bootstrap: Bootstrap;
  blueprints: AgentBlueprintManifest[];
  saving: boolean;
  onSubmit: (request: EvalRequest) => Promise<void>;
  onClose: () => void;
}) {
  const defaultModel = bootstrap.models.data.find((model) => model.isDefault) || bootstrap.models.data[0];
  const [name, setName] = useState("Model comparison");
  const [blueprintId, setBlueprintId] = useState(blueprints[0]?.id || "");
  const [workspace, setWorkspace] = useState(bootstrap.roots[0] || "");
  const [selectedModels, setSelectedModels] = useState<Set<string>>(() => new Set(defaultModel ? [`codex:${defaultModel.model}`] : []));
  const [variables, setVariables] = useState("{}");
  const [requiredPhrases, setRequiredPhrases] = useState("");
  const [forbiddenPhrases, setForbiddenPhrases] = useState("");
  const [maxDurationSeconds, setMaxDurationSeconds] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [formError, setFormError] = useState("");
  const modelOptions = useMemo(() =>
    bootstrap.models.data.map((model) => ({ key: `codex:${model.model}`, provider: "codex" as const, model: model.model, effort: model.defaultReasoningEffort })),
  [bootstrap]);

  const toggleModel = (key: string) => setSelectedModels((current) => {
    const next = new Set(current);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    try {
      const parsedVariables = JSON.parse(variables) as unknown;
      if (!parsedVariables || typeof parsedVariables !== "object" || Array.isArray(parsedVariables)) throw new Error("Variables must be a JSON object");
      const models: EvalModel[] = modelOptions.filter((model) => selectedModels.has(model.key)).map((model) => ({
        provider: model.provider,
        model: model.model,
        reasoningEffort: model.effort
      }));
      if (!models.length) throw new Error("Select at least one model");
      void onSubmit({
        name: name.trim(),
        blueprintId,
        variables: parsedVariables as Record<string, string | number | boolean>,
        workspace: workspace.trim(),
        models,
        successCriteria: {
          requiredPhrases: phraseList(requiredPhrases),
          forbiddenPhrases: phraseList(forbiddenPhrases),
          maxDurationMs: maxDurationSeconds ? Math.round(Number(maxDurationSeconds) * 1_000) : null,
          maxTotalTokens: maxTokens ? Math.round(Number(maxTokens)) : null,
          requireBlueprintGates: true
        }
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  return <form className="eval-form" onSubmit={submit}>
    <div className="eval-form-title"><div><strong>Run a new eval</strong><span>Every model receives the same rendered blueprint prompt in a read-only workspace.</span></div><button type="button" onClick={onClose} aria-label="Close eval form"><XCircle size={16} /></button></div>
    <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required /></label>
    <label><span>Blueprint</span><select value={blueprintId} onChange={(event) => setBlueprintId(event.target.value)} required>{blueprints.map((blueprint) => <option key={blueprint.id} value={blueprint.id}>{blueprint.name} · v{blueprint.version}</option>)}</select></label>
    <label className="wide"><span>Workspace</span><select value={workspace} onChange={(event) => setWorkspace(event.target.value)} required>{bootstrap.roots.map((root) => <option key={root} value={root}>{root}</option>)}</select></label>
    <fieldset className="wide"><legend>Models</legend><div className="eval-model-picker">{modelOptions.map((model) => <label key={model.key}><input type="checkbox" checked={selectedModels.has(model.key)} onChange={() => toggleModel(model.key)} /><span>{model.model}<small>{model.provider}{model.effort ? ` · ${model.effort}` : ""}</small></span></label>)}</div></fieldset>
    <label className="wide"><span>Blueprint variables (JSON)</span><textarea value={variables} onChange={(event) => setVariables(event.target.value)} rows={2} spellCheck={false} /></label>
    <label><span>Output must contain (comma-separated)</span><input value={requiredPhrases} onChange={(event) => setRequiredPhrases(event.target.value)} placeholder="tests pass, complete" /></label>
    <label><span>Output must exclude</span><input value={forbiddenPhrases} onChange={(event) => setForbiddenPhrases(event.target.value)} placeholder="cannot, failed" /></label>
    <label><span>Max seconds (optional)</span><input type="number" min={1} max={86400} value={maxDurationSeconds} onChange={(event) => setMaxDurationSeconds(event.target.value)} /></label>
    <label><span>Max tokens (optional)</span><input type="number" min={1} value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} /></label>
    {formError && <div className="eval-form-error" role="alert">{formError}</div>}
    <div className="eval-form-actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={saving}>{saving ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}Run eval</button></div>
  </form>;
}

function EvalStateIcon({ evaluation }: { evaluation: EvalRun }) {
  if (evaluation.status === "queued" || evaluation.status === "running") return <span className="eval-list-state running"><LoaderCircle className="spin" size={14} /></span>;
  if (evaluation.passed) return <span className="eval-list-state passed"><CheckCircle2 size={14} /></span>;
  return <span className="eval-list-state failed"><XCircle size={14} /></span>;
}

function evalKey(evaluation: EvalRun): string { return `${evaluation.id}:${evaluation.version}`; }
function phraseList(value: string): string[] { return value.split(",").map((phrase) => phrase.trim()).filter(Boolean); }
function formatDuration(ms: number): string { return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`; }
function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(Date.parse(value)); }
function criteriaSummary(evaluation: EvalRun): string {
  const criteria = evaluation.successCriteria;
  const parts = ["turn completes"];
  if (criteria.requireBlueprintGates) parts.push("blueprint gates pass");
  if (criteria.requiredPhrases.length) parts.push(`contains ${criteria.requiredPhrases.join(", ")}`);
  if (criteria.forbiddenPhrases.length) parts.push(`excludes ${criteria.forbiddenPhrases.join(", ")}`);
  if (criteria.maxDurationMs !== null) parts.push(`≤ ${formatDuration(criteria.maxDurationMs)}`);
  if (criteria.maxTotalTokens !== null) parts.push(`≤ ${criteria.maxTotalTokens.toLocaleString()} tokens`);
  return parts.join(" · ");
}
