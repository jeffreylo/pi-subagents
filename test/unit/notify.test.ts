import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import registerSubagentNotify, {
	buildCompletionDetails,
	formatGroupedCompletion,
	formatSingleCompletion,
	parseSubagentNotifyContent,
	type RegisterSubagentNotifyOptions,
	type SubagentNotifyDetails,
} from "../../src/runs/background/notify.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../src/shared/types.ts";

function createPi(currentSessionId = "session-1", registerOptions: RegisterSubagentNotifyOptions = {}) {
	const events = new EventEmitter();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		events,
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};

	// Formatting-focused tests run with batching disabled so single completions
	// emit synchronously. Batching behavior is covered by the dedicated suite below.
	registerSubagentNotify(pi as never, { currentSessionId }, { batchConfig: { enabled: false }, ...registerOptions });

	return { events, sent };
}

function createBatchingPi(clock: ReturnType<typeof createFakeClock>, currentSessionId = "session-a") {
	const events = new EventEmitter();
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		events,
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
	};
	registerSubagentNotify(pi as never, { currentSessionId }, {
		batchConfig: { enabled: true, debounceMs: 150, maxWaitMs: 1000, stragglerDebounceMs: 75, stragglerMaxWaitMs: 400, stragglerWindowMs: 2000 },
		timers: clock.api,
		now: clock.now,
	});
	return { events, sent };
}

interface FakeJob {
	id: number;
	fireAt: number;
	handler: () => void;
}

function createFakeClock() {
	let now = 0;
	let nextId = 1;
	const jobs = new Map<number, FakeJob>();
	const api = {
		setTimeout(handler: () => void, delayMs: number): unknown {
			const id = nextId++;
			jobs.set(id, { id, fireAt: now + delayMs, handler });
			return id;
		},
		clearTimeout(handle: unknown): void {
			if (typeof handle === "number") jobs.delete(handle);
		},
	};
	return {
		api,
		now: () => now,
		advance(ms: number): void {
			now += ms;
			const due = [...jobs.values()].filter((job) => job.fireAt <= now).sort((a, b) => a.fireAt - b.fireAt);
			for (const job of due) {
				if (!jobs.has(job.id)) continue;
				jobs.delete(job.id);
				job.handler();
			}
		},
	};
}

function completionResult(overrides: Record<string, unknown> = {}) {
	return {
		id: `notify-${Math.random().toString(36).slice(2)}`,
		agent: "worker",
		success: true,
		summary: "Done",
		exitCode: 0,
		timestamp: 123,
		sessionId: "session-a",
		...overrides,
	};
}

describe("registerSubagentNotify", () => {
	it("uses a fallback summary when a background completion is empty", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-empty-1",
			agent: "worker",
			success: true,
			summary: "",
			exitCode: 0,
			timestamp: 123,
			sessionId: "session-1",
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: "Background task completed: **worker**\n\n(no output)",
				display: true,
			},
			options: { triggerTurn: true },
		});
	});

	it("preserves non-empty completion summaries", () => {
		const { events, sent } = createPi();
		const summary = "  Done streaming\nAll clear  ";

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-summary-1",
			agent: "worker",
			success: true,
			summary,
			exitCode: 0,
			timestamp: 456,
			taskIndex: 1,
			totalTasks: 3,
			sessionId: "session-1",
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: `Background task completed: **worker** (2/3)\n\n${summary}`,
				display: true,
			},
			options: { triggerTurn: true },
		});
	});

	it("preserves session paths in notification content", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-path-1",
			agent: "worker",
			success: true,
			summary: "Done",
			exitCode: 0,
			timestamp: 456,
			sessionFile: "/tmp/session.jsonl",
			sessionId: "session-1",
		});

		assert.deepEqual(sent, [{
			message: {
				customType: "subagent-notify",
				content: "Background task completed: **worker**\n\nDone\n\nSession file: /tmp/session.jsonl",
				display: true,
			},
			options: { triggerTurn: true },
		}]);
	});

	it("labels paused completions as paused even without an exit code", () => {
		const { events, sent } = createPi();

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-paused-1",
			agent: "worker",
			success: false,
			state: "paused",
			summary: "Paused after interrupt. Waiting for explicit next action.",
			timestamp: 789,
			sessionId: "session-1",
		});

		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], {
			message: {
				customType: "subagent-notify",
				content: "Background task paused: **worker**\n\nPaused after interrupt. Waiting for explicit next action.",
				display: true,
			},
			options: { triggerTurn: true },
		});
	});

	it("ignores completions for other or missing session ids", () => {
		const { events, sent } = createPi("session-owner");

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-other-session",
			agent: "worker",
			success: true,
			summary: "Other done",
			timestamp: 100,
			sessionId: "session-other",
		});
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
			id: "notify-sessionless",
			agent: "worker",
			success: true,
			summary: "Legacy cwd-scoped done",
			timestamp: 101,
			cwd: "/repo",
		});

		assert.deepEqual(sent, []);
	});

	it("emits failed completions immediately even while successes are held", () => {
		const clock = createFakeClock();
		const { events, sent } = createBatchingPi(clock);

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "ok-1", agent: "ok-1", summary: "ok-1 done" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "fail-1", agent: "fail-1", success: false, summary: "boom", exitCode: 1 }));

		// The failure must arrive immediately, and the held success must be
		// flushed ahead of it rather than waiting on the debounce timer.
		assert.equal(sent.length, 2);
		assert.match((sent[0]!.message as { content: string }).content, /Background task completed: \*\*ok-1\*\*/);
		assert.match((sent[1]!.message as { content: string }).content, /Background task failed: \*\*fail-1\*\*/);

		// No deferred emission should arrive later.
		clock.advance(1000);
		assert.equal(sent.length, 2);
	});

	it("groups sibling successes into a single notification after the debounce window", () => {
		const clock = createFakeClock();
		const { events, sent } = createBatchingPi(clock);

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "g-1", agent: "alpha", summary: "alpha done", sessionId: "session-a" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "g-2", agent: "beta", summary: "beta done", sessionId: "session-a" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "g-3", agent: "gamma", summary: "gamma done", sessionId: "session-a" }));
		assert.equal(sent.length, 0);

		clock.advance(150);
		assert.equal(sent.length, 1);
		const content = (sent[0]!.message as { content: string }).content;
		assert.match(content, /^Background tasks completed \(3\): \*\*alpha\*\*, \*\*beta\*\*, \*\*gamma\*\*/);
		assert.match(content, /1\. alpha\nalpha done/);
		assert.match(content, /3\. gamma\ngamma done/);
		assert.deepEqual(sent[0]!.options, { triggerTurn: true });
	});

	it("ignores successes from other sessions instead of grouping them", () => {
		const clock = createFakeClock();
		const { events, sent } = createBatchingPi(clock, "session-a");

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "s-1", agent: "alpha", summary: "alpha done", sessionId: "session-a" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "s-2", agent: "beta", summary: "beta done", sessionId: "session-b" }));
		clock.advance(150);

		assert.equal(sent.length, 1);
		assert.match((sent[0]!.message as { content: string }).content, /^Background task completed: \*\*alpha\*\*/);
		assert.doesNotMatch((sent[0]!.message as { content: string }).content, /beta done/);
	});

	it("does not let another session failure flush held successes", () => {
		const clock = createFakeClock();
		const { events, sent } = createBatchingPi(clock, "session-a");

		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "held-a-1", agent: "alpha", summary: "alpha done", sessionId: "session-a" }));
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, completionResult({ id: "fail-b-1", agent: "beta", success: false, summary: "boom", exitCode: 1, sessionId: "session-b" }));
		assert.equal(sent.length, 0);

		clock.advance(150);
		assert.equal(sent.length, 1);
		assert.match((sent[0]!.message as { content: string }).content, /^Background task completed: \*\*alpha\*\*/);
		assert.doesNotMatch((sent[0]!.message as { content: string }).content, /boom/);
	});
});

describe("completion formatting helpers", () => {
	it("formatSingleCompletion mirrors the in-handler single message shape", () => {
		const content = formatSingleCompletion({
			agent: "worker",
			status: "completed",
			taskInfo: " (2/3)",
			resultPreview: "Done",
			sessionLabel: "Session file",
			sessionValue: "/tmp/session.jsonl",
		});
		assert.equal(content, "Background task completed: **worker** (2/3)\n\nDone\n\nSession file: /tmp/session.jsonl");
	});

	it("formatGroupedCompletion lists each agent with its summary and session", () => {
		const content = formatGroupedCompletion([
			{ agent: "alpha", status: "completed", resultPreview: "alpha done" },
			{ agent: "beta", status: "completed", taskInfo: " (1/2)", resultPreview: "", sessionLabel: "Session", sessionValue: "https://share/abc" },
		]);
		assert.equal(
			content,
			"Background tasks completed (2): **alpha**, **beta** (1/2)\n\n"
			+ "1. alpha\nalpha done\n\n"
			+ "2. beta (1/2)\n(no output)\nSession: https://share/abc",
		);
	});

	it("parses grouped result notifications with an actionable first preview and nonblank fallback header", () => {
		const parsed = parseSubagentNotifyContent([
			"Background task results (2): 1 rejected, 1 review required",
			"",
			"1. worker",
			"Acceptance rejected: focused tests failed",
			"Produced output:",
			"partial patch",
			"",
			"2. reviewer",
			"Independent review is required.",
		].join("\n"));

		assert.equal(parsed?.agent, "2 background tasks");
		assert.notEqual(parsed?.agent.trim(), "");
		assert.equal(parsed?.status, "review-required");
		assert.match(parsed?.resultPreview ?? "", /^Acceptance rejected: focused tests failed/);
		assert.doesNotMatch(parsed?.resultPreview ?? "", /^1\. worker/);

		const fallback = parseSubagentNotifyContent("Background task results (1): 1 review required\n\n");
		assert.equal(fallback?.agent, "1 background task");
		assert.equal(fallback?.resultPreview, "1 review required");
	});

	it("renders actionable rejection and review reasons before produced output", () => {
		const rejected = buildCompletionDetails({
			id: "rejected",
			agent: "worker",
			success: true,
			executionState: "completed",
			resultDisposition: { status: "rejected", source: "acceptance", reason: "Acceptance rejected: tests failed" },
			summary: "child output",
			timestamp: 1,
		});
		assert.equal(rejected.status, "rejected");
		assert.equal(rejected.resultDispositionStatus, "rejected");
		assert.equal(formatSingleCompletion(rejected), "Background task rejected: **worker**\n\nAcceptance rejected: tests failed\n\nProduced output:\nchild output");

		const failedWithRejection = buildCompletionDetails({
			id: "failed-rejected",
			agent: "worker",
			success: false,
			executionState: "failed",
			resultDisposition: { status: "rejected", source: "acceptance", reason: "Acceptance rejected: tests failed" },
			error: "Provider process exited with code 1",
			summary: "partial child output",
			timestamp: 1,
		});
		assert.equal(failedWithRejection.status, "failed");
		assert.equal(failedWithRejection.resultDispositionStatus, "rejected");
		assert.equal(failedWithRejection.resultPreview, "Provider process exited with code 1");
		assert.equal(formatSingleCompletion(failedWithRejection), "Background task failed: **worker**\n\nProvider process exited with code 1\n\nProduced output:\npartial child output");

		const grouped = formatGroupedCompletion([
			failedWithRejection,
			{ agent: "rejected", status: "rejected", resultPreview: "policy rejected", producedOutput: "patch" },
			{ agent: "reviewer", status: "review-required", resultPreview: "independent review missing", producedOutput: "findings" },
		]);
		assert.match(grouped, /^Background task results \(3\): 1 failed, 2 rejected, 1 review required/);
		assert.match(grouped, /1\. worker\nProvider process exited with code 1\nProduced output:\npartial child output/);
		assert.match(grouped, /2\. rejected\npolicy rejected\nProduced output:\npatch/);
		assert.match(grouped, /3\. reviewer\nindependent review missing\nProduced output:\nfindings/);
	});

	it("reports accepted continuation attempts and rejection reasons before child output", () => {
		const accepted = buildCompletionDetails({
			id: "accepted-after-continuation",
			agent: "worker",
			success: true,
			executionState: "completed",
			resultDisposition: { status: "accepted", source: "acceptance", reason: "Acceptance satisfied." },
			continuation: {
				maxAttempts: 2,
				terminalReason: "accepted",
				attempts: [
					{ attempt: 1, action: "initial", executionState: "completed", resultDisposition: { status: "rejected", source: "acceptance", reason: "Missing evidence." } },
					{ attempt: 2, action: "fix", executionState: "completed", resultDisposition: { status: "accepted", source: "acceptance", reason: "Acceptance satisfied." } },
				],
			},
			summary: "validated patch",
			timestamp: 1,
		});
		assert.equal(formatSingleCompletion(accepted), "Background task completed: **worker**\n\nAccepted after 2 attempts.\n\nvalidated patch");

		for (const terminalReason of ["attempts-exhausted", "identical-rejection"] as const) {
			const reason = terminalReason === "attempts-exhausted" ? "Criterion still fails." : "The same rejection recurred.";
			const rejected = buildCompletionDetails({
				id: terminalReason,
				agent: "worker",
				success: true,
				executionState: "completed",
				resultDisposition: { status: "rejected", source: "acceptance", reason },
				continuation: {
					maxAttempts: 2,
					terminalReason,
					attempts: [
						{ attempt: 1, action: "initial", executionState: "completed", resultDisposition: { status: "rejected", source: "acceptance", reason } },
						{ attempt: 2, action: "fix", executionState: "completed", resultDisposition: { status: "rejected", source: "acceptance", reason } },
					],
				},
				summary: "child output",
				timestamp: 1,
			});
			assert.equal(
				formatSingleCompletion(rejected),
				`Background task rejected: **worker**\n\nRejected after 2 attempts: ${reason}\n\nProduced output:\nchild output`,
			);
		}
	});

	it("buildCompletionDetails derives paused status from state and summary", () => {
		assert.equal(buildCompletionDetails({ id: "x", agent: "w", success: false, state: "paused", summary: "Paused after interrupt.", timestamp: 1 }).status, "paused");
		assert.equal(buildCompletionDetails({ id: "x", agent: "w", success: false, summary: "boom", exitCode: 1, timestamp: 1 }).status, "failed");
		assert.equal(buildCompletionDetails({ id: "x", agent: "w", success: true, summary: "ok", exitCode: 0, timestamp: 1 }).status, "completed");
	});

	it("buildCompletionDetails falls back to the unknown agent label", () => {
		const details: SubagentNotifyDetails = buildCompletionDetails({ id: "x", agent: null, success: true, summary: "ok", timestamp: 1 });
		assert.equal(details.agent, "unknown");
		assert.equal(details.status, "completed");
	});
});
