/**
 * Session-home (H) accessor for harness discovery, kept in a leaf module:
 * value-importing it from the `./index` barrel inside tool factories creates an
 * init-order cycle (`BUILTIN_TOOLS` evaluates factory references eagerly).
 */
import type { ToolSession } from "./index";

export type { ToolSession } from "./index";

/**
 * The session's canonical home (H) for harness discovery — settings, agents,
 * skills, rules, context files, extension/plugin sources. `session.cwd` stays
 * the live execution directory (E); only discovery uses this. Manager-less
 * standalone tools retain H === cwd.
 */
export function getToolSessionHome(session: ToolSession): string {
	// `?.()` too: partial/stub managers (tests, extension replicas) may lack it.
	return session.sessionManager?.getSessionHome?.() ?? session.cwd;
}
