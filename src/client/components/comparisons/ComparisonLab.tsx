import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  Columns3,
  GitCompareArrows,
  LoaderCircle,
  Plus,
  RefreshCw,
  Scale,
  Trophy,
  X,
  XCircle
} from "lucide-react";
import { api } from "../../api/client";
import type { Bootstrap, CompareRequest, ComparisonModel, ComparisonRun } from "../../types";

type ComparisonLabProps = {
  bootstrap: Bootstrap;
  onOpenSession: (threadId: string) => void;
  onError: (error: unknown) => void;
};

type ModelOption = {
  key: string;
  provider: "codex";
  model: string;
  label: string;
  efforts: string[];
  defaultEffort: string;
};

type Branch = ComparisonModel & { key: number };

export function ComparisonHeader() {
  return <div className="eval-header"><span><GitCompareArrows size={17} /></span><div><strong>Model compare</strong><small>Parallel branches, diffs, and judge scoring</small></div></div>;
}

export function ComparisonLab({ bootstrap, onOpenSession, onError }: ComparisonLabProps) {
  const [comparisons, setComparisons] = useState<ComparisonRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detailMode, setDetailMode] = useState<"outputs" | "diff">("outputs");
  const [diffKey, setDiffKey] = useState("");
  const selected = comparisons.find((comparison) => comparison.id === selectedId) || comparisons[0] || null;

  const refresh = useCallback(async () => {
    const response = await api<{ data: ComparisonRun[] }>("/api/compare?limit=200");
    setComparisons(response.data);
    setSelectedId((current) => current && response.data.some((comparison) => comparison.id === current)
      ? current
      : response.data[0]?.id || null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void api<{ data: ComparisonRun[] }>("/api/compare?limit=200", { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setComparisons(response.data);
        setSelectedId(response.data[0]?.id || null);
        setFormOpen(response.data.length === 0);
      })
      .catch((error) => { if (error.name !== "AbortError") onError(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [onError]);

  const running = comparisons.some((comparison) => ["queued", "running", "judging"].includes(comparison.status));
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void refresh().catch(onError), 2_000);
    return () => clearInterval(timer);
  }, [onError, refresh, running]);

  useEffect(() => setDetailMode("outputs"), [selectedId]);
  useEffect(() => {
    setDiffKey((current) => current && selected?.diffs.some((diff) => pairKey(diff) === current)
      ? current
      : selected?.diffs[0] ? pairKey(selected.diffs[0]) : "");
  }, [selected?.diffs]);

  const createComparison = async (request: CompareRequest) => {
    setSaving(true);
    try {
      const response = await api<{ comparison: ComparisonRun }>("/api/compare", {
        method: "POST",
        body: JSON.stringify(request)
      });
      setComparisons((current) => [response.comparison, ...current]);
      setSelectedId(response.comparison.id);
      setFormOpen(false);
    } catch (error) {
      onError(error);
      throw error;
    } finally {
      setSaving(false);
    }
  };

  const activeDiff = selected?.diffs.find((diff) => pairKey(diff) === diffKey) || selected?.diffs[0] || null;
  const winner = selected?.judge?.verdict?.winnerOutputId
    ? selected.results.find((result) => result.id === selected.judge?.verdict?.winnerOutputId) || null
    : null;

  return <div className="eval-lab comparison-lab">
    <div className="eval-toolbar">
      <div><strong>Saved comparisons</strong><span>{comparisons.length} run{comparisons.length === 1 ? "" : "s"}</span></div>
      <div><button type="button" onClick={() => void refresh().catch(onError)} aria-label="Refresh comparisons"><RefreshCw size={14} /></button><button type="button" className="primary" onClick={() => setFormOpen(true)}><Plus size={14} />New comparison</button></div>
    </div>
    {formOpen && <ComparisonForm bootstrap={bootstrap} saving={saving} onSubmit={createComparison} onClose={() => setFormOpen(false)} />}
    <div className="eval-layout">
      <aside className="eval-list" aria-label="Comparison history">
        {loading && <div className="eval-empty"><LoaderCircle className="spin" size={18} />Loading comparisons…</div>}
        {!loading && !comparisons.length && <div className="eval-empty"><GitCompareArrows size={21} />No comparisons yet.</div>}
        {comparisons.map((comparison) => <button type="button" key={comparison.id} className={comparison.id === selected?.id ? "active" : ""} onClick={() => setSelectedId(comparison.id)}>
          <ComparisonStateIcon comparison={comparison} />
          <span><strong>{promptTitle(comparison.prompt)}</strong><small>{comparison.results.length} branches · {formatDate(comparison.createdAt)}</small></span>
          <b>{comparison.judge ? <Scale size={13} aria-label="Judged" /> : comparison.results.length}</b>
        </button>)}
      </aside>
      <main className="eval-detail comparison-detail">
        {selected ? <>
          <header><div><span className={`eval-status ${selected.status}`}>{selected.status}</span><h2>{promptTitle(selected.prompt)}</h2><p><code>{selected.workspace}</code> · {selected.id}</p></div></header>
          <div className="eval-definition comparison-definition"><div><span>Common prompt</span><p>{selected.prompt}</p></div><div><span>Execution</span><p>{selected.results.length} read-only branches run in parallel{selected.judge ? ` · judged by ${modelLabel(selected.judge.model)}` : " · no judge"}</p></div></div>
          <div className="eval-results-wrap"><table className="eval-results comparison-results"><thead><tr><th>Branch</th><th>State</th><th>Time</th><th>Tokens</th><th>Judge</th><th>Session</th></tr></thead><tbody>
            {selected.results.map((result, index) => {
              const score = selected.judge?.verdict?.scores.find((candidate) => candidate.outputId === result.id);
              const winning = winner?.id === result.id;
              return <tr key={result.id} className={winning ? "winner" : ""}>
                <td><strong>{winning && <Trophy size={12} />} {result.model.model}</strong><small>{result.model.provider}{result.model.reasoningEffort ? ` · ${result.model.reasoningEffort}` : ""} · branch {index + 1}</small></td>
                <td><span className={`result-state ${result.status}`}>{result.status === "running" ? <LoaderCircle className="spin" size={13} /> : result.status === "completed" ? <CheckCircle2 size={13} /> : result.status === "error" ? <XCircle size={13} /> : null}{result.status}</span>{result.error && <small title={result.error}>{result.error}</small>}</td>
                <td>{result.durationMs === null ? "—" : formatDuration(result.durationMs)}</td>
                <td>{result.totalTokens ? result.totalTokens.toLocaleString() : "—"}</td>
                <td>{score ? <span className="judge-score" title={score.rationale}>{score.score}<small>/100</small></span> : "—"}</td>
                <td>{result.threadId ? <button type="button" className="eval-session-link" onClick={() => onOpenSession(result.threadId!)}>{result.threadId.slice(0, 8)}</button> : "—"}</td>
              </tr>;
            })}
          </tbody></table></div>
          {selected.judge && <JudgeSummary comparison={selected} winner={winner} onOpenSession={onOpenSession} />}
          <div className="comparison-mode" role="tablist" aria-label="Comparison detail mode">
            <button type="button" role="tab" aria-selected={detailMode === "outputs"} className={detailMode === "outputs" ? "active" : ""} onClick={() => setDetailMode("outputs")}><Columns3 size={14} />Side by side</button>
            <button type="button" role="tab" aria-selected={detailMode === "diff"} className={detailMode === "diff" ? "active" : ""} onClick={() => setDetailMode("diff")} disabled={!selected.diffs.length}><GitCompareArrows size={14} />Diff</button>
            {detailMode === "diff" && selected.diffs.length > 0 && <select aria-label="Output pair" value={activeDiff ? pairKey(activeDiff) : ""} onChange={(event) => setDiffKey(event.target.value)}>{selected.diffs.map((diff) => <option key={pairKey(diff)} value={pairKey(diff)}>{diffLabel(selected, diff)}</option>)}</select>}
          </div>
          {detailMode === "outputs" ? <div className="comparison-output-grid">{selected.results.map((result, index) => <article key={result.id}><header><strong>{index + 1}. {modelLabel(result.model)}</strong><span>{result.status}</span></header><pre>{result.output || (result.status === "queued" || result.status === "running" ? "Waiting for output…" : "No output returned.")}</pre></article>)}</div>
            : activeDiff ? <DiffView diff={activeDiff} /> : <div className="eval-empty">Diffs appear after branches finish.</div>}
        </> : !loading && <div className="eval-empty large"><GitCompareArrows size={28} />Create a comparison to branch one prompt across models.</div>}
      </main>
    </div>
  </div>;
}

function ComparisonForm({ bootstrap, saving, onSubmit, onClose }: {
  bootstrap: Bootstrap;
  saving: boolean;
  onSubmit: (request: CompareRequest) => Promise<void>;
  onClose: () => void;
}) {
  const options = useMemo(() => modelOptions(bootstrap), [bootstrap]);
  const nextKey = useRef(3);
  const [prompt, setPrompt] = useState("");
  const [workspace, setWorkspace] = useState(bootstrap.roots[0] || "");
  const [branches, setBranches] = useState<Branch[]>(() => initialBranches(options));
  const [judgeKey, setJudgeKey] = useState("");
  const [judgeEffort, setJudgeEffort] = useState(options[0]?.defaultEffort || "medium");
  const [formError, setFormError] = useState("");

  const changeBranchModel = (key: number, optionKey: string) => {
    const option = options.find((candidate) => candidate.key === optionKey);
    if (!option) return;
    setBranches((current) => current.map((branch) => branch.key === key ? {
      key,
      provider: option.provider,
      model: option.model,
      reasoningEffort: option.defaultEffort
    } : branch));
  };

  const changeBranchEffort = (key: number, effort: string) => setBranches((current) => current.map((branch) => branch.key === key
    ? { ...branch, reasoningEffort: effort }
    : branch));

  const addBranch = () => {
    const option = options[branches.length % Math.max(1, options.length)];
    if (!option || branches.length >= 8) return;
    setBranches((current) => [...current, {
      key: nextKey.current++,
      provider: option.provider,
      model: option.model,
      reasoningEffort: option.defaultEffort
    }]);
  };

  const selectJudge = (key: string) => {
    setJudgeKey(key);
    const option = options.find((candidate) => candidate.key === key);
    if (option) setJudgeEffort(option.defaultEffort);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    const judgeOption = options.find((candidate) => candidate.key === judgeKey);
    const request: CompareRequest = {
      prompt: prompt.trim(),
      workspace,
      models: branches.map(({ key: _key, ...branch }) => branch),
      judge: judgeOption ? {
        provider: judgeOption.provider,
        model: judgeOption.model,
        reasoningEffort: judgeEffort
      } : null
    };
    const unique = new Set(request.models.map((model) => `${model.provider}:${model.model}:${model.reasoningEffort || ""}`));
    if (unique.size !== request.models.length) {
      setFormError("Each branch needs a unique model and effort combination.");
      return;
    }
    void onSubmit(request).catch((error) => setFormError(error instanceof Error ? error.message : String(error)));
  };

  return <form className="eval-form comparison-form" onSubmit={submit}>
    <div className="eval-form-title"><div><strong>Create model comparison</strong><span>Each branch receives the exact same prompt in the same read-only workspace.</span></div><button type="button" onClick={onClose} aria-label="Close comparison form"><XCircle size={16} /></button></div>
    <label className="wide"><span>Prompt</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} maxLength={100_000} required autoFocus /></label>
    <label className="wide"><span>Common workspace</span><select value={workspace} onChange={(event) => setWorkspace(event.target.value)} required>{bootstrap.roots.map((root) => <option key={root} value={root}>{root}</option>)}</select></label>
    <fieldset className="wide comparison-branches"><legend>Model branches</legend>
      {branches.map((branch, index) => {
        const selectedOption = options.find((option) => option.provider === branch.provider && option.model === branch.model) || options[0];
        return <div key={branch.key}><b>{index + 1}</b><select aria-label={`Branch ${index + 1} model`} value={selectedOption?.key || ""} onChange={(event) => changeBranchModel(branch.key, event.target.value)}>{options.map((option) => <option key={option.key} value={option.key}>{option.label} · {option.provider}</option>)}</select><select aria-label={`Branch ${index + 1} effort`} value={branch.reasoningEffort || ""} onChange={(event) => changeBranchEffort(branch.key, event.target.value)}>{selectedOption?.efforts.map((effort) => <option key={effort} value={effort}>{effort} effort</option>)}</select><button type="button" onClick={() => setBranches((current) => current.filter((candidate) => candidate.key !== branch.key))} disabled={branches.length <= 2} aria-label={`Remove branch ${index + 1}`}><X size={14} /></button></div>;
      })}
      <button type="button" className="add-branch" onClick={addBranch} disabled={branches.length >= 8}><Plus size={13} />Add branch</button>
    </fieldset>
    <fieldset className="wide comparison-judge"><legend>Judge (optional)</legend><div><select aria-label="Judge model" value={judgeKey} onChange={(event) => selectJudge(event.target.value)}><option value="">No judge</option>{options.map((option) => <option key={option.key} value={option.key}>{option.label} · {option.provider}</option>)}</select>{judgeKey && <select aria-label="Judge effort" value={judgeEffort} onChange={(event) => setJudgeEffort(event.target.value)}>{options.find((option) => option.key === judgeKey)?.efforts.map((effort) => <option key={effort} value={effort}>{effort} effort</option>)}</select>}<small>The judge runs after all branches and scores every output from 0–100.</small></div></fieldset>
    {formError && <div className="eval-form-error" role="alert">{formError}</div>}
    <div className="eval-form-actions"><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={saving || branches.length < 2}>{saving ? <LoaderCircle className="spin" size={14} /> : <GitCompareArrows size={14} />}Run comparison</button></div>
  </form>;
}

function JudgeSummary({ comparison, winner, onOpenSession }: {
  comparison: ComparisonRun;
  winner: ComparisonRun["results"][number] | null;
  onOpenSession: (threadId: string) => void;
}) {
  const judge = comparison.judge!;
  return <section className={`judge-summary ${judge.status}`}><header><span><Scale size={15} /></span><div><strong>{judge.status === "completed" ? winner ? `${winner.model.model} wins` : "Judge returned no winner" : judge.status === "error" ? "Judge failed" : "Judge in progress"}</strong><small>{modelLabel(judge.model)}{judge.totalTokens ? ` · ${judge.totalTokens.toLocaleString()} tokens` : ""}</small></div>{judge.threadId && <button type="button" className="eval-session-link" onClick={() => onOpenSession(judge.threadId!)}>Open judge session</button>}</header>{judge.verdict?.summary && <p>{judge.verdict.summary}</p>}{judge.error && <p>{judge.error}</p>}</section>;
}

function DiffView({ diff }: { diff: ComparisonRun["diffs"][number] }) {
  return <div className="comparison-diff" role="table" aria-label="Line diff">{diff.lines.length ? diff.lines.map((line, index) => <div key={`${line.kind}:${line.oldLine}:${line.newLine}:${index}`} className={line.kind} role="row"><span>{line.oldLine || ""}</span><span>{line.newLine || ""}</span><b>{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</b><code>{line.text || " "}</code></div>) : <div className="identical">Outputs are identical.</div>}{diff.truncated && <footer>Diff was truncated for display and storage.</footer>}</div>;
}

function ComparisonStateIcon({ comparison }: { comparison: ComparisonRun }) {
  if (["queued", "running", "judging"].includes(comparison.status)) return <span className="eval-list-state running"><LoaderCircle className="spin" size={14} /></span>;
  if (comparison.status === "completed") return <span className="eval-list-state passed"><CheckCircle2 size={14} /></span>;
  return <span className="eval-list-state failed"><XCircle size={14} /></span>;
}

function modelOptions(bootstrap: Bootstrap): ModelOption[] {
  return [
    ...bootstrap.models.data.map((model) => ({
      key: `codex:${model.model}`,
      provider: "codex" as const,
      model: model.model,
      label: model.displayName || model.model,
      efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
      defaultEffort: model.defaultReasoningEffort
    }))
  ];
}

function initialBranches(options: ModelOption[]): Branch[] {
  if (!options.length) return [];
  const first = options[0];
  const second = options[1] || first;
  const secondEffort = second === first ? first.efforts.find((effort) => effort !== first.defaultEffort) || first.defaultEffort : second.defaultEffort;
  return [
    { key: 1, provider: first.provider, model: first.model, reasoningEffort: first.defaultEffort },
    { key: 2, provider: second.provider, model: second.model, reasoningEffort: secondEffort }
  ];
}

function pairKey(diff: ComparisonRun["diffs"][number]): string { return `${diff.leftOutputId}:${diff.rightOutputId}`; }
function diffLabel(comparison: ComparisonRun, diff: ComparisonRun["diffs"][number]): string {
  const left = comparison.results.find((result) => result.id === diff.leftOutputId);
  const right = comparison.results.find((result) => result.id === diff.rightOutputId);
  return `${left ? modelLabel(left.model) : "Output"} ↔ ${right ? modelLabel(right.model) : "Output"}`;
}
function promptTitle(prompt: string): string { return prompt.split("\n")[0]?.trim().slice(0, 72) || "Untitled comparison"; }
function modelLabel(model: ComparisonModel): string { return `${model.model}${model.reasoningEffort ? ` · ${model.reasoningEffort}` : ""}`; }
function formatDuration(ms: number): string { return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`; }
function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(Date.parse(value)); }
