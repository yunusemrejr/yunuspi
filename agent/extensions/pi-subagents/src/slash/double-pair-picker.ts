import { DynamicBorder, type Theme } from "@yunuspi/coding-agent";
import { Container, fuzzyFilter, Input, matchesKey, type KeybindingsManager, Spacer, Text, type TUI } from "@yunuspi/tui";
import type { DoubleModelRef, DoublePair, DoubleReconciler } from "../../../lib/double.ts";
import { defaultDoubleThinking, type DoubleRegistryModel } from "../extension/double-pair.ts";
import { getSupportedThinkingLevels, toModelInfo } from "../shared/model-info.ts";

export interface DoublePairPickerResult {
	confirmed: boolean;
	pair?: DoublePair;
}

export interface DoublePairPickerOptions {
	models: readonly DoubleRegistryModel[];
	/** Prefill (the session's pair, or the one remembered from last time). */
	initial?: { a?: DoubleModelRef; b?: DoubleModelRef; reconcile?: DoubleReconciler };
	/** The model the session runs on: listed first and the default thinking source. */
	session?: { provider: string; id: string };
	sessionThinking?: string;
	done: (result: DoublePairPickerResult) => void;
}

const MAX_VISIBLE = 8;
const RECONCILE_ORDER: readonly DoubleReconciler[] = ["a", "b", "session"];

type Row = { kind: "start" } | { kind: "model"; model: DoubleRegistryModel };

const keyOf = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

/**
 * A small popup that searches the models the user can run (any provider for
 * either slot) and fills the two Double slots. Enter picks the highlighted
 * model for the active slot and moves on; once both slots are filled the first
 * row becomes "Start", so confirming is one more Enter and nothing needs a
 * chord. Built from the same primitives as the /model picker; colors come
 * from the theme the factory receives, because the module-level theme
 * singleton is undefined under the extension's module cache.
 */
export class DoublePairPicker extends Container {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly models: DoubleRegistryModel[];
	private readonly options: DoublePairPickerOptions;
	private readonly searchInput: Input;
	private readonly slotsText: Text;
	private readonly listContainer: Container;
	private readonly hintText: Text;
	private slots: [DoubleModelRef | undefined, DoubleModelRef | undefined];
	private reconcile: DoubleReconciler;
	private active: 0 | 1 = 0;
	private rows: Row[] = [];
	private selectedIndex = 0;
	private note = "";

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, options: DoublePairPickerOptions) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.options = options;
		const session = options.session ? keyOf(options.session) : "";
		// The session's own model first, then by provider and id: the same order the /model picker uses.
		this.models = [...options.models].sort((a, b) =>
			Number(keyOf(b) === session) - Number(keyOf(a) === session)
			|| a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
		this.slots = [options.initial?.a, options.initial?.b];
		this.reconcile = options.initial?.reconcile ?? "a";

		const border = () => new DynamicBorder((value) => theme.fg("border", value));
		this.addChild(border());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Custom Double")) + theme.fg("muted", " · two models, one decision"), 0, 0));
		this.addChild(new Spacer(1));
		this.slotsText = new Text("", 0, 0);
		this.addChild(this.slotsText);
		this.addChild(new Spacer(1));
		this.searchInput = new Input();
		this.searchInput.focused = true;
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.hintText = new Text("", 0, 0);
		this.addChild(this.hintText);
		this.addChild(new Spacer(1));
		this.addChild(border());
		// Edit the slot that still needs a model first; a full prefill starts on Start.
		this.active = this.slots[0] ? (this.slots[1] ? 0 : 1) : 0;
		this.applyFilter("");
	}

	private label(ref: DoubleModelRef | undefined): string {
		if (!ref) return this.theme.fg("muted", "choose a model below");
		const found = this.models.find((model) => model.provider === ref.provider && model.id === ref.id);
		const thinking = ref.thinking ? ` · thinking ${ref.thinking}` : "";
		return `${found?.id ?? ref.id} ${this.theme.fg("muted", `[${ref.provider}]${thinking}`)}`;
	}

	private pair(): DoublePair | undefined {
		const [a, b] = this.slots;
		return a && b ? { a, b, reconcile: this.reconcile } : undefined;
	}

	private applyFilter(query: string): void {
		const matches = query.trim()
			? fuzzyFilter(this.models, query, (model) => `${model.provider}/${model.id} ${model.id} ${model.provider} ${model.name ?? ""}`)
			: [...this.models];
		this.rows = [
			...(!query.trim() && this.pair() ? [{ kind: "start" } as Row] : []),
			...matches.map((model) => ({ kind: "model", model }) as Row),
		];
		this.selectedIndex = 0;
		this.refresh();
	}

	private refresh(): void {
		const th = this.theme;
		const slotLine = (index: 0 | 1) => {
			const marker = this.active === index ? th.fg("accent", "▸ ") : "  ";
			const name = index === 0 ? "A  builds the plan  " : "B  stress-tests it  ";
			return `${marker}${this.active === index ? th.fg("accent", name) : th.fg("muted", name)}${this.label(this.slots[index])}`;
		};
		const reconcileText = this.reconcile === "session" ? "the session model" : `model ${this.reconcile.toUpperCase()}`;
		this.slotsText.setText([
			slotLine(0),
			slotLine(1),
			`  ${th.fg("muted", "reconciles on")} ${reconcileText}`,
		].join("\n"));

		this.listContainer.clear();
		const total = this.rows.length;
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), total - MAX_VISIBLE));
		const end = Math.min(start + MAX_VISIBLE, total);
		const sessionKey = this.options.session ? keyOf(this.options.session) : "";
		for (let i = start; i < end; i++) {
			const row = this.rows[i]!;
			const selected = i === this.selectedIndex;
			const cursor = selected ? th.fg("accent", "→ ") : "  ";
			if (row.kind === "start") {
				const text = "▶ Start Double with these two models";
				this.listContainer.addChild(new Text(cursor + (selected ? th.fg("accent", text) : th.fg("success", text)), 0, 0));
				continue;
			}
			const model = row.model;
			const key = keyOf(model);
			const tags = [
				this.slots[0] && keyOf(this.slots[0]) === key ? "A" : "",
				this.slots[1] && keyOf(this.slots[1]) === key ? "B" : "",
				key === sessionKey ? "session" : "",
			].filter(Boolean).join(" ");
			const badge = th.fg("muted", `[${model.provider}]`);
			const marked = tags ? th.fg("success", ` ✓ ${tags}`) : "";
			this.listContainer.addChild(new Text(`${cursor}${selected ? th.fg("accent", model.id) : model.id} ${badge}${marked}`, 0, 0));
		}
		if (start > 0 || end < total) this.listContainer.addChild(new Text(th.fg("muted", `  (${this.selectedIndex + 1}/${total})`), 0, 0));
		if (total === 0) this.listContainer.addChild(new Text(th.fg("muted", "  No matching models you can run"), 0, 0));
		if (this.note) this.listContainer.addChild(new Text(th.fg("warning", `  ${this.note}`), 0, 0));

		const slotName = this.active === 0 ? "A" : "B";
		this.hintText.setText(th.fg("muted", `↑↓ move · enter ${this.rows[this.selectedIndex]?.kind === "start" ? "start" : `pick for ${slotName}`} · tab switch A/B · ctrl+t thinking · ctrl+r reconciler · esc cancel`));
	}

	private pickModel(model: DoubleRegistryModel): void {
		const previous = this.slots[this.active];
		// Re-picking the same model keeps the thinking level the user already chose for it.
		const thinking = previous && previous.provider === model.provider && previous.id === model.id
			? previous.thinking
			: defaultDoubleThinking(model, this.options.sessionThinking);
		this.slots[this.active] = { provider: model.provider, id: model.id, ...(thinking ? { thinking } : {}) };
		this.note = "";
		const other: 0 | 1 = this.active === 0 ? 1 : 0;
		if (!this.slots[other]) this.active = other;
		this.searchInput.setValue("");
		this.applyFilter("");
	}

	private cycleThinking(): void {
		const ref = this.slots[this.active];
		if (!ref) return;
		const model = this.models.find((candidate) => candidate.provider === ref.provider && candidate.id === ref.id);
		if (!model) return;
		const levels = getSupportedThinkingLevels(toModelInfo(model));
		if (levels.length < 2) {
			this.note = `${ref.id} runs without thinking levels.`;
			this.refresh();
			return;
		}
		const index = levels.findIndex((level) => level === ref.thinking);
		const next = levels[(index + 1) % levels.length]!;
		this.slots[this.active] = { ...ref, thinking: next };
		this.note = "";
		this.refresh();
	}

	private confirm(): void {
		const row = this.rows[this.selectedIndex];
		if (!row) return;
		if (row.kind === "model") {
			this.pickModel(row.model);
			return;
		}
		const pair = this.pair();
		if (pair) this.options.done({ confirmed: true, pair });
	}

	handleInput(keyData: string): void {
		const kb = this.keybindings;
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.rows.length) this.selectedIndex = this.selectedIndex === 0 ? this.rows.length - 1 : this.selectedIndex - 1;
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.down")) {
			if (this.rows.length) this.selectedIndex = this.selectedIndex === this.rows.length - 1 ? 0 : this.selectedIndex + 1;
			this.refresh();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			this.confirm();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.options.done({ confirmed: false });
		} else if (kb.matches(keyData, "tui.input.tab")) {
			this.active = this.active === 0 ? 1 : 0;
			this.refresh();
		} else if (matchesKey(keyData, "ctrl+t")) {
			this.cycleThinking();
		} else if (matchesKey(keyData, "ctrl+r")) {
			this.reconcile = RECONCILE_ORDER[(RECONCILE_ORDER.indexOf(this.reconcile) + 1) % RECONCILE_ORDER.length]!;
			this.refresh();
		} else {
			this.searchInput.handleInput(keyData);
			this.applyFilter(this.searchInput.getValue());
		}
		this.tui.requestRender();
	}
}
