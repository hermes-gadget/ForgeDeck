import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BookOpen, FileText, Globe2, LoaderCircle, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { api } from "../../api/client";
import type { KnowledgePack, KnowledgePackRequest, KnowledgePackSource } from "../../types";

type KnowledgePacksDialogProps = {
  roots: string[];
  onClose: () => void;
  onError: (error: unknown) => void;
};

export function KnowledgePacksDialog({ roots, onClose, onError }: KnowledgePacksDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [packs, setPacks] = useState<KnowledgePack[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"global" | "workspace">("workspace");
  const [workspace, setWorkspace] = useState(roots[0] || "");
  const [sourceText, setSourceText] = useState("");
  const selected = useMemo(() => packs.find((pack) => pack.id === selectedId) || packs[0] || null, [packs, selectedId]);

  useEffect(() => {
    const controller = new AbortController();
    void api<{ data: KnowledgePack[] }>("/api/knowledge-packs", { signal: controller.signal })
      .then(({ data }) => {
        setPacks(data);
        setSelectedId((current) => current && data.some((pack) => pack.id === current) ? current : data[0]?.id || null);
      })
      .catch((error) => { if (error.name !== "AbortError") onError(error); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [onError]);

  useEffect(() => {
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const sources = parseSources(sourceText);
    if (!name.trim() || !sources.length || (scope === "workspace" && !workspace)) return;
    setSaving(true);
    try {
      const body: KnowledgePackRequest = {
        name: name.trim(),
        scope,
        workspace: scope === "workspace" ? workspace : null,
        sources
      };
      const { pack } = await api<{ pack: KnowledgePack }>("/api/knowledge-packs", {
        method: "POST",
        body: JSON.stringify(body)
      });
      setPacks((current) => [...current, pack].sort(comparePacks));
      setSelectedId(pack.id);
      setName("");
      setSourceText("");
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  const refresh = async (pack: KnowledgePack) => {
    setBusyId(pack.id);
    try {
      const response = await api<{ pack: KnowledgePack }>(`/api/knowledge-packs/${pack.id}/refresh`, { method: "POST", body: "{}" });
      setPacks((current) => current.map((candidate) => candidate.id === pack.id ? response.pack : candidate));
    } catch (error) {
      onError(error);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (pack: KnowledgePack) => {
    if (!window.confirm(`Remove the “${pack.name}” knowledge pack?`)) return;
    setBusyId(pack.id);
    try {
      await api(`/api/knowledge-packs/${pack.id}`, { method: "DELETE" });
      setPacks((current) => current.filter((candidate) => candidate.id !== pack.id));
      setSelectedId((current) => current === pack.id ? null : current);
    } catch (error) {
      onError(error);
    } finally {
      setBusyId(null);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className="knowledge-packs-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-packs-title" tabIndex={-1}>
      <header>
        <div><span className="knowledge-packs-icon"><BookOpen size={19} /></span><span><small>Shared context</small><h2 id="knowledge-packs-title">Knowledge packs</h2></span></div>
        <button className="icon-button" onClick={onClose} aria-label="Close knowledge packs"><X size={18} /></button>
      </header>
      <div className="knowledge-packs-body">
        <aside>
          <form onSubmit={(event) => void submit(event)}>
            <strong><Plus size={13} /> Add a pack</strong>
            <label>Name<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="Repository guide" /></label>
            <label>Scope<select value={scope} onChange={(event) => setScope(event.target.value as "global" | "workspace")}><option value="workspace">Workspace</option><option value="global">Global</option></select></label>
            {scope === "workspace" && <label>Workspace<select value={workspace} onChange={(event) => setWorkspace(event.target.value)}>{roots.map((root) => <option key={root} value={root}>{root}</option>)}</select></label>}
            <label>Files, paths, or URLs<textarea value={sourceText} onChange={(event) => setSourceText(event.target.value)} rows={5} placeholder={scope === "workspace" ? "README.md\ndocs/\nhttps://example.com/guide" : "/absolute/path/guide.md\nhttps://example.com/guide"} /><small>One source per line. Prefix a single file with <code>file:</code>; directories and unprefixed paths use <code>path:</code>.</small></label>
            <button className="primary-button" type="submit" disabled={saving || !name.trim() || !sourceText.trim() || (scope === "workspace" && !workspace)}>{saving ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}Add pack</button>
          </form>
          <div className="knowledge-pack-list" aria-label="Knowledge packs">
            {loading ? <span className="knowledge-pack-empty"><LoaderCircle className="spin" size={16} />Loading packs…</span> : packs.map((pack) => <button key={pack.id} className={selected?.id === pack.id ? "selected" : ""} onClick={() => setSelectedId(pack.id)}>
              {pack.scope === "global" ? <Globe2 size={14} /> : <FileText size={14} />}
              <span><strong>{pack.name}</strong><small>{pack.scope === "global" ? "Global" : basename(pack.workspace || "Workspace")} · {pack.sources.length} source{pack.sources.length === 1 ? "" : "s"}</small></span>
              <i className={pack.status} title={pack.errors.join("\n")} />
            </button>)}
            {!loading && !packs.length && <span className="knowledge-pack-empty">No knowledge packs yet.</span>}
          </div>
        </aside>
        <section className="knowledge-pack-preview">
          {selected ? <>
            <div className="knowledge-pack-preview-header">
              <div><strong>{selected.name}</strong><span>{selected.scope === "global" ? "Global" : selected.workspace} · {selected.charCount.toLocaleString()} characters</span></div>
              <div><button onClick={() => void refresh(selected)} disabled={busyId === selected.id}>{busyId === selected.id ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}Refresh</button><button className="danger" onClick={() => void remove(selected)} disabled={busyId === selected.id}><Trash2 size={14} />Remove</button></div>
            </div>
            <div className="knowledge-pack-sources">{selected.sources.map((source, index) => <code key={`${source.type}:${source.reference}:${index}`}>{source.type}:{source.reference}</code>)}</div>
            {selected.errors.length > 0 && <div className="knowledge-pack-errors" role="status">{selected.errors.map((error) => <span key={error}>{error}</span>)}</div>}
            <pre>{selected.content || "This pack has no readable cached content."}</pre>
          </> : <div className="knowledge-pack-preview-empty"><BookOpen size={28} /><strong>Select or add a pack</strong><span>Cached source content will appear here.</span></div>}
        </section>
      </div>
    </div>
  </div>;
}

function parseSources(value: string): KnowledgePackSource[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).map((reference) => {
    if (/^https?:\/\//i.test(reference)) return { type: "url" as const, reference };
    if (reference.startsWith("file:")) return { type: "file" as const, reference: reference.slice(5).trim() };
    if (reference.startsWith("path:")) return { type: "path" as const, reference: reference.slice(5).trim() };
    return { type: "path" as const, reference };
  }).filter((source) => Boolean(source.reference));
}

function comparePacks(left: KnowledgePack, right: KnowledgePack): number {
  return left.scope.localeCompare(right.scope) || (left.workspace || "").localeCompare(right.workspace || "") || left.name.localeCompare(right.name);
}

function basename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}
