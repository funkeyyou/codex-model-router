import { test } from "node:test";
import assert from "node:assert/strict";
import { antigravityFailureKind } from "../src/antigravity-cli.mjs";

test("Antigravity failure classifications distinguish timeout, process exit, ACP errors and validation", () => {
  const cases = [
    [Error("Antigravity CLI session ended"), { stage: "prompt", abortReason: "timeout" }, "turn_timeout"],
    [Error("Antigravity CLI session ended"), { stage: "prompt", closeReason: "process_exit" }, "acp_process_exit"],
    [Error("Antigravity CLI session ended"), { stage: "prompt", closeReason: "invalid_json" }, "acp_invalid_json"],
    [Error("Antigravity CLI session ended"), { stage: "prompt", closeReason: "buffer_limit" }, "acp_buffer_limit"],
    [Error("RESOURCE_EXHAUSTED (code 429)"), { stage: "prompt" }, "rate_limited"],
    [Error("UNAUTHENTICATED (code 401)"), { stage: "prompt" }, "auth_required"],
    [Error("PERMISSION_DENIED (code 403)"), { stage: "prompt" }, "permission_denied"],
    [Error("blocked by policy"), { stage: "prompt" }, "policy_rejected"],
    [Error("Antigravity turn ended early"), { stage: "stop_reason" }, "early_stop"],
    [new SyntaxError("secret response bytes"), { stage: "parse_response" }, "invalid_response_json"],
    [Error("Invalid Antigravity response format"), { stage: "parse_response" }, "invalid_response_format"],
    [Error("Antigravity response changed during streaming"), { stage: "stream_consistency" }, "stream_changed"],
    [Error("Antigravity CLI request failed"), { stage: "prompt" }, "acp_request_failed"],
  ];
  for (const [error, context, kind] of cases) assert.equal(antigravityFailureKind(error, context), kind);
});

test("untrusted ACP error text never appears in diagnostic category", () => {
  const secret = "TOKEN=user-private-message";
  assert.equal(antigravityFailureKind(Error(secret), { stage: "prompt" }), "acp_request_failed");
  assert.equal(antigravityFailureKind(Error(secret), { stage: "initialize" }), "unexpected_failure");
});
