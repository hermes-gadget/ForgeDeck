import { randomUUID } from "node:crypto";
import {
  BlueprintManager,
  BlueprintValidationError,
  type BlueprintVariableValue
} from "./blueprints.js";
import {
  TransactionalStore,
  type MissionRunStoreRow,
  type MissionState,
  type MissionVersionStoreRow
} from "./store.js";

const MISSION_SCHEMA_VERSION = 1 as const;

type MissionValueSource =
  | { source: "mission"; key: string }
  | { source: "node"; nodeId: string; key: string }
  | { source: "literal"; value: BlueprintVariableValue };

type MissionNodeDefinition = {
  id: string;
  name: string;
  blueprintId: string;
  blueprintVersion: number;
  dependsOn: string[];
  inputMapping: Record<string, MissionValueSource>;
  outputMapping: Record<string, string>;
};

export type MissionManifest = {
  schemaVersion: typeof MISSION_SCHEMA_VERSION;
  id: string;
  name: string;
  description: string;
  version: number;
  createdAt: number;
  nodes: MissionNodeDefinition[];
};

type MissionNodeState = "pending" | "running" | "completed" | "failed";

export type MissionNodeRun = {
  nodeId: string;
  state: MissionNodeState;
  inputs: Record<string, BlueprintVariableValue>;
  outputs: Record<string, unknown>;
  operationId: string | null;
  threadId: string | null;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
};

export type MissionRun = {
  id: string;
  missionId: string;
  missionVersion: number;
  state: MissionState;
  inputs: Record<string, BlueprintVariableValue>;
  workspace: string | null;
  outputs: Record<string, Record<string, unknown>>;
  nodes: MissionNodeRun[];
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
};

export type Mission = MissionManifest & {
  state: MissionState;
  latestRun: MissionRun | null;
};

export type MissionExecution = {
  mission: MissionManifest;
  run: MissionRun;
  node: MissionNodeDefinition;
  nodeRun: MissionNodeRun;
  inputs: Record<string, BlueprintVariableValue>;
};

export type MissionNodeInspection =
  | { state: "running"; threadId?: string | null }
  | { state: "completed"; threadId: string; output: Record<string, unknown> }
  | { state: "failed"; threadId?: string | null; error: string };

type MissionDraft = {
  id?: string;
  name: string;
  description: string;
  nodes: Array<Omit<MissionNodeDefinition, "blueprintVersion"> & { blueprintVersion?: number }>;
};

export class MissionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionValidationError";
  }
}

export class MissionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionConflictError";
  }
}

export class MissionManager {
  constructor(
    private readonly store: TransactionalStore,
    private readonly blueprints: BlueprintManager,
    private readonly now: () => number = Date.now
  ) {}

  create(value: unknown): Mission {
    const draft = validateMissionDraft(value);
    const id = draft.id || randomUUID();
    const latest = this.store.latestMissionVersion(id);
    const nodes = draft.nodes.map((node) => {
      const blueprint = this.blueprints.get(node.blueprintId, node.blueprintVersion);
      if (!blueprint) throw new MissionValidationError(`Blueprint for node ${node.id} was not found`);
      validateBlueprintInputs(node, blueprint.definition.variables);
      return { ...node, blueprintVersion: blueprint.version };
    });
    validateGraph(nodes);
    const manifest: MissionManifest = {
      schemaVersion: MISSION_SCHEMA_VERSION,
      id,
      name: draft.name,
      description: draft.description,
      version: (latest?.version || 0) + 1,
      createdAt: this.timestamp(),
      nodes
    };
    try {
      this.store.insertMissionVersion(toVersionRow(manifest));
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        throw new MissionConflictError(`Mission ${id} version ${manifest.version} already exists`);
      }
      throw error;
    }
    return { ...structuredClone(manifest), state: "pending", latestRun: null };
  }

  get(idValue: unknown, versionValue?: unknown): Mission | null {
    const id = missionId(idValue);
    const row = versionValue === undefined || versionValue === null
      ? this.store.latestMissionVersion(id)
      : this.store.getMissionVersion(id, positiveInteger(versionValue, "Mission version"));
    if (!row) return null;
    return this.resource(manifestFromRow(row));
  }

  list(): Mission[] {
    return this.store.listLatestMissionVersions().map((row) => this.resource(manifestFromRow(row)));
  }

  delete(idValue: unknown): boolean {
    const id = missionId(idValue);
    if (this.store.listUnfinishedMissionRuns(10_000).some((run) => run.missionId === id)) {
      throw new MissionConflictError("A pending, running, or paused mission cannot be deleted");
    }
    return this.store.deleteMission(id);
  }

  start(idValue: unknown, value: unknown = {}): Mission {
    const id = missionId(idValue);
    const row = this.store.latestMissionVersion(id);
    if (!row) throw new MissionValidationError("Mission was not found");
    if (this.store.listUnfinishedMissionRuns(10_000).some((candidate) => candidate.missionId === id)) {
      throw new MissionConflictError("Mission already has a pending, running, or paused run");
    }
    const request = validateRunRequest(value);
    const manifest = manifestFromRow(row);
    const timestamp = this.timestamp();
    const run: MissionRun = {
      id: randomUUID(),
      missionId: manifest.id,
      missionVersion: manifest.version,
      state: "pending",
      inputs: request.inputs,
      workspace: request.workspace,
      outputs: {},
      nodes: manifest.nodes.map((node) => ({
        nodeId: node.id,
        state: "pending",
        inputs: {},
        outputs: {},
        operationId: null,
        threadId: null,
        error: null,
        startedAt: null,
        completedAt: null
      })),
      error: null,
      createdAt: timestamp,
      startedAt: null,
      updatedAt: timestamp,
      completedAt: null
    };
    this.store.insertMissionRun(toRunRow(run));
    return { ...manifest, state: run.state, latestRun: structuredClone(run) };
  }

  unfinishedRuns(): MissionRun[] {
    return this.store.listUnfinishedMissionRuns().map(runFromRow);
  }

  manifestForRun(run: MissionRun): MissionManifest | null {
    const row = this.store.getMissionVersion(run.missionId, run.missionVersion);
    return row ? manifestFromRow(row) : null;
  }

  updateRun(run: MissionRun): MissionRun {
    const updated = { ...structuredClone(run), updatedAt: this.timestamp() };
    if (!this.store.updateMissionRun(toRunRow(updated))) throw new MissionValidationError("Mission run was not found");
    return updated;
  }

  private resource(manifest: MissionManifest): Mission {
    const row = this.store.latestMissionRun(manifest.id, manifest.version);
    const latestRun = row ? runFromRow(row) : null;
    return {
      ...structuredClone(manifest),
      state: latestRun?.state || "pending",
      latestRun
    };
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isFinite(value) || value < 0) throw new RangeError("Mission clock must return a non-negative timestamp");
    return Math.round(value);
  }
}

export class MissionRunner {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly missions: MissionManager,
    private readonly execute: (execution: MissionExecution) => Promise<{ operationId: string; threadId?: string | null }>,
    private readonly inspect: (run: MissionRun, nodeRun: MissionNodeRun) => Promise<MissionNodeInspection>,
    private readonly intervalMs = 1_500,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) throw new RangeError("Mission check interval must be positive");
  }

  start(): void {
    if (this.timer) return;
    void this.tick().catch(this.onError);
    this.timer = setInterval(() => void this.tick().catch(this.onError), this.intervalMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const run of this.missions.unfinishedRuns()) {
        if (run.state === "paused") continue;
        await this.advance(run);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async advance(runValue: MissionRun): Promise<void> {
    let run = runValue;
    const manifest = this.missions.manifestForRun(run);
    if (!manifest) {
      this.fail(run, null, "Mission definition was not found");
      return;
    }
    if (run.state === "pending") {
      run = this.missions.updateRun({ ...run, state: "running", startedAt: run.startedAt || run.updatedAt });
    }

    const active = run.nodes.find((node) => node.state === "running");
    if (active) {
      if (!active.operationId) {
        await this.launch(manifest, run, active);
        return;
      }
      const inspection = await this.inspect(run, active);
      if (inspection.state === "running") {
        if (inspection.threadId && inspection.threadId !== active.threadId) {
          this.missions.updateRun(replaceNode(run, { ...active, threadId: inspection.threadId }));
        }
        return;
      }
      if (inspection.state === "failed") {
        this.fail(run, active, inspection.error, inspection.threadId);
        return;
      }
      try {
        const definition = manifest.nodes.find((node) => node.id === active.nodeId)!;
        const outputs = applyOutputMapping(definition.outputMapping, inspection.output);
        const completedNode: MissionNodeRun = {
          ...active,
          state: "completed",
          outputs,
          threadId: inspection.threadId,
          completedAt: run.updatedAt,
          error: null
        };
        this.missions.updateRun(replaceNode(run, completedNode));
      } catch (error) {
        this.fail(run, active, errorMessage(error), inspection.threadId);
      }
      return;
    }

    const completedIds = new Set(run.nodes.filter((node) => node.state === "completed").map((node) => node.nodeId));
    const nextDefinition = manifest.nodes.find((node) => {
      const nodeRun = run.nodes.find((candidate) => candidate.nodeId === node.id);
      return nodeRun?.state === "pending" && node.dependsOn.every((dependency) => completedIds.has(dependency));
    });
    if (nextDefinition) {
      const nodeRun = run.nodes.find((node) => node.nodeId === nextDefinition.id)!;
      try {
        const inputs = resolveNodeInputs(nextDefinition, run);
        const runningNode: MissionNodeRun = {
          ...nodeRun,
          state: "running",
          inputs,
          startedAt: run.updatedAt,
          error: null
        };
        const updated = this.missions.updateRun(replaceNode(run, runningNode));
        await this.launch(manifest, updated, updated.nodes.find((node) => node.nodeId === runningNode.nodeId)!);
      } catch (error) {
        this.fail(run, nodeRun, errorMessage(error));
      }
      return;
    }

    if (run.nodes.every((node) => node.state === "completed")) {
      const outputs = Object.fromEntries(run.nodes.map((node) => [node.nodeId, node.outputs]));
      this.missions.updateRun({
        ...run,
        state: "completed",
        outputs,
        completedAt: run.updatedAt,
        error: null
      });
      return;
    }
    this.fail(run, null, "Mission graph could not make progress");
  }

  private async launch(manifest: MissionManifest, run: MissionRun, nodeRun: MissionNodeRun): Promise<void> {
    const node = manifest.nodes.find((candidate) => candidate.id === nodeRun.nodeId);
    if (!node) {
      this.fail(run, nodeRun, "Mission node definition was not found");
      return;
    }
    try {
      const result = await this.execute({ mission: manifest, run, node, nodeRun, inputs: nodeRun.inputs });
      this.missions.updateRun(replaceNode(run, {
        ...nodeRun,
        operationId: result.operationId,
        threadId: result.threadId || nodeRun.threadId
      }));
    } catch (error) {
      this.fail(run, nodeRun, errorMessage(error));
    }
  }

  private fail(run: MissionRun, node: MissionNodeRun | null, error: string, threadId?: string | null): void {
    const failedRun = node ? replaceNode(run, {
      ...node,
      state: "failed",
      threadId: threadId || node.threadId,
      error,
      completedAt: run.updatedAt
    }) : run;
    this.missions.updateRun({
      ...failedRun,
      state: "failed",
      error,
      completedAt: run.updatedAt
    });
  }
}

function validateMissionDraft(value: unknown): MissionDraft {
  const record = object(value, "Mission");
  allowedKeys(record, ["id", "name", "description", "nodes"]);
  if (!Array.isArray(record.nodes) || record.nodes.length < 1 || record.nodes.length > 50) {
    throw new MissionValidationError("Mission nodes must contain between 1 and 50 nodes");
  }
  return {
    ...(record.id === undefined ? {} : { id: missionId(record.id) }),
    name: text(record.name, "Mission name", 100),
    description: optionalText(record.description, "Mission description", 1_000),
    nodes: record.nodes.map((value, index) => validateNode(value, index))
  };
}

function validateNode(value: unknown, index: number): MissionDraft["nodes"][number] {
  const record = object(value, `Mission node ${index + 1}`);
  allowedKeys(record, ["id", "name", "blueprintId", "blueprintVersion", "dependsOn", "inputMapping", "outputMapping"]);
  const id = nodeId(record.id, `Mission node ${index + 1} ID`);
  const dependencies = stringArray(record.dependsOn ?? [], `${id} dependencies`, nodeId);
  if (new Set(dependencies).size !== dependencies.length) throw new MissionValidationError(`Node ${id} dependencies must be unique`);
  return {
    id,
    name: optionalText(record.name, `Node ${id} name`, 100) || id,
    blueprintId: identifier(record.blueprintId, `Node ${id} blueprint ID`, 128),
    ...(record.blueprintVersion === undefined || record.blueprintVersion === null
      ? {}
      : { blueprintVersion: positiveInteger(record.blueprintVersion, `Node ${id} blueprint version`) }),
    dependsOn: dependencies,
    inputMapping: inputMappings(record.inputMapping ?? {}, id),
    outputMapping: outputMappings(record.outputMapping ?? {}, id)
  };
}

function inputMappings(value: unknown, node: string): Record<string, MissionValueSource> {
  const record = object(value, `Node ${node} input mapping`);
  if (Object.keys(record).length > 100) throw new MissionValidationError(`Node ${node} has too many input mappings`);
  return Object.fromEntries(Object.entries(record).map(([target, candidate]) => {
    const name = variableName(target, `Node ${node} input name`);
    const source = object(candidate, `Node ${node} input ${name}`);
    if (source.source === "mission") {
      allowedKeys(source, ["source", "key"]);
      return [name, { source: "mission", key: variableName(source.key, `Node ${node} mission input key`) }];
    }
    if (source.source === "node") {
      allowedKeys(source, ["source", "nodeId", "key"]);
      return [name, {
        source: "node",
        nodeId: nodeId(source.nodeId, `Node ${node} input source node`),
        key: variableName(source.key, `Node ${node} output key`)
      }];
    }
    if (source.source === "literal") {
      allowedKeys(source, ["source", "value"]);
      return [name, { source: "literal", value: primitive(source.value, `Node ${node} literal input`) }];
    }
    throw new MissionValidationError(`Node ${node} input ${name} has an invalid source`);
  }));
}

function outputMappings(value: unknown, node: string): Record<string, string> {
  const record = object(value, `Node ${node} output mapping`);
  if (Object.keys(record).length > 100) throw new MissionValidationError(`Node ${node} has too many output mappings`);
  return Object.fromEntries(Object.entries(record).map(([target, path]) => [
    variableName(target, `Node ${node} output name`),
    outputPath(path, `Node ${node} output path`)
  ]));
}

function validateBlueprintInputs(
  node: MissionDraft["nodes"][number],
  variables: Array<{ name: string; required: boolean; secret?: boolean; default?: BlueprintVariableValue }>
): void {
  const accepted = new Map(variables.filter((variable) => !variable.secret).map((variable) => [variable.name, variable]));
  for (const target of Object.keys(node.inputMapping)) {
    if (!accepted.has(target)) throw new MissionValidationError(`Node ${node.id} maps unknown blueprint input ${target}`);
  }
  for (const variable of accepted.values()) {
    if (variable.required && variable.default === undefined && !node.inputMapping[variable.name]) {
      throw new MissionValidationError(`Node ${node.id} must map required blueprint input ${variable.name}`);
    }
  }
}

function validateGraph(nodes: MissionNodeDefinition[]): void {
  const byId = new Map<string, MissionNodeDefinition>();
  for (const node of nodes) {
    if (byId.has(node.id)) throw new MissionValidationError(`Mission node ID ${node.id} is duplicated`);
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) throw new MissionValidationError(`Node ${node.id} depends on unknown node ${dependency}`);
      if (dependency === node.id) throw new MissionValidationError(`Node ${node.id} cannot depend on itself`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeIdValue: string): void => {
    if (visiting.has(nodeIdValue)) throw new MissionValidationError("Mission graph must not contain a cycle");
    if (visited.has(nodeIdValue)) return;
    visiting.add(nodeIdValue);
    for (const dependency of byId.get(nodeIdValue)!.dependsOn) visit(dependency);
    visiting.delete(nodeIdValue);
    visited.add(nodeIdValue);
  };
  for (const node of nodes) visit(node.id);

  const ancestors = (nodeIdValue: string, found = new Set<string>()): Set<string> => {
    for (const dependency of byId.get(nodeIdValue)!.dependsOn) {
      if (found.has(dependency)) continue;
      found.add(dependency);
      ancestors(dependency, found);
    }
    return found;
  };
  for (const node of nodes) {
    const allowedSources = ancestors(node.id);
    for (const mapping of Object.values(node.inputMapping)) {
      if (mapping.source === "node" && !allowedSources.has(mapping.nodeId)) {
        throw new MissionValidationError(`Node ${node.id} must depend on output source ${mapping.nodeId}`);
      }
      if (mapping.source === "node" && !byId.get(mapping.nodeId)?.outputMapping[mapping.key]) {
        throw new MissionValidationError(`Node ${node.id} references unmapped output ${mapping.nodeId}.${mapping.key}`);
      }
    }
  }
}

function validateRunRequest(value: unknown): { inputs: Record<string, BlueprintVariableValue>; workspace: string | null } {
  const record = object(value ?? {}, "Mission run");
  allowedKeys(record, ["inputs", "workspace"]);
  const inputs = object(record.inputs ?? {}, "Mission inputs");
  if (Object.keys(inputs).length > 100) throw new MissionValidationError("Mission inputs are limited to 100 values");
  return {
    inputs: Object.fromEntries(Object.entries(inputs).map(([key, candidate]) => [
      variableName(key, "Mission input name"),
      primitive(candidate, `Mission input ${key}`)
    ])),
    workspace: record.workspace === undefined || record.workspace === null
      ? null
      : text(record.workspace, "Mission workspace", 4_096)
  };
}

function resolveNodeInputs(node: MissionNodeDefinition, run: MissionRun): Record<string, BlueprintVariableValue> {
  return Object.fromEntries(Object.entries(node.inputMapping).map(([target, source]) => {
    if (source.source === "literal") return [target, source.value];
    if (source.source === "mission") {
      const value = run.inputs[source.key];
      if (value === undefined) throw new MissionValidationError(`Mission input ${source.key} is required by node ${node.id}`);
      return [target, value];
    }
    const sourceNode = run.nodes.find((candidate) => candidate.nodeId === source.nodeId);
    const value = sourceNode?.outputs[source.key];
    if (!isPrimitive(value)) {
      throw new MissionValidationError(`Node output ${source.nodeId}.${source.key} is unavailable or is not a blueprint value`);
    }
    return [target, value];
  }));
}

function applyOutputMapping(mapping: Record<string, string>, output: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(mapping).map(([name, path]) => {
    const value = path.split(".").reduce<unknown>((current, segment) => {
      if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
      return (current as Record<string, unknown>)[segment];
    }, output);
    if (value === undefined) throw new MissionValidationError(`Node output path ${path} was not produced`);
    return [name, value];
  }));
}

function replaceNode(run: MissionRun, node: MissionNodeRun): MissionRun {
  return { ...run, nodes: run.nodes.map((candidate) => candidate.nodeId === node.nodeId ? node : candidate) };
}

function toVersionRow(manifest: MissionManifest): MissionVersionStoreRow {
  return {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    payload: JSON.stringify(manifest),
    createdAt: manifest.createdAt
  };
}

function manifestFromRow(row: MissionVersionStoreRow): MissionManifest {
  const manifest = JSON.parse(row.payload) as MissionManifest;
  if (manifest.schemaVersion !== MISSION_SCHEMA_VERSION) throw new MissionValidationError("Unsupported mission schema version");
  return structuredClone(manifest);
}

function toRunRow(run: MissionRun): MissionRunStoreRow {
  return {
    id: run.id,
    missionId: run.missionId,
    missionVersion: run.missionVersion,
    state: run.state,
    payload: JSON.stringify(run),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt
  };
}

function runFromRow(row: MissionRunStoreRow): MissionRun {
  return structuredClone(JSON.parse(row.payload) as MissionRun);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MissionValidationError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function allowedKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const extra = Object.keys(record).find((key) => !keys.includes(key));
  if (extra) throw new MissionValidationError(`Unexpected field ${extra}`);
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000]/.test(value)) {
    throw new MissionValidationError(`${label} must contain between 1 and ${maximum} characters`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string, maximum: number): string {
  if (value === undefined || value === null || value === "") return "";
  return text(value, label, maximum);
}

function identifier(value: unknown, label: string, maximum: number): string {
  const result = text(value, label, maximum);
  if (!/^[a-zA-Z0-9._:-]+$/.test(result)) throw new MissionValidationError(`${label} contains invalid characters`);
  return result;
}

function missionId(value: unknown): string {
  return identifier(value, "Mission ID", 128);
}

function nodeId(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(result)) {
    throw new MissionValidationError(`${label} must start with a letter and contain only letters, numbers, underscores, or hyphens`);
  }
  return result;
}

function variableName(value: unknown, label: string): string {
  const result = text(value, label, 100);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) throw new MissionValidationError(`${label} is invalid`);
  return result;
}

function outputPath(value: unknown, label: string): string {
  const result = text(value, label, 500);
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(result)) {
    throw new MissionValidationError(`${label} must be a dot-separated object path`);
  }
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new MissionValidationError(`${label} must be a positive integer`);
  return number;
}

function stringArray(
  value: unknown,
  label: string,
  validator: (value: unknown, label: string) => string
): string[] {
  if (!Array.isArray(value) || value.length > 50) throw new MissionValidationError(`${label} must be an array of at most 50 values`);
  return value.map((candidate) => validator(candidate, label));
}

function primitive(value: unknown, label: string): BlueprintVariableValue {
  if (!isPrimitive(value)) throw new MissionValidationError(`${label} must be a string, number, or boolean`);
  if (typeof value === "number" && !Number.isFinite(value)) throw new MissionValidationError(`${label} must be finite`);
  return value;
}

function isPrimitive(value: unknown): value is BlueprintVariableValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function errorMessage(error: unknown): string {
  if (error instanceof BlueprintValidationError || error instanceof MissionValidationError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
