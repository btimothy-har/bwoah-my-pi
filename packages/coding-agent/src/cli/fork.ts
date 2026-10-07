/**
 * Fork identity and app-update policy for Bwoah My Pi.
 *
 * Sole source of truth for the fork's human-facing identity and its refusal of
 * upstream app self-updates. Compatibility-sensitive consumers (protocol
 * metadata, native stamps, cache keys, changelog markers, USER_AGENT) keep the
 * plain `VERSION` from `@oh-my-pi/pi-utils/dirs`; only explicit human display
 * surfaces read `DISPLAY_VERSION`.
 */
import { VERSION } from "@oh-my-pi/pi-utils/dirs";

/** Human-facing fork name. Protocol metadata keeps plain `APP_NAME`. */
export const FORK_NAME = "Bwoah My Pi";

/** Version reported to humans: upstream version plus the fork suffix. */
export const DISPLAY_VERSION = `${VERSION}+bwoah`;

/** The fork does not support the upstream app self-updater; updates come from the source checkout. */
export const APP_UPDATES_SUPPORTED = false;

/** Refusal message shown when an app update is requested. */
export const APP_UPDATE_REFUSAL = `${FORK_NAME} does not support app self-update. Update your source checkout and run bun setup. Plugin updates remain available with omp update --plugins.`;
