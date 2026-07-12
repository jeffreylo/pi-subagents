import type { AcceptanceReviewResult, ContinuationInput, ContinuationState, JsonSchemaObject, ResolvedAcceptanceConfig, ResultDisposition, SingleResult } from "../../shared/types.ts";

export const DEFAULT_CONTINUATION_MAX_ATTEMPTS = 2;
export const MAX_CONTINUATION_ATTEMPTS = 3;

export const ACCEPTANCE_REVIEW_RESULT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["status", "findings"],
	properties: {
		status: { type: "string", enum: ["no-blockers", "blockers", "needs-parent-decision"] },
		findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["severity", "issue", "rationale"], properties: { severity: { type: "string", enum: ["blocker", "non-blocking"] }, file: { type: "string" }, issue: { type: "string" }, rationale: { type: "string" } } } },
	},
} satisfies JsonSchemaObject;

export function parseAcceptanceReviewResult(value: unknown): AcceptanceReviewResult | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.status !== "no-blockers" && record.status !== "blockers" && record.status !== "needs-parent-decision") return undefined;
	if (!Array.isArray(record.findings)) return undefined;
	const findings: AcceptanceReviewResult["findings"] = [];
	for (const finding of record.findings) {
		if (!finding || typeof finding !== "object" || Array.isArray(finding)) return undefined;
		const item = finding as Record<string, unknown>;
		if ((item.severity !== "blocker" && item.severity !== "non-blocking") || typeof item.issue !== "string" || typeof item.rationale !== "string") return undefined;
		findings.push({ severity: item.severity, issue: item.issue, rationale: item.rationale, ...(typeof item.file === "string" ? { file: item.file } : {}) });
	}
	return { status: record.status, findings };
}

export function resolveContinuationMaxAttempts(input: ContinuationInput | undefined): number {
	if (input === false) return 1;
	const configured = input?.maxAttempts;
	if (configured === undefined) return DEFAULT_CONTINUATION_MAX_ATTEMPTS;
	if (!Number.isInteger(configured) || configured < 1) return 1;
	return Math.min(configured, MAX_CONTINUATION_ATTEMPTS);
}

export function shouldContinueRejectedResult(
	input: ContinuationInput | undefined,
	acceptance: ResolvedAcceptanceConfig,
	disposition: ResultDisposition,
): boolean {
	if (input === false || disposition.status !== "rejected") return false;
	if (input !== undefined) return true;
	if (disposition.source === "completion-guard") return true;
	return acceptance.level === "checked" || acceptance.level === "verified" || acceptance.level === "reviewed";
}

export function rejectionSignature(disposition: ResultDisposition): string | undefined {
	if (disposition.status !== "rejected") return undefined;
	return `${disposition.source}:${disposition.reason.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export function continuationFeedback(reason: string): string {
	return [
		"Continuation feedback: the prior child execution completed, but its result was not accepted.",
		`Exact rejection reason: ${reason}`,
		"Implement only this correction in the existing cwd/worktree, then return updated evidence.",
		"Do not replay the original task and do not repeat completed external side effects (publishing, sending, merging, deploying, payments, or other non-idempotent actions).",
	].join("\n\n");
}

export function hasNonIdempotentUncertainty(task: string): boolean {
	return /\b(?:deploy|publish|release|merge|send|email|message|payment|charge|purchase|delete[- ]branch|create[- ]pr|open[- ]pr)\b/i.test(task);
}

export function initialContinuationState(maxAttempts: number, result: Pick<SingleResult, "executionState" | "resultDisposition" | "finalOutput">): ContinuationState {
	return {
		maxAttempts,
		attempts: [{
			attempt: 1,
			action: "initial",
			executionState: result.executionState ?? "failed",
			resultDisposition: result.resultDisposition ?? { status: "not-required" },
			...(result.finalOutput ? { output: result.finalOutput } : {}),
			...(result.resultDisposition?.status === "rejected" || result.resultDisposition?.status === "review-required" ? { reason: result.resultDisposition.reason } : {}),
			...(result.resultDisposition?.status === "rejected" ? { signature: rejectionSignature(result.resultDisposition) } : {}),
		}],
	};
}
