import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, LoaderCircle, Pencil, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { api } from "../../api/client";
import type { Bootstrap, PolicyAction, PolicyField, PolicyOperator, PolicyRule } from "../../types";

type PoliciesDialogProps = {
  bootstrap: Bootstrap;
  onClose: () => void;
  onError: (error: unknown) => void;
};

const FIELDS: Array<{ value: PolicyField; label: string }> = [
  { value: "session_class", label: "Session class" },
  { value: "model", label: "Model" },
  { value: "reasoning_effort", label: "Reasoning effort" },
  { value: "workspace", label: "Workspace" },
  { value: "time_of_day", label: "Time of day" },
  { value: "max_concurrency", label: "Max concurrency" },
  { value: "max_tokens_per_session", label: "Max tokens per session" }
];

const OPERATOR_LABELS: Record<PolicyOperator, string> = {
  equals: "Equals",
  not_equals: "Does not equal",
  contains: "Contains",
  less_than: "Less than",
  less_than_or_equal: "At most",
  greater_than: "Greater than",
  greater_than_or_equal: "At least"
};

const FIELD_LABELS = Object.fromEntries(FIELDS.map((field) => [field.value, field.label])) as Record<PolicyField, string>;

export function PoliciesDialog({ bootstrap, onClose, onError }: PoliciesDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [policies, setPolicies] = useState<PolicyRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [field, setField] = useState<PolicyField>("session_class");
  const [operator, setOperator] = useState<PolicyOperator>("equals");
  const [value, setValue] = useState("standard");
  const [action, setAction] = useState<PolicyAction>("warn");

  useEffect(() => {
    const controller = new AbortController();
    void api<{ data: PolicyRule[] }>("/api/policies", { signal: controller.signal })
      .then(({ data }) => setPolicies(data))
      .catch((error) => { if (error.name !== "AbortError") onError(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [onError]);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const chooseField = (next: PolicyField) => {
    setField(next);
    const operators = operatorsFor(next);
    setOperator(operators[0]);
    setValue(defaultValue(next, bootstrap));
  };

  const reset = () => {
    setEditingId(null);
    setName("");
    setField("session_class");
    setOperator("equals");
    setValue("standard");
    setAction("warn");
  };

  const edit = (policy: PolicyRule) => {
    setEditingId(policy.id);
    setName(policy.name);
    setField(policy.condition.field);
    setOperator(policy.condition.operator);
    setValue(String(policy.condition.value));
    setAction(policy.action);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !value.trim()) return;
    setSaving(true);
    try {
      const numeric = field === "max_concurrency" || field === "max_tokens_per_session";
      const { policy } = await api<{ policy: PolicyRule }>("/api/policies", {
        method: "POST",
        body: JSON.stringify({
          ...(editingId ? { id: editingId } : {}),
          name: name.trim(),
          condition: { field, operator, value: numeric ? Number(value) : value.trim() },
          action
        })
      });
      setPolicies((current) => editingId
        ? current.map((candidate) => candidate.id === policy.id ? policy : candidate)
        : [...current, policy]);
      reset();
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (policy: PolicyRule) => {
    if (!window.confirm(`Delete the “${policy.name}” policy?`)) return;
    setBusyId(policy.id);
    try {
      await api("/api/policies", { method: "DELETE", body: JSON.stringify({ id: policy.id }) });
      setPolicies((current) => current.filter((candidate) => candidate.id !== policy.id));
      if (editingId === policy.id) reset();
    } catch (error) {
      onError(error);
    } finally {
      setBusyId(null);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className="policies-dialog" role="dialog" aria-modal="true" aria-labelledby="policies-title" tabIndex={-1}>
      <header>
        <div><span className="policies-icon"><ShieldCheck size={19} /></span><span><small>Pre-flight rules</small><h2 id="policies-title">Session policies</h2></span></div>
        <button className="icon-button" onClick={onClose} aria-label="Close session policies"><X size={18} /></button>
      </header>
      <div className="policies-body">
        <form onSubmit={(event) => void submit(event)}>
          <strong>{editingId ? <Pencil size={13} /> : <Plus size={13} />}{editingId ? "Edit policy" : "Add a policy"}</strong>
          <label className="policy-name">Name<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="Warn on high reasoning" /></label>
          <label>Condition<select value={field} onChange={(event) => chooseField(event.target.value as PolicyField)}>{FIELDS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label>Operator<select value={operator} onChange={(event) => setOperator(event.target.value as PolicyOperator)}>{operatorsFor(field).map((option) => <option key={option} value={option}>{OPERATOR_LABELS[option]}</option>)}</select></label>
          <ValueField field={field} value={value} bootstrap={bootstrap} onChange={setValue} />
          <label>Action<select value={action} onChange={(event) => setAction(event.target.value as PolicyAction)}><option value="allow">Allow</option><option value="warn">Warn</option><option value="block">Block</option></select></label>
          <div className="policy-form-actions">{editingId && <button type="button" onClick={reset}>Cancel edit</button>}<button className="primary-button" disabled={saving || !name.trim() || !value.trim()}>{saving ? <LoaderCircle className="spin" size={14} /> : editingId ? <Pencil size={14} /> : <Plus size={14} />}{editingId ? "Save changes" : "Add policy"}</button></div>
        </form>
        <section className="policy-list" aria-label="Session policies">
          {loading ? <div className="policy-empty"><LoaderCircle className="spin" size={18} />Loading policies…</div> : policies.map((policy) => <article key={policy.id} className={`policy-rule action-${policy.action}`}>
            <span className="policy-action-icon">{policy.action === "warn" ? <AlertTriangle size={16} /> : <ShieldCheck size={16} />}</span>
            <div><strong>{policy.name}<em>{policy.action}</em></strong><span>{FIELD_LABELS[policy.condition.field]} · {OPERATOR_LABELS[policy.condition.operator].toLowerCase()} · <code>{policy.condition.value}</code></span></div>
            <button onClick={() => edit(policy)} aria-label={`Edit ${policy.name}`}><Pencil size={14} /></button>
            <button className="danger" disabled={busyId === policy.id} onClick={() => void remove(policy)} aria-label={`Delete ${policy.name}`}>{busyId === policy.id ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}</button>
          </article>)}
          {!loading && !policies.length && <div className="policy-empty"><ShieldCheck size={28} /><strong>No policies</strong><span>All session creation and resume requests are allowed.</span></div>}
        </section>
      </div>
    </div>
  </div>;
}

function ValueField({ field, value, bootstrap, onChange }: { field: PolicyField; value: string; bootstrap: Bootstrap; onChange: (value: string) => void }) {
  if (field === "session_class") return <label>Value<select value={value} onChange={(event) => onChange(event.target.value)}><option value="standard">Standard</option><option value="spark">Spark</option></select></label>;
  if (field === "reasoning_effort") return <label>Value<input list="policy-efforts" value={value} onChange={(event) => onChange(event.target.value)} /><datalist id="policy-efforts">{[...new Set(bootstrap.models.data.flatMap((model) => model.supportedReasoningEfforts.map((option) => option.reasoningEffort)))].map((effort) => <option key={effort} value={effort} />)}</datalist></label>;
  if (field === "model") return <label>Value<input list="policy-models" value={value} onChange={(event) => onChange(event.target.value)} /><datalist id="policy-models">{bootstrap.models.data.map((model) => <option key={`${model.id}:${model.model}`} value={model.model} />)}</datalist></label>;
  if (field === "workspace") return <label>Value<input list="policy-workspaces" value={value} onChange={(event) => onChange(event.target.value)} /><datalist id="policy-workspaces">{bootstrap.roots.map((root) => <option key={root} value={root} />)}</datalist></label>;
  if (field === "time_of_day") return <label>Value<input type="time" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
  return <label>Value<input type="number" min={0} step={1} value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function operatorsFor(field: PolicyField): PolicyOperator[] {
  if (["model", "reasoning_effort", "workspace"].includes(field)) return ["equals", "not_equals", "contains"];
  if (field === "session_class") return ["equals", "not_equals"];
  return ["greater_than_or_equal", "greater_than", "less_than_or_equal", "less_than", "equals", "not_equals"];
}

function defaultValue(field: PolicyField, bootstrap: Bootstrap): string {
  if (field === "session_class") return "standard";
  if (field === "model") return bootstrap.models.data[0]?.model || "";
  if (field === "reasoning_effort") return bootstrap.models.data[0]?.defaultReasoningEffort || "medium";
  if (field === "workspace") return bootstrap.roots[0] || "";
  if (field === "time_of_day") return "18:00";
  return "1";
}
