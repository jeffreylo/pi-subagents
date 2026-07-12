import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ACCEPTANCE_REVIEW_RESULT_SCHEMA,
	continuationFeedback,
	hasNonIdempotentUncertainty,
	parseAcceptanceReviewResult,
	rejectionSignature,
	resolveContinuationMaxAttempts,
} from "../../src/runs/shared/continuation.ts";

describe("bounded continuation policy", () => {
	it("defaults to two writer attempts, disables explicitly, and caps at three", () => {
		assert.equal(resolveContinuationMaxAttempts(undefined), 2);
		assert.equal(resolveContinuationMaxAttempts(false), 1);
		assert.equal(resolveContinuationMaxAttempts({ maxAttempts: 3 }), 3);
		assert.equal(resolveContinuationMaxAttempts({ maxAttempts: 99 }), 3);
	});

	it("keys rejection signatures by source and normalized reason", () => {
		assert.equal(rejectionSignature({ status: "rejected", source: "acceptance", reason: " Missing   evidence " }), "acceptance:missing evidence");
	});

	it("builds fix-only feedback that forbids replaying external side effects", () => {
		const feedback = continuationFeedback("criterion-2 failed");
		assert.match(feedback, /Exact rejection reason: criterion-2 failed/);
		assert.match(feedback, /Do not replay the original task/);
		assert.match(feedback, /do not repeat completed external side effects/i);
		assert.equal(hasNonIdempotentUncertainty("Deploy and publish release"), true);
		assert.equal(hasNonIdempotentUncertainty("Implement a local parser fix"), false);
	});

	it("validates the internal structured review result", () => {
		assert.equal(ACCEPTANCE_REVIEW_RESULT_SCHEMA.type, "object");
		assert.deepEqual(parseAcceptanceReviewResult({ status: "no-blockers", findings: [] }), { status: "no-blockers", findings: [] });
		assert.deepEqual(parseAcceptanceReviewResult({ status: "blockers", findings: [{ severity: "blocker", file: "src/a.ts", issue: "race", rationale: "unsafe" }] }), { status: "blockers", findings: [{ severity: "blocker", file: "src/a.ts", issue: "race", rationale: "unsafe" }] });
		assert.equal(parseAcceptanceReviewResult({ status: "blockers", findings: [{ issue: "missing fields" }] }), undefined);
	});
});
