import * as fs from "node:fs";

export interface DrainableSource {
	pause(): void;
	resume(): void;
}

export interface JsonlWriteStream {
	write(chunk: string): boolean;
	once(event: "drain", listener: () => void): JsonlWriteStream;
	once(event: "error", listener: (error: Error) => void): JsonlWriteStream;
	on(event: "error", listener: (error: Error) => void): JsonlWriteStream;
	end(callback?: () => void): void;
}

const DEFAULT_MAX_JSONL_BYTES = 50 * 1024 * 1024;
const JSONL_CLOSE_TIMEOUT_MS = 1000;

interface JsonlWriterDeps {
	createWriteStream?: (filePath: string) => JsonlWriteStream;
	maxBytes?: number;
	onError?: (message: string) => void;
}

interface JsonlWriter {
	writeLine(line: string): void;
	close(): Promise<void>;
	getError(): string | undefined;
}

export function createJsonlWriter(
	filePath: string | undefined,
	source: DrainableSource,
	deps: JsonlWriterDeps = {},
): JsonlWriter {
	if (!filePath) {
		return {
			writeLine() {},
			async close() {},
			getError() { return undefined; },
		};
	}

	let writeError: string | undefined;
	const recordError = (error: unknown) => {
		if (writeError) return;
		const message = error instanceof Error ? error.message : String(error);
		writeError = `Failed to write JSONL artifact '${filePath}': ${message}`;
		deps.onError?.(writeError);
	};

	const createWriteStream = deps.createWriteStream ?? ((targetPath: string) => fs.createWriteStream(targetPath, { flags: "a" }));
	let backpressured = false;
	let closed = false;
	let bytesWritten = 0;
	const maxBytes = deps.maxBytes ?? DEFAULT_MAX_JSONL_BYTES;
	let stream: JsonlWriteStream | undefined;
	let closePromise: Promise<void> | undefined;
	try {
		stream = createWriteStream(filePath);
		stream.on("error", (error) => {
			recordError(error);
			if (backpressured) {
				backpressured = false;
				source.resume();
			}
			closed = true;
			stream = undefined;
		});
	} catch (error) {
		recordError(error);
		return {
			writeLine() {},
			async close() {},
			getError() { return writeError; },
		};
	}

	return {
		writeLine(line: string) {
			if (!stream || closed || !line.trim()) return;
			const chunk = `${line}\n`;
			const chunkBytes = Buffer.byteLength(chunk, "utf-8");
			if (bytesWritten + chunkBytes > maxBytes) return;
			try {
				const ok = stream.write(chunk);
				bytesWritten += chunkBytes;
				if (!ok && !backpressured) {
					backpressured = true;
					source.pause();
					stream.once("drain", () => {
						backpressured = false;
						if (!closed) source.resume();
					});
				}
			} catch (error) {
				recordError(error);
				if (backpressured) {
					backpressured = false;
					source.resume();
				}
				closed = true;
				stream = undefined;
			}
		},
		close() {
			if (closePromise) return closePromise;
			if (!stream || closed) return Promise.resolve();
			closed = true;
			const current = stream;
			stream = undefined;
			closePromise = new Promise<void>((resolve) => {
				let done = false;
				let timeout: NodeJS.Timeout | undefined;
				const finish = () => {
					if (done) return;
					done = true;
					if (timeout) clearTimeout(timeout);
					resolve();
				};
				timeout = setTimeout(() => {
					recordError(new Error(`close timed out after ${JSONL_CLOSE_TIMEOUT_MS}ms`));
					finish();
				}, JSONL_CLOSE_TIMEOUT_MS);
				timeout.unref?.();
				current.once("error", (error) => {
					recordError(error);
					finish();
				});
				try {
					current.end(finish);
				} catch (error) {
					recordError(error);
					finish();
				}
			});
			return closePromise;
		},
		getError() {
			return writeError;
		},
	};
}
