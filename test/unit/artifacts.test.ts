import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	formatArtifactWriteFailure,
	getArtifactsDir,
	getProjectArtifactsDir,
	getProjectChainRunsDir,
	getProjectSubagentsDir,
	tryWriteArtifact,
} from "../../src/shared/artifacts.ts";

describe("project-local artifact paths", () => {
	it("places generated subagent files under .pi-subagents for a project cwd", () => {
		const cwd = path.join("tmp", "repo");
		assert.equal(getProjectSubagentsDir(cwd), path.join(cwd, ".pi-subagents"));
		assert.equal(getProjectArtifactsDir(cwd), path.join(cwd, ".pi-subagents", "artifacts"));
		assert.equal(getProjectChainRunsDir(cwd), path.join(cwd, ".pi-subagents", "chain-runs"));
		assert.equal(getArtifactsDir(null, cwd), path.join(cwd, ".pi-subagents", "artifacts"));
	});

	it("keeps the session artifact fallback when no project cwd is available", () => {
		const sessionFile = path.join("tmp", "sessions", "parent.jsonl");
		assert.equal(getArtifactsDir(sessionFile), path.join("tmp", "sessions", "subagent-artifacts"));
	});

	it("recreates artifact parent directories at write time", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-test-"));
		try {
			const filePath = path.join(tempDir, ".pi-subagents", "artifacts", "out.md");
			assert.equal(tryWriteArtifact(filePath, "ok"), undefined);
			fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
			assert.equal(tryWriteArtifact(filePath, "still ok"), undefined);
			assert.equal(fs.readFileSync(filePath, "utf-8"), "still ok");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("returns a useful diagnostic when optional artifact persistence fails", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifacts-test-"));
		try {
			const blockingFile = path.join(tempDir, "blocking-file");
			fs.writeFileSync(blockingFile, "not a directory", "utf-8");
			const failure = tryWriteArtifact(path.join(blockingFile, "out.md"), "ok", "write artifact output");
			assert.ok(failure);
			assert.equal(failure.operation, "write artifact output");
			assert.match(formatArtifactWriteFailure(failure), /Failed to write artifact output/);
			assert.match(formatArtifactWriteFailure(failure), /blocking-file/);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
