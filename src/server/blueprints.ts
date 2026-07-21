import { randomUUID } from "node:crypto";
import { MODEL_PRESETS, type ModelPreset } from "../shared/contracts.js";
import { TransactionalStore, type BlueprintVersionStoreRow } from "./store.js";

const AGENT_BLUEPRINT_SCHEMA_VERSION = 1 as const;

export type BlueprintVariableValue = string | number | boolean;
type BlueprintVariableType = "string" | "number" | "boolean";
type BlueprintBackend = "codex" | "claude";

type BlueprintVariableSchema = {
  name: string;
  type: BlueprintVariableType;
  description?: string;
  required: boolean;
  secret?: boolean;
  default?: BlueprintVariableValue;
};

type BlueprintWorkspaceSelector = {
  selector: "current" | "fixed" | "variable";
  value?: string;
};

type BlueprintModelPolicy = {
  backend: BlueprintBackend;
  routing: "fixed" | "fallback";
  model: string;
  effort?: string | null;
  preset?: ModelPreset;
  fallbacks?: Array<{ backend: BlueprintBackend; model: string; effort?: string | null }>;
};

type BlueprintGuardianPolicy = {
  stallTimeoutMinutes: number;
  escalationModel?: string | null;
};

type AgentBlueprintDefinition = {
  promptTemplate: string;
  role: string;
  workspace: BlueprintWorkspaceSelector;
  model: BlueprintModelPolicy;
  tools: { enable: string[]; disable: string[] };
  knowledge: Array<{ type: "file" | "url"; reference: string }>;
  completionGates: Array<{
    name: string;
    description: string;
    required: boolean;
    artifactType?: "FileArtifact" | "PatchArtifact" | "TestResultArtifact" | "CommandArtifact" | "ReviewVerdictArtifact";
    artifactName?: string;
    path?: string;
    schema?: Record<string, unknown>;
    minimumCount?: number;
    mustPass?: boolean;
    trust?: "deterministic" | "human" | "advisory";
  }>;
  approvals: { mode: "on-request" | "never" | "plan"; requiredFor: string[] };
  variables: BlueprintVariableSchema[];
  guardian?: BlueprintGuardianPolicy;
};

/** Portable, secret-free representation of one immutable blueprint version. */
export type AgentBlueprintManifest = {
  schemaVersion: typeof AGENT_BLUEPRINT_SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  version: number;
  createdAt: number;
  definition: AgentBlueprintDefinition;
};

type AgentBlueprintDraft = {
  id?: string;
  name: string;
  description?: string;
  definition: AgentBlueprintDefinition;
};

export type ResolvedBlueprintRun = {
  manifest: AgentBlueprintManifest;
  prompt: string;
  variables: Record<string, BlueprintVariableValue>;
};

export class BlueprintValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlueprintValidationError";
  }
}

export class BlueprintConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlueprintConflictError";
  }
}

export class BlueprintManager {
  constructor(
    private readonly store: TransactionalStore,
    private readonly now: () => number = Date.now
  ) {}

  create(draftValue: unknown): AgentBlueprintManifest {
    const draft = validateBlueprintDraft(draftValue);
    const id = draft.id || randomUUID();
    if (this.store.latestBlueprintVersion(id)) {
      throw new BlueprintConflictError(`Blueprint ${id} already exists; create a new immutable version instead`);
    }
    return this.persist({
      schemaVersion: AGENT_BLUEPRINT_SCHEMA_VERSION,
      id,
      name: draft.name,
      description: draft.description || "",
      version: 1,
      createdAt: timestamp(this.now()),
      definition: draft.definition
    });
  }

  createVersion(idValue: unknown, draftValue: unknown): AgentBlueprintManifest {
    const id = blueprintId(idValue);
    const latest = this.store.latestBlueprintVersion(id);
    if (!latest) throw new BlueprintValidationError(`Blueprint ${id} does not exist`);
    const draft = validateBlueprintDraft(draftValue, false);
    return this.persist({
      schemaVersion: AGENT_BLUEPRINT_SCHEMA_VERSION,
      id,
      name: draft.name,
      description: draft.description || "",
      version: latest.version + 1,
      createdAt: timestamp(this.now()),
      definition: draft.definition
    });
  }

  import(value: unknown): AgentBlueprintManifest {
    const manifest = validateBlueprintManifest(value);
    if (this.store.getBlueprintVersion(manifest.id, manifest.version)) {
      throw new BlueprintConflictError(`Blueprint ${manifest.id} version ${manifest.version} already exists`);
    }
    const latest = this.store.latestBlueprintVersion(manifest.id);
    if (latest && manifest.version <= latest.version) {
      throw new BlueprintConflictError(`Imported blueprint version must be newer than version ${latest.version}`);
    }
    return this.persist(manifest);
  }

  get(idValue: unknown, versionValue?: unknown): AgentBlueprintManifest | null {
    const id = blueprintId(idValue);
    const row = versionValue === undefined || versionValue === null
      ? this.store.latestBlueprintVersion(id)
      : this.store.getBlueprintVersion(id, blueprintVersion(versionValue));
    return row ? manifestFromRow(row) : null;
  }

  versions(idValue: unknown): AgentBlueprintManifest[] {
    return this.store.listBlueprintVersions(blueprintId(idValue)).map(manifestFromRow);
  }

  search(query = "", limit = 50): AgentBlueprintManifest[] {
    if (typeof query !== "string" || query.length > 200) throw new BlueprintValidationError("Blueprint search must be 200 characters or fewer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BlueprintValidationError("Blueprint search limit must be between 1 and 200");
    return this.store.searchLatestBlueprintVersions(query.trim(), limit).map(manifestFromRow);
  }

  getByName(nameValue: unknown): AgentBlueprintManifest | null {
    const name = text(nameValue, "Blueprint name", 100);
    const matches = this.store.latestBlueprintVersionsByName(name);
    if (matches.length > 1) {
      throw new BlueprintConflictError(`Blueprint name ${name} is ambiguous; use a unique name before triggering it`);
    }
    return matches[0] ? manifestFromRow(matches[0]) : null;
  }

  resolve(idValue: unknown, versionValue: unknown, values: unknown): ResolvedBlueprintRun {
    const manifest = this.get(idValue, versionValue);
    if (!manifest) throw new BlueprintValidationError("Blueprint version was not found");
    const variables = resolveVariables(manifest.definition.variables, values);
    return {
      manifest,
      prompt: interpolateTemplate(manifest.definition.promptTemplate, variables, manifest.definition.variables),
      variables
    };
  }

  private persist(manifest: AgentBlueprintManifest): AgentBlueprintManifest {
    const validated = validateBlueprintManifest(manifest);
    try {
      this.store.insertBlueprintVersion({
        id: validated.id,
        version: validated.version,
        name: validated.name,
        description: validated.description,
        payload: JSON.stringify(validated),
        createdAt: validated.createdAt
      });
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        throw new BlueprintConflictError(`Blueprint ${validated.id} version ${validated.version} already exists`);
      }
      throw error;
    }
    return structuredClone(validated);
  }
}

function validateBlueprintDraft(value: unknown, allowId = true): AgentBlueprintDraft {
  const record = object(value, "Blueprint");
  allowedKeys(record, allowId ? ["id", "name", "description", "definition"] : ["name", "description", "definition"]);
  return {
    ...(record.id === undefined ? {} : { id: blueprintId(record.id) }),
    name: text(record.name, "Blueprint name", 100),
    description: optionalText(record.description, "Blueprint description", 1_000) || "",
    definition: validateDefinition(record.definition)
  };
}

function validateBlueprintManifest(value: unknown): AgentBlueprintManifest {
  const record = object(value, "Blueprint manifest");
  allowedKeys(record, ["schemaVersion", "id", "name", "description", "version", "createdAt", "definition"]);
  if (record.schemaVersion !== AGENT_BLUEPRINT_SCHEMA_VERSION) {
    throw new BlueprintValidationError(`Unsupported blueprint schema version ${String(record.schemaVersion)}`);
  }
  return {
    schemaVersion: AGENT_BLUEPRINT_SCHEMA_VERSION,
    id: blueprintId(record.id),
    name: text(record.name, "Blueprint name", 100),
    description: optionalText(record.description, "Blueprint description", 1_000) || "",
    version: blueprintVersion(record.version),
    createdAt: timestamp(record.createdAt),
    definition: validateDefinition(record.definition)
  };
}

function validateDefinition(value: unknown): AgentBlueprintDefinition {
  const record = object(value, "Blueprint definition");
  allowedKeys(record, ["promptTemplate", "role", "workspace", "model", "tools", "knowledge", "completionGates", "approvals", "variables", "guardian"]);
  const variables = variableSchemas(record.variables);
  const definition: AgentBlueprintDefinition = {
    promptTemplate: template(record.promptTemplate, "Prompt template", 100_000),
    role: text(record.role, "Blueprint role", 200),
    workspace: workspaceSelector(record.workspace),
    model: modelPolicy(record.model),
    tools: toolPolicy(record.tools),
    knowledge: knowledgeReferences(record.knowledge),
    completionGates: completionGates(record.completionGates),
    approvals: approvalPolicy(record.approvals),
    variables,
    ...(record.guardian === undefined ? {} : { guardian: guardianPolicy(record.guardian) })
  };
  validateTemplateReferences(definition, variables);
  return definition;
}

function guardianPolicy(value: unknown): BlueprintGuardianPolicy {
  const record = object(value, "Guardian policy");
  allowedKeys(record, ["stallTimeoutMinutes", "escalationModel"]);
  const stallTimeoutMinutes = Number(record.stallTimeoutMinutes);
  if (!Number.isInteger(stallTimeoutMinutes) || stallTimeoutMinutes < 1 || stallTimeoutMinutes > 24 * 60) {
    throw new BlueprintValidationError("Guardian stall timeout must be between 1 and 1440 minutes");
  }
  return {
    stallTimeoutMinutes,
    ...(record.escalationModel === undefined ? {} : {
      escalationModel: optionalIdentifier(record.escalationModel, "Guardian escalation model", 128, /^[a-zA-Z0-9._:/-]+$/)
    })
  };
}

function workspaceSelector(value: unknown): BlueprintWorkspaceSelector {
  const record = object(value, "Workspace selector");
  allowedKeys(record, ["selector", "value"]);
  const selector = oneOf(record.selector, ["current", "fixed", "variable"] as const, "Workspace selector");
  const selectedValue = optionalText(record.value, "Workspace selector value", 4_096);
  if (selector !== "current" && !selectedValue) throw new BlueprintValidationError(`${selector} workspace selectors require a value`);
  if (selector === "current" && selectedValue) throw new BlueprintValidationError("Current workspace selectors cannot contain a value");
  if (selector === "variable" && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(selectedValue || "")) {
    throw new BlueprintValidationError("Variable workspace selectors must use a reference such as ${WORKSPACE}");
  }
  return { selector, ...(selectedValue ? { value: selectedValue } : {}) };
}

function modelPolicy(value: unknown): BlueprintModelPolicy {
  const record = object(value, "Model policy");
  allowedKeys(record, ["backend", "routing", "model", "effort", "preset", "fallbacks"]);
  const backend = oneOf(record.backend, ["codex", "claude"] as const, "Model backend");
  const routing = oneOf(record.routing, ["fixed", "fallback"] as const, "Model routing policy");
  const model = identifier(record.model, "Model", 128, /^[a-zA-Z0-9._:/-]+$/);
  const effort = optionalIdentifier(record.effort, "Reasoning effort", 64, /^[a-zA-Z0-9_-]+$/);
  const preset = record.preset === undefined || record.preset === null
    ? null
    : oneOf(record.preset, ["quick", "balanced", "deep"] as const, "Model preset");
  const rawFallbacks = record.fallbacks === undefined ? [] : array(record.fallbacks, "Model fallbacks", 8);
  const fallbacks = rawFallbacks.map((item, index) => {
    const fallback = object(item, `Model fallback ${index + 1}`);
    allowedKeys(fallback, ["backend", "model", "effort"]);
    return {
      backend: oneOf(fallback.backend, ["codex", "claude"] as const, "Fallback backend"),
      model: identifier(fallback.model, "Fallback model", 128, /^[a-zA-Z0-9._:/-]+$/),
      effort: optionalIdentifier(fallback.effort, "Fallback effort", 64, /^[a-zA-Z0-9_-]+$/)
    };
  });
  if (preset) {
    const target = MODEL_PRESETS[preset];
    if (backend !== "codex") throw new BlueprintValidationError("Model presets only support the Codex backend");
    if (model !== target.model || effort !== target.effort) {
      throw new BlueprintValidationError(`${target.label} preset must use ${target.model} with ${target.effort} effort`);
    }
  }
  if (routing === "fixed" && fallbacks.length) throw new BlueprintValidationError("Fixed model policies cannot declare fallbacks");
  if (routing === "fallback" && !fallbacks.length) throw new BlueprintValidationError("Fallback model policies require at least one fallback");
  return { backend, routing, model, effort, ...(preset ? { preset } : {}), ...(fallbacks.length ? { fallbacks } : {}) };
}

function toolPolicy(value: unknown): AgentBlueprintDefinition["tools"] {
  const record = object(value, "Tool policy");
  allowedKeys(record, ["enable", "disable"]);
  const enable = stringArray(record.enable, "Enabled tools", 100, 128);
  const disable = stringArray(record.disable, "Disabled tools", 100, 128);
  const overlap = enable.find((tool) => disable.includes(tool));
  if (overlap) throw new BlueprintValidationError(`Tool ${overlap} cannot be both enabled and disabled`);
  return { enable, disable };
}

function knowledgeReferences(value: unknown): AgentBlueprintDefinition["knowledge"] {
  return array(value, "Knowledge references", 100).map((item, index) => {
    const reference = object(item, `Knowledge reference ${index + 1}`);
    allowedKeys(reference, ["type", "reference"]);
    const type = oneOf(reference.type, ["file", "url"] as const, "Knowledge reference type");
    const pathOrUrl = template(reference.reference, "Knowledge reference", 4_096);
    if (type === "url") validateSecretFreeUrl(pathOrUrl);
    return { type, reference: pathOrUrl };
  });
}

function completionGates(value: unknown): AgentBlueprintDefinition["completionGates"] {
  return array(value, "Completion gates", 50).map((item, index) => {
    const gate = object(item, `Completion gate ${index + 1}`);
    allowedKeys(gate, ["name", "description", "required", "artifactType", "artifactName", "path", "schema", "minimumCount", "mustPass", "trust"]);
    if (typeof gate.required !== "boolean") throw new BlueprintValidationError("Completion gate required must be a boolean");
    if (gate.mustPass !== undefined && typeof gate.mustPass !== "boolean") throw new BlueprintValidationError("Completion gate mustPass must be a boolean");
    const minimumCount = gate.minimumCount === undefined ? undefined : Number(gate.minimumCount);
    if (minimumCount !== undefined && (!Number.isInteger(minimumCount) || minimumCount < 1 || minimumCount > 100)) {
      throw new BlueprintValidationError("Completion gate minimumCount must be between 1 and 100");
    }
    const schema = gate.schema === undefined ? undefined : object(gate.schema, "Completion gate schema");
    return {
      name: text(gate.name, "Completion gate name", 100),
      description: text(gate.description, "Completion gate description", 1_000),
      required: gate.required,
      ...(gate.artifactType === undefined ? {} : { artifactType: oneOf(gate.artifactType, ["FileArtifact", "PatchArtifact", "TestResultArtifact", "CommandArtifact", "ReviewVerdictArtifact"] as const, "Completion gate artifact type") }),
      ...(gate.artifactName === undefined ? {} : { artifactName: text(gate.artifactName, "Completion gate artifact name", 200) }),
      ...(gate.path === undefined ? {} : { path: text(gate.path, "Completion gate path", 4_096) }),
      ...(schema === undefined ? {} : { schema }),
      ...(minimumCount === undefined ? {} : { minimumCount }),
      ...(gate.mustPass === undefined ? {} : { mustPass: gate.mustPass }),
      ...(gate.trust === undefined ? {} : { trust: oneOf(gate.trust, ["deterministic", "human", "advisory"] as const, "Completion gate trust") })
    };
  });
}

function approvalPolicy(value: unknown): AgentBlueprintDefinition["approvals"] {
  const record = object(value, "Approval requirements");
  allowedKeys(record, ["mode", "requiredFor"]);
  return {
    mode: oneOf(record.mode, ["on-request", "never", "plan"] as const, "Approval mode"),
    requiredFor: stringArray(record.requiredFor, "Approval requirements", 50, 200)
  };
}

function variableSchemas(value: unknown): BlueprintVariableSchema[] {
  const names = new Set<string>();
  return array(value, "Input variables", 100).map((item, index) => {
    const variable = object(item, `Input variable ${index + 1}`);
    allowedKeys(variable, ["name", "type", "description", "required", "secret", "default"]);
    const name = identifier(variable.name, "Variable name", 64, /^[A-Za-z_][A-Za-z0-9_]*$/);
    if (names.has(name)) throw new BlueprintValidationError(`Variable ${name} is declared more than once`);
    names.add(name);
    const type = oneOf(variable.type, ["string", "number", "boolean"] as const, "Variable type");
    if (typeof variable.required !== "boolean") throw new BlueprintValidationError(`Variable ${name} required must be a boolean`);
    if (variable.secret !== undefined && typeof variable.secret !== "boolean") throw new BlueprintValidationError(`Variable ${name} secret must be a boolean`);
    const secret = variable.secret === true;
    if (/password|secret|credential|token|api_?key|private_?key/i.test(name) && !secret) {
      throw new BlueprintValidationError(`Credential-like variable ${name} must be marked secret`);
    }
    if (secret && type !== "string") throw new BlueprintValidationError(`Secret variable ${name} must use the string type`);
    if (secret && variable.default !== undefined) throw new BlueprintValidationError(`Secret variable ${name} cannot contain a default value`);
    const defaultValue = variable.default === undefined ? undefined : variableValue(variable.default, type, `Variable ${name} default`);
    return {
      name,
      type,
      description: optionalText(variable.description, `Variable ${name} description`, 500) || undefined,
      required: variable.required,
      ...(secret ? { secret: true } : {}),
      ...(defaultValue === undefined ? {} : { default: defaultValue })
    };
  });
}

function validateTemplateReferences(definition: AgentBlueprintDefinition, variables: BlueprintVariableSchema[]): void {
  const declarations = new Set(variables.map((variable) => variable.name));
  const strings = [
    definition.promptTemplate,
    definition.workspace.value || "",
    ...definition.knowledge.map((item) => item.reference)
  ];
  for (const value of strings) {
    for (const name of templateReferences(value)) {
      if (!declarations.has(name)) throw new BlueprintValidationError(`Template references undeclared variable ${name}`);
    }
  }
  for (const variable of variables) {
    if (variable.secret && !strings.some((value) => value.includes(`\${${variable.name}}`))) {
      throw new BlueprintValidationError(`Secret variable ${variable.name} must be used through a ${"${"}${variable.name}} reference`);
    }
  }
}

function resolveVariables(schemas: BlueprintVariableSchema[], value: unknown): Record<string, BlueprintVariableValue> {
  const supplied = value === undefined || value === null ? {} : object(value, "Blueprint variables");
  const known = new Set(schemas.map((schema) => schema.name));
  const unknown = Object.keys(supplied).filter((name) => !known.has(name));
  if (unknown.length) throw new BlueprintValidationError(`Unknown blueprint variable${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  const resolved: Record<string, BlueprintVariableValue> = {};
  for (const schema of schemas) {
    if (schema.secret) {
      if (supplied[schema.name] !== undefined) throw new BlueprintValidationError(`Secret variable ${schema.name} must be resolved by its environment reference`);
      continue;
    }
    const raw = supplied[schema.name] ?? schema.default;
    if (raw === undefined) {
      if (schema.required) throw new BlueprintValidationError(`Blueprint variable ${schema.name} is required`);
      continue;
    }
    resolved[schema.name] = variableValue(raw, schema.type, `Blueprint variable ${schema.name}`);
  }
  return resolved;
}

function interpolateTemplate(templateValue: string, values: Record<string, BlueprintVariableValue>, schemas: BlueprintVariableSchema[]): string {
  const secretNames = new Set(schemas.filter((schema) => schema.secret).map((schema) => schema.name));
  return templateValue.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (reference, name: string) => {
    if (secretNames.has(name)) return reference;
    const value = values[name];
    return value === undefined ? "" : String(value);
  });
}

function manifestFromRow(row: BlueprintVersionStoreRow): AgentBlueprintManifest {
  return validateBlueprintManifest(JSON.parse(row.payload) as unknown);
}

function validateSecretFreeUrl(value: string): void {
  if (value.includes("${")) return;
  let url: URL;
  try { url = new URL(value); } catch { throw new BlueprintValidationError("URL knowledge references must be valid URLs or variable templates"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new BlueprintValidationError("URL knowledge references must use HTTP or HTTPS");
  if (url.username || url.password) throw new BlueprintValidationError("URL knowledge references cannot embed credentials");
  for (const key of url.searchParams.keys()) {
    if (/token|secret|password|credential|api[_-]?key/i.test(key)) {
      throw new BlueprintValidationError(`URL knowledge reference query parameter ${key} must use a variable reference`);
    }
  }
}

function templateReferences(value: string): string[] {
  return [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]);
}

function variableValue(value: unknown, type: BlueprintVariableType, label: string): BlueprintVariableValue {
  if (type === "string" && typeof value === "string" && value.length <= 10_000) return value;
  if (type === "number" && typeof value === "number" && Number.isFinite(value)) return value;
  if (type === "boolean" && typeof value === "boolean") return value;
  throw new BlueprintValidationError(`${label} must be a ${type}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BlueprintValidationError(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new BlueprintValidationError(`${label} must be an array`);
  if (value.length > maximum) throw new BlueprintValidationError(`${label} can contain at most ${maximum} entries`);
  return value;
}

function allowedKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new BlueprintValidationError(`Unknown blueprint field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new BlueprintValidationError(`${label} is required`);
  if (value.length > maximum) throw new BlueprintValidationError(`${label} must be ${maximum} characters or fewer`);
  if (/\u0000/.test(value)) throw new BlueprintValidationError(`${label} cannot contain null characters`);
  return value.trim();
}

function template(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new BlueprintValidationError(`${label} must be a string`);
  if (value.length > maximum) throw new BlueprintValidationError(`${label} must be ${maximum} characters or fewer`);
  if (/\u0000/.test(value)) throw new BlueprintValidationError(`${label} cannot contain null characters`);
  return value;
}

function optionalText(value: unknown, label: string, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return text(value, label, maximum);
}

function identifier(value: unknown, label: string, maximum: number, pattern: RegExp): string {
  const result = text(value, label, maximum);
  if (!pattern.test(result)) throw new BlueprintValidationError(`${label} contains invalid characters`);
  return result;
}

function optionalIdentifier(value: unknown, label: string, maximum: number, pattern: RegExp): string | null {
  if (value === undefined || value === null || value === "") return null;
  return identifier(value, label, maximum, pattern);
}

function stringArray(value: unknown, label: string, maximum: number, itemMaximum: number): string[] {
  const values = array(value, label, maximum).map((item) => text(item, label, itemMaximum));
  if (new Set(values).size !== values.length) throw new BlueprintValidationError(`${label} cannot contain duplicates`);
  return values;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new BlueprintValidationError(`${label} must be one of: ${choices.join(", ")}`);
  }
  return value as T;
}

function blueprintId(value: unknown): string {
  return identifier(value, "Blueprint ID", 128, /^[a-zA-Z0-9._:-]+$/);
}

function blueprintVersion(value: unknown): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new BlueprintValidationError("Blueprint version must be a positive integer");
  return version;
}

function timestamp(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new BlueprintValidationError("Blueprint creation timestamp is invalid");
  return result;
}
