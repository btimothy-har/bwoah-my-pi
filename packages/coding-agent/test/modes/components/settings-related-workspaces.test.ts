/**
 * Structured `/settings` editor for `workspace.related`.
 *
 * Drives `SettingsSelectorComponent` through the real `createSettingsHost`:
 * keyboard add/edit/remove flows, canonical checkout keys for linked
 * worktrees, inline rejection of invalid paths, global-layer isolation, and
 * unknown-field preservation. Assertions observe only the persisted global
 * settings layer and the rendered UI — never component internals.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { RelatedWorkspacesSubmenu } from "@oh-my-pi/pi-tui/overlays/related-workspaces-submenu";
import type {
	RelatedPathResolution,
	RelatedWorkspaceMapView,
	RelatedWorkspacesHost,
} from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const ENTER = "\n";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const DELETE_KEY = "\x1b[3~";
const BACKSPACE = "\x7f";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(120);
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	const rows = 40;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function createSelector(onChange: (path: string, value: unknown) => void): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: createSettingsHost(),
			plugins: createPluginSettingsHost(process.cwd()),
		},
		{
			onChange,
			onCancel: () => {},
		},
	);
}

function recordChanges(): {
	changes: Array<{ path: string; value: unknown }>;
	onChange: (path: string, value: unknown) => void;
} {
	const changes: Array<{ path: string; value: unknown }> = [];
	return { changes, onChange: (path, value) => changes.push({ path, value }) };
}

function rendered(component: SettingsSelectorComponent): string {
	return Bun.stripANSI(component.render(120).join("\n"));
}

function typeText(component: SettingsSelectorComponent, text: string): void {
	for (const ch of text) component.handleInput(ch);
}

/**
 * Submissions resolve asynchronously through the real filesystem and native Git
 * with no promise or event exposed to the test, so poll the platform clock
 * (fake timers cannot drive real fs/VCS work).
 */
async function waitFor(condition: () => boolean, description: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (condition()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${description}`);
}

interface RelatedEntrySnapshot {
	directories?: string[];
	contextFiles?: string[];
	[field: string]: unknown;
}

/** Global-layer `workspace.related` only — the layer the editor reads and writes. */
function relatedMap(): Record<string, RelatedEntrySnapshot> {
	const raw = settings.getGlobalSettings() as unknown as {
		workspace?: { related?: Record<string, RelatedEntrySnapshot> };
	};
	return raw.workspace?.related ?? {};
}

/** Filter the settings list down to the Related Directories row and open its editor. */
async function openEditor(component: SettingsSelectorComponent): Promise<void> {
	typeText(component, "related directories");
	component.handleInput(ENTER);
	await waitFor(() => rendered(component).includes("Add checkout…"), "related-directories editor to open");
}

/** Only `git init` lacks a native facade API; config and the seed commit go through the VCS natives. */
async function gitCli(cwd: string, ...args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
	return stdout.trim();
}

async function initRepoAt(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await gitCli(dir, "init", "-q", "-b", "main");
	const repo = vcs.git(dir);
	if (!repo) throw new Error(`git repository not discovered at ${dir}`);
	await repo.configSet("user.email", "test@example.com");
	await repo.configSet("user.name", "test");
	await Bun.write(path.join(dir, "README.md"), "seed\n");
	await repo.stageFiles(["README.md"]);
	await repo.commitCreate("init", {});
}

interface Fixture {
	root: string;
	/** Canonical Git checkout. */
	repoA: string;
	/** Linked worktree of `repoA`; adding it must store `repoA`. */
	worktreeA: string;
	/** Plain directory containing an AGENTS.md, used as a related directory. */
	dirB: string;
	/** Plain directory that is not a Git checkout. */
	plainP: string;
	/** Markdown file outside the checkout, used as a shared context file. */
	sharedFile: string;
}

async function makeFixture(): Promise<Fixture> {
	// Canonicalize once: on macOS mkdtemp under /var resolves to /private/var,
	// and stored paths must match the resolver's realpath'd output. Temp roots
	// live outside $HOME, so `shortenPath` is a no-op and stored values equal
	// these absolute paths.
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-related-settings-")));
	const repoA = path.join(root, "repo-a");
	await initRepoAt(repoA);
	const repo = vcs.git(repoA);
	if (!repo) throw new Error(`git repository not discovered at ${repoA}`);
	await repo.createBranch("wt-branch", "HEAD", false);
	const worktreeA = path.join(root, "repo-a-wt");
	await repo.worktreeAdd(worktreeA, "wt-branch", { detach: false, clone: false });
	const dirB = path.join(root, "dir-b");
	await fs.mkdir(dirB, { recursive: true });
	await Bun.write(path.join(dirB, "AGENTS.md"), "# B\n");
	const plainP = path.join(root, "plain");
	await fs.mkdir(plainP, { recursive: true });
	const sharedFile = path.join(root, "shared.md");
	await Bun.write(sharedFile, "# shared\n");
	return { root, repoA, worktreeA, dirB, plainP, sharedFile };
}

describe("workspace.related structured editor", () => {
	let fixture: Fixture | undefined;

	afterEach(async () => {
		if (fixture) await fs.rm(fixture.root, { recursive: true, force: true });
		fixture = undefined;
	});

	it("adds a checkout by linked-worktree path, then a directory and a context file", async () => {
		const fx = (fixture = await makeFixture());
		const { changes, onChange } = recordChanges();
		const comp = createSelector(onChange);

		await openEditor(comp);
		expect(rendered(comp)).toContain("Add checkout…");

		// The map is empty, so "Add checkout…" is the only row.
		comp.handleInput(ENTER);
		typeText(comp, fx.worktreeA);
		comp.handleInput(ENTER);
		await waitFor(() => Object.keys(relatedMap()).length === 1, "checkout to persist");

		// Stored under the canonical primary checkout, not the worktree path.
		expect(relatedMap()).toEqual({ [fx.repoA]: { directories: [], contextFiles: [] } });
		await waitFor(() => rendered(comp).includes("Add directory…"), "entry view for the new checkout");

		// Both lists are empty: the first enabled row is "Add directory…".
		comp.handleInput(ENTER);
		typeText(comp, fx.dirB);
		comp.handleInput(ENTER);
		await waitFor(() => relatedMap()[fx.repoA]?.directories?.length === 1, "directory to persist");
		expect(relatedMap()[fx.repoA]).toEqual({ directories: [fx.dirB], contextFiles: [] });

		// Enabled rows are now: the stored directory, Add directory…, Add context file….
		await waitFor(() => rendered(comp).includes("Add context file…"), "entry view after directory add");
		comp.handleInput(DOWN);
		comp.handleInput(DOWN);
		comp.handleInput(ENTER);
		typeText(comp, fx.sharedFile);
		comp.handleInput(ENTER);
		await waitFor(() => relatedMap()[fx.repoA]?.contextFiles?.length === 1, "context file to persist");
		expect(relatedMap()).toEqual({ [fx.repoA]: { directories: [fx.dirB], contextFiles: [fx.sharedFile] } });

		expect(changes.map(change => change.path)).toEqual([
			"workspace.related",
			"workspace.related",
			"workspace.related",
		]);
		expect(changes.at(-1)?.value).toEqual({
			[fx.repoA]: { directories: [fx.dirB], contextFiles: [fx.sharedFile] },
		});
	});

	it("rejects invalid input inline and leaves the map unchanged", async () => {
		const fx = (fixture = await makeFixture());
		settings.set("workspace.related", { [fx.repoA]: { directories: [], contextFiles: [] } });
		const { changes, onChange } = recordChanges();
		const comp = createSelector(onChange);

		await openEditor(comp);

		// A plain directory is not a Git checkout.
		comp.handleInput(DOWN); // checkout row → Add checkout…
		comp.handleInput(ENTER);
		typeText(comp, fx.plainP);
		comp.handleInput(ENTER);
		await waitFor(() => rendered(comp).includes("Not inside a Git checkout."), "checkout rejection");
		expect(Object.keys(relatedMap())).toEqual([fx.repoA]);
		expect(changes).toEqual([]);
		comp.handleInput(ESC);

		// A nonexistent directory.
		await waitFor(() => rendered(comp).includes("Add checkout…"), "checkouts view");
		comp.handleInput(ENTER); // the seeded checkout row
		await waitFor(() => rendered(comp).includes("Add directory…"), "entry view");
		comp.handleInput(ENTER); // Add directory… is the first enabled row
		typeText(comp, path.join(fx.root, "nope"));
		comp.handleInput(ENTER);
		await waitFor(() => rendered(comp).includes("Directory not found"), "missing-directory rejection");
		expect(relatedMap()[fx.repoA]).toEqual({ directories: [], contextFiles: [] });
		comp.handleInput(ESC);

		// The checkout itself would be ignored at runtime.
		await waitFor(() => rendered(comp).includes("Add directory…"), "entry view");
		comp.handleInput(ENTER);
		typeText(comp, fx.repoA);
		comp.handleInput(ENTER);
		await waitFor(() => rendered(comp).includes("Contains the checkout"), "self-containing rejection");
		expect(relatedMap()[fx.repoA]).toEqual({ directories: [], contextFiles: [] });
		comp.handleInput(ESC);

		// A regular file is not a directory.
		await waitFor(() => rendered(comp).includes("Add directory…"), "entry view");
		comp.handleInput(ENTER);
		typeText(comp, path.join(fx.dirB, "AGENTS.md"));
		comp.handleInput(ENTER);
		await waitFor(() => rendered(comp).includes("Directory not found"), "file-as-directory rejection");
		expect(relatedMap()[fx.repoA]).toEqual({ directories: [], contextFiles: [] });
		comp.handleInput(ESC);

		// A duplicate directory is rejected after a legitimate add.
		await waitFor(() => rendered(comp).includes("Add directory…"), "entry view");
		comp.handleInput(ENTER);
		typeText(comp, fx.dirB);
		comp.handleInput(ENTER);
		await waitFor(() => relatedMap()[fx.repoA]?.directories?.length === 1, "directory to persist");
		expect(changes.length).toBe(1);

		await waitFor(() => rendered(comp).includes(fx.dirB), "stored directory row");
		comp.handleInput(DOWN); // stored row → Add directory…
		comp.handleInput(ENTER);
		typeText(comp, fx.dirB);
		comp.handleInput(ENTER);
		await waitFor(() => rendered(comp).includes("Already listed."), "duplicate rejection");
		expect(relatedMap()[fx.repoA]).toEqual({ directories: [fx.dirB], contextFiles: [] });
		expect(changes.length).toBe(1);
	});

	it("edits a stored directory in place and refuses to empty it", async () => {
		const fx = (fixture = await makeFixture());
		const nestedDir = path.join(fx.dirB, "nested");
		await fs.mkdir(nestedDir, { recursive: true });
		settings.set("workspace.related", { [fx.repoA]: { directories: [fx.dirB], contextFiles: [] } });
		const { changes, onChange } = recordChanges();
		const comp = createSelector(onChange);

		await openEditor(comp);
		comp.handleInput(ENTER); // the seeded checkout row
		await waitFor(() => rendered(comp).includes(fx.dirB), "entry view");

		// The stored directory is the first enabled row; Enter edits it with the
		// value seeded, so appending retargets the path.
		comp.handleInput(ENTER);
		typeText(comp, path.sep + "nested");
		comp.handleInput(ENTER);
		await waitFor(() => relatedMap()[fx.repoA]?.directories?.[0] === nestedDir, "edit to persist");
		expect(relatedMap()[fx.repoA]).toEqual({ directories: [nestedDir], contextFiles: [] });
		expect(changes.length).toBe(1);

		// Resubmitting an unchanged value closes without writing.
		await waitFor(() => rendered(comp).includes(nestedDir), "entry view after edit");
		comp.handleInput(ENTER);
		comp.handleInput(ENTER);
		await waitFor(() => rendered(comp).includes("Add directory…"), "entry view after unchanged submit");
		expect(relatedMap()[fx.repoA]?.directories).toEqual([nestedDir]);
		expect(changes.length).toBe(1);

		// Clearing the seeded value rejects instead of removing the row.
		comp.handleInput(ENTER);
		for (let i = 0; i < nestedDir.length; i++) comp.handleInput(BACKSPACE);
		comp.handleInput(ENTER);
		await waitFor(() => rendered(comp).includes("Remove the row with Delete"), "empty-edit rejection");
		expect(relatedMap()[fx.repoA]?.directories).toEqual([nestedDir]);
		expect(changes.length).toBe(1);
	});

	it("removes items with Delete/Backspace and a checkout after confirmation", async () => {
		const fx = (fixture = await makeFixture());
		settings.set("workspace.related", {
			[fx.repoA]: { directories: [fx.dirB], contextFiles: [fx.sharedFile] },
		});
		const { changes, onChange } = recordChanges();
		const comp = createSelector(onChange);

		await openEditor(comp);
		comp.handleInput(ENTER); // the seeded checkout row
		await waitFor(() => rendered(comp).includes(fx.dirB), "entry view");

		// The stored directory is the first enabled row; Delete removes it without confirmation.
		comp.handleInput(DELETE_KEY);
		await waitFor(() => relatedMap()[fx.repoA]?.directories?.length === 0, "directory removal");
		expect(relatedMap()[fx.repoA]).toEqual({ directories: [], contextFiles: [fx.sharedFile] });

		// Enabled rows are now Add directory…, the context file, Add context file….
		await waitFor(() => !rendered(comp).includes(fx.dirB), "entry view after directory removal");
		comp.handleInput(DOWN); // Add directory… → context-file row
		comp.handleInput(BACKSPACE); // filter is empty: Backspace removes the selected row
		await waitFor(() => relatedMap()[fx.repoA]?.contextFiles?.length === 0, "context file removal");
		expect(relatedMap()[fx.repoA]).toEqual({ directories: [], contextFiles: [] });

		// Removing a checkout asks first.
		comp.handleInput(ESC);
		await waitFor(() => rendered(comp).includes("Add checkout…"), "checkouts view");
		comp.handleInput(DELETE_KEY);
		await waitFor(() => rendered(comp).includes("Remove"), "removal confirmation");
		comp.handleInput(DOWN); // Keep → Remove
		comp.handleInput(ENTER);
		await waitFor(() => Object.keys(relatedMap()).length === 0, "checkout removal");
		expect(relatedMap()).toEqual({});

		// Esc closes the editor; the row summary reflects the emptied map.
		comp.handleInput(ESC);
		const summaryLine = rendered(comp)
			.split("\n")
			.find(line => line.includes("Related Directories"));
		expect(summaryLine).toBeDefined();
		expect(summaryLine).toContain("none");

		expect(changes.map(change => change.path)).toEqual([
			"workspace.related",
			"workspace.related",
			"workspace.related",
		]);
	});

	it("reads and writes only the global layer, ignoring runtime overrides", async () => {
		const fx = (fixture = await makeFixture());
		settings.override("workspace.related", { "/elsewhere/proj": { directories: ["/x"] } });
		const { changes, onChange } = recordChanges();
		const comp = createSelector(onChange);

		await openEditor(comp);
		// The override-layer checkout is never offered for editing.
		expect(rendered(comp)).not.toContain("/elsewhere/proj");

		// Only row is "Add checkout…".
		comp.handleInput(ENTER);
		typeText(comp, fx.repoA);
		comp.handleInput(ENTER);
		await waitFor(() => Object.keys(relatedMap()).length === 1, "checkout to persist");

		// The write did not copy the override-layer entry into the global file…
		expect(Object.keys(relatedMap())).toEqual([fx.repoA]);
		// …nor disturb the override itself.
		expect(settings.get("workspace.related")).toHaveProperty("/elsewhere/proj");
		expect(changes.length).toBe(1);
	});

	it("preserves unknown fields on retained entries", async () => {
		const fx = (fixture = await makeFixture());
		settings.set("workspace.related", { [fx.repoA]: { directories: [], note: "keep" } } as never);
		const { onChange } = recordChanges();
		const comp = createSelector(onChange);

		await openEditor(comp);
		comp.handleInput(ENTER); // the seeded checkout row
		await waitFor(() => rendered(comp).includes("Add directory…"), "entry view");
		comp.handleInput(ENTER); // Add directory…
		typeText(comp, fx.dirB);
		comp.handleInput(ENTER);
		await waitFor(() => relatedMap()[fx.repoA]?.directories?.length === 1, "directory to persist");

		expect(relatedMap()[fx.repoA]?.note).toBe("keep");
		expect(relatedMap()[fx.repoA]?.directories).toEqual([fx.dirB]);
	});
});

function simulatedHost(initial: RelatedWorkspaceMapView) {
	const state = {
		map: structuredClone(initial),
		writes: 0,
		onReload: async () => {},
	};
	const host: RelatedWorkspacesHost = {
		reload: () => state.onReload(),
		readGlobal: () => structuredClone(state.map),
		write: map => {
			state.map = structuredClone(map);
			state.writes++;
		},
		resolveCheckout: async input =>
			input === "/repo" && "/repo" in state.map
				? { ok: false, error: "This checkout is already configured." }
				: { ok: true, path: input === "/repo" ? "~/repo" : input },
		resolvePath: async (_kind, _key, input, existing) =>
			existing.includes(input) ? { ok: false, error: "Already listed." } : { ok: true, path: input },
		pathAvailable: async () => true,
	};
	return { host, state };
}

/**
 * Drain a released submit continuation. Once the deferred host call resolves,
 * the rest of the chain is a bounded number of already-resolved promises
 * (reload → re-resolve → write), so yielding the microtask queue a fixed
 * number of times settles it deterministically — no wall-clock guessing.
 */
async function settleAsyncWork(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/**
 * Wrap one host method so its first call stays pending until the returned
 * `release` is invoked; later calls pass through. Holds a text submit in
 * flight while the test navigates away with Esc.
 */
function holdFirstCall<A extends unknown[]>(
	method: (...args: A) => Promise<RelatedPathResolution>,
): { wrapped: (...args: A) => Promise<RelatedPathResolution>; release: (r: RelatedPathResolution) => void } {
	let holding = true;
	const pending = Promise.withResolvers<RelatedPathResolution>();
	return {
		wrapped: (...args: A) => {
			if (!holding) return method(...args);
			holding = false;
			return pending.promise;
		},
		release: pending.resolve,
	};
}

describe("related-workspace editor races", () => {
	it("does not delete a hidden row when a search has no selected result", async () => {
		const repo = "/repo";
		const directories = Array.from({ length: 15 }, (_, i) => `/related-${i}`);
		const { host, state } = simulatedHost({ [repo]: { directories, contextFiles: [] } });
		const menu = new RelatedWorkspacesSubmenu(
			host,
			() => {},
			() => {},
		);
		menu.handleInput(ENTER);
		await Promise.resolve();
		for (const ch of "unmatched-query") menu.handleInput(ch);
		menu.handleInput(DELETE_KEY);
		await Promise.resolve();
		expect(state.map[repo]?.directories).toEqual(directories);
		expect(state.writes).toBe(0);
	});

	it("surfaces a failed reload during Delete without an unhandled rejection", async () => {
		const repo = "/repo";
		const { host, state } = simulatedHost({ [repo]: { directories: ["/related"], contextFiles: [] } });
		const menu = new RelatedWorkspacesSubmenu(
			host,
			() => {},
			() => {},
		);
		menu.handleInput(ENTER);
		await Promise.resolve();
		state.onReload = async () => {
			throw new Error("Invalid configuration");
		};
		menu.handleInput(DELETE_KEY);
		await waitFor(
			() => Bun.stripANSI(menu.render(120).join("\n")).includes("Invalid configuration"),
			"reload error to appear",
		);
		expect(state.map[repo]?.directories).toEqual(["/related"]);
		expect(state.writes).toBe(0);
	});

	it("never overwrites another row after a disk edit reorders the entry", async () => {
		const repo = "/repo";
		const { host, state } = simulatedHost({
			[repo]: { directories: ["/first", "/second"], contextFiles: [] },
		});
		const menu = new RelatedWorkspacesSubmenu(
			host,
			() => {},
			() => {},
		);
		menu.handleInput(ENTER);
		menu.handleInput(ENTER);
		state.map[repo]!.directories = ["/second", "/first"];
		for (const ch of "/replacement") menu.handleInput(ch);
		menu.handleInput(ENTER);
		await Promise.resolve();
		expect(state.map[repo]?.directories).toEqual(["/second", "/first"]);
		expect(state.writes).toBe(0);
	});

	it("rejects a checkout added to YAML while its add field is open", async () => {
		const { host, state } = simulatedHost({});
		const menu = new RelatedWorkspacesSubmenu(
			host,
			() => {},
			() => {},
		);
		menu.handleInput(ENTER);
		state.onReload = async () => {
			state.map["/repo"] = { directories: [], contextFiles: [] };
		};
		for (const ch of "/repo") menu.handleInput(ch);
		menu.handleInput(ENTER);
		await waitFor(
			() => Bun.stripANSI(menu.render(120).join("\n")).includes("already configured"),
			"canonical duplicate error",
		);
		expect(Object.keys(state.map)).toEqual(["/repo"]);
		expect(state.writes).toBe(0);
	});

	it("drops a checkout submit canceled with Esc while resolution is in flight", async () => {
		const { host, state } = simulatedHost({});
		const held = holdFirstCall(host.resolveCheckout);
		host.resolveCheckout = held.wrapped;
		const changes: RelatedWorkspaceMapView[] = [];
		const menu = new RelatedWorkspacesSubmenu(
			host,
			map => changes.push(map),
			() => {},
		);
		menu.handleInput(ENTER); // sole row is "Add checkout…"
		for (const ch of "/slow-repo") menu.handleInput(ch);
		menu.handleInput(ENTER);
		menu.handleInput(ESC);
		expect(Bun.stripANSI(menu.render(120).join("\n"))).toContain("Add checkout…");
		menu.handleInput(ENTER);
		for (const ch of "/new-repo") menu.handleInput(ch);

		held.release({ ok: true, path: "/slow-repo" });
		await settleAsyncWork();

		expect(state.writes).toBe(0);
		expect(changes).toHaveLength(0);
		expect(Object.keys(state.map)).toEqual([]);
		const view = Bun.stripANSI(menu.render(120).join("\n"));
		expect(view).toContain("Add checkout");
		expect(view).toContain("/new-repo");
		expect(view).not.toContain("Add directory…");
	});

	it("drops an add-directory submit canceled with Esc while resolution is in flight", async () => {
		const repo = "/repo";
		const { host, state } = simulatedHost({ [repo]: { directories: [], contextFiles: [] } });
		const held = holdFirstCall(host.resolvePath);
		host.resolvePath = held.wrapped;
		const changes: RelatedWorkspaceMapView[] = [];
		const menu = new RelatedWorkspacesSubmenu(
			host,
			map => changes.push(map),
			() => {},
		);
		menu.handleInput(ENTER); // open the seeded checkout
		await Promise.resolve();
		menu.handleInput(ENTER); // first enabled row is "Add directory…"
		for (const ch of "/new-dir") menu.handleInput(ch);
		menu.handleInput(ENTER);
		menu.handleInput(ESC);
		const entryView = Bun.stripANSI(menu.render(120).join("\n"));
		expect(entryView).toContain("Add directory…");
		expect(entryView).not.toContain("Add directory ·");

		held.release({ ok: true, path: "/new-dir" });
		await settleAsyncWork();

		expect(state.writes).toBe(0);
		expect(changes).toHaveLength(0);
		expect(state.map[repo]?.directories).toEqual([]);
		expect(Bun.stripANSI(menu.render(120).join("\n"))).not.toContain("/new-dir");
	});

	it("clears the search when a deletion drops the entry list to the visible threshold", async () => {
		const repo = "/repo";
		const directories = Array.from({ length: 9 }, (_, i) => `/related-${i}`);
		const { host, state } = simulatedHost({ [repo]: { directories, contextFiles: [] } });
		const changes: RelatedWorkspaceMapView[] = [];
		const menu = new RelatedWorkspacesSubmenu(
			host,
			map => changes.push(map),
			() => {},
		);
		menu.handleInput(ENTER);
		await Promise.resolve();

		// 13 rows (2 headings + 9 directories + 2 add rows) overflow maxVisible 12,
		// so type-to-search is active; the query matches only the last directory.
		for (const ch of "related-8") menu.handleInput(ch);
		menu.handleInput(DELETE_KEY);
		await waitFor(() => state.writes === 1, "directory removal to persist");
		expect(state.map[repo]?.directories).toEqual(directories.slice(0, 8));

		// Back at 12 rows the stale query must not strand the user on an empty
		// result set: the remaining rows are visible and navigable again.
		const list = Bun.stripANSI(menu.render(120).join("\n"));
		expect(list).not.toContain("Search:");
		expect(list).toContain("/related-0");
		expect(list).toContain("Add directory…");
		for (let i = 0; i < 8; i++) menu.handleInput(DOWN);
		menu.handleInput(ENTER);
		expect(Bun.stripANSI(menu.render(120).join("\n"))).toContain("Add directory · /repo");
		expect(state.map[repo]?.directories).toEqual(directories.slice(0, 8));
		expect(changes).toHaveLength(1);
	});
});
