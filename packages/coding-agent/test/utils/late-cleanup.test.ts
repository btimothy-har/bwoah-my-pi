import { describe, expect, it } from "bun:test";
import { drainLateCleanups, trackLateCleanup } from "@oh-my-pi/pi-coding-agent/utils/late-cleanup";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
	return Promise.withResolvers<void>();
}

describe("drainLateCleanups", () => {
	it("waits for tracked cleanups and reports a full drain", async () => {
		const gate = deferred();
		trackLateCleanup(gate.promise, { resource: "test" });
		const drained = drainLateCleanups(Date.now() + 1000);
		gate.resolve();
		expect(await drained).toBe(true);
	});

	it("joins cleanups registered while draining", async () => {
		const first = deferred();
		trackLateCleanup(first.promise, { resource: "test" });
		const drained = drainLateCleanups(Date.now() + 5000);
		// Registered while the drain is waiting on `first`, and left pending
		// until after the probe below.
		const second = deferred();
		trackLateCleanup(second.promise, { resource: "test-nested" });
		first.resolve();
		// (No chain: `second` must stay pending until after the probe below.)
		// Microtask-drain only: a drain that snapshots the registry once would
		// have settled at `first`; the re-reading drain must still be waiting
		// on the pending `second`.
		for (let i = 0; i < 20; i++) await Promise.resolve();
		let settledEarly = false;
		drained.then(() => (settledEarly = true));
		await Promise.resolve();
		expect(settledEarly).toBe(false);
		second.resolve();
		expect(await drained).toBe(true);
	});

	it("returns false at the deadline without cancelling the underlying work", async () => {
		const gate = deferred();
		trackLateCleanup(gate.promise, { resource: "test" });
		// Deadline already passed: the drain reports false immediately; the
		// tracked promise still owns its resource and settles undisturbed.
		const drained = drainLateCleanups(Date.now() - 1);
		expect(await drained).toBe(false);
		gate.resolve();
		await gate.promise;
	});

	it("survives tracked cleanup rejection without failing the drain", async () => {
		const gate = deferred();
		trackLateCleanup(gate.promise, { resource: "test" });
		const drained = drainLateCleanups(Date.now() + 1000);
		gate.reject(new Error("cleanup failed"));
		expect(await drained).toBe(true);
	});
});
