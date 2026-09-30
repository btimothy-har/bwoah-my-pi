import { logger } from "@oh-my-pi/pi-utils";

const pendingCleanups = new Set<Promise<void>>();

/** Keep timed-out cleanup reachable until its resources really settle. */
export function trackLateCleanup(work: Promise<void>, context: Record<string, unknown>): void {
	const tracked = work
		.catch(error => {
			logger.warn("Deferred cleanup failed", {
				...context,
				error: error instanceof Error ? error.message : String(error),
			});
		})
		.finally(() => pendingCleanups.delete(tracked));
	pendingCleanups.add(tracked);
}

/**
 * Await every tracked late cleanup until the set is empty or `deadlineAt`
 * passes. Returns `false` at the deadline: pending work is NOT cancelled —
 * its promises keep owning their resources, and durable cleanup metadata
 * (isolation cleanup records) lets a later launch finish the job.
 * Cleanups registered while draining are awaited too.
 */
export async function drainLateCleanups(deadlineAt: number): Promise<boolean> {
	let drained = true;
	for (;;) {
		const pending = [...pendingCleanups];
		if (pending.length === 0) break;
		const settled = Promise.allSettled(pending).then(() => {});
		const remaining = Math.max(0, deadlineAt - Date.now());
		const timeout = Promise.withResolvers<void>();
		const timer = setTimeout(() => timeout.resolve(), remaining);
		timer.unref?.();
		await Promise.race([settled, timeout.promise]);
		clearTimeout(timer);
		if (pendingCleanups.size > 0 && Date.now() >= deadlineAt) {
			drained = false;
			break;
		}
	}
	return drained;
}
