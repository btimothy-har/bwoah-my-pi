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
import {
	normalizeProviderMaxInFlightRequests,
	Settings,
	settings,
	validateProviderMaxInFlightRequests,
} from "./settings";
import {
	getDefault,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	isCredential,
	type SettingPath,
} from "./settings-schema";
import { normalizeRelatedWorkspaceMap, relatedWorkspaceKey } from "../session/related-workspace";
import { normalizeWorkspaceDirectory } from "../session/session-workspace";
import { resolveWorkspacePolicyState } from "../session/workspace-policy";

const CONDITIONS: Record<string, () => boolean> = {
	macOS: () => process.platform === "darwin",
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	advisorEnabled: () => {
		try {
			return Settings.instance.get("advisor.enabled") === true;
		} catch {
			return false;
		}
	},
	vimModeEnabled: () => {
		try {
			return Settings.instance.get("tui.vimMode") === true;
		} catch {
			return false;
		}
	},
	hindsightActive: () => {
		try {
			return Settings.instance.get("memory.backend") === "hindsight";
		} catch {
			return false;
		}
	},
	mnemopiActive: () => {
		try {
			return Settings.instance.get("memory.backend") === "mnemopi";
		} catch {
			return false;
		}
	},
	autolearnActive: () => {
		try {
			return Settings.instance.get("autolearn.enabled") === true;
		} catch {
			return false;
		}
	},
	autoThinkingActive: () => {
		try {
			return Settings.instance.get("defaultThinkingLevel") === "auto";
		} catch {
			return false;
		}
	},
	usageAwareFallbackEnabled: () => {
		try {
			return Settings.instance.get("retry.usageAwareFallback") === true;
		} catch {
			return false;
		}
	},
	planModeEnabled: () => {
		try {
			return Settings.instance.get("plan.enabled");
		} catch {
			return false;
		}
	},
	planAutosaveEnabled: () => {
		try {
			return Settings.instance.get("plan.enabled") && Settings.instance.get("plan.autosave");
		} catch {
			return false;
		}
	},
	unexpectedStopSmart: () => {
		try {
			return Settings.instance.get("features.unexpectedStopDetection") === "smart";
		} catch {
			return false;
		}
	},
};

/** Adapt the application schema and settings store to the terminal overlay. */
export function createSettingsHost(): SettingsHost {
	const entries: SettingsDisplayEntry[] = [];
	for (const tab of SETTING_TABS) {
		for (const path of getPathsForTab(tab)) {
			const ui = getUi(path);
			entries.push({
				path,
				type: getType(path),
				defaultValue: getDefault(path),
				ui,
				enumValues: getEnumValues(path),
				credential: isCredential(path),
				condition: ui?.condition ? CONDITIONS[ui.condition] : undefined,
			});
		}
	}
	return {
		entries,
		get: path => settings.get(path as SettingPath),
		set: (path, value) => settings.set(path as SettingPath, value as never),
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
				settings.set("workspace.related", next);
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
