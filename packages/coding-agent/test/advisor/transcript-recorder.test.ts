/**
 * Contracts: AdvisorTranscriptRecorder persists the advisor agent's turns to a
 * subagent-style JSONL (`<session>/__advisor.jsonl`) so the advisor model's usage
 * is attributed in stats and its transcript shows in the Agent Hub.
 *
 * - Assistant turns land as `{type:"message", message:{role:"assistant", usage}}`
 *   entries — exactly the shape the stats parser reads for usage.
 * - User deltas are persisted but flagged `synthetic`/agent-attributed so stats'
 *   user-message metrics skip them.
 * - Non-conversational message kinds are not persisted.
 * - The target follows the session file: a switch routes later turns to the new
 *   session's `__advisor.jsonl`, leaving the prior file intact.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	ADVISOR_TRANSCRIPT_FILENAME,
	AdvisorTranscriptRecorder,
	advisorTranscriptFilename,
	loadAdvisorTranscriptCosts,
} from "@oh-my-pi/pi-coding-agent/advisor/transcript-recorder";
import type { SessionFileChange } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, removeWithRetries } from "@oh-my-pi/pi-utils";

interface AdvisorEntry {
	type?: string;
	id?: unknown;
	message?: {
		role?: string;
		model?: string;
		usage?: { input?: number };
		synthetic?: boolean;
		attribution?: string;
	};
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "advisor-recorder-"));
	try {
		return await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

/** Parse the message entries (skipping the session header) from an advisor JSONL. */
async function readMessageEntries(file: string): Promise<AdvisorEntry[]> {
	const text = await Bun.file(file).text();
	// JSON.parse returns `any`; assigning to the typed array narrows reads below.
	const entries: AdvisorEntry[] = text
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
	return entries.filter(entry => entry.type === "message");
}

function assistantMessage(text: string, inputTokens: number, cost = 0, provider = "anthropic"): AgentMessage {
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages",
		provider,
		model: "test-advisor-model",
		usage: {
			input: inputTokens,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 3,
			cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop" as const,
		timestamp: 1,
	};
	return message as unknown as AgentMessage;
}

function userMessage(text: string): AgentMessage {
	const message = { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 };
	return message as unknown as AgentMessage;
}

function developerMessage(text: string): AgentMessage {
	const message = { role: "developer" as const, content: [{ type: "text" as const, text }], timestamp: 1 };
	return message as unknown as AgentMessage;
}

describe("AdvisorTranscriptRecorder", () => {
	it("persists assistant turns with usage to <session>/__advisor.jsonl", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("reviewing", 42));
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages).toHaveLength(1);
			expect(messages[0].message?.role).toBe("assistant");
			expect(messages[0].message?.model).toBe("test-advisor-model");
			expect(messages[0].message?.usage?.input).toBe(42);
			// Stats keys on a non-empty entry id; SessionManager must assign one.
			expect(typeof messages[0].id).toBe("string");
			expect(String(messages[0].id).length).toBeGreaterThan(0);
		});
	});

	it("marks advisor user deltas synthetic and agent-attributed", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(userMessage("### Session update"));
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages).toHaveLength(1);
			expect(messages[0].message?.role).toBe("user");
			expect(messages[0].message?.synthetic).toBe(true);
			expect(messages[0].message?.attribution).toBe("agent");
		});
	});

	it("skips non-conversational message kinds", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(developerMessage("noise"));
			recorder.record(assistantMessage("kept", 1));
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.map(m => m.message?.role)).toEqual(["assistant"]);
		});
	});

	it("routes later turns to the new session file after a switch", async () => {
		await withTempDir(async dir => {
			let sessionFile = path.join(dir, "first.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("before switch", 1));
			sessionFile = path.join(dir, "second.jsonl");
			recorder.record(assistantMessage("after switch", 2));
			await recorder.close();

			const first = await readMessageEntries(path.join(dir, "first", ADVISOR_TRANSCRIPT_FILENAME));
			const second = await readMessageEntries(path.join(dir, "second", ADVISOR_TRANSCRIPT_FILENAME));
			expect(first).toHaveLength(1);
			expect(first[0].message?.usage?.input).toBe(1);
			expect(second).toHaveLength(1);
			expect(second[0].message?.usage?.input).toBe(2);
		});
	});

	it("skips a retried batch but keeps every billed assistant turn", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			// A failing advisor re-sends the identical batch each attempt; the turn
			// only commits once it finally succeeds (issue #9553).
			for (let attempt = 0; attempt < 5; attempt++) {
				recorder.beginTurn();
				recorder.record({ ...userMessage("### Session update"), timestamp: attempt + 1 } as AgentMessage);
				recorder.record(assistantMessage(`attempt ${attempt}`, 1, 0.1));
			}
			recorder.commitTurn();
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.filter(m => m.message?.role === "user")).toHaveLength(1);
			expect(messages.filter(m => m.message?.role === "assistant")).toHaveLength(5);
			expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBeCloseTo(0.5, 8);
		});
	});

	it("keeps identical deltas that belong to distinct committed turns", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			// The user re-submits the same prompt across three separate turns: each
			// renders an identical "Session update" yet is genuinely new content.
			for (let turn = 0; turn < 3; turn++) {
				recorder.beginTurn();
				recorder.record(userMessage("### Session update"));
				recorder.record(assistantMessage(`review ${turn}`, 1, 0.1));
				recorder.commitTurn();
			}
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.filter(m => m.message?.role === "user")).toHaveLength(3);
		});
	});

	it("keeps a repeated delta after the prior batch is abandoned", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.beginTurn();
			recorder.record(userMessage("### Session update"));
			recorder.abandonTurn();
			recorder.beginTurn();
			recorder.record(userMessage("### Session update"));
			recorder.commitTurn();
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.filter(m => m.message?.role === "user")).toHaveLength(2);
		});
	});

	it("holds post-snapshot records behind a byte boundary", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("before", 1, 0.25));
			const gate = Promise.withResolvers<void>();
			const ready = recorder.blockWritesUntil(gate.promise);
			recorder.record(assistantMessage("after", 1, 0.5));
			await ready;

			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const beforeRelease = await readMessageEntries(transcript);
			expect(beforeRelease.filter(m => m.message?.role === "assistant")).toHaveLength(1);

			gate.resolve();
			await recorder.close();
			const afterRelease = await readMessageEntries(transcript);
			expect(afterRelease.filter(m => m.message?.role === "assistant")).toHaveLength(2);
		});
	});

	it("keeps identical deltas delivered within one turn", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			// Two tool runs with byte-identical output render two identical chunks in
			// one delivery; both must persist (they are distinct positions, not a replay).
			recorder.beginTurn();
			recorder.record(userMessage("### Session update"));
			recorder.record(userMessage("### Session update"));
			recorder.record(assistantMessage("review", 1, 0.1));
			recorder.commitTurn();
			await recorder.close();

			const messages = await readMessageEntries(path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME));
			expect(messages.filter(m => m.message?.role === "user")).toHaveLength(2);
		});
	});

	it("loads cumulative costs by advisor slug", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const primary = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			const security = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
				advisorTranscriptFilename("security"),
			);
			primary.record(assistantMessage("primary", 1, 0.25));
			security.record(assistantMessage("first", 1, 0.25));
			security.record(assistantMessage("second", 1, 0.5));
			await Promise.all([primary.close(), security.close()]);

			expect(Object.fromEntries(await loadAdvisorTranscriptCosts(sessionFile))).toEqual({
				"": 0.25,
				security: 0.75,
			});
		});
	});

	it("excludes providers that only produced zero-cost turns from subscription attribution", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("paid", 1, 0.25, "openai"));
			recorder.record(assistantMessage("failed subscription fallback", 1, 0, "anthropic"));
			await recorder.close();

			const providersBySlug = new Map<string, Set<string>>();
			await loadAdvisorTranscriptCosts(sessionFile, { providersBySlug });
			expect([...(providersBySlug.get("") ?? [])]).toEqual(["openai"]);
		});
	});

	it("yields before snapshotting transcript metadata", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("persisted", 1, 0.25));
			await recorder.close();

			let snapshotTaken = false;
			const costs = loadAdvisorTranscriptCosts(sessionFile, {
				onSnapshot: () => {
					snapshotTaken = true;
				},
			});
			expect(snapshotTaken).toBe(false);
			expect((await costs).get("")).toBeCloseTo(0.25, 8);
			expect(snapshotTaken).toBe(true);
		});
	});

	it("excludes transcript entries appended after the cost snapshot", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("persisted before snapshot", 1, 0.25));
			await recorder.close();

			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const appended = Promise.withResolvers<void>();
			const costs = loadAdvisorTranscriptCosts(sessionFile, {
				onSnapshot: () => {
					const entry = JSON.stringify({
						type: "message",
						message: assistantMessage("billed after snapshot", 1, 0.5),
					});
					void fs.appendFile(transcript, `${entry}\n`).then(appended.resolve, appended.reject);
				},
			});
			await appended.promise;

			expect((await costs).get("")).toBeCloseTo(0.25, 8);
			expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBeCloseTo(0.75, 8);
		});
	});

	it("keeps valid costs when persisted entries are malformed", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "sess.jsonl");
			const recorder = new AdvisorTranscriptRecorder(
				() => sessionFile,
				() => dir,
			);
			recorder.record(assistantMessage("valid", 1, 0.25));
			await recorder.close();
			const transcript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const lines = (await fs.readFile(transcript, "utf8")).trimEnd().split("\n");
			lines.splice(
				-1,
				0,
				JSON.stringify({ type: "message", message: { role: "assistant" } }),
				"{ this is not valid json",
				JSON.stringify({ type: "message" }),
				"null",
			);
			await fs.writeFile(transcript, `${lines.join("\n")}\n`);

			expect((await loadAdvisorTranscriptCosts(sessionFile)).get("")).toBe(0.25);
		});
	});
});

describe("AdvisorTranscriptRecorder root relocation", () => {
	/**
	 * Harness emulating the owning session manager: holds the current session
	 * file and delivers storage-only relocation events synchronously after the
	 * path flips, exactly like `#moveOffSessionFile`/`rebaseSessionFile` do.
	 */
	function relocatableRecorder(
		dir: string,
		after?: Promise<unknown>,
	): {
		recorder: AdvisorTranscriptRecorder;
		relocate: (to: string, ready?: Promise<void>, reason?: SessionFileChange["reason"]) => void;
	} {
		let sessionFile = path.join(dir, "sess.jsonl");
		let changeCb: ((change: SessionFileChange) => void) | undefined;
		const recorder = new AdvisorTranscriptRecorder(
			() => sessionFile,
			() => dir,
			ADVISOR_TRANSCRIPT_FILENAME,
			after,
			cb => {
				changeCb = cb;
				return () => {
					changeCb = undefined;
				};
			},
		);
		let generation = 0;
		return {
			recorder,
			relocate(to, ready = Promise.resolve(), reason = "recovery") {
				const from = sessionFile;
				sessionFile = to;
				changeCb?.({ from, to, generation: ++generation, reason, ready });
			},
		};
	}

	async function pathExists(file: string): Promise<boolean> {
		return (await fs.stat(file).catch(() => null)) !== null;
	}

	async function readSessionId(file: string): Promise<unknown> {
		const text = await Bun.file(file).text();
		for (const line of text.trim().split("\n")) {
			const entry = JSON.parse(line);
			if (entry.type === "session") return entry.id;
		}
		return undefined;
	}

	/** Usage inputs of the persisted assistant turns, in file order. */
	async function recordedInputs(file: string): Promise<unknown[]> {
		return (await readMessageEntries(file)).map(entry => entry.message?.usage?.input);
	}

	/** Rejected readiness without an unhandled-rejection report; the recorder awaits it. */
	function failedSeed(message: string): Promise<void> {
		const ready = Promise.reject(new Error(message));
		ready.catch(() => {});
		return ready;
	}

	it("gates records queued before and after a recovery on truthful seed readiness", async () => {
		await withTempDir(async dir => {
			const gate = Promise.withResolvers<void>();
			const { recorder, relocate } = relocatableRecorder(dir, gate.promise);
			const oldTranscript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const newTranscript = path.join(dir, "sibling", ADVISOR_TRANSCRIPT_FILENAME);

			// Accepted before the migration starts, still gated behind `after`.
			recorder.record(assistantMessage("queued before migration", 1));
			const seed = Promise.withResolvers<void>();
			relocate(path.join(dir, "sibling.jsonl"), seed.promise);
			gate.resolve();
			recorder.record(assistantMessage("queued after migration", 2));

			// Publication at the new root must wait for the seed: an early create
			// would make the seed's no-overwrite copy skip the transcript.
			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(await pathExists(newTranscript)).toBe(false);

			seed.resolve();
			await recorder.close();

			expect(await recordedInputs(newTranscript)).toEqual([1, 2]);
			// The vacated root was never written or recreated.
			expect(await pathExists(path.join(dir, "sess"))).toBe(false);
			expect(await pathExists(oldTranscript)).toBe(false);
		});
	});

	it("rebases the open writer onto the recovered root with the same advisor session id", async () => {
		await withTempDir(async dir => {
			const { recorder, relocate } = relocatableRecorder(dir);
			const oldTranscript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const newTranscript = path.join(dir, "sibling", ADVISOR_TRANSCRIPT_FILENAME);
			recorder.record(assistantMessage("before recovery", 1));
			// Writer open at the old root, its bytes durable there.
			await recorder.flush();

			const seed = Promise.withResolvers<void>();
			relocate(path.join(dir, "sibling.jsonl"), seed.promise);
			recorder.record(assistantMessage("after recovery", 2));
			seed.resolve();
			await recorder.close();

			// The settled writer's journal is republished complete at the current
			// root; the queued-after record follows it there.
			expect(await recordedInputs(newTranscript)).toEqual([1, 2]);
			// No post-recovery writes land at the vacated path.
			expect(await recordedInputs(oldTranscript)).toEqual([1]);
			// Same advisor session, repointed — never recreated under a fresh id.
			expect(await readSessionId(newTranscript)).toBe(await readSessionId(oldTranscript));
		});
	});

	it("follows chained relocations deterministically", async () => {
		await withTempDir(async dir => {
			const { recorder, relocate } = relocatableRecorder(dir);
			const a = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const b = path.join(dir, "sibling", ADVISOR_TRANSCRIPT_FILENAME);
			const c = path.join(dir, "third", ADVISOR_TRANSCRIPT_FILENAME);
			recorder.record(assistantMessage("seeded at A", 1));
			await recorder.flush();

			const seedAB = Promise.withResolvers<void>();
			relocate(path.join(dir, "sibling.jsonl"), seedAB.promise);
			const seedBC = Promise.withResolvers<void>();
			relocate(path.join(dir, "third.jsonl"), seedBC.promise);
			recorder.record(assistantMessage("queued across both", 2));

			seedAB.resolve();
			seedBC.resolve();
			await recorder.close();

			// Each hop's republication carried exactly the bytes settled so far.
			expect(await recordedInputs(a)).toEqual([1]);
			expect(await recordedInputs(b)).toEqual([1]);
			expect(await recordedInputs(c)).toEqual([1, 2]);
			const id = await readSessionId(a);
			expect(await readSessionId(b)).toBe(id);
			expect(await readSessionId(c)).toBe(id);
		});
	});

	it("waits out the seed so its copied history is not skipped", async () => {
		await withTempDir(async dir => {
			const first = new AdvisorTranscriptRecorder(
				() => path.join(dir, "sess.jsonl"),
				() => dir,
			);
			first.record(assistantMessage("history", 1));
			await first.close();
			const oldTranscript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const newTranscript = path.join(dir, "sibling", ADVISOR_TRANSCRIPT_FILENAME);

			const { recorder, relocate } = relocatableRecorder(dir);
			// Emulate the owning manager's artifact seed: readiness resolves only
			// after the old root's bytes exist at the new root (no-overwrite copy).
			const copy = Promise.withResolvers<void>();
			const ready = copy.promise.then(() =>
				fs.cp(path.join(dir, "sess"), path.join(dir, "sibling"), {
					recursive: true,
					force: false,
					errorOnExist: false,
				}),
			);
			relocate(path.join(dir, "sibling.jsonl"), ready);
			recorder.record(assistantMessage("after seed", 2));

			for (let i = 0; i < 20; i++) await Promise.resolve();
			expect(await pathExists(newTranscript)).toBe(false);

			copy.resolve();
			await recorder.close();

			// Seeded history plus the queued record — nothing lost, same advisor id.
			expect(await recordedInputs(newTranscript)).toEqual([1, 2]);
			expect(await readSessionId(newTranscript)).toBe(await readSessionId(oldTranscript));
		});
	});

	it("follows a move whose rename already carried the transcript", async () => {
		await withTempDir(async dir => {
			const { recorder, relocate } = relocatableRecorder(dir);
			const oldTranscript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
			const newTranscript = path.join(dir, "moved", ADVISOR_TRANSCRIPT_FILENAME);
			recorder.record(assistantMessage("before move", 1));
			await recorder.flush();

			// `moveTo` relocates the artifact tree inline and only then notifies
			// with already-settled readiness.
			await fs.rename(path.join(dir, "sess"), path.join(dir, "moved"));
			relocate(path.join(dir, "moved.jsonl"), Promise.resolve(), "move");
			recorder.record(assistantMessage("after move", 2));
			await recorder.close();

			expect(await recordedInputs(newTranscript)).toEqual([1, 2]);
			// The rename vacated the old path; nothing recreated it.
			expect(await pathExists(oldTranscript)).toBe(false);
		});
	});

	it("surfaces a failed seed while moving the live writer off the foreign root", async () => {
		await withTempDir(async dir => {
			const warn = spyOn(logger, "warn").mockImplementation(() => {});
			try {
				const { recorder, relocate } = relocatableRecorder(dir);
				const oldTranscript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
				const newTranscript = path.join(dir, "sibling", ADVISOR_TRANSCRIPT_FILENAME);
				recorder.record(assistantMessage("before failed seed", 1));
				await recorder.flush();

				relocate(path.join(dir, "sibling.jsonl"), failedSeed("seed boom"));
				recorder.record(assistantMessage("after failed seed", 2));
				await recorder.close();

				expect(warn).toHaveBeenCalledWith("Advisor transcript relocation: artifact seed failed", expect.anything());
				// The writer could not stay on the foreign old root; the complete
				// bytes at the continuing root come from the republished journal —
				// verified by the rebase — never assumed from the failed copy.
				expect(await recordedInputs(newTranscript)).toEqual([1, 2]);
				expect(await recordedInputs(oldTranscript)).toEqual([1]);
				expect(await readSessionId(newTranscript)).toBe(await readSessionId(oldTranscript));
			} finally {
				warn.mockRestore();
			}
		});
	});

	it("fabricates no history at the new root when the seed failed before any writer opened", async () => {
		await withTempDir(async dir => {
			const warn = spyOn(logger, "warn").mockImplementation(() => {});
			try {
				const gate = Promise.withResolvers<void>();
				const { recorder, relocate } = relocatableRecorder(dir, gate.promise);
				const oldTranscript = path.join(dir, "sess", ADVISOR_TRANSCRIPT_FILENAME);
				const newTranscript = path.join(dir, "sibling", ADVISOR_TRANSCRIPT_FILENAME);
				recorder.record(assistantMessage("only genuine bytes", 7));
				relocate(path.join(dir, "sibling.jsonl"), failedSeed("seed boom"));
				gate.resolve();
				await recorder.close();

				expect(warn).toHaveBeenCalledWith("Advisor transcript relocation: artifact seed failed", expect.anything());
				// The new root holds exactly the bytes genuinely published there;
				// the vacated root was never recreated.
				expect(await recordedInputs(newTranscript)).toEqual([7]);
				expect(await pathExists(oldTranscript)).toBe(false);
			} finally {
				warn.mockRestore();
			}
		});
	});
});
