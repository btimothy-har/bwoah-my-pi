import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { type OutputArtifactLease, OutputSink } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { bashToolRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import { formatOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { outputMeta, saveOutputArtifactText } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import type { ArtifactAllocation } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries, sanitizeText } from "@oh-my-pi/pi-utils";

const createdTempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "output-sink-fd-"));
	createdTempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of createdTempDirs.splice(0)) {
		await removeWithRetries(dir);
	}
});

// Force a spill on the first push: a tiny threshold plus a chunk larger than it
// kicks off the async artifact `Bun.FileSink` creation. dump()/dispose() both
// await that in-flight creation internally, so no wall-clock wait is needed to
// observe the fd being opened and then closed.
function spill(sink: OutputSink): void {
	sink.push(`${"x".repeat(64)}\n`);
}

/** Substitute only this artifact's writer, retaining real file/descriptor behavior. */
function instrumentArtifact(artifactPath: string): Bun.FileSink {
	const file = Bun.file(artifactPath);
	const writer = file.writer();
	vi.spyOn(file, "writer").mockReturnValue(writer);
	const realFile = Bun.file.bind(Bun);
	vi.spyOn(Bun, "file").mockImplementation((source, options) => {
		if (source === artifactPath) return file;
		return realFile(source as string, options);
	});
	return writer;
}
describe("OutputSink fd lifecycle", () => {
	test("dispose() releases the spill descriptor on error/abort paths that skip dump()", async () => {
		const dir = await createTempDir();
		const skill = path.join(dir, "SKILL.md");
		await Bun.write(skill, "# skill\n");

		// Cross the 64-descriptor limit used by the leak repro. More iterations do
		// not strengthen that boundary and only multiply serial file I/O.
		for (let i = 0; i < 72; i++) {
			const artifactPath = path.join(dir, `spill-${i}.txt`);
			const sink = new OutputSink({ artifactPath, artifactId: `art-${i}`, spillThreshold: 16 });
			spill(sink);
			// Error/abort path: bail without dump().
			await sink.dispose();
			// Descriptor released → the artifact is closed, complete, and readable,
			// and the unrelated skill read never hits EMFILE.
			const content = await Bun.file(artifactPath).text();
			expect(content).toContain("x".repeat(64));
			await Bun.file(skill).text();
		}
	});

	test("dump() then dispose() closes the sink exactly once", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "spill.txt");
		const sink = new OutputSink({ artifactPath, artifactId: "once", spillThreshold: 16 });
		spill(sink);

		const summary = await sink.dump();
		expect(summary.artifactId).toBe("once");
		expect(summary.truncated).toBe(true);

		// dispose() after dump() must be a harmless idempotent no-op — no throw
		// from double-closing the underlying FileSink.
		await sink.dispose();

		const content = await Bun.file(artifactPath).text();
		expect(content).toContain("x".repeat(64));
	});

	test("push() after finalize is dropped and never resurrects the descriptor", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "spill.txt");
		const sink = new OutputSink({ artifactPath, artifactId: "drop", spillThreshold: 16 });
		spill(sink);
		await sink.dispose();

		// A late chunk (e.g. a native callback firing after the error path tore
		// down) must not reopen a fresh spill sink.
		sink.push(`${"y".repeat(64)}\n`);
		await sink.dispose();

		const content = await Bun.file(artifactPath).text();
		expect(content).not.toContain("y".repeat(64));
	});

	test("dispose() preserves cancellation cleanup when capped tail replay fails", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "capped.txt");
		const writer = instrumentArtifact(artifactPath);
		const write = writer.write.bind(writer);
		vi.spyOn(writer, "write").mockImplementation(chunk => {
			if (typeof chunk === "string" && chunk.includes("[ARTIFACT TRUNCATED")) {
				throw new Error("simulated disk write failure");
			}
			return write(chunk);
		});
		const end = vi.spyOn(writer, "end");
		const sink = new OutputSink({
			artifactPath,
			artifactId: "capped",
			spillThreshold: 16,
			artifactMaxBytes: 40,
			artifactHeadBytes: 20,
		});
		sink.push("h".repeat(30));
		sink.push("t".repeat(60));
		await sink.dispose();
		await sink.dispose();
		sink.push("late callback");

		const summary = await sink.dump();
		expect(summary.output).toBe("t".repeat(16));
		expect(summary.artifactId).toBeUndefined();
		expect(summary.artifactError).toBe("flush");
		expect(end).toHaveBeenCalledTimes(1);
		expect(await Bun.file(artifactPath).text()).toBe("h".repeat(20));
		expect(formatOutputNotice(outputMeta().truncationFromSummary(summary, { direction: "tail" }).get())).toContain(
			"not saved completely",
		);
	});

	test("an artifact open failure is terminal even when its target becomes writable", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "blocked");
		await fs.mkdir(artifactPath);
		const sink = new OutputSink({ artifactPath, artifactId: "incomplete", spillThreshold: 4 });
		sink.push("lost-before-failure");
		await fs.rmdir(artifactPath);
		sink.push("tail");
		const summary = await sink.dump();
		const notice = formatOutputNotice(outputMeta().truncationFromSummary(summary, { direction: "tail" }).get());

		expect(summary.output).toBe("tail");
		expect(summary.artifactError).toBe("open");
		expect(summary.artifactId).toBeUndefined();
		expect(notice).toContain("not saved completely");
		expect(notice).not.toContain("artifact://");
		expect(await Bun.file(artifactPath).exists()).toBe(false);
	});

	test("a write failure preserves bounded output and stops subsequent capture writes", async () => {
		const dir = await createTempDir();
		const writer = instrumentArtifact(path.join(dir, "write.txt"));
		const sink = new OutputSink({
			artifactPath: path.join(dir, "write.txt"),
			artifactId: "write",
			spillThreshold: 4,
		});
		sink.push("prefix");
		const write = vi.spyOn(writer, "write").mockImplementation(() => {
			throw new Error("write failed");
		});
		const end = vi.spyOn(writer, "end");
		sink.push("failed");
		sink.push("tail");
		const summary = await sink.dump();
		await sink.dispose();

		expect(summary.output).toBe("tail");
		expect(summary.totalBytes).toBe(16);
		expect(summary.artifactError).toBe("write");
		expect(summary.artifactId).toBeUndefined();
		expect(write).toHaveBeenCalledTimes(1);
		expect(end).toHaveBeenCalledTimes(1);
		expect(await Bun.file(path.join(dir, "write.txt")).text()).toBe("prefix");
	});

	test("dump waits for rejected asynchronous writes before reporting recovery availability", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "async.txt");
		const writer = instrumentArtifact(artifactPath);
		const pendingWrite = Promise.withResolvers<number>();
		vi.spyOn(writer, "write").mockReturnValue(pendingWrite.promise);
		const end = vi.spyOn(writer, "end");
		const sink = new OutputSink({ artifactPath, artifactId: "async", spillThreshold: 4 });
		sink.push("prefix");
		const dumping = sink.dump();
		pendingWrite.reject(new Error("asynchronous write failed"));
		const summary = await dumping;

		expect(summary.output).toBe("efix");
		expect(summary.artifactError).toBe("write");
		expect(summary.artifactId).toBeUndefined();
		expect(end).toHaveBeenCalledTimes(1);
	});

	test("flush failure still closes the writer and is surfaced without a recovery link", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "flush.txt");
		const writer = instrumentArtifact(artifactPath);
		vi.spyOn(writer, "flush").mockImplementation(() => {
			throw new Error("flush failed");
		});
		const end = vi.spyOn(writer, "end");
		const sink = new OutputSink({ artifactPath, artifactId: "flush", spillThreshold: 4 });
		sink.push("prefix");
		const summary = await sink.dump();
		await sink.dispose();

		expect(summary.artifactError).toBe("flush");
		expect(summary.artifactId).toBeUndefined();
		expect(end).toHaveBeenCalledTimes(1);
		expect(formatOutputNotice(outputMeta().truncationFromSummary(summary, { direction: "tail" }).get())).toContain(
			"not saved completely",
		);
	});

	test("concurrent finalization waits for end failure even after output was minimized", async () => {
		const dir = await createTempDir();
		const artifactPath = path.join(dir, "end.txt");
		const writer = instrumentArtifact(artifactPath);
		const close = writer.end.bind(writer);
		const closing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const end = vi.spyOn(writer, "end").mockImplementation(async () => {
			await close();
			closing.resolve();
			await release.promise;
			throw new Error("end failed");
		});
		const sink = new OutputSink({ artifactPath, artifactId: "end", spillThreshold: 4 });
		sink.push("prefix");
		sink.replace("ok");
		const disposing = sink.dispose();
		await closing.promise;
		const dumping = sink.dump();
		release.resolve();
		await disposing;
		const summary = await dumping;
		await sink.dispose();
		const notice = formatOutputNotice(outputMeta().truncationFromSummary(summary, { direction: "tail" }).get());

		expect(summary.output).toBe("ok");
		expect(summary.truncated).toBe(false);
		expect(summary.artifactError).toBe("end");
		expect(summary.artifactId).toBeUndefined();
		expect(notice).toContain("not saved completely");
		expect(notice).not.toContain("artifact://");
		expect(end).toHaveBeenCalledTimes(1);
		expect(await Bun.file(artifactPath).text()).toBe("prefix");
		const meta = outputMeta().truncationFromSummary(summary, { direction: "tail" }).get();
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("Expected dark theme");
		const component = bashToolRenderer.renderResult(
			{ content: [{ type: "text", text: summary.output + notice }], details: { meta }, isError: false },
			{ expanded: true, isPartial: false, renderContext: { isFullOutput: true } },
			uiTheme,
			{ command: "printf ok" },
		);
		const rendered = sanitizeText(component.render(160).join("\n"));
		expect(rendered).toContain("not saved completely");
		expect(rendered).not.toContain("artifact://");
	});
});

/** Moves the allocation root independently of the sink's open descriptor. */
class FixtureArtifactLease implements OutputArtifactLease {
	resolveCount = 0;
	completeCount = 0;
	failNextResolve = false;
	failComplete = false;
	currentDir: string;
	readonly #filename: string;
	readonly #events?: string[];
	#writePath: string | undefined;
	#settlement: Promise<void> | undefined;

	constructor(initialDir: string, filename: string, events?: string[]) {
		this.currentDir = initialDir;
		this.#filename = filename;
		this.#events = events;
	}

	resolvePath(): Promise<string> {
		this.resolveCount++;
		if (this.failNextResolve) {
			this.failNextResolve = false;
			return Promise.reject(new Error("resolve failed"));
		}
		if (!this.#writePath) {
			this.#writePath = path.join(this.currentDir, this.#filename);
			return Promise.resolve(this.#writePath);
		}
		if (!this.#settlement) return Promise.resolve(this.#writePath);
		return Promise.resolve(path.join(this.currentDir, this.#filename));
	}

	complete(): Promise<void> {
		this.completeCount++;
		this.#settlement ??= this.#settle();
		return this.#settlement;
	}

	async #settle(): Promise<void> {
		this.#events?.push("complete");
		if (this.failComplete) throw new Error("complete failed");
		if (this.#writePath && (await Bun.file(this.#writePath).exists())) {
			const bytes = await Bun.file(this.#writePath).arrayBuffer();
			await Bun.write(path.join(this.currentDir, this.#filename), bytes);
		}
	}
}

describe("OutputSink artifact lease", () => {
	test("an fd opened before recovery publishes complete finalized bytes into the current root", async () => {
		const oldRoot = await createTempDir();
		const newRoot = await createTempDir();
		const filename = "0.bash.log";
		const oldPath = path.join(oldRoot, filename);
		const events: string[] = [];
		const lease = new FixtureArtifactLease(oldRoot, filename, events);
		const writer = instrumentArtifact(oldPath);
		const opened = Promise.withResolvers<void>();
		const write = writer.write.bind(writer);
		vi.spyOn(writer, "write").mockImplementation(chunk => {
			opened.resolve();
			return write(chunk);
		});
		const end = writer.end.bind(writer);
		vi.spyOn(writer, "end").mockImplementation(async () => {
			events.push("end");
			return await end();
		});
		const sink = new OutputSink({ artifactId: "0", artifactLease: lease, spillThreshold: 1, artifactMaxBytes: 0 });
		const prefixText = "before recovery\n".repeat(1024);
		const tailText = "after recovery\n".repeat(1024);

		sink.push(prefixText);
		await opened.promise;

		// Seed the stale prefix a recovery copy can leave while the descriptor is open.
		await Bun.write(path.join(newRoot, filename), prefixText.slice(0, 8192));
		lease.currentDir = newRoot;

		sink.push(tailText);
		const summary = await sink.dump();

		expect(events).toEqual(["end", "complete"]);
		expect(lease.completeCount).toBe(1);
		expect(summary.artifactId).toBe("0");
		expect(summary.artifactError).toBeUndefined();
		const finalized = await Bun.file(path.join(newRoot, filename)).text();
		expect(finalized).toBe(prefixText + tailText);
	});

	test("an allocated-but-unopened sink opens in the current root after relocation", async () => {
		const oldRoot = await createTempDir();
		const newRoot = await createTempDir();
		const filename = "1.bash.log";
		const lease = new FixtureArtifactLease(oldRoot, filename);
		const sink = new OutputSink({ artifactId: "1", artifactLease: lease, spillThreshold: 1, artifactMaxBytes: 0 });

		lease.currentDir = newRoot;
		sink.push(`${"x".repeat(64)}\n`);
		const summary = await sink.dump();

		expect(summary.artifactId).toBe("1");
		expect(lease.completeCount).toBe(1);
		expect(await Bun.file(path.join(newRoot, filename)).text()).toBe(`${"x".repeat(64)}\n`);
		expect(await Bun.file(path.join(oldRoot, filename)).exists()).toBe(false);
	});

	test("dump() then dispose() settles the lease exactly once", async () => {
		const root = await createTempDir();
		const lease = new FixtureArtifactLease(root, "2.bash.log");
		const sink = new OutputSink({ artifactId: "2", artifactLease: lease, spillThreshold: 4 });
		sink.push(`${"x".repeat(64)}\n`);

		const summary = await sink.dump();
		await sink.dispose();

		expect(summary.artifactId).toBe("2");
		expect(lease.completeCount).toBe(1);
		expect(await Bun.file(path.join(root, "2.bash.log")).text()).toBe(`${"x".repeat(64)}\n`);
	});

	test("a no-spill allocation settles the reservation without creating a file or advertising an id", async () => {
		const root = await createTempDir();
		const lease = new FixtureArtifactLease(root, "3.bash.log");
		const sink = new OutputSink({ artifactId: "3", artifactLease: lease, spillThreshold: 1024 });
		sink.push("short\n");

		const summary = await sink.dump();

		expect(lease.resolveCount).toBe(0);
		expect(lease.completeCount).toBe(1);
		expect(summary.artifactId).toBeUndefined();
		expect(summary.artifactError).toBeUndefined();
		expect(await fs.readdir(root)).toEqual([]);
	});

	test("an open-time resolve failure is terminal, still settles the lease, and suppresses the id", async () => {
		const root = await createTempDir();
		const lease = new FixtureArtifactLease(root, "4.bash.log");
		lease.failNextResolve = true;
		const sink = new OutputSink({ artifactId: "4", artifactLease: lease, spillThreshold: 4 });
		sink.push(`${"x".repeat(64)}\n`);

		const summary = await sink.dump();

		expect(summary.artifactError).toBe("open");
		expect(summary.artifactId).toBeUndefined();
		expect(lease.completeCount).toBe(1);
		expect(await fs.readdir(root)).toEqual([]);
	});

	test("a settlement failure keeps the inline output but suppresses the artifact id", async () => {
		const root = await createTempDir();
		const lease = new FixtureArtifactLease(root, "5.bash.log");
		lease.failComplete = true;
		const sink = new OutputSink({ artifactId: "5", artifactLease: lease, spillThreshold: 4 });
		sink.push(`${"x".repeat(64)}\n`);

		const summary = await sink.dump();
		await sink.dispose();

		expect(summary.artifactError).toBe("end");
		expect(summary.artifactId).toBeUndefined();
		expect(summary.output).toBe("xxx\n");
		expect(summary.truncated).toBe(true);
		expect(lease.completeCount).toBe(1);
	});

	test("a capped leased artifact stays a head/tail sample and settles once", async () => {
		const root = await createTempDir();
		const filename = "6.bash.log";
		const lease = new FixtureArtifactLease(root, filename);
		const sink = new OutputSink({
			artifactId: "6",
			artifactLease: lease,
			spillThreshold: 16,
			artifactMaxBytes: 32,
			artifactHeadBytes: 16,
		});
		sink.push("0123456789ABCDEF".repeat(4)); // 64 bytes against a 32-byte cap

		const summary = await sink.dump();

		expect(summary.artifactId).toBe("6");
		expect(summary.artifactElidedBytes).toBeGreaterThan(0);
		expect(lease.completeCount).toBe(1);
		const finalized = await Bun.file(path.join(root, filename)).text();
		expect(finalized.startsWith("0123456789ABCDEF")).toBe(true);
		expect(finalized.endsWith("0123456789ABCDEF")).toBe(true);
		expect(finalized).toContain("[ARTIFACT TRUNCATED:");
		const stripped = finalized.replace(/\n?\[ARTIFACT TRUNCATED:[^\]]+\]\n?/g, "");
		expect(Buffer.byteLength(stripped)).toBe(32);
	});
});

describe("saveOutputArtifactText lease settlement", () => {
	function sessionWithAllocation(allocation: ArtifactAllocation): ToolSession {
		return {
			allocateOutputArtifact: async () => allocation,
		} as unknown as ToolSession;
	}

	test("a managed allocation writes through the current root and advertises the finalized path", async () => {
		const oldRoot = await createTempDir();
		const newRoot = await createTempDir();
		const filename = "7.bash-original.log";
		const lease = new FixtureArtifactLease(oldRoot, filename);
		const session = sessionWithAllocation({ id: "7", path: path.join(oldRoot, filename), lease });

		lease.currentDir = newRoot;
		const saved = await saveOutputArtifactText(session, "bash-original", "raw payload\n");

		expect(lease.completeCount).toBe(1);
		expect(saved?.id).toBe("7");
		expect(saved?.path).toBe(path.join(newRoot, filename));
		expect(await Bun.file(path.join(newRoot, filename)).text()).toBe("raw payload\n");
		expect(await Bun.file(path.join(oldRoot, filename)).exists()).toBe(false);
	});

	test("an unmanaged allocation keeps the pre-lease path contract", async () => {
		const root = await createTempDir();
		const artifactPath = path.join(root, "a.tool.log");
		const session = sessionWithAllocation({ id: "a", path: artifactPath });

		const saved = await saveOutputArtifactText(session, "tool", "payload");

		expect(saved).toEqual({ id: "a", path: artifactPath });
		expect(await Bun.file(artifactPath).text()).toBe("payload");
	});

	test("a write failure still settles the lease and advertises nothing", async () => {
		const root = await createTempDir();
		// A regular file standing in for the directory makes the write fail with
		// ENOTDIR regardless of parent-directory creation behavior.
		const blocker = path.join(root, "blocker");
		await Bun.write(blocker, "not a directory");
		const filename = "8.bash.log";
		const lease = new FixtureArtifactLease(blocker, filename);
		const session = sessionWithAllocation({ id: "8", path: path.join(blocker, filename), lease });

		const saved = await saveOutputArtifactText(session, "bash", "payload");

		expect(saved).toBeUndefined();
		expect(lease.completeCount).toBe(1);
	});

	test("a settlement failure after a successful write advertises nothing", async () => {
		const root = await createTempDir();
		const filename = "9.bash.log";
		const lease = new FixtureArtifactLease(root, filename);
		lease.failComplete = true;
		const session = sessionWithAllocation({ id: "9", path: path.join(root, filename), lease });

		const saved = await saveOutputArtifactText(session, "bash", "payload");

		expect(saved).toBeUndefined();
		expect(lease.completeCount).toBe(1);
		expect(await Bun.file(path.join(root, filename)).text()).toBe("payload");
	});

	test("a missing or empty allocation advertises no artifact", async () => {
		expect(await saveOutputArtifactText({} as ToolSession, "bash", "payload")).toBeUndefined();
		expect(await saveOutputArtifactText(sessionWithAllocation({}), "bash", "payload")).toBeUndefined();
	});
});
