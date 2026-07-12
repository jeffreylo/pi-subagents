/**
 * Subagent completion notifications.
 *
 * Successful (completed) async results are held briefly and emitted as a
 * single grouped message when sibling jobs finish within a short window (see
 * `completion-batcher.ts`). Failed and paused results bypass grouping and fire
 * immediately, flushing any held successes first, so failure and attention
 * signals are never delayed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildCompletionKey, getGlobalSeenMap, markSeenWithTtl } from "./completion-dedupe.ts";
import {
	type CompletionBatchConfig,
	type CompletionBatcher,
	createCompletionBatcher,
	resolveCompletionBatchConfig,
} from "./completion-batcher.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, type AcceptanceLedger, type ContinuationState, type ExecutionState, type ResultDisposition, type SubagentState } from "../../shared/types.ts";
import { aggregateResultDisposition, deriveExecutionState, deriveResultDisposition } from "../shared/outcome.ts";

interface ChainStepResult {
	agent: string;
	output: string;
	error?: string;
	success: boolean;
}

export interface SubagentNotifyDetails {
	agent: string;
	status: "completed" | "failed" | "timed-out" | "budget-exceeded" | "rejected" | "review-required" | "paused" | "stopped" | "detached";
	taskInfo?: string;
	resultPreview: string;
	producedOutput?: string;
	resultDispositionStatus?: "rejected" | "review-required";
	durationMs?: number;
	sessionLabel?: string;
	sessionValue?: string;
}

export function parseSubagentNotifyContent(content: string): SubagentNotifyDetails | undefined {
	const lines = content.split("\n");
	const header = lines[0] ?? "";
	const groupedMatch = header.match(/^Background task(?:s completed| results) \((\d+)\):\s*(.*)$/);
	if (groupedMatch) {
		const count = Number(groupedMatch[1]);
		const summary = groupedMatch[2]?.trim() ?? "";
		let status: SubagentNotifyDetails["status"] = "completed";
		if (header.startsWith("Background task results")) {
			status = /\bfailed\b/.test(summary)
				? "failed"
				: /\btimed out\b/.test(summary)
					? "timed-out"
					: /\bbudget exceeded\b/.test(summary)
						? "budget-exceeded"
						: /\breview required\b/.test(summary)
							? "review-required"
							: /\brejected\b/.test(summary)
								? "rejected"
								: "failed";
		}
		const groupedBody = lines.slice(2);
		if (/^\d+\.\s+\S/.test(groupedBody[0] ?? "")) groupedBody.shift();
		return {
			agent: `${count} background ${count === 1 ? "task" : "tasks"}`,
			status,
			resultPreview: groupedBody.join("\n").trim() || summary || "(no output)",
		};
	}
	const match = header.match(/^Background task (completed|failed|timed-out|budget-exceeded|rejected|review-required|paused|stopped|detached): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/);
	if (!match) return undefined;
	const body = lines.slice(2);
	let sessionIndex = -1;
	for (let i = body.length - 1; i >= 1; i--) {
		if (body[i - 1]?.trim() === "" && /^(Session|Session file|Session share error):\s+/.test(body[i]!)) {
			sessionIndex = i;
			break;
		}
	}
	const sessionLine = sessionIndex >= 0 ? body[sessionIndex] : undefined;
	const resultLines = sessionIndex >= 0 ? body.slice(0, sessionIndex) : body;
	const producedOutputIndex = resultLines.findIndex((line) => line === "Produced output:");
	const resultPreviewLines = producedOutputIndex >= 0 ? resultLines.slice(0, producedOutputIndex) : resultLines;
	const producedOutput = producedOutputIndex >= 0 ? resultLines.slice(producedOutputIndex + 1).join("\n").trim() : undefined;
	const resultPreview = resultPreviewLines.join("\n").trim() || "(no output)";
	let sessionLabel: string | undefined;
	let sessionValue: string | undefined;
	if (sessionLine) {
		const separator = sessionLine.indexOf(":");
		sessionLabel = sessionLine.slice(0, separator).toLowerCase();
		sessionValue = sessionLine.slice(separator + 1).trim();
	}
	return {
		agent: match[2]!,
		status: match[1] as SubagentNotifyDetails["status"],
		...(match[3] ? { taskInfo: match[3] } : {}),
		resultPreview,
		...(producedOutput ? { producedOutput } : {}),
		...(sessionLabel && sessionValue ? { sessionLabel, sessionValue } : {}),
	};
}

interface SubagentResult {
	id: string | null;
	agent: string | null;
	success: boolean;
	summary: string;
	error?: string;
	exitCode?: number;
	state?: string;
	executionState?: ExecutionState;
	resultDisposition?: ResultDisposition;
	acceptance?: AcceptanceLedger;
	continuation?: ContinuationState;
	results?: Array<ChainStepResult & { executionState?: ExecutionState; resultDisposition?: ResultDisposition; continuation?: ContinuationState; acceptance?: AcceptanceLedger }>;
	timestamp: number;
	durationMs?: number;
	cwd?: string;
	sessionFile?: string;
	shareUrl?: string;
	gistUrl?: string;
	shareError?: string;
	taskIndex?: number;
	totalTasks?: number;
	sessionId?: string | null;
}

interface NotifyTimerApi {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface RegisterSubagentNotifyOptions {
	batchConfig?: CompletionBatchConfig;
	timers?: NotifyTimerApi;
	now?: () => number;
}

function formatSessionLine(details: SubagentNotifyDetails): string | undefined {
	if (!details.sessionValue) return undefined;
	return details.sessionLabel ? `${details.sessionLabel}: ${details.sessionValue}` : details.sessionValue;
}

export function formatSingleCompletion(details: SubagentNotifyDetails): string {
	const sessionLine = formatSessionLine(details);
	return [
		`Background task ${details.status}: **${details.agent}**${details.taskInfo ?? ""}`,
		"",
		details.resultPreview.trim() ? details.resultPreview : "(no output)",
		details.producedOutput?.trim() ? "" : undefined,
		details.producedOutput?.trim() ? `Produced output:\n${details.producedOutput.trim()}` : undefined,
		sessionLine ? "" : undefined,
		sessionLine,
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

export function formatGroupedCompletion(details: SubagentNotifyDetails[]): string {
	const allCompleted = details.every((detail) => detail.status === "completed");
	const counts = new Map<SubagentNotifyDetails["status"], number>();
	for (const detail of details) counts.set(detail.status, (counts.get(detail.status) ?? 0) + 1);
	const rejected = details.filter((detail) => detail.status === "rejected" || detail.resultDispositionStatus === "rejected").length;
	const reviewRequired = details.filter((detail) => detail.status === "review-required" || detail.resultDispositionStatus === "review-required").length;
	const countParts = [
		counts.get("failed") ? `${counts.get("failed")} failed` : undefined,
		counts.get("timed-out") ? `${counts.get("timed-out")} timed out` : undefined,
		counts.get("budget-exceeded") ? `${counts.get("budget-exceeded")} budget exceeded` : undefined,
		rejected ? `${rejected} rejected` : undefined,
		reviewRequired ? `${reviewRequired} review required` : undefined,
		counts.get("paused") ? `${counts.get("paused")} paused` : undefined,
		counts.get("stopped") ? `${counts.get("stopped")} stopped` : undefined,
		counts.get("detached") ? `${counts.get("detached")} detached` : undefined,
	].filter((part): part is string => Boolean(part));
	const header = allCompleted
		? `Background tasks completed (${details.length}): ${details.map((d) => `**${d.agent}**${d.taskInfo ?? ""}`).join(", ")}`
		: `Background task results (${details.length}): ${countParts.length > 0 ? countParts.join(", ") : `${details.length} results`}`;
	const blocks: string[] = [header, ""];
	for (let index = 0; index < details.length; index++) {
		const detail = details[index];
		if (!detail) continue;
		const sessionLine = formatSessionLine(detail);
		blocks.push(`${index + 1}. ${detail.agent}${detail.taskInfo ?? ""}`);
		blocks.push(detail.resultPreview.trim() ? detail.resultPreview : "(no output)");
		if (detail.producedOutput?.trim()) blocks.push(`Produced output:\n${detail.producedOutput.trim()}`);
		if (sessionLine) blocks.push(sessionLine);
		blocks.push("");
	}
	return blocks.join("\n").trimEnd();
}

function sendCompletion(pi: Pick<ExtensionAPI, "sendMessage">, details: SubagentNotifyDetails[]): void {
	if (details.length === 0) return;
	const content = details.length === 1
		? formatSingleCompletion(details[0]!)
		: formatGroupedCompletion(details);
	pi.sendMessage(
		{
			customType: "subagent-notify",
			content,
			display: true,
		},
		{ triggerTurn: true },
	);
}

function completionBatchKey(result: SubagentResult): string {
	const sessionId = typeof result.sessionId === "string" ? result.sessionId.trim() : "";
	if (sessionId) return `session:${sessionId}`;
	const cwd = typeof result.cwd === "string" ? result.cwd.trim() : "";
	return cwd ? `cwd:${cwd}` : "unknown";
}

export function buildCompletionDetails(result: SubagentResult): SubagentNotifyDetails {
	const agent = result.agent ?? "unknown";
	const summary = typeof result.summary === "string" ? result.summary : "";
	const executionState = deriveExecutionState({
		executionState: result.executionState,
		exitCode: result.exitCode,
		success: result.success,
		state: result.state,
	});
	const resultDisposition = aggregateResultDisposition([
		deriveResultDisposition({ resultDisposition: result.resultDisposition, acceptance: result.acceptance }),
		...(result.results ?? []).map((child) => deriveResultDisposition(child)),
	]);
	const status = executionState !== "completed"
		? executionState
		: resultDisposition.status === "review-required"
			? "review-required"
			: resultDisposition.status === "rejected"
				? "rejected"
				: "completed";
	const unsuccessfulDisposition = resultDisposition.status === "rejected" || resultDisposition.status === "review-required";
	const failedChildError = result.results?.find((child) => child.success === false && child.error)?.error;
	const executionReason = result.error?.trim() || failedChildError?.trim() || summary;
	const continuation = result.continuation ?? result.results?.find((child) => child.continuation)?.continuation;
	const writerAttempts = continuation?.attempts.filter((attempt) => attempt.action !== "review").reduce((max, attempt) => Math.max(max, attempt.attempt), 0) ?? 0;
	const acceptedAfterContinuation = executionState === "completed" && continuation?.terminalReason === "accepted" && writerAttempts > 1;
	const resultPreview = executionState === "completed" && unsuccessfulDisposition
		? `${writerAttempts > 1 ? `Rejected after ${writerAttempts} attempts: ` : ""}${resultDisposition.reason}`
		: acceptedAfterContinuation
			? `Accepted after ${writerAttempts} attempts.\n\n${summary}`
			: continuation?.currentAction === "review"
				? `Reviewing result.\n\n${executionReason}`
				: executionReason;
	const producedOutput = unsuccessfulDisposition || (!acceptedAfterContinuation && summary.trim() && summary.trim() !== resultPreview.trim())
		? summary
		: undefined;

	const taskInfo =
		result.taskIndex !== undefined && result.totalTasks !== undefined
			? ` (${result.taskIndex + 1}/${result.totalTasks})`
			: undefined;

	const session =
		result.shareUrl
			? { label: "Session", value: result.shareUrl }
			: result.shareError
				? { label: "Session share error", value: result.shareError }
				: result.sessionFile
					? { label: "Session file", value: result.sessionFile }
					: undefined;

	return {
		agent,
		status,
		...(taskInfo ? { taskInfo } : {}),
		resultPreview,
		...(producedOutput ? { producedOutput } : {}),
		...(unsuccessfulDisposition ? { resultDispositionStatus: resultDisposition.status } : {}),
		...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
		...(session ? { sessionLabel: session.label, sessionValue: session.value } : {}),
	};
}

export default function registerSubagentNotify(
	pi: ExtensionAPI,
	state: Pick<SubagentState, "currentSessionId">,
	options: RegisterSubagentNotifyOptions = {},
): void {
	const unsubscribeStoreKey = "__pi_subagents_notify_unsubscribe__";
	const batcherStoreKey = "__pi_subagents_notify_batcher__";
	const globalStore = globalThis as Record<string, unknown>;
	const previousUnsubscribe = globalStore[unsubscribeStoreKey];
	if (typeof previousUnsubscribe === "function") {
		try {
			previousUnsubscribe();
		} catch {
			// Best effort cleanup for stale handlers from an older reload.
		}
	}
	const previousBatcher = globalStore[batcherStoreKey];
	if (previousBatcher && typeof (previousBatcher as { dispose?: () => void }).dispose === "function") {
		try {
			(previousBatcher as { dispose: () => void }).dispose();
		} catch {
			// Best effort cleanup for a stale batcher from an older reload.
		}
	}

	const seen = getGlobalSeenMap("__pi_subagents_notify_seen__");
	const ttlMs = 10 * 60 * 1000;
	const nowFn = options.now ?? Date.now;
	const batchConfig = resolveCompletionBatchConfig(options.batchConfig);
	const batchers = new Map<string, CompletionBatcher<SubagentNotifyDetails>>();
	globalStore[batcherStoreKey] = {
		dispose() {
			for (const batcher of batchers.values()) batcher.dispose();
			batchers.clear();
		},
	};

	const handleComplete = (data: unknown) => {
		const result = data as SubagentResult;
		if (typeof result.sessionId !== "string" || result.sessionId !== state.currentSessionId) return;
		const now = nowFn();
		const key = buildCompletionKey(result, "notify");
		if (markSeenWithTtl(seen, key, now, ttlMs)) return;

		const details = buildCompletionDetails(result);
		const batchKey = completionBatchKey(result);
		let batcher = batchers.get(batchKey);
		if (!batcher) {
			batcher = createCompletionBatcher<SubagentNotifyDetails>({
				config: batchConfig,
				emit: (items) => sendCompletion(pi, items),
				...(options.timers ? { timers: options.timers } : {}),
				now: nowFn,
			});
			batchers.set(batchKey, batcher);
		}
		if (details.status !== "completed") {
			// Failures and paused runs bypass grouping. Flush any held
			// successes for the same owner first so they are not stranded
			// behind this signal, then emit the non-completion result immediately.
			batcher.flush();
			sendCompletion(pi, [details]);
			return;
		}
		batcher.push(details);
	};

	globalStore[unsubscribeStoreKey] = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete);
}
