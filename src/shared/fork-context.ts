import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";

type SubagentExecutionContext = "fresh" | "fork";

interface BranchSessionEntry {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
		provider?: string;
		api?: string;
		model?: string;
	};
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
}

interface ForkContextResolver {
	sessionFileForIndex(index?: number): string | undefined;
}

export function resolveSubagentContext(value: unknown): SubagentExecutionContext {
	return value === "fork" ? "fork" : "fresh";
}

function hasUnsafeSignedThinkingBlock(message: BranchSessionEntry["message"]): boolean {
	if (!message || !Array.isArray(message.content)) return false;
	const provider = typeof message.provider === "string" ? message.provider.toLowerCase() : "";
	const api = typeof message.api === "string" ? message.api.toLowerCase() : "";
	const model = typeof message.model === "string" ? message.model.toLowerCase() : "";
	const isAnthropic = provider === "anthropic" || api === "anthropic-messages" || model.startsWith("anthropic/");

	return message.content.some((block) => {
		if (!block || typeof block !== "object" || !("type" in block)) return false;
		if (block.type === "redacted_thinking") return true;
		if (block.type !== "thinking" || !isAnthropic) return false;
		const signature = "thinkingSignature" in block ? block.thinkingSignature : "signature" in block ? block.signature : undefined;
		return block.redacted === true || (typeof signature === "string" && signature.length > 0);
	});
}

function assertNoSignedThinkingBlocks(entries: BranchSessionEntry[], sessionFile: string): void {
	const unsafeEntry = entries.find((entry) =>
		entry.type === "message"
		&& entry.message?.role === "assistant"
		&& hasUnsafeSignedThinkingBlock(entry.message)
	);
	if (!unsafeEntry) return;

	throw new Error(
		`Forked subagent context is unsafe for ${sessionFile}: the inherited transcript contains Anthropic signed thinking/redacted_thinking blocks. `
		+ "pi-subagents cannot verify lossless preservation of those blocks after session branching or compaction. "
		+ "Run this subagent with context: \"fresh\" or fork from a parent transcript without those signed thinking blocks.",
	);
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
	const sessionDir = sessionManager.getSessionDir?.();
	const cachedSessionFiles = new Map<number, string>();

	return {
		sessionFileForIndex(index = 0): string | undefined {
			const cached = cachedSessionFiles.get(index);
			if (cached) return cached;
			try {
				if (!fs.existsSync(parentSessionFile)) {
					throw new Error(`Parent session file does not exist: ${parentSessionFile}. Pi has not persisted enough history to fork yet.`);
				}
				const sourceManager = openSession(parentSessionFile, sessionDir);
				const sessionFile = sourceManager.createBranchedSession(leafId);
				if (!sessionFile) {
					throw new Error("Session manager did not return a forked session file.");
				}
				if (!fs.existsSync(sessionFile)) {
					const header = sourceManager.getHeader?.();
					const entries = sourceManager.getEntries?.();
					if (!header || !entries) {
						throw new Error(`Session manager returned a forked session file that does not exist and cannot be persisted by fallback: ${sessionFile}`);
					}
					assertNoSignedThinkingBlocks(entries, sessionFile);
					fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
					fs.writeFileSync(sessionFile, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
				} else {
					assertNoSignedThinkingBlocks(readSessionEntries(sessionFile), sessionFile);
				}
				cachedSessionFiles.set(index, sessionFile);
				return sessionFile;
			} catch (error) {
				const cause = error instanceof Error ? error : new Error(String(error));
				throw new Error(`Failed to create forked subagent session: ${cause.message}`, { cause });
			}
		},
	};
}
