import test from "node:test";
import assert from "node:assert/strict";
import { isApplyPatchCall, isInjectedUserContext } from "./external-monitor.js";

test("standalone Codex context records are hidden from chat", () => {
  assert.equal(isInjectedUserContext("<environment_context>\n  <cwd>/workspace</cwd>\n</environment_context>"), true);
  assert.equal(isInjectedUserContext("<codex_internal_context source=\"goal\">continue</codex_internal_context>"), true);
});

test("real user messages mentioning environment context remain visible", () => {
  assert.equal(isInjectedUserContext("Please fix this: <environment_context>example</environment_context>"), false);
  assert.equal(isInjectedUserContext("testing followup in ForgeDeck"), false);
});

test("apply_patch wrappers are not classified as shell commands", () => {
  assert.equal(isApplyPatchCall('text(await tools.apply_patch("*** Begin Patch\\n*** End Patch"))'), true);
  assert.equal(isApplyPatchCall('await tools.exec_command({ cmd: "npm test" })'), false);
});
