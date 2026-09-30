import { vi } from "bun:test";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";

export interface CloneSeamOptions {
	/**
	 * Fixed repo root reported by the probe and the prepared context. Defaults
	 * to echoing the caller's cwd, which keeps nested or temp-dir sessions
	 * self-consistent without a real Git checkout.
	 */
	repoRoot?: string;
	/**
	 * Prepared-context baseline shape: `"null"` (default) records an explicit
	 * null baseline, `"omit"` drops the key entirely. Inert either way — the
	 * baseline is only consumed by the real isolation runner, which this seam
	 * replaces — so suites keep whichever shape they historically stubbed.
	 */
	baseline?: "null" | "omit";
}

/**
 * Stub the ordinary-clone seam so a structured subagent run reaches the
 * (separately mocked) executor without a real Git checkout: the probe and
 * preparation succeed vacuously, the isolated runner delegates to
 * `runSubprocess`, and merges resolve to a clean no-op apply-back.
 *
 * The runner stub forwards the subprocess result to `opts.onSubprocessResult`,
 * mirroring the real runner's usage-reporting callback so eval-path accounting
 * stays observable; task-kind invocations leave the callback undefined, so
 * forwarding is a no-op there.
 *
 * Tests that need a different runner or merge outcome re-spy the same exports
 * after calling this — the later `vi.spyOn` implementation wins.
 */
export function stubCloneSeam(options: CloneSeamOptions = {}): void {
	vi.spyOn(isolationRunner, "probeIsolationRepoRoot").mockImplementation(async cwd => ({
		repoRoot: options.repoRoot ?? cwd,
	}));
	vi.spyOn(isolationRunner, "prepareIsolationContext").mockImplementation(async cwd =>
		options.baseline === "omit"
			? ({ repoRoot: options.repoRoot ?? cwd } as never)
			: ({ repoRoot: options.repoRoot ?? cwd, baseline: null } as never),
	);
	vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async opts => {
		const result = await executorModule.runSubprocess(opts.baseOptions);
		opts.onSubprocessResult?.(result);
		return result;
	});
	vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
		summary: "",
		changesApplied: true,
		hadAnyChanges: false,
		mergedBranchForNestedPatches: false,
	});
}
