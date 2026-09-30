import * as fs from "node:fs/promises";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import {
	SETTING_TABS,
	type RelatedPathResolution,
	type SettingsDisplayEntry,
	type SettingsHost,
} from "@oh-my-pi/pi-tui/overlays/settings-defs";
import {
	directoryIsEnterable,
	isRecord,
	normalizePathForComparison,
	relativePathWithinNormalizedRoot,
	resolveEquivalentPath,
} from "@oh-my-pi/pi-utils";
import { isSettingsInitialized, Settings, settings } from "./settings";
import { orderedSettings } from "./all-settings";
import { type AnySetting, lookup } from "./registry";
import { cfgWorkspaceRelated } from "../session/context-settings";

import { cfgPlanAutosave, cfgPlanEnabled } from "../plan-mode/settings";
import {
	cfgRetryUsageAwareFallback,
	cfgDefaultThinkingLevel,
	normalizeProviderMaxInFlightRequests,
	validateProviderMaxInFlightRequests,
} from "../session/settings";
import { cfgAutolearnEnabled } from "../autolearn/settings";
import { cfgMemoryBackend } from "../memory-backend/settings";
import { cfgTuiVimMode } from "../modes/settings";
import { cfgAdvisorEnabled } from "../advisor/settings";
import { normalizeRelatedWorkspaceMap, relatedWorkspaceKey } from "../session/related-workspace";
import { normalizeWorkspaceDirectory } from "../session/session-workspace";
import { resolveWorkspacePolicyState } from "../session/workspace-policy";

/** Condition over the global settings; hidden (false) until they are initialized. */
function whenSettings(test: (settings: Settings) => boolean): () => boolean {
	return () => isSettingsInitialized() && test(Settings.instance);
}

const CONDITIONS: Record<string, () => boolean> = {
	macOS: () => process.platform === "darwin",
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	advisorEnabled: whenSettings(s => cfgAdvisorEnabled.get(s) === true),
	vimModeEnabled: whenSettings(s => cfgTuiVimMode.get(s) === true),
	hindsightActive: whenSettings(s => cfgMemoryBackend.get(s) === "hindsight"),
	mnemopiActive: whenSettings(s => cfgMemoryBackend.get(s) === "mnemopi"),
	autolearnActive: whenSettings(s => cfgAutolearnEnabled.get(s) === true),
	autoThinkingActive: whenSettings(s => cfgDefaultThinkingLevel.get(s) === "auto"),
	usageAwareFallbackEnabled: whenSettings(s => cfgRetryUsageAwareFallback.get(s) === true),
	planModeEnabled: whenSettings(s => cfgPlanEnabled.get(s)),
	planAutosaveEnabled: whenSettings(s => cfgPlanEnabled.get(s) && cfgPlanAutosave.get(s)),
};

/** Description suffix telling the panel user that an environment variable is in play. */
function envNote(setting: AnySetting): string {
	if (!setting.envName || setting.envValue() === undefined) return "";
	return setting.envFallback
		? ` Unset, it falls back to $${setting.envName}.`
		: ` $${setting.envName} overrides this setting while it is set.`;
}

/**
 * Adapt the application schema and settings store to the terminal overlay. The panel shows and
 * edits the value of the settings layers, never an environment-supplied one (so an env credential
 * is never pre-filled or written to config); descriptions note an active environment variable.
 */
export function createSettingsHost(): SettingsHost {
	const entries: SettingsDisplayEntry[] = [];
	for (const tab of SETTING_TABS) {
		for (const setting of orderedSettings()) {
			const ui = setting.ui;
			if (ui?.tab !== tab) continue;
			const note = envNote(setting);
			entries.push({
				path: setting.id,
				type: setting.type,
				defaultValue: setting.default,
				ui: note ? { ...ui, description: `${ui.description}${note}` } : ui,
				enumValues: setting.enumValues,
				credential: setting.isCredential,
				condition: ui.condition ? CONDITIONS[ui.condition] : undefined,
			});
		}
	}
	const resolve = (path: string): AnySetting => {
		const setting = lookup(path);
		if (!setting) throw new Error(`Unknown setting: ${path}`);
		return setting;
	};
	return {
		entries,
		get: path => lookup(path)?.layered(settings),
		set: (path, value) => resolve(path).set(settings, value),
		unset: path => resolve(path).unset(settings),
		normalizeProviderLimits: normalizeProviderMaxInFlightRequests,
		validateProviderLimits: validateProviderMaxInFlightRequests,
		relatedWorkspaces: {
			reload: () => settings.reloadFromDisk(),
			readGlobal: () => {
				const raw = settings.getGlobalSettings();
				return normalizeRelatedWorkspaceMap(isRecord(raw.workspace) ? raw.workspace.related : undefined);
			},
			write: map => {
				const raw = settings.getGlobalSettings();
				const rawRelated = isRecord(raw.workspace) && isRecord(raw.workspace.related) ? raw.workspace.related : {};
				const next = Object.fromEntries(
					Object.entries(map).map(([key, entry]) => [
						key,
						{
							...(isRecord(rawRelated[key]) ? rawRelated[key] : {}),
							directories: entry.directories,
							contextFiles: entry.contextFiles,
						},
					]),
				);
				cfgWorkspaceRelated.set(settings, next);
			},
			resolveCheckout: async (input, existingKeys): Promise<RelatedPathResolution> => {
				const abs = normalizeWorkspaceDirectory(input.trim());
				if (!(await directoryIsEnterable(abs))) return { ok: false, error: "Directory not found or not readable." };
				const key = relatedWorkspaceKey(await resolveWorkspacePolicyState(abs));
				if (key === null) return { ok: false, error: "Not inside a Git checkout." };
				const comparable = normalizePathForComparison(key);
				if (
					existingKeys.some(
						existing => normalizePathForComparison(normalizeWorkspaceDirectory(existing)) === comparable,
					)
				)
					return { ok: false, error: "This checkout is already configured." };
				return { ok: true, path: shortenPath(key) };
			},
			resolvePath: async (kind, checkoutKey, input, existing): Promise<RelatedPathResolution> => {
				const root = normalizeWorkspaceDirectory(checkoutKey);
				let abs = normalizeWorkspaceDirectory(input.trim(), root);
				if (kind === "directory") {
					if (!(await directoryIsEnterable(abs)))
						return { ok: false, error: "Directory not found or not readable." };
					abs = resolveEquivalentPath(abs);
					if (
						relativePathWithinNormalizedRoot(
							normalizePathForComparison(abs),
							normalizePathForComparison(root),
						) !== null
					)
						return { ok: false, error: "Contains the checkout itself; it would be ignored at runtime." };
				} else {
					try {
						if (!(await fs.stat(abs)).isFile()) return { ok: false, error: "Not a regular file." };
					} catch {
						return { ok: false, error: "File not found." };
					}
				}
				const comparable = normalizePathForComparison(abs);
				if (
					existing.some(stored => {
						const existingAbs = normalizeWorkspaceDirectory(stored, root);
						return (
							normalizePathForComparison(
								kind === "directory" ? resolveEquivalentPath(existingAbs) : existingAbs,
							) === comparable
						);
					})
				)
					return { ok: false, error: "Already listed." };
				return { ok: true, path: shortenPath(abs) };
			},
			pathAvailable: async (kind, checkoutKey, stored) => {
				const abs = normalizeWorkspaceDirectory(stored, normalizeWorkspaceDirectory(checkoutKey));
				if (kind === "directory") return directoryIsEnterable(abs);
				try {
					return (await fs.stat(abs)).isFile();
				} catch {
					return false;
				}
			},
		},
	};
}
