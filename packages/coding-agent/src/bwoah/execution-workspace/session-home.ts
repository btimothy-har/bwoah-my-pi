import * as path from "node:path";
import { normalizePathForComparison, pathIsWithin } from "@oh-my-pi/pi-utils/dirs";
import type { SessionHeader } from "../../session/session-entries";
import type { SessionLoadResult } from "../../session/session-loader";
import type { CwdIdentity, TerminalBreadcrumb } from "../../session/session-paths";

export interface SessionHomeFallback {
	cwd: string;
	cwdIdentity: CwdIdentity;
	sessionId: string;
}

const SESSION_HOME_FALLBACK_PREFIX = "runtime-fallback";

export function resolveSessionHome(header: Pick<SessionHeader, "cwd"> | null | undefined, fallbackCwd: string): string {
	return typeof header?.cwd === "string" && header.cwd.length > 0 ? header.cwd : fallbackCwd;
}

function isCwdIdentity(value: unknown): value is CwdIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const identity = value as { dev?: unknown; ino?: unknown };
	return (
		typeof identity.dev === "string" &&
		/^\d+$/.test(identity.dev) &&
		typeof identity.ino === "string" &&
		/^\d+$/.test(identity.ino)
	);
}

function parseSessionHomeFallback(value: unknown, sessionHome: string): SessionHomeFallback | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const fallback = value as { cwd?: unknown; cwdIdentity?: unknown; sessionId?: unknown };
	if (
		typeof fallback.cwd !== "string" ||
		fallback.cwd.length === 0 ||
		!path.isAbsolute(fallback.cwd) ||
		!isCwdIdentity(fallback.cwdIdentity) ||
		typeof fallback.sessionId !== "string" ||
		fallback.sessionId.length === 0 ||
		normalizePathForComparison(fallback.cwd) === normalizePathForComparison(sessionHome)
	) {
		return undefined;
	}
	return {
		cwd: fallback.cwd,
		cwdIdentity: { dev: fallback.cwdIdentity.dev, ino: fallback.cwdIdentity.ino },
		sessionId: fallback.sessionId,
	};
}

export function createSessionHomeFallback(
	sessionHome: string,
	runtimeCwd: string,
	sessionId: string,
	identity: CwdIdentity | undefined,
): SessionHomeFallback | undefined {
	if (
		!identity ||
		!isCwdIdentity(identity) ||
		typeof runtimeCwd !== "string" ||
		runtimeCwd.length === 0 ||
		!path.isAbsolute(runtimeCwd) ||
		typeof sessionId !== "string" ||
		sessionId.length === 0 ||
		normalizePathForComparison(sessionHome) === normalizePathForComparison(runtimeCwd)
	) {
		return undefined;
	}
	return {
		cwd: runtimeCwd,
		cwdIdentity: { dev: identity.dev, ino: identity.ino },
		sessionId,
	};
}

function matchesSessionHomeFallback(
	hint: SessionHomeFallback | undefined,
	launchCwd: string,
	launchIdentity: CwdIdentity | undefined,
): boolean {
	return (
		hint !== undefined &&
		launchIdentity !== undefined &&
		normalizePathForComparison(hint.cwd) === normalizePathForComparison(launchCwd) &&
		hint.cwdIdentity.dev === launchIdentity.dev &&
		hint.cwdIdentity.ino === launchIdentity.ino
	);
}

function sessionHomeFallbackOwnsHeader(
	hint: SessionHomeFallback,
	breadcrumbHome: string,
	header: SessionHeader,
): boolean {
	if (header.id !== hint.sessionId) return false;
	const headerCwd: unknown = header.cwd;
	if (headerCwd === undefined || headerCwd === "") return true;
	return (
		typeof headerCwd === "string" &&
		normalizePathForComparison(headerCwd) === normalizePathForComparison(breadcrumbHome)
	);
}

export function parseSessionHomeFallbackExtras(
	lines: readonly string[],
	sessionHome: string,
): SessionHomeFallback | undefined {
	let found = false;
	let payload: string | undefined;
	for (const rawLine of lines.slice(2)) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (
			line !== SESSION_HOME_FALLBACK_PREFIX &&
			!line.startsWith(`${SESSION_HOME_FALLBACK_PREFIX} `) &&
			!line.startsWith(`${SESSION_HOME_FALLBACK_PREFIX}\t`)
		) {
			continue;
		}
		if (found) return undefined;
		found = true;
		if (line === SESSION_HOME_FALLBACK_PREFIX || line.startsWith(`${SESSION_HOME_FALLBACK_PREFIX}\t`)) {
			return undefined;
		}
		payload = line.slice(SESSION_HOME_FALLBACK_PREFIX.length + 1);
	}
	if (payload === undefined) return undefined;
	try {
		return parseSessionHomeFallback(JSON.parse(payload) as unknown, sessionHome);
	} catch {
		return undefined;
	}
}

export function formatSessionHomeFallback(hint: SessionHomeFallback | undefined): string | undefined {
	return hint === undefined ? undefined : `${SESSION_HOME_FALLBACK_PREFIX} ${JSON.stringify(hint)}`;
}

export interface SessionHomeLoadSource {
	sessionFile: string | undefined;
	sessionId: string | undefined;
	home: string;
	cwd: string;
	sessionDir: string;
	fallbackRuntimeOnly: boolean;
	additionalDirectories: string[];
}

export interface SessionHomeLoadTarget {
	sessionFile: string;
	header: SessionHeader;
	recordedCwdEnterable: boolean;
	sessionDir?: string;
	legacySessionHome?: string;
}

export interface SessionHomeLoadDecision {
	sessionHomeFallback: string;
	cwd: string;
	sessionDir: string;
	fallbackRuntimeOnly: boolean;
	additionalDirectories: string[];
}

export function resolveSessionHomeLoad(
	source: SessionHomeLoadSource,
	target: SessionHomeLoadTarget,
): SessionHomeLoadDecision {
	const sameIdentity =
		source.sessionFile !== undefined &&
		source.sessionId !== undefined &&
		source.sessionId === target.header.id &&
		normalizePathForComparison(source.sessionFile) === normalizePathForComparison(target.sessionFile);
	const headerCwd = target.header.cwd;
	const hasRecordedHome = typeof headerCwd === "string" && headerCwd.length > 0;
	const sessionHomeFallback = target.legacySessionHome ?? (sameIdentity ? source.home : path.resolve(source.cwd));
	let cwd = source.cwd;
	let fallbackRuntimeOnly: boolean;
	if (hasRecordedHome) {
		if (target.recordedCwdEnterable) {
			cwd = path.resolve(headerCwd);
			fallbackRuntimeOnly = false;
		} else {
			fallbackRuntimeOnly = true;
		}
	} else if (target.legacySessionHome !== undefined) {
		fallbackRuntimeOnly =
			normalizePathForComparison(target.legacySessionHome) !== normalizePathForComparison(source.cwd);
	} else if (sameIdentity) {
		fallbackRuntimeOnly = source.fallbackRuntimeOnly;
	} else {
		fallbackRuntimeOnly = false;
	}
	const additionalDirectories =
		sameIdentity && fallbackRuntimeOnly ? source.additionalDirectories : (target.header.additionalDirectories ?? []);
	return {
		sessionHomeFallback,
		cwd,
		sessionDir:
			target.sessionDir !== undefined
				? path.resolve(target.sessionDir)
				: sameIdentity
					? source.sessionDir
					: path.dirname(path.resolve(target.sessionFile)),
		fallbackRuntimeOnly,
		additionalDirectories,
	};
}

export function resolvePersistedSessionHomeDirectories(
	fallbackRuntimeOnly: boolean,
	liveDirectories: readonly string[],
	inheritedDirectories?: readonly string[],
): string[] | undefined {
	const directories = fallbackRuntimeOnly ? inheritedDirectories : liveDirectories;
	return directories && directories.length > 0 ? [...directories] : undefined;
}

export type SessionHomeContinuationDecision =
	| { kind: "fresh"; sessionHome: string; sessionDir: string; fallbackRuntimeOnly: boolean }
	| { kind: "resume"; sessionFile: string }
	| { kind: "verify-fallback"; sessionFile: string; hint: SessionHomeFallback }
	| { kind: "other-project" }
	| { kind: "scan" };

export function resolveSessionHomeContinuation(input: {
	breadcrumb: TerminalBreadcrumb;
	launchCwd: string;
	launchIdentity: CwdIdentity | undefined;
	discoverySessionDir: string;
	explicitSessionDir?: string;
}): SessionHomeContinuationDecision {
	const { breadcrumb, launchCwd, launchIdentity, explicitSessionDir } = input;
	const sameHome = normalizePathForComparison(breadcrumb.cwd) === normalizePathForComparison(launchCwd);
	const sameFallback = matchesSessionHomeFallback(breadcrumb.runtimeFallback, launchCwd, launchIdentity);
	const containmentTarget =
		breadcrumb.fresh && !breadcrumb.exists ? path.dirname(breadcrumb.sessionFile) : breadcrumb.sessionFile;
	const withinExplicitSessionDir =
		explicitSessionDir === undefined || pathIsWithin(explicitSessionDir, containmentTarget);
	const permittedHome = sameHome && withinExplicitSessionDir;
	const permittedFallback = sameFallback && withinExplicitSessionDir;

	if (breadcrumb.fresh && !breadcrumb.exists) {
		if (permittedHome) {
			return {
				kind: "fresh",
				sessionHome: path.resolve(launchCwd),
				sessionDir: path.resolve(input.discoverySessionDir),
				fallbackRuntimeOnly: false,
			};
		}
		if (permittedFallback) {
			return {
				kind: "fresh",
				sessionHome: breadcrumb.cwd,
				sessionDir: path.resolve(explicitSessionDir ?? path.dirname(breadcrumb.sessionFile)),
				fallbackRuntimeOnly: true,
			};
		}
	}

	if (withinExplicitSessionDir && sameHome) return { kind: "resume", sessionFile: breadcrumb.sessionFile };
	if (withinExplicitSessionDir && sameFallback && breadcrumb.runtimeFallback) {
		return { kind: "verify-fallback", sessionFile: breadcrumb.sessionFile, hint: breadcrumb.runtimeFallback };
	}
	return sameHome ? { kind: "scan" } : { kind: "other-project" };
}

export function acceptSessionHomeFallbackCandidate(
	hint: SessionHomeFallback,
	breadcrumbHome: string,
	loaded: SessionLoadResult,
): { accepted: false } | { accepted: true; legacySessionHome?: string } {
	if (loaded.invalidHeader || loaded.entries.length === 0) return { accepted: false };
	const leadingEntry = loaded.entries[0];
	if (leadingEntry?.type !== "session") return { accepted: false };
	const header = leadingEntry as SessionHeader;
	if (!sessionHomeFallbackOwnsHeader(hint, breadcrumbHome, header)) return { accepted: false };
	if (header.cwd === "" || header.cwd === undefined) {
		return { accepted: true, legacySessionHome: breadcrumbHome };
	}
	return { accepted: true };
}
