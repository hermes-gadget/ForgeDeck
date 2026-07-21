import { randomUUID } from "node:crypto";
import { policyConditionSchema, type PolicyAction, type PolicyCondition, type PolicyRequest } from "../shared/contracts.js";
import { TransactionalStore, type PolicyStoreRow } from "./store.js";

export type PolicyRecord = {
  id: string;
  name: string;
  condition: PolicyCondition;
  action: PolicyAction;
  createdAt: number;
  updatedAt: number;
};

export type PolicyEvaluationContext = {
  sessionClass: "standard" | "spark";
  model: string;
  reasoningEffort: string | null;
  workspace: string;
  timeOfDay: string;
  concurrency: number;
  tokensUsed: number;
};

export type PolicyDecision = {
  action: PolicyAction;
  blocked: boolean;
  reason: string | null;
  warnings: string[];
  matched: PolicyRecord[];
};

export class PolicyNotFoundError extends Error {
  constructor() {
    super("Policy not found");
    this.name = "PolicyNotFoundError";
  }
}

export class PolicyManager {
  constructor(
    private readonly store: TransactionalStore,
    private readonly now: () => number = Date.now
  ) {}

  list(): PolicyRecord[] {
    return this.store.listPolicies().map(fromStoreRow);
  }

  save(input: PolicyRequest): PolicyRecord {
    const previous = input.id ? this.store.getPolicy(input.id) : null;
    if (input.id && !previous) throw new PolicyNotFoundError();
    const timestamp = this.now();
    const record: PolicyRecord = {
      id: input.id || randomUUID(),
      name: input.name,
      condition: input.condition,
      action: input.action,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    this.store.upsertPolicy(toStoreRow(record));
    return clonePolicy(record);
  }

  remove(id: string): boolean {
    return this.store.removePolicy(id);
  }

  evaluate(context: PolicyEvaluationContext): PolicyDecision {
    return evaluatePolicyRules(this.list(), context);
  }
}

export function evaluatePolicyRules(rules: PolicyRecord[], context: PolicyEvaluationContext): PolicyDecision {
  const matched = rules.filter((rule) => conditionMatches(rule.condition, context));
  const blocks = matched.filter((rule) => rule.action === "block");
  const warnings = matched.filter((rule) => rule.action === "warn").map((rule) => warningReason(rule));
  if (blocks.length) {
    return {
      action: "block",
      blocked: true,
      reason: blocks.map((rule) => blockReason(rule)).join(" "),
      warnings,
      matched: matched.map(clonePolicy)
    };
  }
  return {
    action: warnings.length ? "warn" : "allow",
    blocked: false,
    reason: null,
    warnings,
    matched: matched.map(clonePolicy)
  };
}

function conditionMatches(condition: PolicyCondition, context: PolicyEvaluationContext): boolean {
  const actual = conditionValue(condition.field, context);
  const expected = condition.value;
  switch (condition.operator) {
    case "equals": return actual === expected;
    case "not_equals": return actual !== expected;
    case "contains": return typeof actual === "string" && typeof expected === "string" && actual.includes(expected);
    case "less_than": return orderedCompare(actual, expected, (left, right) => left < right);
    case "less_than_or_equal": return orderedCompare(actual, expected, (left, right) => left <= right);
    case "greater_than": return orderedCompare(actual, expected, (left, right) => left > right);
    case "greater_than_or_equal": return orderedCompare(actual, expected, (left, right) => left >= right);
  }
}

function orderedCompare(
  actual: string | number,
  expected: string | number,
  compare: (left: string, right: string) => boolean
): boolean {
  if (typeof actual !== typeof expected) return false;
  return compare(String(actual).padStart(typeof actual === "number" ? 20 : 0, "0"), String(expected).padStart(typeof expected === "number" ? 20 : 0, "0"));
}

function conditionValue(field: PolicyCondition["field"], context: PolicyEvaluationContext): string | number {
  switch (field) {
    case "session_class": return context.sessionClass;
    case "model": return context.model;
    case "reasoning_effort": return context.reasoningEffort || "";
    case "workspace": return context.workspace;
    case "time_of_day": return context.timeOfDay;
    case "max_concurrency": return context.concurrency;
    case "max_tokens_per_session": return context.tokensUsed;
  }
}

function blockReason(rule: PolicyRecord): string {
  return `Blocked by policy “${rule.name}”: ${describeCondition(rule.condition)}.`;
}

function warningReason(rule: PolicyRecord): string {
  return `Policy “${rule.name}” warns: ${describeCondition(rule.condition)}.`;
}

function describeCondition(condition: PolicyCondition): string {
  const field = {
    session_class: "session class",
    model: "model",
    reasoning_effort: "reasoning effort",
    workspace: "workspace",
    time_of_day: "time of day",
    max_concurrency: "concurrency",
    max_tokens_per_session: "session tokens"
  }[condition.field];
  const operator = {
    equals: "equals",
    not_equals: "does not equal",
    contains: "contains",
    less_than: "is less than",
    less_than_or_equal: "is at most",
    greater_than: "is greater than",
    greater_than_or_equal: "is at least"
  }[condition.operator];
  return `${field} ${operator} ${condition.value}`;
}

function fromStoreRow(row: PolicyStoreRow): PolicyRecord {
  return {
    id: row.id,
    name: row.name,
    condition: policyConditionSchema.parse({ field: row.field, operator: row.operator, value: JSON.parse(row.valueJson) }),
    action: row.action,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function toStoreRow(record: PolicyRecord): PolicyStoreRow {
  return {
    id: record.id,
    name: record.name,
    field: record.condition.field,
    operator: record.condition.operator,
    valueJson: JSON.stringify(record.condition.value),
    action: record.action,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function clonePolicy(record: PolicyRecord): PolicyRecord {
  return { ...record, condition: { ...record.condition } };
}
