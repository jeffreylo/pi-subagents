import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AcceptanceLedger, ResultDisposition } from "../../src/shared/types.ts";
import {
	aggregateResultDisposition,
	deriveExecutionState,
	deriveResultDisposition,
	executionStateToResultStatus,
} from "../../src/runs/shared/outcome.ts";

function rejectedAcceptance(reviewStatus?: "blockers" | "needs-parent-decision"): AcceptanceLedger {
	return {
		status: "rejected",
		explicit: true,
		effectiveAcceptance: {
			level: "reviewed",
			explicit: true,
			inferredReason: [],
			criteria: [],
			evidence: [],
			verify: [],
			stopRules: [],
		},
		inferredReason: [],
		criteria: [],
		runtimeChecks: [],
		verifyRuns: [],
		...(reviewStatus ? {
			reviewResult: {
				status: reviewStatus,
				findings: [{ severity: reviewStatus === "blockers" ? "blocker" : "non-blocking", issue: "review unavailable", rationale: "independent review required" }],
			},
		} : {}),
	};
}

describe("orthogonal subagent outcomes", () => {
	it("derives every terminal execution state independently from result policy", () => {
		assert.equal(deriveExecutionState({ exitCode: 0 }), "completed");
		assert.equal(deriveExecutionState({ exitCode: 1 }), "failed");
		assert.equal(deriveExecutionState({ exitCode: 1, timedOut: true }), "timed-out");
		assert.equal(deriveExecutionState({ exitCode: 1, turnBudgetExceeded: true }), "budget-exceeded");
		assert.equal(deriveExecutionState({ exitCode: 0, interrupted: true }), "paused");
		assert.equal(deriveExecutionState({ exitCode: 1, stopped: true }), "stopped");
		assert.equal(deriveExecutionState({ exitCode: -2, detached: true }), "detached");
		assert.equal(executionStateToResultStatus("timed-out"), "failed");
		assert.equal(executionStateToResultStatus("budget-exceeded"), "failed");
	});

	it("distinguishes acceptance, completion-guard, and missing-review dispositions", () => {
		assert.deepEqual(deriveResultDisposition({}), { status: "not-required" });
		assert.deepEqual(deriveResultDisposition({ acceptance: { ...rejectedAcceptance(), status: "accepted" } }), { status: "accepted" });
		assert.deepEqual(deriveResultDisposition({ acceptance: rejectedAcceptance() }), {
			status: "rejected",
			source: "acceptance",
			reason: "Acceptance rejected.",
		});
		assert.deepEqual(deriveResultDisposition({ completionGuardTriggered: true }), {
			status: "rejected",
			source: "completion-guard",
			reason: "Subagent completed without making edits for an implementation task. It appears to have returned planning or scratchpad output instead of applying changes.",
		});
		assert.deepEqual(deriveResultDisposition({ acceptance: rejectedAcceptance("needs-parent-decision") }), {
			status: "review-required",
			source: "independent-review",
			reason: "Independent acceptance review is required but no reviewer result is available. Parent action is required.",
		});
	});

	it("aggregates rejected ahead of review-required without changing execution status", () => {
		const reviewRequired: ResultDisposition = { status: "review-required", source: "independent-review", reason: "review" };
		const rejected: ResultDisposition = { status: "rejected", source: "acceptance", reason: "rejected" };
		assert.equal(aggregateResultDisposition([{ status: "accepted" }, reviewRequired, rejected]).status, "rejected");
		assert.equal(aggregateResultDisposition([{ status: "accepted" }, reviewRequired]).status, "review-required");
	});
});
