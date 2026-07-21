import assert from "node:assert/strict";
import test from "node:test";
import { sessionExportSchema } from "../shared/contracts.js";
import { createSessionExport, sessionExportToMarkdown } from "./session-export.js";

const workspace = "/home/alice/private/project";
const secretToken = "ghp_1234567890abcdef";
const rawToolOutput = "RAW_TOOL_OUTPUT_MUST_NOT_EXPORT";
const rawDiff = "+token=do-not-export-this-diff";

test("session exports retain run provenance and summaries without raw tool data", () => {
  const record = createSessionExport({
    id: "thread-12345678",
    name: "Review session",
    preview: "Reviewed the change",
    cwd: workspace,
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    sessionClass: "standard",
    category: "Review",
    tags: ["release"],
    blueprintId: "review-blueprint",
    blueprintVersion: 3,
    createdAt: 2_000_000_000_000,
    updatedAt: 2_000_000_065_000,
    status: { type: "idle" },
    turns: [{
      id: "turn-1",
      status: "completed",
      startedAt: 2_000_000_001_000,
      completedAt: 2_000_000_061_000,
      items: [
        { type: "userMessage", content: [{ type: "text", text: `Review ${workspace}; token=${secretToken}` }] },
        { type: "commandExecution", command: "npm test", aggregatedOutput: rawToolOutput },
        { id: "files-1", type: "fileChange", status: "completed", changes: [
          { path: `${workspace}/src/index.ts`, kind: "update", diff: rawDiff },
          { path: "/etc/passwd", kind: "read" }
        ] },
        { type: "agentMessage", text: `Authorization: Bearer abc.def-123\nUpdated ${workspace}/src/index.ts` }
      ]
    }]
  }, { exportedAt: 2_000_000_070_000 });

  assert.doesNotThrow(() => sessionExportSchema.parse(record));
  assert.equal(record.provenance.sessionId, "thread-12345678");
  assert.equal(record.provenance.blueprintId, "review-blueprint");
  assert.equal(record.provenance.blueprintVersion, 3);
  assert.equal(record.session.durationMs, 65_000);
  assert.equal(record.session.workspace, "project");
  assert.equal(record.prompt, "Review [WORKSPACE]; token=[REDACTED]");
  assert.equal(record.runs[0].durationMs, 60_000);
  assert.deepEqual(record.artifactSummaries[0].files, [
    { path: "src/index.ts", operation: "update" },
    { path: "passwd", operation: "read" }
  ]);
  assert.equal(record.keyOutputs[0].text, "Authorization: [REDACTED]\nUpdated [WORKSPACE]/src/index.ts");

  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, new RegExp(secretToken));
  assert.doesNotMatch(serialized, /abc\.def-123/);
  assert.doesNotMatch(serialized, /home\/alice/);
  assert.doesNotMatch(serialized, new RegExp(rawToolOutput));
  assert.doesNotMatch(serialized, /do-not-export-this-diff/);
});

test("Markdown exports are structured and use the same redacted record", () => {
  const record = createSessionExport({
    id: "thread-87654321",
    name: "Final report",
    cwd: workspace,
    createdAt: 2_000_000_000,
    updatedAt: 2_000_000_005,
    status: { type: "idle" },
    turns: []
  }, {
    exportedAt: 2_000_000_006,
    metadata: { lastPrompt: `password=hunter2 in ${workspace}` }
  });
  const markdown = sessionExportToMarkdown(record);

  assert.match(markdown, /^# ForgeDeck session export:/);
  assert.match(markdown, /## Provenance/);
  assert.match(markdown, /## Run records/);
  assert.match(markdown, /## Artifact summaries/);
  assert.match(markdown, /## Key outputs/);
  assert.match(markdown, /password=\[REDACTED\] in \[WORKSPACE\]/);
  assert.doesNotMatch(markdown, /hunter2/);
  assert.doesNotMatch(markdown, /home\/alice/);
});

test("persisted artifact summaries omit artifact content by default", () => {
  const artifactSecret = "sk-1234567890abcdefghijkl";
  const record = createSessionExport({
    id: "thread-artifact1",
    cwd: workspace,
    createdAt: 2_000_000_000,
    updatedAt: 2_000_000_001,
    status: { type: "idle" },
    turns: [{ id: "turn-1", status: "completed", items: [] }]
  }, {
    artifacts: [{
      id: "11111111-1111-4111-8111-111111111111",
      type: "CommandArtifact",
      name: "Build result",
      version: 2,
      producer: { turnId: "turn-1" },
      validation: { status: "valid" },
      createdAt: 2_000_000_000,
      content: { command: "npm run build", output: `credential ${artifactSecret}` }
    }]
  });

  assert.deepEqual(record.artifactSummaries, [{
    id: "11111111-1111-4111-8111-111111111111",
    turnId: "turn-1",
    type: "CommandArtifact",
    name: "Build result",
    version: 2,
    status: "valid",
    createdAt: "2033-05-18T03:33:20.000Z",
    fileCount: 0,
    files: []
  }]);
  assert.equal(record.runs[0].artifactCount, 1);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(artifactSecret));
});
