import { useEffect, useRef, useState } from "react";
import { Check, Folder, ShieldCheck } from "lucide-react";
import { api } from "../api/client";
import type { PendingRequest } from "../types";

export function ApprovalTray({ requests, onResolved, onError }: { requests: PendingRequest[]; onResolved: (id: string | number) => void; onError: (error: unknown) => void }) {
  const request = requests[0];
  const trayRef = useRef<HTMLDivElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const params = request.params || {};
  const questions = Array.isArray(params.questions) ? params.questions as Array<{ id: string; header: string; question: string; isSecret: boolean; options: Array<{ label: string; description: string }> | null }> : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  useEffect(() => setAnswers({}), [request.id]);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (firstActionRef.current?.disabled ? null : firstActionRef.current)?.focus();
    if (document.activeElement === previousFocus) {
      trayRef.current?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), button:not(:disabled)")?.focus();
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !trayRef.current) return;
      const focusable = [...trayRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); previousFocus?.focus(); };
  }, [request.id]);
  const isKnown = request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval";
  const isQuestion = request.method === "item/tool/requestUserInput";
  const decide = async (decision: string) => { try { await api(`/api/approvals/${encodeURIComponent(String(request.id))}`, { method: "POST", body: JSON.stringify({ decision }) }); onResolved(request.id); } catch (error) { onError(error); } };
  const answerQuestions = async () => { try { const mapped = Object.fromEntries(questions.map((question) => [question.id, { answers: [answers[question.id] || ""] }])); await api(`/api/approvals/${encodeURIComponent(String(request.id))}`, { method: "POST", body: JSON.stringify({ result: { answers: mapped } }) }); onResolved(request.id); } catch (error) { onError(error); } };
  return <div ref={trayRef} className="approval-tray" role="alertdialog" aria-modal="true" aria-labelledby="approval-title" aria-describedby="approval-description">
    <div className="approval-title"><div><ShieldCheck size={18} /><span id="approval-title">Codex needs approval <small>{requests.length > 1 ? `${requests.length} requests waiting` : "Session paused safely"}</small></span></div></div>
    <div className="approval-content" id="approval-description"><strong>{request.method.includes("commandExecution") ? "Run this command?" : request.method.includes("fileChange") ? "Apply these file changes?" : "Codex is requesting input"}</strong>{params.command ? <code>{String(params.command)}</code> : <p>{String(params.reason || "Review this request before continuing.")}</p>}{Boolean(params.cwd) && <small><Folder size={12} />{String(params.cwd)}</small>}{isQuestion && <div className="approval-questions">{questions.map((question) => <label key={question.id}><span>{question.header}<small>{question.question}</small></span>{question.options?.length ? <select value={answers[question.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}><option value="" disabled>Choose…</option>{question.options.map((option) => <option key={option.label} value={option.label}>{option.label} — {option.description}</option>)}</select> : <input type={question.isSecret ? "password" : "text"} value={answers[question.id] || ""} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}</label>)}</div>}</div>
    {isKnown ? <div className="approval-actions"><button ref={firstActionRef} onClick={() => void decide("decline")} className="deny">Decline</button><button onClick={() => void decide("accept")}>Allow once</button><button onClick={() => void decide("acceptForSession")} className="approve"><Check size={15} />Allow for session</button></div> : isQuestion ? <div className="approval-actions"><button ref={firstActionRef} className="approve" disabled={questions.some((question) => !answers[question.id])} onClick={() => void answerQuestions()}><Check size={15} />Send answer</button></div> : <div className="approval-actions"><span className="unsupported-request">Open the Codex CLI to answer this structured request.</span></div>}
  </div>;
}
