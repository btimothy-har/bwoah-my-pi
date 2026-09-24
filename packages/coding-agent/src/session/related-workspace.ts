/**
 * Resolution of the global `workspace.related` map for the live execution
 * directory.
 *
 * The map is keyed by canonical checkout path (absolute or `~`-prefixed) and
 * supplies read-only related directories plus shared context files for any
 * session running inside that checkout or one of its linked worktrees. All
 * YAML shape validation lives here: values arrive from config verbatim, so
 * every malformed key, entry, or list item degrades to a warning and is
 * skipped. Map results are recomputed on every system-prompt rebuild and are
 * never persisted into the session.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	directoryIsEnterable,
	isEnoent,
	isRecord,
	logger,
	normalizePathForComparison,
	resolveEquivalentPath,
} from "@oh-my-pi/pi-utils";
import { loadCapability } from "../capability";
import { type ContextFile, contextFileCapability } from "../capability/context-file";
import type { RelatedWorkspaceEntry } from "../config/settings-schema";
import { expandAtImports } from "../discovery/at-imports";
import { normalizePromptPath } from "../utils/prompt-path";
import { normalizeWorkspaceDirectory } from "./session-workspace";
import type { WorkspacePolicyState } from "./workspace-policy";

export interface RelatedWorkspace {
	/** Realpath-normalized canonical checkout that matched a map key; null when no entry applies. */
	key: string | null;
	/** Enterable related directories from the map: absolute, realpath-normalized, deduped, cwd excluded. */
	directories: string[];
	/** Shared context file paths from the map: absolute, `~` expanded; existence checked by loadSharedContextFiles. */
	contextFiles: string[];
}

export const EMPTY_RELATED_WORKSPACE: RelatedWorkspace = { key: null, directories: [], contextFiles: [] };

/** One rendered `<related-directories>` entry. Paths are `normalizePromptPath`-normalized. */
export interface RelatedDirectory {
	path: string;
	/** Project-level context file paths owned by this root, for on-demand reading. */
	contextFiles: string[];
}

/**
 * Canonical checkout key for `workspace.related` lookup: the repository root
 * for a primary checkout, the primary root for a linked worktree. Isolated
 * task sandboxes and unverified directories never match. Callers MUST obtain
 * `state` from `resolveWorkspacePolicyState(cwd, isolatedTaskRoot)` with the
 * isolated root passed: isolated sandboxes sever Git metadata and would
 * otherwise classify as primary.
 */
export function relatedWorkspaceKey(state: WorkspacePolicyState): string | null {
	switch (state.kind) {
		case "primary":
			return state.root;
		case "worktree":
			return state.primaryRoot;
		case "isolated":
		case "unverified":
			return null;
	}
}

/**
 * Resolve the `workspace.related` entry applying to `state`/`cwd`.
 *
 * The first map key whose normalized absolute path equals the canonical
 * checkout key wins; later duplicates warn and are ignored. Directory entries
 * resolve relative paths against the matched canonical root, must be
 * enterable, and are realpath-normalized, deduped, and stripped of `cwd`.
 * Context file entries follow the same path rules without an existence check
 * (missing files warn at load time). Never throws: any failure degrades to
 * {@link EMPTY_RELATED_WORKSPACE}.
 */
export async function resolveRelatedWorkspace(args: {
	state: WorkspacePolicyState;
	cwd: string;
	related: Record<string, RelatedWorkspaceEntry>;
}): Promise<RelatedWorkspace> {
	try {
		const stateKey = relatedWorkspaceKey(args.state);
		if (stateKey === null) return EMPTY_RELATED_WORKSPACE;
		const wanted = normalizePathForComparison(stateKey);
		let matchedKey: string | null = null;
		let matchedEntry: RelatedWorkspaceEntry | null = null;
		let canonicalRoot = "";
		for (const [mapKey, entry] of Object.entries(args.related)) {
			const candidate = normalizeWorkspaceDirectory(mapKey);
			if (normalizePathForComparison(candidate) !== wanted) continue;
			if (matchedKey === null) {
				matchedKey = mapKey;
				matchedEntry = entry;
				canonicalRoot = candidate;
			} else {
				logger.warn("workspace.related: duplicate key ignored", { key: mapKey });
			}
		}
		if (matchedKey === null || matchedEntry === null) return EMPTY_RELATED_WORKSPACE;
		if (!isRecord(matchedEntry)) {
			logger.warn("workspace.related: entry is not an object", { key: matchedKey });
			return EMPTY_RELATED_WORKSPACE;
		}

		const cwdComparable = normalizePathForComparison(args.cwd);
		const directories: string[] = [];
		const seenDirectories = new Set<string>();
		const rawDirectories = Array.isArray(matchedEntry.directories) ? matchedEntry.directories : [];
		for (const value of rawDirectories) {
			if (typeof value !== "string") {
				logger.warn("workspace.related: ignoring non-string directory", { key: matchedKey, value });
				continue;
			}
			let directory = normalizeWorkspaceDirectory(value, canonicalRoot);
			if (!(await directoryIsEnterable(directory))) {
				logger.warn("workspace.related: skipping unavailable directory", { key: matchedKey, path: directory });
				continue;
			}
			directory = resolveEquivalentPath(directory);
			const comparable = normalizePathForComparison(directory);
			if (comparable === cwdComparable || seenDirectories.has(comparable)) continue;
			seenDirectories.add(comparable);
			directories.push(directory);
		}

		const contextFiles: string[] = [];
		const seenContextFiles = new Set<string>();
		const rawContextFiles = Array.isArray(matchedEntry.contextFiles) ? matchedEntry.contextFiles : [];
		for (const value of rawContextFiles) {
			if (typeof value !== "string") {
				logger.warn("workspace.related: ignoring non-string context file", { key: matchedKey, value });
				continue;
			}
			const contextFile = normalizeWorkspaceDirectory(value, canonicalRoot);
			if (seenContextFiles.has(contextFile)) continue;
			seenContextFiles.add(contextFile);
			contextFiles.push(contextFile);
		}

		return { key: resolveEquivalentPath(canonicalRoot), directories, contextFiles };
	} catch (error) {
		logger.warn("workspace.related: resolution failed", { error: String(error) });
		return EMPTY_RELATED_WORKSPACE;
	}
}

/**
 * Union of session-added and map-supplied workspace directories for prompt
 * rendering: session entries first, then related entries, dropping anything
 * equal to `cwd` and deduping by realpath comparison (first occurrence wins).
 */
export function effectiveWorkspaceDirectories(
	cwd: string,
	sessionDirectories: readonly string[],
	relatedDirectories: readonly string[],
): string[] {
	const cwdComparable = normalizePathForComparison(cwd);
	const seen = new Set<string>();
	const directories: string[] = [];
	for (const directory of [...sessionDirectories, ...relatedDirectories]) {
		const comparable = normalizePathForComparison(directory);
		if (comparable === cwdComparable || seen.has(comparable)) continue;
		seen.add(comparable);
		directories.push(directory);
	}
	return directories;
}

/**
 * Load shared context file bodies in the map's order. Missing files
 * (`ENOENT`) and unreadable files warn and are skipped; empty files are
 * skipped silently. Survivors have their `@`-imports expanded.
 */
export async function loadSharedContextFiles(
	paths: readonly string[],
): Promise<Array<{ path: string; content: string }>> {
	const files: Array<{ path: string; content: string }> = [];
	for (const contextFile of paths) {
		let content: string;
		try {
			// A configured FIFO/device would make Bun.file().text() wait for EOF indefinitely.
			if (!(await fs.stat(contextFile)).isFile()) {
				logger.warn("workspace.related: context file unreadable", { path: contextFile });
				continue;
			}
			content = await Bun.file(contextFile).text();
		} catch (error) {
			if (isEnoent(error)) {
				logger.warn("workspace.related: context file missing", { path: contextFile });
			} else {
				logger.warn("workspace.related: context file unreadable", { path: contextFile, error });
			}
			continue;
		}
		if (content.trim() === "") continue;
		files.push({ path: contextFile, content: await expandAtImports(content, contextFile) });
	}
	return files;
}

/**
 * Provider discovery reads files, but only lexically owned paths enter the
 * prompt; a symlinked AGENTS.md remains a path in its related root. Loading the
 * capability directly avoids a system-prompt import cycle.
 */
export async function listRelatedContextFiles(roots: readonly string[]): Promise<RelatedDirectory[]> {
	return await Promise.all(
		roots.map(async root => {
			const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: root }).catch(() => ({
				items: [],
			}));
			const contextFiles = result.items
				.filter(item => {
					if (item.level !== "project") return false;
					const relative = path.relative(root, item.path);
					return (
						relative !== "" &&
						relative !== ".." &&
						!relative.startsWith(`..${path.sep}`) &&
						!path.isAbsolute(relative)
					);
				})
				.map(item => normalizePromptPath(item.path));
			return { path: normalizePromptPath(root), contextFiles };
		}),
	);
}
