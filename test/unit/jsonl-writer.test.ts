import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJsonlWriter, type DrainableSource, type JsonlWriteStream } from "../../src/shared/jsonl-writer.ts";

class MockSource implements DrainableSource {
	paused = 0;
	resumed = 0;
	pause(): void {
		this.paused++;
	}
	resume(): void {
		this.resumed++;
	}
}

class MockStream implements JsonlWriteStream {
	writes: string[] = [];
	ended = false;
	endCount = 0;
	private drainHandler?: () => void;
	private errorHandlers: Array<(error: Error) => void> = [];
	private readonly writeResults: boolean[];
	private readonly endError?: Error;
	constructor(writeResults: boolean[] = [], endError?: Error) {
		this.writeResults = writeResults;
		this.endError = endError;
	}
	write(chunk: string): boolean {
		this.writes.push(chunk);
		if (this.writeResults.length === 0) return true;
		return this.writeResults.shift() ?? true;
	}
	once(event: "drain", listener: () => void): JsonlWriteStream;
	once(event: "error", listener: (error: Error) => void): JsonlWriteStream;
	once(event: "drain" | "error", listener: (() => void) | ((error: Error) => void)): JsonlWriteStream {
		if (event === "drain") this.drainHandler = listener as () => void;
		else this.errorHandlers.push((error) => {
			this.errorHandlers = this.errorHandlers.filter((handler) => handler !== listener);
			(listener as (error: Error) => void)(error);
		});
		return this;
	}
	on(event: "error", listener: (error: Error) => void): JsonlWriteStream {
		this.errorHandlers.push(listener);
		return this;
	}
	end(callback?: () => void): void {
		this.ended = true;
		this.endCount++;
		if (this.endError) {
			setTimeout(() => this.emitError(this.endError!), 0);
			return;
		}
		callback?.();
	}
	emitDrain(): void {
		this.drainHandler?.();
	}
	emitError(error: Error): void {
		for (const handler of [...this.errorHandlers]) handler(error);
	}
}

describe("createJsonlWriter", () => {
	it("writes lines with trailing newline", () => {
		const source = new MockSource();
		const stream = new MockStream();
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
		});
		writer.writeLine('{"type":"a"}');
		writer.writeLine('{"type":"b"}');
		assert.deepEqual(stream.writes, ['{"type":"a"}\n', '{"type":"b"}\n']);
	});

	it("pauses on backpressure and resumes on drain", () => {
		const source = new MockSource();
		const stream = new MockStream([false, true]);
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
		});
		writer.writeLine('{"type":"a"}');
		assert.equal(source.paused, 1);
		assert.equal(source.resumed, 0);
		stream.emitDrain();
		assert.equal(source.resumed, 1);
		writer.writeLine('{"type":"b"}');
		assert.deepEqual(stream.writes, ['{"type":"a"}\n', '{"type":"b"}\n']);
	});

	it("closes stream once", async () => {
		const source = new MockSource();
		const stream = new MockStream();
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
		});
		await writer.close();
		assert.equal(stream.ended, true);
		await writer.close();
		assert.equal(stream.ended, true);
	});

	it("returns no-op writer when file path is undefined", async () => {
		const source = new MockSource();
		const writer = createJsonlWriter(undefined, source);
		writer.writeLine('{"type":"a"}');
		await writer.close();
		assert.equal(source.paused, 0);
		assert.equal(source.resumed, 0);
	});

	it("stops writing when maxBytes exceeded without pausing source", () => {
		const source = new MockSource();
		const stream = new MockStream();
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
			maxBytes: 30,
		});
		writer.writeLine('{"type":"a"}');
		writer.writeLine('{"type":"b"}');
		writer.writeLine('{"type":"c"}');
		assert.equal(stream.writes.length, 2);
		assert.deepEqual(stream.writes, ['{"type":"a"}\n', '{"type":"b"}\n']);
		assert.equal(source.paused, 0);
	});

	it("absorbs asynchronous stream errors", async () => {
		const source = new MockSource();
		const stream = new MockStream([false]);
		const errors: string[] = [];
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
			onError: (message) => errors.push(message),
		});
		writer.writeLine('{"type":"a"}');
		assert.equal(source.paused, 1);
		stream.emitError(new Error("ENOTDIR: not a directory"));
		writer.writeLine('{"type":"b"}');
		await writer.close();
		assert.equal(source.resumed, 1);
		assert.equal(stream.writes.length, 1);
		assert.match(writer.getError() ?? "", /ENOTDIR/);
		assert.deepEqual(errors, [writer.getError()]);
	});

	it("shares one in-flight close across concurrent callers", async () => {
		const source = new MockSource();
		const stream = new MockStream([], new Error("delayed concurrent close failure"));
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
		});
		writer.writeLine('{"type":"a"}');
		const closeA = writer.close();
		const closeB = writer.close();
		assert.strictEqual(closeA, closeB);
		await Promise.all([closeA, closeB]);
		assert.equal(stream.endCount, 1);
		assert.match(writer.getError() ?? "", /delayed concurrent close failure/);
	});

	it("waits for close errors before resolving", async () => {
		const source = new MockSource();
		const stream = new MockStream([], new Error("delayed close failure"));
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
		});
		writer.writeLine('{"type":"a"}');
		await writer.close();
		assert.match(writer.getError() ?? "", /delayed close failure/);
	});

	it("allows writes up to exactly maxBytes", () => {
		const source = new MockSource();
		const stream = new MockStream();
		const line = '{"x":"a"}';
		const lineBytes = Buffer.byteLength(`${line}\n`, "utf-8");
		const writer = createJsonlWriter("/tmp/out.jsonl", source, {
			createWriteStream: () => stream,
			maxBytes: lineBytes * 2,
		});
		writer.writeLine(line);
		writer.writeLine(line);
		writer.writeLine(line);
		assert.equal(stream.writes.length, 2);
	});
});
