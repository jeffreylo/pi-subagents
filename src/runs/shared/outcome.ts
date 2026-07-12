import type {
	AcceptanceLedger,
	ExecutionState,
	ResultDisposition,
	SubagentResultStatus,
} from "../../shared/types.ts";

export const COMPLETION_GUARD_REJECTION_REASON = "Subagent completed without making edits for an implementation task. It appears to have returned planning or scratchpad output instead of applying changes.";

interface OutcomeLike {
	executionState?: ExecutionState;
	resultDisposition?: ResultDisposition;
	exitCode?: number | null;
	success?: boolean;
	state?: string;
	detached?: boolean;
	interrupted?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudgetExceeded?: boolean;
	completionGuardTriggered?: boolean;
	acceptance?: Pick<AcceptanceLedger, "status" | "reviewResult" | "runtimeChecks" | "verifyRuns">;
	error?: string;
}

export function deriveExecutionState(value: OutcomeLike): ExecutionState {
	if (value.executionState) return value.executionState;
	if (value.detached || value.state === "detached") return "detached";
	if (value.stopped || value.state === "stopped") return "stopped";
	if (value.interrupted || value.state === "paused") return "paused";
	if (value.turnBudgetExceeded) return "budget-exceeded";
	if (value.timedOut) return "timed-out";
	if (value.state === "failed") return "failed";
	if (typeof value.exitCode === "number") return value.exitCode === 0 ? "completed" : "failed";
	if (typeof value.success === "boolean") return value.success ? "completed" : "failed";
	return value.state === "complete" || value.state === "completed" ? "completed" : "failed";
}

function acceptanceReason(acceptance: OutcomeLike["acceptance"]): string {
	const failedCheck = acceptance?.runtimeChecks?.find((check) => check.status === "failed");
	if (failedCheck) return `Acceptance rejected: ${failedCheck.message}`;
	const failedVerify = acceptance?.verifyRuns?.find((run) => run.status === "failed" || run.status === "timed-out");
	if (failedVerify) return `Acceptance verification '${failedVerify.id}' ${failedVerify.status}.`;
	if (acceptance?.reviewResult?.status === "blockers") return "Acceptance review found blockers.";
	return "Acceptance rejected.";
}

export function deriveResultDisposition(value: OutcomeLike): ResultDisposition {
	if (value.resultDisposition) return value.resultDisposition;
	if (value.completionGuardTriggered) {
		return { status: "rejected", source: "completion-guard", reason: COMPLETION_GUARD_REJECTION_REASON };
	}
	if (value.acceptance?.status === "rejected") {
		const skippedForExecution = value.acceptance.runtimeChecks?.some((check) => check.id === "timeout" || check.id === "turn-budget" || check.id === "detached");
		if (skippedForExecution) return { status: "not-required" };
		if (value.acceptance.reviewResult?.status === "needs-parent-decision") {
			return {
				status: "review-required",
				source: "independent-review",
				reason: "Independent acceptance review is required but no reviewer result is available. Parent action is required.",
			};
		}
		return { status: "rejected", source: "acceptance", reason: acceptanceReason(value.acceptance) };
	}
	if (value.acceptance && value.acceptance.status !== "not-required") return { status: "accepted" };
	return { status: "not-required" };
}

export function aggregateResultDisposition(values: Array<ResultDisposition | undefined>): ResultDisposition {
	return values.find((value) => value?.status === "rejected")
		?? values.find((value) => value?.status === "review-required")
		?? (values.some((value) => value?.status === "accepted") ? { status: "accepted" } : { status: "not-required" });
}

export function executionStateToResultStatus(state: ExecutionState): SubagentResultStatus {
	if (state === "completed") return "completed";
	if (state === "paused") return "paused";
	if (state === "stopped") return "stopped";
	if (state === "detached") return "detached";
	return "failed";
}

export function resultDispositionIsUnsuccessful(disposition: ResultDisposition | undefined): boolean {
	return disposition?.status === "rejected" || disposition?.status === "review-required";
}

export function resultDispositionLabel(disposition: ResultDisposition | undefined): string | undefined {
	if (disposition?.status === "rejected") return "result rejected";
	if (disposition?.status === "review-required") return "review required";
	return undefined;
}
