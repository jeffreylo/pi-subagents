import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findModelInfo, splitKnownThinkingSuffix, type ModelInfo } from "./model-info.ts";

type SubagentExecutionContext = "fresh" | "fork";

interface BranchSessionEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
		provider?: string;
		api?: string;
		model?: string;
		toolCallId?: string;
		tool_call_id?: string;
		toolUseId?: string;
		tool_use_id?: string;
	};
	thinkingLevel?: string;
}

interface BranchSessionManager {
	createBranchedSession(leafId: string): string | undefined;
	getHeader?: () => BranchSessionEntry | null;
	getEntries?: () => BranchSessionEntry[];
}

interface ForkableSessionManager {
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	getSessionDir?(): string;
	openSession?: (path: string, sessionDir?: string) => BranchSessionManager;
}

interface ForkContextResolverOptions {
	openSession?: (path: string, sessionDir?: string) => BranchSessionManager;
	/**
	 * Directory where branched (forked) child sessions are created. When
	 * omitted, the branched session lands in the parent's session directory,
	 * which pollutes the top-level session history with subagent children.
	 */
	branchSessionDir?: string;
}

export interface ForkSafetyInfo {
	sanitized: boolean;
	danglingToolUse: boolean;
}

interface ForkContextResolution {
	sessionFile: string;
	safetyInfo: ForkSafetyInfo;
}

interface ForkContextResolver {
	sessionFileForIndex(index?: number): string | undefined;
	forkSafetyInfoForIndex(index?: number): ForkSafetyInfo | undefined;
}

export function resolveSubagentContext(value: unknown): SubagentExecutionContext {
	return value === "fork" ? "fork" : "fresh";
}

function isUnsafeAnthropicThinkingBlock(message: BranchSessionEntry["message"], block: unknown): boolean {
	if (!message || !block || typeof block !== "object" || !("type" in block)) return false;
	const provider = typeof message.provider === "string" ? message.provider.toLowerCase() : "";
	const api = typeof message.api === "string" ? message.api.toLowerCase() : "";
	const model = typeof message.model === "string" ? message.model.toLowerCase() : "";
	const isAnthropic = provider === "anthropic" || api === "anthropic-messages" || model.startsWith("anthropic/");
	if (block.type === "redacted_thinking") return true;
	if (block.type !== "thinking" || !isAnthropic) return false;
	const signature = "thinkingSignature" in block ? block.thinkingSignature : "signature" in block ? block.signature : undefined;
	return block.redacted === true || (typeof signature === "string" && signature.length > 0);
}

function createEntryId(entries: BranchSessionEntry[]): string {
	const ids = new Set(entries.map((entry) => entry.id).filter((id): id is string => typeof id === "string"));
	for (let attempt = 0; attempt < 100; attempt++) {
		const id = randomUUID().slice(0, 8);
		if (!ids.has(id)) return id;
	}
	return randomUUID();
}

function contentBlockType(block: unknown): string | undefined {
	return block && typeof block === "object" && "type" in block && typeof block.type === "string" ? block.type : undefined;
}

function contentBlockId(block: unknown): string | undefined {
	if (!block || typeof block !== "object") return undefined;
	if ("id" in block && typeof block.id === "string") return block.id;
	if ("toolUseId" in block && typeof block.toolUseId === "string") return block.toolUseId;
	if ("tool_use_id" in block && typeof block.tool_use_id === "string") return block.tool_use_id;
	if ("toolCallId" in block && typeof block.toolCallId === "string") return block.toolCallId;
	if ("tool_call_id" in block && typeof block.tool_call_id === "string") return block.tool_call_id;
	return undefined;
}

function messageToolResultId(message: BranchSessionEntry["message"]): string | undefined {
	if (!message) return undefined;
	return message.toolCallId ?? message.tool_call_id ?? message.toolUseId ?? message.tool_use_id;
}

function hasDanglingToolUse(entries: BranchSessionEntry[]): boolean {
	const messageEntries = entries.filter((entry) => entry.type === "message" && entry.message);
	for (let index = messageEntries.length - 1; index >= 0; index--) {
		const message = messageEntries[index]?.message;
		if (!message) continue;
		if (message.role === "user") return false;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const toolUseIds: string[] = [];
		for (const block of message.content) {
			const type = contentBlockType(block);
			if (type !== "tool_use" && type !== "toolCall") continue;
			const id = contentBlockId(block);
			if (!id) return true;
			toolUseIds.push(id);
		}
		if (toolUseIds.length === 0) continue;
		const answeredIds = new Set<string>();
		for (const entry of messageEntries.slice(index + 1)) {
			if (entry.message?.role !== "toolResult") return false;
			const id = messageToolResultId(entry.message);
			if (id) answeredIds.add(id);
		}
		return toolUseIds.some((id) => !answeredIds.has(id));
	}
	return false;
}

function appendThinkingOffEntry(entries: BranchSessionEntry[]): void {
	const last = entries[entries.length - 1];
	if (last?.type === "thinking_level_change" && last.thinkingLevel === "off") return;
	const parent = [...entries].reverse().find((entry) => typeof entry.id === "string");
	entries.push({
		type: "thinking_level_change",
		id: createEntryId(entries),
		parentId: parent?.id ?? null,
		timestamp: new Date().toISOString(),
		thinkingLevel: "off",
	});
}

function sanitizeUnsafeThinkingBlocks(entries: BranchSessionEntry[]): boolean {
	let sanitized = false;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		const filtered = entry.message.content.filter((block) => !isUnsafeAnthropicThinkingBlock(entry.message, block));
		if (filtered.length === entry.message.content.length) continue;
		entry.message.content = filtered;
		sanitized = true;
	}
	return sanitized;
}

function sanitizeForkEntries(entries: BranchSessionEntry[]): ForkSafetyInfo {
	const sanitized = sanitizeUnsafeThinkingBlocks(entries);
	const danglingToolUse = sanitized ? hasDanglingToolUse(entries) : false;
	if (danglingToolUse) appendThinkingOffEntry(entries);
	return { sanitized, danglingToolUse };
}

function childModelIsAnthropic(model: string | undefined, availableModels?: ModelInfo[], preferredProvider?: string): boolean {
	if (!model) return false;
	const modelInfo = findModelInfo(model, availableModels, preferredProvider);
	if (modelInfo) return modelInfo.provider.toLowerCase() === "anthropic";
	return splitKnownThinkingSuffix(model).baseModel.toLowerCase().startsWith("anthropic/");
}

export function resolveForkThinkingOverride(
	forkSafetyInfo: ForkSafetyInfo | undefined,
	childModel: string | undefined,
	availableModels?: ModelInfo[],
	preferredProvider?: string,
): "off" | undefined {
	if (!forkSafetyInfo?.sanitized || !forkSafetyInfo.danglingToolUse) return undefined;
	return childModelIsAnthropic(childModel, availableModels, preferredProvider) ? "off" : undefined;
}

function readSessionEntries(sessionFile: string): BranchSessionEntry[] {
	const lines = fs.readFileSync(sessionFile, "utf-8").split("\n").filter((line) => line.trim().length > 0);
	return lines.map((line, index) => {
		try {
			return JSON.parse(line) as BranchSessionEntry;
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			throw new Error(`Unable to inspect forked session ${sessionFile}: invalid JSONL on line ${index + 1}: ${cause.message}`, { cause });
		}
	});
}

export function createForkContextResolver(
	sessionManager: ForkableSessionManager,
	requestedContext: unknown,
	options: ForkContextResolverOptions = {},
): ForkContextResolver {
	if (resolveSubagentContext(requestedContext) !== "fork") {
		return {
			sessionFileForIndex: () => undefined,
			forkSafetyInfoForIndex: () => undefined,
		};
	}

	const parentSessionFile = sessionManager.getSessionFile();
	if (!parentSessionFile) {
		throw new Error("Forked subagent context requires a persisted parent session.");
	}

	const leafId = sessionManager.getLeafId();
	if (!leafId) {
		throw new Error("Forked subagent context requires a current leaf to fork from.");
	}

	const openSession = options.openSession
		?? sessionManager.openSession
		?? ((file: string, dir?: string) => SessionManager.open(file, dir));
	const sessionDir = options.branchSessionDir ?? sessionManager.getSessionDir?.();
	const cachedResolutions = new Map<number, ForkContextResolution>();

	const resolveFork = (index = 0): ForkContextResolution => {
		const cached = cachedResolutions.get(index);
		if (cached) return cached;
		try {
			if (!fs.existsSync(parentSessionFile)) {
				throw new Error(`Parent session file does not exist: ${parentSessionFile}. Pi has not persisted enough history to fork yet.`);
			}
			// createBranchedSession writes into the session dir without creating
			// it, so the resolver must guarantee the directory exists.
			if (options.branchSessionDir) {
				fs.mkdirSync(options.branchSessionDir, { recursive: true });
			}
			const sourceManager = openSession(parentSessionFile, sessionDir);
			const sessionFile = sourceManager.createBranchedSession(leafId);
			if (!sessionFile) {
				throw new Error("Session manager did not return a forked session file.");
			}
			let safetyInfo: ForkSafetyInfo = { sanitized: false, danglingToolUse: false };
			if (!fs.existsSync(sessionFile)) {
				const header = sourceManager.getHeader?.();
				const entries = sourceManager.getEntries?.();
				if (!header || !entries) {
					throw new Error(`Session manager returned a forked session file that does not exist and cannot be persisted by fallback: ${sessionFile}`);
				}
				safetyInfo = sanitizeForkEntries(entries);
				fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
				fs.writeFileSync(sessionFile, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
			} else {
				const entries = readSessionEntries(sessionFile);
				safetyInfo = sanitizeForkEntries(entries);
				if (safetyInfo.sanitized || safetyInfo.danglingToolUse) {
					fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
				}
			}
			const resolution = { sessionFile, safetyInfo };
			cachedResolutions.set(index, resolution);
			return resolution;
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			throw new Error(`Failed to create forked subagent session: ${cause.message}`, { cause });
		}
	};

	return {
		sessionFileForIndex(index = 0): string | undefined {
			return resolveFork(index).sessionFile;
		},
		forkSafetyInfoForIndex(index = 0): ForkSafetyInfo | undefined {
			return resolveFork(index).safetyInfo;
		},
	};
}
