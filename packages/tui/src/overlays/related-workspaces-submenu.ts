/**
 * Structured editor for `workspace.related`: a list of canonical checkouts, and
 * per checkout two lists (read-only related directories, shared context files)
 * with add/edit/remove. Every accepted mutation is applied immediately through
 * the host (which owns persistence, path resolution, and Git classification);
 * Esc always goes back one view. List views re-read config.yml from disk when
 * shown so hand edits made while the editor is open surface.
 */
import { SelectFormField, TextFormField, type TextFormFieldOptions } from "../components/form";
import type { SelectItem } from "../components/select-list";
import { formTheme } from "../chrome/form-theme";
import { matchesKey } from "../keys";
import type { SgrMouseEvent } from "../mouse";
import { shortenPath } from "../render/render-utils";
import { getSelectListTheme } from "../theme/theme";
import { Container } from "../tui";
import type { RelatedWorkspaceEntryView, RelatedWorkspaceMapView, RelatedWorkspacesHost } from "./settings-defs";

const ADD_CHECKOUT = "__add";
const ADD_DIRECTORY = "__add_dir";
const ADD_CONTEXT_FILE = "__add_ctx";

type RelatedListKind = "directory" | "contextFile";
type RelatedListField = "directories" | "contextFiles";

type TextVariant =
	| { kind: "checkout" }
	| { kind: "add"; list: RelatedListKind }
	| { kind: "edit"; list: RelatedListKind; index: number; original: string };

const FIELD_BY_KIND: Record<RelatedListKind, RelatedListField> = {
	directory: "directories",
	contextFile: "contextFiles",
};

function parseRowValue(value: string): { list: RelatedListKind; stored: string } | undefined {
	if (value.startsWith("dir:")) return { list: "directory", stored: value.slice(4) };
	if (value.startsWith("ctx:")) return { list: "contextFile", stored: value.slice(4) };
	return undefined;
}

export class RelatedWorkspacesSubmenu extends Container {
	#view: "checkouts" | "entry" | "text" | "confirm" = "checkouts";
	#currentKey: string | undefined;
	/** Active list field; undefined while the text view is shown. */
	#field: SelectFormField | undefined;
	#textVariant: TextVariant | undefined;
	/** Set for the duration of a text-view submit; a second Enter while set is ignored. */
	#submitting = false;
	/** Generation counter so a stale availability pass never touches a newer entry view. */
	#entryBuild = 0;
	/** Generation counter for reload-driven list refreshes; stale results never touch the view. */
	#refreshId = 0;
	/** Row values whose stored path no longer resolves, annotated "Not found". */
	#unavailable = new Set<string>();

	readonly #host: RelatedWorkspacesHost;
	readonly #onChange: (map: RelatedWorkspaceMapView) => void;
	readonly #onCancel: () => void;
	readonly #requestRender: (() => void) | undefined;

	constructor(
		host: RelatedWorkspacesHost,
		onChange: (map: RelatedWorkspaceMapView) => void,
		onCancel: () => void,
		requestRender?: () => void,
	) {
		super();
		this.#host = host;
		this.#onChange = onChange;
		this.#onCancel = onCancel;
		this.#requestRender = requestRender;
		this.#showCheckouts();
	}

	#checkoutItems(): SelectItem[] {
		const map = this.#host.readGlobal();
		const items: SelectItem[] = Object.entries(map).map(([key, entry]) => ({
			value: key,
			label: shortenPath(key),
			description: `${entry.directories.length} directories · ${entry.contextFiles.length} context files`,
		}));
		items.push({
			value: ADD_CHECKOUT,
			label: "Add checkout…",
			description: "Path of a Git checkout or one of its worktrees",
		});
		return items;
	}

	#showCheckouts(): void {
		this.#view = "checkouts";
		this.#currentKey = undefined;
		this.clear();

		const items = this.#checkoutItems();

		const field = new SelectFormField({
			theme: formTheme,
			label: "Related Directories",
			description: "Read-only related roots and shared context per canonical checkout.",
			items,
			maxVisible: 12,
			selectTheme: getSelectListTheme(),
			hint: "  Enter to edit · Delete to remove · Esc to go back",
			onSubmit: value => {
				if (value === ADD_CHECKOUT) {
					this.#showText({ kind: "checkout" });
					return;
				}
				this.#currentKey = value;
				this.#showEntry();
			},
			onCancel: this.#onCancel,
			requestRender: this.#requestRender,
		});
		this.#field = field;
		this.addChild(field);
		this.#requestRender?.();
		this.#scheduleReloadRefresh();
	}

	/**
	 * Re-read persisted layers so hand edits to config.yml surface, then swap the
	 * current list view's rows in place (setItems retains the filter query and
	 * selection by value). A result that lands after the user navigated on is
	 * dropped by the generation/view guard, so a fast Enter is never stomped; a
	 * reload failure renders inline instead of disappearing.
	 */
	#scheduleReloadRefresh(): void {
		const id = ++this.#refreshId;
		const view = this.#view;
		if (view !== "checkouts" && view !== "entry") return;
		const key = this.#currentKey;
		void this.#host.reload().then(
			() => {
				if (id !== this.#refreshId || this.#view !== view || !this.#field) return;
				if (view === "checkouts") {
					this.#field.selectList.setItems(this.#checkoutItems());
				} else {
					if (key === undefined || this.#currentKey !== key) return;
					const entry = this.#host.readGlobal()[key];
					if (!entry) {
						// The checkout was removed by a hand edit; fall back to the list.
						this.#showCheckouts();
						return;
					}
					this.#field.selectList.setItems(this.#buildEntryItems(entry));
					this.#scheduleAvailability(key, entry);
				}
				this.#requestRender?.();
			},
			error => {
				if (id !== this.#refreshId || this.#view !== view) return;
				this.#field?.setError(
					`Failed to reload settings: ${error instanceof Error ? error.message : String(error)}`,
				);
				this.#requestRender?.();
			},
		);
	}

	#buildEntryItems(entry: RelatedWorkspaceEntryView): SelectItem[] {
		const items: SelectItem[] = [{ value: "__h_dirs", label: "Related directories", disabled: true }];
		for (const stored of entry.directories) {
			const value = `dir:${stored}`;
			items.push({
				value,
				label: shortenPath(stored),
				description: this.#unavailable.has(value) ? "Not found" : undefined,
			});
		}
		items.push({ value: ADD_DIRECTORY, label: "Add directory…" });
		items.push({ value: "__h_ctx", label: "Shared context files", disabled: true });
		for (const stored of entry.contextFiles) {
			const value = `ctx:${stored}`;
			items.push({
				value,
				label: shortenPath(stored),
				description: this.#unavailable.has(value) ? "Not found" : undefined,
			});
		}
		items.push({ value: ADD_CONTEXT_FILE, label: "Add context file…" });
		return items;
	}

	#showEntry(): void {
		const key = this.#currentKey;
		if (key === undefined) {
			this.#showCheckouts();
			return;
		}
		this.#view = "entry";
		this.clear();
		this.#unavailable = new Set();

		const entry = this.#host.readGlobal()[key] ?? { directories: [], contextFiles: [] };
		const items = this.#buildEntryItems(entry);
		const field = new SelectFormField({
			theme: formTheme,
			label: shortenPath(key),
			description: "Directories are read-only reference; context files follow the repository's instructions.",
			items,
			maxVisible: 12,
			selectTheme: getSelectListTheme(),
			hint: "  Enter to edit · Delete to remove · Esc to go back",
			onSubmit: value => this.#activateEntryRow(value),
			onCancel: () => this.#showCheckouts(),
			requestRender: this.#requestRender,
		});
		this.#field = field;
		this.addChild(field);
		this.#requestRender?.();
		this.#scheduleReloadRefresh();
		this.#scheduleAvailability(key, entry);
	}

	#activateEntryRow(value: string): void {
		if (value === ADD_DIRECTORY) {
			this.#showText({ kind: "add", list: "directory" });
			return;
		}
		if (value === ADD_CONTEXT_FILE) {
			this.#showText({ kind: "add", list: "contextFile" });
			return;
		}
		const key = this.#currentKey;
		const row = parseRowValue(value);
		if (key === undefined || row === undefined) return;
		const entry = this.#host.readGlobal()[key];
		const index = entry?.[FIELD_BY_KIND[row.list]].indexOf(row.stored) ?? -1;
		if (index === -1) {
			// Stale row (concurrent edit); rebuild from the persisted state.
			this.#showEntry();
			return;
		}
		this.#showText({ kind: "edit", list: row.list, index, original: row.stored });
	}

	#scheduleAvailability(key: string, entry: RelatedWorkspaceEntryView): void {
		const build = ++this.#entryBuild;
		const checks = [
			...entry.directories.map(stored => ({
				value: `dir:${stored}`,
				available: this.#host.pathAvailable("directory", key, stored),
			})),
			...entry.contextFiles.map(stored => ({
				value: `ctx:${stored}`,
				available: this.#host.pathAvailable("contextFile", key, stored),
			})),
		];
		if (checks.length === 0) return;
		void Promise.all(checks.map(check => check.available)).then(
			results => {
				if (build !== this.#entryBuild || this.#view !== "entry" || !this.#field) return;
				const unavailable = new Set(checks.filter((_, i) => !results[i]).map(check => check.value));
				if (
					unavailable.size === this.#unavailable.size &&
					[...unavailable].every(value => this.#unavailable.has(value))
				)
					return;
				this.#unavailable = unavailable;
				// Rebuild from a fresh read so rows removed since the build stay removed.
				const fresh = this.#host.readGlobal()[key];
				if (!fresh) return;
				this.#field.selectList.setItems(this.#buildEntryItems(fresh));
				this.#requestRender?.();
			},
			() => {},
		);
	}

	#showText(variant: TextVariant): void {
		const key = this.#currentKey;
		if (variant.kind !== "checkout" && key === undefined) {
			this.#showCheckouts();
			return;
		}

		let options: TextFormFieldOptions;
		if (variant.kind === "checkout") {
			options = {
				theme: formTheme,
				label: "Add checkout",
				description: "Git checkout or worktree path; stored as its main checkout.",
				empty: "cancel",
				hint: "  Enter to save · Esc to cancel",
				onSubmit: value => {
					if (this.#submitting) return;
					return this.#submitText(value);
				},
				onCancel: () => this.#cancelText(),
				requestRender: this.#requestRender,
			};
		} else {
			const list = variant.list;
			const noun = list === "directory" ? "directory" : "context file";
			const description =
				list === "directory"
					? "Absolute, ~, or checkout-relative path; listed as read-only reference."
					: "Markdown shown after the repository's instructions; those win on conflict.";
			const base: TextFormFieldOptions = {
				theme: formTheme,
				label: `${variant.kind === "add" ? "Add" : "Edit"} ${noun} · ${shortenPath(key!)}`,
				description,
				hint: "  Enter to save · Esc to cancel",
				onSubmit: value => {
					if (this.#submitting) return;
					return this.#submitText(value);
				},
				onCancel: () => this.#cancelText(),
				requestRender: this.#requestRender,
			};
			if (variant.kind === "edit") {
				if (this.#host.readGlobal()[key!]?.[FIELD_BY_KIND[list]][variant.index] !== variant.original) {
					this.#showEntry();
					return;
				}
				options = {
					...base,
					initialValue: variant.original,
					empty: "reject",
					emptyError: "Remove the row with Delete from the list.",
				};
			} else {
				options = { ...base, empty: "cancel" };
			}
		}

		this.#view = "text";
		this.#textVariant = variant;
		this.#field = undefined;
		this.clear();
		this.addChild(new TextFormField(options));
		this.#requestRender?.();
	}

	#cancelText(): void {
		if (this.#textVariant?.kind === "checkout") {
			this.#showCheckouts();
		} else {
			this.#showEntry();
		}
	}

	/**
	 * Mutation protocol for text submits: resolve the input first, then reload
	 * persisted layers, then synchronously read → mutate → write → notify with no
	 * await between readGlobal and write (avoids lost updates against a
	 * concurrent hand edit or a double submit).
	 */
	async #submitText(value: string): Promise<void> {
		this.#submitting = true;
		try {
			const variant = this.#textVariant;
			if (!variant) return;

			if (variant.kind === "checkout") {
				const resolution = await this.#host.resolveCheckout(value, Object.keys(this.#host.readGlobal()));
				if (!resolution.ok) throw new Error(resolution.error);
				await this.#host.reload();
				const fresh = await this.#host.resolveCheckout(value, Object.keys(this.#host.readGlobal()));
				if (!fresh.ok) throw new Error(fresh.error);
				const map = this.#host.readGlobal();
				map[fresh.path] = { directories: [], contextFiles: [] };
				this.#host.write(map);
				this.#onChange(map);
				this.#currentKey = fresh.path;
				this.#showEntry();
				return;
			}

			const key = this.#currentKey;
			if (key === undefined) {
				this.#showCheckouts();
				return;
			}
			const field = FIELD_BY_KIND[variant.list];
			const current = this.#host.readGlobal()[key]?.[field] ?? [];

			if (variant.kind === "edit") {
				if (current[variant.index] !== variant.original) {
					this.#showEntry();
					return;
				}
				if (value === variant.original) {
					this.#showEntry();
					return;
				}
			}

			const existing = variant.kind === "edit" ? current.filter((_, i) => i !== variant.index) : current;

			const resolution = await this.#host.resolvePath(variant.list, key, value, existing);
			if (!resolution.ok) throw new Error(resolution.error);
			await this.#host.reload();
			const refreshed = this.#host.readGlobal()[key];
			if (!refreshed) throw new Error("This checkout is no longer configured.");
			if (variant.kind === "edit" && refreshed[field][variant.index] !== variant.original) {
				this.#showEntry();
				return;
			}
			const validated = await this.#host.resolvePath(
				variant.list,
				key,
				value,
				variant.kind === "edit" ? refreshed[field].filter((_, i) => i !== variant.index) : refreshed[field],
			);
			if (!validated.ok) throw new Error(validated.error);
			const map = this.#host.readGlobal();
			const entry = map[key];
			if (!entry) throw new Error("This checkout is no longer configured.");
			if (variant.kind === "edit") {
				if (entry[field][variant.index] !== variant.original) {
					this.#showEntry();
					return;
				}
				entry[field][variant.index] = validated.path;
			} else {
				entry[field].push(validated.path);
			}
			this.#host.write(map);
			this.#onChange(map);
			this.#showEntry();
		} finally {
			this.#submitting = false;
		}
	}

	#showConfirm(): void {
		const key = this.#currentKey;
		if (key === undefined) {
			this.#showCheckouts();
			return;
		}
		this.#view = "confirm";
		this.clear();

		const items: SelectItem[] = [
			{ value: "keep", label: "Keep" },
			{ value: "remove", label: "Remove" },
		];
		const field = new SelectFormField({
			theme: formTheme,
			label: `Remove ${shortenPath(key)}?`,
			description: "Its related directories and context files are dropped from workspace.related.",
			items,
			currentValue: "keep",
			selectTheme: getSelectListTheme(),
			hint: "  Enter to choose · Esc to go back",
			onSubmit: value => {
				if (value !== "remove") {
					this.#showCheckouts();
					return;
				}
				return this.#removeCheckout(key);
			},
			onCancel: () => this.#showCheckouts(),
			requestRender: this.#requestRender,
		});
		this.#field = field;
		this.addChild(field);
		this.#requestRender?.();
	}

	async #removeCheckout(key: string): Promise<void> {
		await this.#host.reload();
		const map = this.#host.readGlobal();
		delete map[key];
		this.#host.write(map);
		this.#onChange(map);
		this.#showCheckouts();
	}

	async #removeEntryRow(key: string, list: RelatedListKind, stored: string, selectedValue: string): Promise<void> {
		const field = FIELD_BY_KIND[list];
		await this.#host.reload();
		const map = this.#host.readGlobal();
		const entry = map[key];
		if (!entry) {
			this.#showCheckouts();
			return;
		}
		const index = entry[field].indexOf(stored);
		if (index === -1) return;
		entry[field].splice(index, 1);
		this.#host.write(map);
		this.#onChange(map);
		this.#unavailable.delete(selectedValue);

		// A path is cheap to re-add: no confirmation, just rebuild the rows in place.
		if (this.#view !== "entry" || this.#currentKey !== key || !this.#field) return;
		const items = this.#buildEntryItems(entry);
		this.#field.selectList.setItems(items);
		if (items.some(item => item.value === selectedValue)) {
			this.#field.selectList.setSelectedValue(selectedValue);
		}
		this.#requestRender?.();
	}

	#handleRemovalKey(): void {
		const selected = this.#field?.selectList.getSelectedItem()?.value;
		if (selected === undefined) return;
		if (this.#view === "checkouts") {
			if (selected === ADD_CHECKOUT) return;
			this.#currentKey = selected;
			this.#showConfirm();
			return;
		}
		const key = this.#currentKey;
		const row = parseRowValue(selected);
		if (key === undefined || row === undefined) return;
		void this.#removeEntryRow(key, row.list, row.stored, selected).catch(error => {
			if (this.#view !== "entry" || this.#currentKey !== key) return;
			this.#field?.setError(error instanceof Error ? error.message : String(error));
			this.#requestRender?.();
		});
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.#field?.routeMouse(event, line, col);
	}

	handleInput(data: string): void {
		if (
			this.#field &&
			(this.#view === "checkouts" || this.#view === "entry") &&
			(matchesKey(data, "delete") ||
				(matchesKey(data, "backspace") && this.#field.selectList.getFilter().length === 0))
		) {
			this.#handleRemovalKey();
			return;
		}
		this.children[0]?.handleInput?.(data);
	}
}
