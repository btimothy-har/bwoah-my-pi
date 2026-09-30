/**
 * A subagent run that holds one spawn-semaphore permit until it settles.
 *
 * The task tool starts every spawn through a `SpawnRun`, always after the
 * whole call passed admission (no speculative streaming launch). The run
 * executes detached from any owner; the owner that adopts it binds its abort
 * signal and progress/artifact sinks via {@link SpawnRun.attach}, and the
 * latest progress update replays on attach so a run that advanced before
 * adoption is not rendered as pending.
 */
import type { AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";

/** Wall-clock stamps a spawn reports to the executor: call time and permit time. */
export interface SpawnLaunchTiming {
	invokedAt: number;
	acquiredAt: number;
}

/** Permit source bounding concurrent subagents; the task tool's session semaphore. */
export interface SpawnPermit {
	acquire(signal: AbortSignal): Promise<void>;
	release(): void;
}

/** Everything the run body needs from its `SpawnRun`. */
export interface SpawnRunBody {
	signal: AbortSignal;
	timing: SpawnLaunchTiming;
	onUpdate: AgentToolUpdateCallback<TaskToolDetails>;
	onArtifactsRetained: (cleanup: () => Promise<void>) => void;
}

/** Owner bindings applied when a run is adopted. */
export interface SpawnRunOwner {
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
	onArtifactsRetained?: (cleanup: () => Promise<void>) => void;
}

export class SpawnRun {
	readonly #controller = new AbortController();
	#onUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined;
	#lastUpdate: AgentToolResult<TaskToolDetails> | undefined;
	#onArtifactsRetained: ((cleanup: () => Promise<void>) => void) | undefined;
	#retainedCleanup: (() => Promise<void>) | undefined;
	/** Resolves once the permit is held; rejects with the acquire error when aborted first. */
	readonly started: Promise<SpawnLaunchTiming>;
	/** The run's payload; rejects only when `started` does. */
	readonly result: Promise<AgentToolResult<TaskToolDetails>>;

	/** Acquire a permit, then run `body` and release the permit when it settles. */
	constructor(permit: SpawnPermit, body: (run: SpawnRunBody) => Promise<AgentToolResult<TaskToolDetails>>) {
		const invokedAt = Date.now();
		this.started = permit.acquire(this.#controller.signal).then(() => ({ invokedAt, acquiredAt: Date.now() }));
		this.result = this.started.then(async timing => {
			try {
				return await body({
					signal: this.#controller.signal,
					timing,
					onUpdate: update => {
						this.#lastUpdate = update;
						return this.#onUpdate?.(update);
					},
					onArtifactsRetained: cleanup => {
						if (this.#onArtifactsRetained) this.#onArtifactsRetained(cleanup);
						else this.#retainedCleanup = cleanup;
					},
				});
			} finally {
				permit.release();
			}
		});
		// Owners await these only after adoption.
		void this.result.catch(() => undefined);
	}

	/** Bind the adopting owner: its abort cancels the run, and buffered progress/artifacts flush to it. */
	attach(owner: SpawnRunOwner): void {
		const signal = owner.signal;
		if (signal?.aborted) this.#controller.abort(signal.reason);
		else signal?.addEventListener("abort", () => this.#controller.abort(signal.reason), { once: true });
		this.#onUpdate = owner.onUpdate;
		if (this.#lastUpdate) void owner.onUpdate?.(this.#lastUpdate);
		this.#onArtifactsRetained = owner.onArtifactsRetained;
		const retained = this.#retainedCleanup;
		this.#retainedCleanup = undefined;
		if (retained) {
			if (owner.onArtifactsRetained) owner.onArtifactsRetained(retained);
			else void retained();
		}
	}
}
