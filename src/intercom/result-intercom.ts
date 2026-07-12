import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
	type Details,
	type ExecutionState,
	type IntercomEventBus,
	type ResultDisposition,
	type NestedRunSummary,
	type PublicNestedRunSummary,
	type SingleResult,
	type SubagentResultIntercomChild,
	type SubagentResultIntercomPayload,
	type SubagentResultStatus,
	type SubagentRunMode,
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
} from "../shared/types.ts";
import { aggregateResultDisposition, deriveExecutionState, executionStateToResultStatus } from "../runs/shared/outcome.ts";

export function resolveSubagentResultStatus(input: {
	executionState?: ExecutionState;
	exitCode?: number;
	success?: boolean;
	state?: string;
	interrupted?: boolean;
	detached?: boolean;
	resultDisposition?: ResultDisposition;
}): SubagentResultStatus {
	return executionStateToResultStatus(deriveExecutionState(input));
}

interface ResultCounts {
	execution: Record<SubagentResultStatus, number>;
	rejected: number;
	reviewRequired: number;
}

function countStatuses(children: SubagentResultIntercomChild[]): ResultCounts {
	const counts: ResultCounts = {
		execution: { completed: 0, failed: 0, paused: 0, stopped: 0, detached: 0 },
		rejected: 0,
		reviewRequired: 0,
	};
	for (const child of children) {
		counts.execution[child.status] += 1;
		if (child.resultDisposition?.status === "rejected") counts.rejected += 1;
		if (child.resultDisposition?.status === "review-required") counts.reviewRequired += 1;
	}
	return counts;
}

function formatStatusCounts(counts: ResultCounts): string {
	const completed = Math.max(0, counts.execution.completed - counts.rejected - counts.reviewRequired);
	const parts = [
		counts.execution.failed ? `${counts.execution.failed} failed` : undefined,
		counts.rejected ? `${counts.rejected} rejected` : undefined,
		counts.reviewRequired ? `${counts.reviewRequired} review required` : undefined,
		completed ? `${completed} completed` : undefined,
		counts.execution.stopped ? `${counts.execution.stopped} stopped` : undefined,
		counts.execution.paused ? `${counts.execution.paused} paused` : undefined,
		counts.execution.detached ? `${counts.execution.detached} detached` : undefined,
	].filter((part): part is string => Boolean(part));
	return parts.length ? parts.join(", ") : "0 results";
}

function resolveGroupedStatus(children: SubagentResultIntercomChild[]): SubagentResultStatus {
	const counts = countStatuses(children).execution;
	if (counts.failed > 0) return "failed";
	if (counts.stopped > 0) return "stopped";
	if (counts.paused > 0) return "paused";
	if (counts.completed > 0) return "completed";
	if (counts.detached > 0) return "detached";
	return "failed";
}

function compactNestedRun(run: NestedRunSummary | PublicNestedRunSummary, depth = 0): PublicNestedRunSummary {
	return {
		id: run.id,
		parentRunId: run.parentRunId,
		...(run.parentStepIndex !== undefined ? { parentStepIndex: run.parentStepIndex } : {}),
		...(run.parentAgent ? { parentAgent: run.parentAgent } : {}),
		depth: run.depth,
		path: run.path.slice(0, 4).map((part) => ({
			runId: part.runId,
			...(part.stepIndex !== undefined ? { stepIndex: part.stepIndex } : {}),
			...(part.agent ? { agent: part.agent } : {}),
		})),
		...(run.asyncDir ? { asyncDir: run.asyncDir } : {}),
		...(run.sessionId ? { sessionId: run.sessionId } : {}),
		...(run.sessionFile ? { sessionFile: run.sessionFile } : {}),
		...(run.intercomTarget ? { intercomTarget: run.intercomTarget } : {}),
		...(run.ownerIntercomTarget ? { ownerIntercomTarget: run.ownerIntercomTarget } : {}),
		...(run.leafIntercomTarget ? { leafIntercomTarget: run.leafIntercomTarget } : {}),
		...(run.ownerState ? { ownerState: run.ownerState } : {}),
		...(run.mode ? { mode: run.mode } : {}),
		state: run.state,
		...(run.executionState ? { executionState: run.executionState } : {}),
		...(run.resultDisposition ? { resultDisposition: run.resultDisposition } : {}),
		...(run.agent ? { agent: run.agent } : {}),
		...(run.agents?.length ? { agents: run.agents.slice(0, 12) } : {}),
		...(run.currentStep !== undefined ? { currentStep: run.currentStep } : {}),
		...(run.chainStepCount !== undefined ? { chainStepCount: run.chainStepCount } : {}),
		...(run.parallelGroups?.length ? { parallelGroups: run.parallelGroups.slice(0, 8) } : {}),
		...(run.activityState ? { activityState: run.activityState } : {}),
		...(run.lastActivityAt !== undefined ? { lastActivityAt: run.lastActivityAt } : {}),
		...(run.currentTool ? { currentTool: run.currentTool } : {}),
		...(run.currentToolStartedAt !== undefined ? { currentToolStartedAt: run.currentToolStartedAt } : {}),
		...(run.currentPath ? { currentPath: run.currentPath } : {}),
		...(run.turnCount !== undefined ? { turnCount: run.turnCount } : {}),
		...(run.toolCount !== undefined ? { toolCount: run.toolCount } : {}),
		...(run.totalTokens ? { totalTokens: run.totalTokens } : {}),
		...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
		...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
		...(run.lastUpdate !== undefined ? { lastUpdate: run.lastUpdate } : {}),
		...(run.error ? { error: run.error } : {}),
		...(run.steps?.length ? { steps: run.steps.slice(0, 12).map((step) => ({
			agent: step.agent,
			status: step.status,
			...(step.executionState ? { executionState: step.executionState } : {}),
			...(step.resultDisposition ? { resultDisposition: step.resultDisposition } : {}),
			...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
			...(step.activityState ? { activityState: step.activityState } : {}),
			...(step.lastActivityAt !== undefined ? { lastActivityAt: step.lastActivityAt } : {}),
			...(step.currentTool ? { currentTool: step.currentTool } : {}),
			...(step.currentToolStartedAt !== undefined ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
			...(step.currentPath ? { currentPath: step.currentPath } : {}),
			...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
			...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
			...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
			...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
			...(step.error ? { error: step.error } : {}),
			...(depth < 2 && step.children?.length ? { children: step.children.slice(0, 8).map((child) => compactNestedRun(child, depth + 1)) } : {}),
		})) } : {}),
		...(depth < 2 && run.children?.length ? { children: run.children.slice(0, 8).map((child) => compactNestedRun(child, depth + 1)) } : {}),
	};
}

export function compactNestedResultChildren(children: Array<NestedRunSummary | PublicNestedRunSummary> | undefined): PublicNestedRunSummary[] | undefined {
	if (!children?.length) return undefined;
	return children.slice(0, 16).map((child) => compactNestedRun(child));
}

export function attachNestedChildrenToResultChildren(
	runId: string,
	children: SubagentResultIntercomChild[],
	nestedChildren: NestedRunSummary[] | undefined,
): SubagentResultIntercomChild[] {
	const compact = compactNestedResultChildren(nestedChildren);
	if (!compact?.length) return children.map((child) => ({ ...child, children: compactNestedResultChildren(child.children) }));
	return children.map((child, index) => {
		const childIndex = child.index ?? index;
		const alreadyAttachedIds = new Set(child.children?.map((nested) => nested.id) ?? []);
		const attached = compact.filter((nested) => nested.parentRunId === runId && nested.parentStepIndex === childIndex && !alreadyAttachedIds.has(nested.id));
		const fallbackAttached = children.length === 1
			? compact.filter((nested) => nested.parentRunId === runId && nested.parentStepIndex === undefined && !alreadyAttachedIds.has(nested.id))
			: [];
		const merged = compactNestedResultChildren([...(child.children ?? []), ...attached, ...fallbackAttached]);
		return merged?.length ? { ...child, children: merged } : { ...child, children: undefined };
	});
}

function formatNestedResultLines(children: PublicNestedRunSummary[] | undefined): string[] {
	if (!children?.length) return [];
	const lines = ["Nested subagents:"];
	let remaining = 10;
	const append = (runs: PublicNestedRunSummary[] | undefined, indent: string): void => {
		for (const run of runs ?? []) {
			if (remaining <= 0) {
				lines.push(`${indent}↳ +more nested runs; inspect status for full tree`);
				return;
			}
			remaining--;
			const label = run.agent ?? run.agents?.join("+") ?? run.id;
			lines.push(`${indent}↳ ${label} — ${run.state} [${run.id}]`);
			if (run.sessionFile) lines.push(`${indent}  Session: ${run.sessionFile}`);
			append(run.children, `${indent}  `);
			for (const step of run.steps ?? []) append(step.children, `${indent}    `);
		}
	};
	append(children, "");
	return lines;
}

interface GroupedResultIntercomMessageInput {
	to: string;
	runId: string;
	mode: SubagentRunMode;
	source: "foreground" | "async";
	children: SubagentResultIntercomChild[];
	asyncId?: string;
	asyncDir?: string;
	chainSteps?: number;
}

function asyncResumeGuidance(input: {
	source: "foreground" | "async";
	children: SubagentResultIntercomChild[];
	asyncId?: string;
}): string | undefined {
	if (input.source !== "async" || !input.asyncId) return undefined;
	const resumable = input.children.filter((child) => typeof child.sessionPath === "string" && fs.existsSync(child.sessionPath));
	if (input.children.length === 1 && resumable.length === 1) {
		return `Revive: subagent({ action: "resume", id: "${input.asyncId}", message: "..." })`;
	}
	if (resumable.length > 0) {
		const firstIndex = resumable[0]?.index ?? input.children.indexOf(resumable[0]!);
		return `Revive child: subagent({ action: "resume", id: "${input.asyncId}", index: ${firstIndex}, message: "..." })`;
	}
	return "Resume: unavailable; no child session file was persisted.";
}

function resultStatusLabel(child: SubagentResultIntercomChild): string {
	const disposition = child.resultDisposition?.status === "rejected"
		? "result rejected"
		: child.resultDisposition?.status === "review-required"
			? "review required"
			: undefined;
	return disposition ? `${child.status}; ${disposition}` : child.status;
}

function formatSubagentResultIntercomMessage(input: {
	runId: string;
	mode: SubagentRunMode;
	status: SubagentResultStatus;
	source: "foreground" | "async";
	children: SubagentResultIntercomChild[];
	asyncId?: string;
	asyncDir?: string;
	chainSteps?: number;
}): string {
	const counts = countStatuses(input.children);
	const lines: string[] = [
		"subagent results",
		"",
		`Run: ${input.runId}`,
		`Mode: ${input.mode}`,
		`Status: ${input.status}`,
		`Children: ${formatStatusCounts(counts)}`,
	];
	if (input.mode === "chain" && typeof input.chainSteps === "number") {
		lines.push(`Chain steps: ${input.chainSteps}`);
	}
	if (input.asyncId) lines.push(`Async id: ${input.asyncId}`);
	if (input.asyncDir) lines.push(`Async dir: ${input.asyncDir}`);
	const resumeGuidance = asyncResumeGuidance(input);
	if (resumeGuidance) lines.push(resumeGuidance);
	if (input.children.some((child) => child.intercomTarget)) {
		lines.push("");
		lines.push(input.source === "async"
			? "Previous intercom targets below identify child sessions used while they were running. Inspect artifacts or session logs if resume is unavailable."
			: "Intercom targets below identify child sessions used while they were running; completed child sessions may no longer be reachable. Inspect artifacts or session logs for follow-up.");
	}

	for (let index = 0; index < input.children.length; index++) {
		const child = input.children[index]!;
		lines.push("");
		lines.push(`${index + 1}. ${child.agent} — ${resultStatusLabel(child)}`);
		if (child.intercomTarget) lines.push(`${input.source === "async" ? "Previous intercom target" : "Run intercom target"}: ${child.intercomTarget}`);
		if (child.artifactPath) lines.push(`Output artifact: ${child.artifactPath}`);
		if (child.sessionPath) lines.push(`Session: ${child.sessionPath}`);
		lines.push(...formatNestedResultLines(child.children));
		if (child.continuation?.attempts.length) {
			lines.push("Continuation history:");
			for (const attempt of child.continuation.attempts) {
				lines.push(`- attempt ${attempt.attempt} · ${attempt.action}${attempt.reason ? `: ${attempt.reason}` : ""}`);
			}
			if (child.continuation.terminalReason) lines.push(`Continuation stopped: ${child.continuation.terminalReason}`);
		}
		if (child.resultDisposition?.status === "rejected" || child.resultDisposition?.status === "review-required") {
			lines.push("Action required:");
			lines.push(child.resultDisposition.reason);
		}
		lines.push("Produced output:");
		lines.push(child.summary);
	}

	return lines.join("\n");
}

export function buildSubagentResultIntercomPayload(input: GroupedResultIntercomMessageInput): SubagentResultIntercomPayload {
	const children = input.children.map((child) => ({
		...child,
		summary: child.summary.trim() || "(no output)",
		children: compactNestedResultChildren(child.children),
	}));
	const status = resolveGroupedStatus(children);
	const summary = formatStatusCounts(countStatuses(children));
	const executionState: ExecutionState = children.some((child) => child.status === "failed")
		? "failed"
		: children.some((child) => child.status === "stopped")
			? "stopped"
			: children.some((child) => child.status === "paused")
				? "paused"
				: children.some((child) => child.status === "completed")
					? "completed"
					: "detached";
	const resultDisposition = aggregateResultDisposition(children.map((child) => child.resultDisposition));
	const firstChild = children[0];
	const payload: SubagentResultIntercomPayload = {
		to: input.to,
		runId: input.runId,
		mode: input.mode,
		status,
		summary,
		executionState,
		resultDisposition,
		source: input.source,
		children,
		...(input.asyncId ? { asyncId: input.asyncId } : {}),
		...(input.asyncDir ? { asyncDir: input.asyncDir } : {}),
		...(typeof input.chainSteps === "number" ? { chainSteps: input.chainSteps } : {}),
		...(firstChild?.agent ? { agent: firstChild.agent } : {}),
		...(firstChild?.index !== undefined ? { index: firstChild.index } : {}),
		...(firstChild?.artifactPath ? { artifactPath: firstChild.artifactPath } : {}),
		...(firstChild?.sessionPath ? { sessionPath: firstChild.sessionPath } : {}),
		message: "",
	};
	payload.message = formatSubagentResultIntercomMessage(payload);
	return payload;
}

export async function deliverSubagentResultIntercomEvent(
	events: IntercomEventBus,
	payload: SubagentResultIntercomPayload,
	timeoutMs = 500,
): Promise<boolean> {
	return deliverSubagentIntercomMessageEvent(events, payload.to, payload.message, timeoutMs, payload);
}

export async function deliverSubagentIntercomMessageEvent(
	events: IntercomEventBus,
	to: string,
	message: string,
	timeoutMs = 500,
	extra: Record<string, unknown> = {},
): Promise<boolean> {
	if (typeof events.on !== "function" || typeof events.emit !== "function") return false;
	const requestId = typeof extra.requestId === "string" ? extra.requestId : randomUUID();
	return new Promise((resolve) => {
		let settled = false;
		let unsubscribe: (() => void) | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (delivered: boolean) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			unsubscribe?.();
			resolve(delivered);
		};
		unsubscribe = events.on(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, (data) => {
			if (!data || typeof data !== "object") return;
			const delivery = data as { requestId?: unknown; delivered?: unknown };
			if (delivery.requestId !== requestId) return;
			finish(delivery.delivered === true);
		});
		timer = setTimeout(() => finish(false), timeoutMs);
		try {
			events.emit(SUBAGENT_RESULT_INTERCOM_EVENT, { ...extra, to, message, requestId });
		} catch {
			finish(false);
		}
	});
}

function stripSingleResultOutputs(result: SingleResult): SingleResult {
	return {
		...result,
		messages: undefined,
		finalOutput: undefined,
		truncation: undefined,
	};
}

export function stripDetailsOutputsForIntercomReceipt(details: Details): Details {
	return {
		...details,
		results: details.results.map(stripSingleResultOutputs),
	};
}

export function formatSubagentResultReceipt(input: {
	mode: SubagentRunMode;
	runId: string;
	payload: SubagentResultIntercomPayload;
}): string {
	const counts = countStatuses(input.payload.children);
	const modeLabel = input.mode === "single"
		? "single subagent result"
		: input.mode === "parallel"
			? "parallel subagent results"
			: "chain subagent results";
	const lines = [
		`Delivered ${modeLabel} via intercom.`,
		`Run: ${input.runId}`,
		`Children: ${formatStatusCounts(counts)}`,
	];

	const artifacts = input.payload.children.filter((child) => typeof child.artifactPath === "string");
	if (artifacts.length > 0) {
		lines.push("Artifacts:");
		for (const child of artifacts) {
			lines.push(`- ${child.agent} [${child.status}]: ${child.artifactPath}`);
		}
	}

	const intercomTargets = input.payload.children.filter((child) => typeof child.intercomTarget === "string");
	if (intercomTargets.length > 0) {
		lines.push("Run intercom targets (may be inactive after completion):");
		for (const child of intercomTargets) {
			lines.push(`- ${child.agent} [${child.status}]: ${child.intercomTarget}`);
		}
	}

	const sessions = input.payload.children.filter((child) => typeof child.sessionPath === "string");
	if (sessions.length > 0) {
		lines.push("Sessions:");
		for (const child of sessions) {
			lines.push(`- ${child.agent} [${child.status}]: ${child.sessionPath}`);
		}
	}

	lines.push("Full grouped output was sent over intercom.");
	return lines.join("\n");
}
