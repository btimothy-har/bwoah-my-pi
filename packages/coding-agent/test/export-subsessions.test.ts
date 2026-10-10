import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { exportFromFile } from "../src/export/html";
import { BlobStore, externalizeImageDataSync } from "../src/session/blob-store";
import { serializeTitleSlot } from "../src/session/session-title-slot";
import { collectSubSessions } from "../src/session/sub-sessions";

type JsonObject = Record<string, unknown>;

interface EmbeddedSubSession {
	header: JsonObject | null;
	entries: JsonObject[];
	leafId: string | null;
}

interface EmbeddedSessionData {
	header: JsonObject | null;
	entries: JsonObject[];
	leafId: string | null;
	subSessions?: Record<string, EmbeddedSubSession>;
}

function sessionHeader(id: string, extra: JsonObject = {}): JsonObject {
	return {
		type: "session",
		version: 3,
		id,
		timestamp: "2026-06-12T00:00:00.000Z",
		cwd: "/tmp",
		...extra,
	};
}

function userEntry(
	id: string,
	parentId: string | null,
	text: string,
	timestamp = "2026-06-12T00:00:01.000Z",
): JsonObject {
	return {
		type: "message",
		id,
		parentId,
		timestamp,
		message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(timestamp) },
	};
}

async function writeSessionFile(
	filePath: string,
	header: JsonObject,
	entries: JsonObject[] = [],
	titleSlot = "",
): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const lines = [header, ...entries].map(entry => JSON.stringify(entry));
	await Bun.write(filePath, `${titleSlot}${lines.join("\n")}\n`);
}

function embeddedSession(html: string): EmbeddedSessionData {
	const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	if (!encoded) throw new Error("Export HTML is missing embedded session data");
	return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as EmbeddedSessionData;
}

async function exportData(
	inputPath: string,
	outputPath: string,
	options?: { includeSubSessions?: boolean },
): Promise<EmbeddedSessionData> {
	await exportFromFile(inputPath, { ...options, outputPath });
	return embeddedSession(await Bun.file(outputPath).text());
}

async function snapshotFile(filePath: string): Promise<{ bytes: Buffer; mtimeMs: number }> {
	const [bytes, stats] = await Promise.all([fs.readFile(filePath), fs.stat(filePath)]);
	return { bytes, mtimeMs: stats.mtimeMs };
}

async function expectFileUnchanged(filePath: string, before: { bytes: Buffer; mtimeMs: number }): Promise<void> {
	const after = await snapshotFile(filePath);
	expect(after.bytes).toEqual(before.bytes);
	expect(after.mtimeMs).toBe(before.mtimeMs);
}

const unsupportedLinkErrorCodes: Record<string, true> = {
	EACCES: true,
	ENOSYS: true,
	ENOTSUP: true,
	EOPNOTSUPP: true,
	EPERM: true,
};

function linkCreationUnsupported(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	const code = error.code;
	return typeof code === "string" && unsupportedLinkErrorCodes[code] === true;
}

/**
 * Contract: a session at `<dir>/<name>.jsonl` embeds subagent transcripts from
 * `<dir>/<name>/<AgentId>.jsonl` (recursively) under slash-joined keys, with
 * parent links and last-entry leaf ids. Corrupt/empty/backup files are skipped.
 */

function sessionJsonl(id: string, entryIds: string[], previousSessionFiles?: string[]): string {
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: "2026-06-12T00:00:00.000Z",
			cwd: "/tmp",
			previousSessionFiles,
		}),
	];
	let parent: string | null = null;
	for (const entryId of entryIds) {
		lines.push(
			JSON.stringify({
				type: "model_change",
				id: entryId,
				parentId: parent,
				timestamp: "2026-06-12T00:00:01.000Z",
				model: "test/model",
			}),
		);
		parent = entryId;
	}
	return `${lines.join("\n")}\n`;
}

describe("session HTML export and sub-session collection", () => {
	let root: string;
	let mainFile: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subsessions-"));
		mainFile = path.join(root, "main.jsonl");
		await Bun.write(mainFile, sessionJsonl("main", ["m1"]));
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	test("collects nested subagent sessions with parent links and leaf ids", async () => {
		await Bun.write(path.join(root, "main/Alpha.jsonl"), sessionJsonl("alpha", ["a1", "a2"]));
		await Bun.write(path.join(root, "main/Alpha/Child.jsonl"), sessionJsonl("child", ["c1"]));
		await Bun.write(path.join(root, "main/Beta.jsonl"), sessionJsonl("beta", ["b1"]));

		const subs = await collectSubSessions(mainFile);

		expect(Object.keys(subs).sort()).toEqual(["Alpha", "Alpha/Child", "Beta"]);
		expect(subs.Alpha).toMatchObject({ agentId: "Alpha", parent: null, leafId: "a2" });
		expect(subs.Alpha.entries.map(e => e.id)).toEqual(["a1", "a2"]);
		expect(subs.Alpha.header?.id).toBe("alpha");
		expect(subs["Alpha/Child"]).toMatchObject({ agentId: "Child", parent: "Alpha", leafId: "c1" });
		expect(subs.Beta).toMatchObject({ agentId: "Beta", parent: null, leafId: "b1" });
	});

	test("strips private main and nested headers while preserving the transcript and source files", async () => {
		const mainPath = "/Users/private/main.jsonl";
		const childPath = "/Users/private/Alpha.jsonl";
		const grandchildPath = "/Users/private/Alpha/Grandchild.jsonl";
		const childFile = path.join(root, "main/Alpha.jsonl");
		const grandchildFile = path.join(root, "main/Alpha/Grandchild.jsonl");
		await writeSessionFile(
			mainFile,
			sessionHeader("main", {
				cwd: "/workspace/main",
				additionalDirectories: ["/workspace/shared"],
				previousSessionFiles: [mainPath],
				executionCwd: "/machine/main",
			}),
			[userEntry("m1", null, "main conversation")],
		);
		await writeSessionFile(
			childFile,
			sessionHeader("alpha", {
				cwd: "/workspace/alpha",
				additionalDirectories: ["/workspace/alpha/shared"],
				previousSessionFiles: [childPath],
				executionCwd: { legacy: "invalid type" },
			}),
			[userEntry("a1", null, "child conversation")],
		);
		await writeSessionFile(
			grandchildFile,
			sessionHeader("grandchild", {
				cwd: "/workspace/grandchild",
				previousSessionFiles: [grandchildPath],
				executionCwd: "/machine/grandchild",
			}),
			[userEntry("g1", null, "grandchild conversation")],
		);
		const artifactMarker = path.join(root, "main", "export-marker.bin");
		const markerBytes = Buffer.from([0, 1, 2, 255]);
		await Bun.write(artifactMarker, markerBytes);
		const sources = [mainFile, childFile, grandchildFile, artifactMarker];
		const before = await Promise.all(sources.map(snapshotFile));
		const outputPath = path.join(root, "export.html");

		const data = await exportData(mainFile, outputPath);

		if (!data.header || !data.subSessions) throw new Error("Expected main and nested session data");
		expect(data.header.cwd).toBe("/workspace/main");
		expect(data.header.additionalDirectories).toEqual(["/workspace/shared"]);
		expect(data.header.previousSessionFiles).toBeUndefined();
		expect(data.header.executionCwd).toBeUndefined();
		expect(data.subSessions.Alpha?.header?.cwd).toBe("/workspace/alpha");
		expect(data.subSessions.Alpha?.header?.additionalDirectories).toEqual(["/workspace/alpha/shared"]);
		expect(data.subSessions.Alpha?.header?.previousSessionFiles).toBeUndefined();
		expect(data.subSessions.Alpha?.header?.executionCwd).toBeUndefined();
		expect(data.subSessions["Alpha/Grandchild"]?.header?.cwd).toBe("/workspace/grandchild");
		expect(data.subSessions["Alpha/Grandchild"]?.header?.previousSessionFiles).toBeUndefined();
		expect(data.subSessions["Alpha/Grandchild"]?.header?.executionCwd).toBeUndefined();
		expect(Object.keys(data.subSessions).sort()).toEqual(["Alpha", "Alpha/Grandchild"]);
		expect(JSON.stringify(data)).toContain("main conversation");
		expect(JSON.stringify(data)).toContain("child conversation");
		expect(JSON.stringify(data)).toContain("grandchild conversation");
		for (const [index, source] of sources.entries()) await expectFileUnchanged(source, before[index]!);
		expect(await fs.readFile(artifactMarker)).toEqual(markerBytes);
	});

	test("rejects a missing input without creating session or export files", async () => {
		const missingInput = path.join(root, "missing.jsonl");
		const outputPath = path.join(root, "export.html");

		await expect(exportFromFile(missingInput, { outputPath })).rejects.toThrow(`File not found: ${missingInput}`);
		expect(await Bun.file(missingInput).exists()).toBe(false);
		expect(await Bun.file(outputPath).exists()).toBe(false);
	});

	test("exports from a read-only source bucket without entering inaccessible recorded paths", async () => {
		const sourceBucket = path.join(root, "locked-source");
		const sourceFile = path.join(sourceBucket, "saved.jsonl");
		const artifactDir = path.join(sourceBucket, "saved");
		const markerPath = path.join(artifactDir, "artifact-marker.bin");
		const recordedCwd = path.join(root, "missing-workspace");
		const recordedExecutionCwd = path.join(root, "missing-execution-workspace");
		await writeSessionFile(
			sourceFile,
			sessionHeader("saved", {
				cwd: recordedCwd,
				executionCwd: recordedExecutionCwd,
			}),
			[userEntry("saved-entry", null, "read-only conversation")],
		);
		await fs.mkdir(artifactDir, { recursive: true });
		await Bun.write(markerPath, "artifact marker");
		const sources = [sourceFile, markerPath];
		const before = await Promise.all(sources.map(snapshotFile));
		const bucketEntries = (await fs.readdir(sourceBucket)).sort();
		const artifactEntries = (await fs.readdir(artifactDir)).sort();
		const outputPath = path.join(root, "read-only-export.html");
		const restrictPermissions = process.platform !== "win32";
		try {
			if (restrictPermissions) {
				await fs.chmod(sourceFile, 0o444);
				await fs.chmod(markerPath, 0o444);
				await fs.chmod(artifactDir, 0o555);
				await fs.chmod(sourceBucket, 0o555);
			}

			const data = await exportData(sourceFile, outputPath);

			expect(data.header?.cwd).toBe(recordedCwd);
			expect(data.header?.executionCwd).toBeUndefined();
			expect(JSON.stringify(data)).toContain("read-only conversation");
			expect((await fs.readdir(sourceBucket)).sort()).toEqual(bucketEntries);
			expect((await fs.readdir(artifactDir)).sort()).toEqual(artifactEntries);
			for (const [index, source] of sources.entries()) await expectFileUnchanged(source, before[index]!);
			expect(await Bun.file(recordedCwd).exists()).toBe(false);
			expect(await Bun.file(recordedExecutionCwd).exists()).toBe(false);
		} finally {
			if (restrictPermissions) {
				await fs.chmod(sourceBucket, 0o755);
				await fs.chmod(artifactDir, 0o755);
				await fs.chmod(sourceFile, 0o644);
				await fs.chmod(markerPath, 0o644);
			}
		}
	});

	test("exports a valid header-only transcript with no leaf", async () => {
		const headerOnlyFile = path.join(root, "header-only.jsonl");
		await writeSessionFile(headerOnlyFile, sessionHeader("header-only"));
		const before = await snapshotFile(headerOnlyFile);

		const data = await exportData(headerOnlyFile, path.join(root, "header-only.html"));

		expect(data.entries).toEqual([]);
		expect(data.leafId).toBeNull();
		await expectFileUnchanged(headerOnlyFile, before);
	});

	test("rejects empty and malformed headers but ignores malformed trailing records without repairing the source", async () => {
		const emptyFile = path.join(root, "empty-session.jsonl");
		const malformedFile = path.join(root, "malformed-header.jsonl");
		const emptyOutput = path.join(root, "empty-export.html");
		const malformedOutput = path.join(root, "malformed-export.html");
		await Bun.write(emptyFile, "");
		await Bun.write(malformedFile, "{not a header\n");
		const emptyBefore = await snapshotFile(emptyFile);
		const malformedBefore = await snapshotFile(malformedFile);

		await expect(exportFromFile(emptyFile, { outputPath: emptyOutput })).rejects.toThrow(
			`Cannot resume session "${path.resolve(emptyFile)}": the session file holds no entries. The file was not modified.`,
		);
		await expect(exportFromFile(malformedFile, { outputPath: malformedOutput })).rejects.toThrow(
			`Cannot resume session "${path.resolve(malformedFile)}": the session header is missing or malformed. The file was not modified.`,
		);
		expect(await Bun.file(emptyOutput).exists()).toBe(false);
		expect(await Bun.file(malformedOutput).exists()).toBe(false);
		await expectFileUnchanged(emptyFile, emptyBefore);
		await expectFileUnchanged(malformedFile, malformedBefore);

		const validFile = path.join(root, "malformed-tail.jsonl");
		const validEntry = userEntry("survives", null, "surviving conversation");
		await Bun.write(
			validFile,
			`${JSON.stringify(sessionHeader("valid"))}\n${JSON.stringify(validEntry)}\n{bad trailing record\n`,
		);
		const validBefore = await snapshotFile(validFile);
		const data = await exportData(validFile, path.join(root, "malformed-tail.html"));
		expect(data.entries.map(entry => entry.id)).toEqual(["survives"]);
		expect(data.leafId).toBe("survives");
		expect(JSON.stringify(data)).toContain("surviving conversation");
		await expectFileUnchanged(validFile, validBefore);
	});

	test("migrates v1 parent links and hook messages in the exported snapshot", async () => {
		const legacyFile = path.join(root, "legacy-v1.jsonl");
		await writeSessionFile(legacyFile, sessionHeader("legacy-v1", { version: 1 }), [
			{
				type: "message",
				timestamp: "2026-06-12T00:00:01.000Z",
				message: { role: "user", content: "legacy user message", timestamp: 1 },
			},
			{
				type: "message",
				timestamp: "2026-06-12T00:00:02.000Z",
				message: { role: "hookMessage", content: "legacy hook message", timestamp: 2 },
			},
			{
				type: "model_change",
				timestamp: "2026-06-12T00:00:03.000Z",
				model: "test/model",
			},
		]);
		const before = await snapshotFile(legacyFile);

		const data = await exportData(legacyFile, path.join(root, "legacy-v1.html"));

		const ids = data.entries.map(entry => entry.id);
		if (!ids.every((id): id is string => typeof id === "string")) {
			throw new Error("Migrated entries must have string ids");
		}
		expect(new Set(ids).size).toBe(3);
		expect(data.entries.map(entry => entry.parentId)).toEqual([null, ids[0], ids[1]]);
		const migratedHookEntry = data.entries[1];
		if (!migratedHookEntry) throw new Error("Expected the migrated hook entry");
		expect((migratedHookEntry.message as JsonObject).role).toBe("custom");
		expect(data.leafId).toBe(ids[2]);
		expect(data.header?.version).toBe(3);
		await expectFileUnchanged(legacyFile, before);
	});

	test("chooses the last file entry as leaf even when it is an older timestamped sibling", async () => {
		const branchFile = path.join(root, "branched-v3.jsonl");
		const timestamp = "2026-06-12T00:00:00.000Z";
		await writeSessionFile(branchFile, sessionHeader("branched"), [
			{
				type: "model_change",
				id: "root-entry",
				parentId: null,
				timestamp,
				model: "test/model",
			},
			{
				type: "model_change",
				id: "newer-child",
				parentId: "root-entry",
				timestamp: "2026-06-12T00:00:05.000Z",
				model: "test/model",
			},
			{
				type: "model_change",
				id: "last-file-sibling",
				parentId: "root-entry",
				timestamp: "2026-06-12T00:00:01.000Z",
				model: "test/model",
			},
		]);

		const data = await exportData(branchFile, path.join(root, "branched-v3.html"));

		expect(data.entries.map(entry => entry.id)).toEqual(["root-entry", "newer-child", "last-file-sibling"]);
		expect(data.leafId).toBe("last-file-sibling");
	});

	test("folds the fixed title slot and normalizes assistant messages without dropping non-Copilot replay metadata", async () => {
		const titleFile = path.join(root, "titled-session.jsonl");
		const replayFile = path.join(root, "assistant-normalization.jsonl");
		const titleSlot = serializeTitleSlot({
			title: "Fixed slot title",
			source: "user",
			updatedAt: "2026-06-12T00:00:10.000Z",
		});
		await writeSessionFile(
			titleFile,
			sessionHeader("titled", { title: "stale header title", titleSource: "auto" }),
			[userEntry("title-entry", null, "titled conversation")],
			titleSlot,
		);
		const replayPayload = {
			type: "openaiResponsesHistory",
			provider: "openai",
			items: [{ type: "reasoning", encrypted_content: "retained replay history" }],
		};
		await writeSessionFile(replayFile, sessionHeader("assistant-normalization"), [
			{
				type: "message",
				id: "copilot",
				parentId: null,
				timestamp: "2026-06-12T00:00:01.000Z",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "thinking", thinkingSignature: "copilot-signature" }],
					api: "openai-responses",
					provider: "github-copilot",
					model: "test/model",
					usage: { input: 4, output: 3 },
					stopReason: "stop",
					providerPayload: { ...replayPayload, provider: "github-copilot" },
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "openai",
				parentId: "copilot",
				timestamp: "2026-06-12T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "OpenAI turn" }],
					api: "openai-responses",
					provider: "openai",
					model: "test/model",
					usage: { input: 1, output: 2 },
					stopReason: "stop",
					providerPayload: replayPayload,
					timestamp: 2,
				},
			},
		]);

		const titleData = await exportData(titleFile, path.join(root, "titled-session.html"));
		const replayData = await exportData(replayFile, path.join(root, "assistant-normalization.html"));
		const copilotMessage = replayData.entries[0]?.message as JsonObject;
		const copilotContent = copilotMessage.content as JsonObject[];
		const copilotUsage = copilotMessage.usage as JsonObject;
		const openaiMessage = replayData.entries[1]?.message as JsonObject;
		const openaiUsage = openaiMessage.usage as JsonObject;

		expect(titleData.header?.title).toBe("Fixed slot title");
		expect(titleData.header?.titleSource).toBe("user");
		expect(copilotUsage).toMatchObject({
			input: 4,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 7,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		expect(copilotMessage.providerPayload).toBeUndefined();
		expect(copilotContent[0]?.thinkingSignature).toBeUndefined();
		expect(openaiMessage.providerPayload).toEqual(replayPayload);
		expect(openaiUsage).toMatchObject({ totalTokens: 3, cost: { total: 0 } });
	});

	test("rejects exporting over the transcript and preserves its bytes", async () => {
		const before = await snapshotFile(mainFile);

		await expect(exportFromFile(mainFile, { outputPath: mainFile })).rejects.toThrow(
			`Cannot export HTML over a source session file: ${mainFile}`,
		);

		await expectFileUnchanged(mainFile, before);
	});

	test("rejects a symlink output alias to the transcript", async () => {
		const outputAlias = path.join(root, "session-alias.jsonl");
		try {
			await fs.symlink(mainFile, outputAlias);
		} catch (error) {
			if (linkCreationUnsupported(error)) return;
			throw error;
		}
		const before = await snapshotFile(mainFile);

		await expect(exportFromFile(mainFile, { outputPath: outputAlias })).rejects.toThrow(
			`Cannot export HTML over a source session file: ${outputAlias}`,
		);

		await expectFileUnchanged(mainFile, before);
		expect((await fs.readFile(outputAlias)).toString("base64")).toBe(before.bytes.toString("base64"));
	});

	test("rejects a hardlink output alias to the transcript", async () => {
		const outputAlias = path.join(root, "session-hardlink.jsonl");
		try {
			await fs.link(mainFile, outputAlias);
		} catch (error) {
			if (linkCreationUnsupported(error)) return;
			throw error;
		}
		const before = await snapshotFile(mainFile);

		await expect(exportFromFile(mainFile, { outputPath: outputAlias })).rejects.toThrow(
			`Cannot export HTML over a source session file: ${outputAlias}`,
		);

		await expectFileUnchanged(mainFile, before);
		expect((await fs.readFile(outputAlias)).toString("base64")).toBe(before.bytes.toString("base64"));
	});

	test("rejects exporting over an included nested transcript", async () => {
		const nestedFile = path.join(root, "main/Alpha.jsonl");
		await Bun.write(nestedFile, sessionJsonl("alpha", ["a1"]));
		const sources = [mainFile, nestedFile];
		const before = await Promise.all(sources.map(snapshotFile));

		await expect(exportFromFile(mainFile, { outputPath: nestedFile })).rejects.toThrow(
			`Cannot export HTML over a source session file: ${nestedFile}`,
		);

		for (const [index, source] of sources.entries()) await expectFileUnchanged(source, before[index]!);
	});

	test("resolves blob-backed images from an isolated blob directory and retains missing references", async () => {
		const agentDir = path.join(root, "isolated-agent");
		const blobStore = new BlobStore(path.join(agentDir, "blobs"));
		const imageBytes = Buffer.from("isolated export image bytes");
		const imageData = imageBytes.toString("base64");
		const imageRef = externalizeImageDataSync(blobStore, imageData, "image/png");
		const missingImageRef = `blob:sha256:${"f".repeat(64)}`;
		const sourceFile = path.join(root, "blob-session.jsonl");
		const outputPath = path.join(root, "blob-export.html");
		await writeSessionFile(sourceFile, sessionHeader("blob-session"), [
			{
				type: "message",
				id: "image-result",
				parentId: null,
				timestamp: "2026-06-12T00:00:01.000Z",
				message: {
					role: "toolResult",
					toolCallId: "image-call",
					toolName: "read",
					content: [
						{ type: "image", data: imageRef, mimeType: "image/png" },
						{ type: "image", data: missingImageRef, mimeType: "image/png" },
					],
					isError: false,
					timestamp: 1,
				},
			},
		]);

		const childScript = `
			import { exportFromFile } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/export/html/index.ts"))};
			const inputPath = ${JSON.stringify(sourceFile)};
			const outputPath = ${JSON.stringify(outputPath)};
			await exportFromFile(inputPath, { outputPath });
			const html = await Bun.file(outputPath).text();
			const encoded = html.match(/<script id="session-data" type="application\\/json">([^<]+)<\\/script>/)?.[1];
			if (!encoded) throw new Error("Export HTML did not embed session data");
			console.log("EXPORT_SESSION_DATA:" + encoded);
		`;
		const home = path.join(root, "child-home");
		const child = Bun.spawnSync([process.execPath, "--eval", childScript], {
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: {
				HOME: home,
				USERPROFILE: home,
				TMPDIR: os.tmpdir(),
				TMP: os.tmpdir(),
				TEMP: os.tmpdir(),
				...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
				...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
				PI_CODING_AGENT_DIR: agentDir,
				NO_COLOR: "1",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
		const outputLine = new TextDecoder()
			.decode(child.stdout)
			.split(/\r?\n/)
			.find(line => line.startsWith("EXPORT_SESSION_DATA:"));
		if (!outputLine) throw new Error("Blob-isolated export child did not report embedded session data");
		const encoded = outputLine.slice("EXPORT_SESSION_DATA:".length);
		const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as EmbeddedSessionData;
		const imageEntry = data.entries[0];
		if (!imageEntry) throw new Error("Expected the exported image entry");
		const imageContent = (imageEntry.message as JsonObject).content as JsonObject[];

		expect(imageContent[0]?.data).toBe(imageData);
		expect(imageContent[1]?.data).toBe(missingImageRef);
	});

	test("skips corrupt, empty, backup, and non-jsonl files", async () => {
		await Bun.write(path.join(root, "main/Good.jsonl"), sessionJsonl("good", ["g1"]));
		await Bun.write(path.join(root, "main/corrupt.jsonl"), "{not json\n");
		await Bun.write(path.join(root, "main/empty.jsonl"), "");
		await Bun.write(path.join(root, "main/Good.jsonl.123.bak"), sessionJsonl("bak", ["x1"]));
		await Bun.write(path.join(root, "main/notes.md"), "# notes\n");

		const subs = await collectSubSessions(mainFile);

		expect(Object.keys(subs)).toEqual(["Good"]);
	});

	test("skips advisor transcripts stored alongside subagent sessions", async () => {
		await Bun.write(path.join(root, "main/Scout.jsonl"), sessionJsonl("scout", ["s1"]));
		await Bun.write(path.join(root, "main/__advisor.jsonl"), sessionJsonl("adv", ["v1"]));
		await Bun.write(path.join(root, "main/__advisor.reviewer.jsonl"), sessionJsonl("adv2", ["v2"]));
		await Bun.write(path.join(root, "main/Scout/__advisor.jsonl"), sessionJsonl("adv3", ["v3"]));

		const subs = await collectSubSessions(mainFile);

		expect(Object.keys(subs)).toEqual(["Scout"]);
	});

	test("terminates when a transcript stem names the directory itself", async () => {
		// "..jsonl" has the stem "."; descending into `<dir>/.` used to rescan the same directory forever.
		await Bun.write(path.join(root, "main/..jsonl"), sessionJsonl("dot", ["d1"]));
		await Bun.write(path.join(root, "main/Scout.jsonl"), sessionJsonl("scout", ["s1"]));

		const subs = await collectSubSessions(mainFile);

		expect(Object.keys(subs).sort()).toEqual([".", "Scout"]);
	});

	test("flags subagents killed with a tombstone sidecar as aborted", async () => {
		await Bun.write(path.join(root, "main/Killed.jsonl"), sessionJsonl("killed", ["k1"]));
		await Bun.write(path.join(root, "main/Killed.jsonl.tombstone"), "");
		await Bun.write(path.join(root, "main/Live.jsonl"), sessionJsonl("live", ["l1"]));

		const subs = await collectSubSessions(mainFile);

		expect(subs.Killed.aborted).toBe(true);
		expect(subs.Live.aborted).toBe(false);
	});

	test("returns empty record when no subagent dir exists", async () => {
		expect(await collectSubSessions(mainFile)).toEqual({});
		expect(await collectSubSessions(path.join(root, "not-a-session"))).toEqual({});
	});
});
