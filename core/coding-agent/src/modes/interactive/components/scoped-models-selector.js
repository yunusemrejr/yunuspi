import { Container, fuzzyFilter, getKeybindings, Input, Key, matchesKey, Spacer, Text, } from "@yunuspi/tui";
import { builtinMediaModels, normalizeMediaModels } from "../../../core/media-models.js";
import { getModelSearchText } from "../model-search.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyDisplayText } from "./keybinding-hints.js";
function isEnabled(enabledIds, id) {
    return enabledIds === null || enabledIds.includes(id);
}
/** Collapse an explicit list back to null (= all enabled) when it covers every available model. */
function normalizeEnabled(result, allIds) {
    return result.length === allIds.length && result.every((id) => allIds.includes(id)) ? null : result;
}
function toggle(enabledIds, allIds, id) {
    if (enabledIds === null)
        return allIds.filter((modelId) => modelId !== id);
    const index = enabledIds.indexOf(id);
    if (index >= 0)
        return [...enabledIds.slice(0, index), ...enabledIds.slice(index + 1)];
    return normalizeEnabled([...enabledIds, id], allIds);
}
function enableAll(enabledIds, allIds, targetIds) {
    if (enabledIds === null)
        return null; // Already all enabled
    const targets = targetIds ?? allIds;
    const result = [...enabledIds];
    for (const id of targets) {
        if (!result.includes(id))
            result.push(id);
    }
    return normalizeEnabled(result, allIds);
}
function clearAll(enabledIds, allIds, targetIds) {
    if (enabledIds === null) {
        return targetIds ? allIds.filter((id) => !targetIds.includes(id)) : [];
    }
    const targets = new Set(targetIds ?? enabledIds);
    return enabledIds.filter((id) => !targets.has(id));
}
function move(enabledIds, id, delta) {
    if (enabledIds === null)
        return null;
    const list = [...enabledIds];
    const index = list.indexOf(id);
    if (index < 0)
        return list;
    const newIndex = index + delta;
    if (newIndex < 0 || newIndex >= list.length)
        return list;
    const result = [...list];
    [result[index], result[newIndex]] = [result[newIndex], result[index]];
    return result;
}
function getSortedIds(enabledIds, allIds) {
    if (enabledIds === null)
        return allIds;
    const enabledSet = new Set(enabledIds);
    return [...enabledIds, ...allIds.filter((id) => !enabledSet.has(id))];
}
/**
 * Component for enabling/disabling models for Ctrl+P cycling.
 * Changes are session-only until explicitly persisted with Ctrl+S.
 */
export class ScopedModelsSelectorComponent extends Container {
    modelsById = new Map();
    allIds = [];
    enabledIds = null;
    filteredItems = [];
    selectedIndex = 0;
    searchInput;
    // Focusable implementation - propagate to searchInput for IME cursor positioning
    _focused = false;
    get focused() {
        return this._focused;
    }
    set focused(value) {
        this._focused = value;
        this.searchInput.focused = value;
    }
    listContainer;
    footerText;
    callbacks;
    maxVisible = 8;
    isDirty = false;
    refreshStatusText;
    activeTab = 0;
    tabs = ["LLM", "Images", "Video", "Audio"];
    tabText;
    mediaModels = builtinMediaModels();
    mediaSelections = {};
    filteredMedia = [];
    mediaIndex = 0;
    mediaDirty = false;
    mediaStatus;
    constructor(config, callbacks) {
        super();
        this.callbacks = callbacks;
        this.mediaSelections = normalizeMediaModels(config.mediaSelections);
        this.mediaModels = config.mediaModels ?? builtinMediaModels();
        for (const model of config.allModels) {
            const fullId = `${model.provider}/${model.id}`;
            this.modelsById.set(fullId, model);
            this.allIds.push(fullId);
        }
        this.enabledIds = config.enabledModelIds === null ? null : [...config.enabledModelIds];
        this.filteredItems = this.buildItems();
        // Header
        this.addChild(new DynamicBorder());
        this.addChild(new Spacer(1));
        this.addChild(new Text(theme.fg("accent", theme.bold("Model Configuration")), 0, 0));
        this.addChild(new Text(theme.fg("muted", `Session-only. ${keyDisplayText("app.models.save")} to save to settings.`), 0, 0));
        this.tabText = new Text(this.getTabText(), 0, 0);
        this.addChild(this.tabText);
        this.addChild(new Spacer(1));
        // Search input
        this.searchInput = new Input();
        this.addChild(this.searchInput);
        this.addChild(new Spacer(1));
        // List container
        this.listContainer = new Container();
        this.addChild(this.listContainer);
        // Footer hint
        this.addChild(new Spacer(1));
        if (config.refreshStatus) {
            this.refreshStatusText = new Text(theme.fg("muted", `  ${config.refreshStatus}`), 0, 0);
            this.addChild(this.refreshStatusText);
        }
        this.footerText = new Text(this.getFooterText(), 0, 0);
        this.addChild(this.footerText);
        this.addChild(new DynamicBorder());
        this.updateList();
    }
    getTabText() {
        return this.tabs.map((name, i) => i === this.activeTab ? theme.fg("accent", theme.bold(`[${name}]`)) : theme.fg("muted", name)).join("  ") + theme.fg("dim", "  Tab / Shift+Tab");
    }
    setMediaRefreshStatus(message) {
        this.mediaStatus = message;
        if (this.activeTab > 0) this.updateList();
    }
    updateMediaModels(models) {
        this.mediaModels = models;
        this.refresh();
    }
    mediaItems() {
        const kinds = this.activeTab === 1 ? ["image"] : this.activeTab === 2 ? ["video"] : ["speech", "music", "sfx"];
        const rows = this.mediaModels.filter(row => kinds.includes(row.kind));
        for (const kind of kinds) {
            const id = this.mediaSelections[kind];
            if (id && !rows.some(row => row.kind === kind && row.id === id)) rows.push({ kind, id, name: id, description: "Selected route is outside this catalog; generation still requires backend configuration and supported capabilities.", source: "configured" });
        }
        const query = this.searchInput.getValue();
        return query ? fuzzyFilter(rows, query, row => `${row.kind} ${row.id} ${row.name} ${row.description}`) : rows;
    }
    updateModels(models, enabledModelIds) {
        const selectedId = this.filteredItems[this.selectedIndex]?.fullId;
        if (enabledModelIds !== undefined)
            this.enabledIds = enabledModelIds === null ? null : [...enabledModelIds];
        this.modelsById.clear();
        this.allIds = [];
        for (const model of models) {
            const fullId = `${model.provider}/${model.id}`;
            this.modelsById.set(fullId, model);
            this.allIds.push(fullId);
        }
        this.refresh();
        const refreshedIndex = selectedId ? this.filteredItems.findIndex((item) => item.fullId === selectedId) : -1;
        if (refreshedIndex >= 0) {
            this.selectedIndex = refreshedIndex;
            this.updateList();
        }
    }
    setRefreshStatus(message, kind) {
        this.refreshStatusText?.setText(theme.fg(kind, `  ${message}`));
    }
    buildItems() {
        return getSortedIds(this.enabledIds, this.allIds).map((id) => ({
            fullId: id,
            model: this.modelsById.get(id),
            enabled: isEnabled(this.enabledIds, id),
        }));
    }
    getFooterText() {
        if (this.activeTab > 0) return theme.fg("dim", `  ${keyDisplayText("tui.select.confirm")} select · ${keyDisplayText("app.models.save")} save · Esc close · media tools`) + (this.mediaDirty ? theme.fg("warning", " (unsaved)") : "");
        const enabledCount = this.enabledIds?.filter((id) => this.modelsById.has(id)).length ?? this.allIds.length;
        const unavailableCount = this.enabledIds?.filter((id) => !this.modelsById.has(id)).length ?? 0;
        const allEnabled = this.enabledIds === null;
        const countText = allEnabled
            ? "all enabled"
            : `${enabledCount}/${this.allIds.length} enabled${unavailableCount ? ` · ${unavailableCount} unavailable` : ""}`;
        const parts = [
            `${keyDisplayText("tui.select.confirm")} toggle`,
            `${keyDisplayText("app.models.enableAll")} all`,
            `${keyDisplayText("app.models.clearAll")} clear`,
            `${keyDisplayText("app.models.toggleProvider")} provider`,
            `${keyDisplayText("app.models.reorderUp")}/${keyDisplayText("app.models.reorderDown")} reorder`,
            `${keyDisplayText("app.models.save")} save`,
            countText,
        ];
        return this.isDirty
            ? theme.fg("dim", `  ${parts.join(" · ")} `) + theme.fg("warning", "(unsaved)")
            : theme.fg("dim", `  ${parts.join(" · ")}`);
    }
    refresh() {
        if (this.activeTab > 0) {
            this.filteredMedia = this.mediaItems();
            this.mediaIndex = Math.min(this.mediaIndex, Math.max(0, this.filteredMedia.length - 1));
            this.updateList();
            this.footerText.setText(this.getFooterText());
            return;
        }
        const query = this.searchInput.getValue();
        const items = this.buildItems();
        this.filteredItems = query
            ? fuzzyFilter(items, query, (item) => item.model
                ? getModelSearchText({ id: item.model.id, provider: item.model.provider, name: item.model.name })
                : item.fullId)
            : items;
        this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
        this.updateList();
        this.footerText.setText(this.getFooterText());
    }
    notifyChange() {
        this.callbacks.onChange(this.enabledIds === null ? null : [...this.enabledIds]);
    }
    updateList() {
        this.listContainer.clear();
        if (this.activeTab > 0) {
            this.filteredMedia = this.mediaItems();
            const start = Math.max(0, Math.min(this.mediaIndex - 4, this.filteredMedia.length - this.maxVisible));
            for (let i = start; i < Math.min(start + this.maxVisible, this.filteredMedia.length); i++) {
                const row = this.filteredMedia[i];
                const prefix = i === this.mediaIndex ? theme.fg("accent", "→ ") : "  ";
                const chosen = this.mediaSelections[row.kind] === row.id ? theme.fg("accent", "✓ ") : "  ";
                const name = i === this.mediaIndex ? theme.fg("accent", row.name) : row.name;
                this.listContainer.addChild(new Text(`${prefix}${chosen}${name}` + theme.fg("muted", ` [${row.kind}] ${row.id}`), 0, 0));
            }
            const row = this.filteredMedia[this.mediaIndex];
            this.listContainer.addChild(new Spacer(1));
            if (row) {
                this.listContainer.addChild(new Text(theme.fg("muted", `  ${row.description.slice(0, 300)}`), 0, 0));
                const caps = row.capabilities;
                if (caps) {
                    const parameters = caps.supported_parameters ?? {};
                    const details = row.kind === 'image'
                        ? [parameters.input_references?.max ? `up to ${parameters.input_references.max} references` : 'text prompt', parameters.background?.values?.includes('transparent') ? 'transparent output' : '', parameters.resolution?.values?.join('/'), parameters.aspect_ratio?.values?.slice(0, 8).join(' ')]
                        : [caps.supported_durations?.length ? `${Math.min(...caps.supported_durations)}–${Math.max(...caps.supported_durations)} seconds` : '', caps.supported_resolutions?.join('/'), caps.supported_aspect_ratios?.join(' '), caps.supported_frame_images?.includes('last_frame') ? 'first + last frames' : caps.supported_frame_images?.includes('first_frame') ? 'first frame' : 'text prompt'];
                    this.listContainer.addChild(new Text(theme.fg("dim", `  ${details.filter(Boolean).join(' · ')} · price checked in generation plan`), 0, 0));
                }
                this.listContainer.addChild(new Text(theme.fg("dim", `  ${this.mediaIndex + 1}/${this.filteredMedia.length} · ${row.source} · ${row.id.startsWith("local/") ? "local dependencies required" : "provider credentials required"}`), 0, 0));
            } else this.listContainer.addChild(new Text(theme.fg("muted", "  No matching media models; catalogs refresh when this page opens."), 0, 0));
            if (this.mediaStatus) this.listContainer.addChild(new Text(theme.fg("muted", `  ${this.mediaStatus}`), 0, 0));
            return;
        }
        if (this.filteredItems.length === 0) {
            this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
            return;
        }
        const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible));
        const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);
        for (let i = startIndex; i < endIndex; i++) {
            const item = this.filteredItems[i];
            const isSelected = i === this.selectedIndex;
            const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
            const id = item.model?.id ?? item.fullId;
            const styledId = item.model ? id : theme.strikethrough(id);
            const modelText = isSelected ? theme.fg("accent", styledId) : styledId;
            const providerBadge = theme.fg("muted", item.model ? ` [${item.model.provider}]` : " [unavailable]");
            const status = item.model && item.enabled ? theme.fg("accent", "✓ ") : "  ";
            this.listContainer.addChild(new Text(`${prefix}${status}${modelText}${providerBadge}`, 0, 0));
        }
        // Add scroll indicator if needed
        if (startIndex > 0 || endIndex < this.filteredItems.length) {
            this.listContainer.addChild(new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0));
        }
        if (this.filteredItems.length > 0) {
            const selected = this.filteredItems[this.selectedIndex];
            this.listContainer.addChild(new Spacer(1));
            this.listContainer.addChild(new Text(theme.fg("muted", `  ${selected.model ? `Model Name: ${selected.model.name}` : "Model unavailable"}`), 0, 0));
        }
    }
    handleInput(data) {
        const kb = getKeybindings();
        if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
            const delta = matchesKey(data, Key.shift("tab")) ? -1 : 1;
            this.activeTab = (this.activeTab + delta + this.tabs.length) % this.tabs.length;
            this.searchInput.setValue(""); this.mediaIndex = 0;
            this.tabText.setText(this.getTabText()); this.refresh(); return;
        }
        if (this.activeTab > 0) {
            if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
                if (this.filteredMedia.length) this.mediaIndex = (this.mediaIndex + (kb.matches(data, "tui.select.up") ? -1 : 1) + this.filteredMedia.length) % this.filteredMedia.length;
                this.updateList(); return;
            }
            if (kb.matches(data, "tui.select.confirm")) {
                const row = this.filteredMedia[this.mediaIndex];
                if (row) { this.mediaSelections[row.kind] = row.id; this.mediaDirty = true; this.callbacks.onMediaChange?.({ ...this.mediaSelections }); this.refresh(); }
                return;
            }
            if (kb.matches(data, "app.models.save")) {
                this.callbacks.onMediaPersist?.({ ...this.mediaSelections }); this.mediaDirty = false; this.footerText.setText(this.getFooterText()); return;
            }
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
                if (matchesKey(data, Key.ctrl("c")) && this.searchInput.getValue()) { this.searchInput.setValue(""); this.refresh(); }
                else this.callbacks.onCancel();
                return;
            }
            this.searchInput.handleInput(data); this.mediaIndex = 0; this.refresh(); return;
        }
        // Navigation
        if (kb.matches(data, "tui.select.up")) {
            if (this.filteredItems.length === 0)
                return;
            this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
            this.updateList();
            return;
        }
        if (kb.matches(data, "tui.select.down")) {
            if (this.filteredItems.length === 0)
                return;
            this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
            this.updateList();
            return;
        }
        // Reorder enabled models
        const reorderUp = kb.matches(data, "app.models.reorderUp");
        const reorderDown = kb.matches(data, "app.models.reorderDown");
        if (reorderUp || reorderDown) {
            if (this.enabledIds === null)
                return;
            const item = this.filteredItems[this.selectedIndex];
            if (item && isEnabled(this.enabledIds, item.fullId)) {
                const delta = reorderUp ? -1 : 1;
                const currentIndex = this.enabledIds.indexOf(item.fullId);
                const newIndex = currentIndex + delta;
                // Only move if within bounds
                if (newIndex >= 0 && newIndex < this.enabledIds.length) {
                    this.enabledIds = move(this.enabledIds, item.fullId, delta);
                    this.isDirty = true;
                    this.selectedIndex += delta;
                    this.refresh();
                    this.notifyChange();
                }
            }
            return;
        }
        // Toggle on Enter
        if (kb.matches(data, "tui.select.confirm")) {
            const item = this.filteredItems[this.selectedIndex];
            if (item) {
                this.enabledIds = toggle(this.enabledIds, this.allIds, item.fullId);
                this.isDirty = true;
                this.refresh();
                this.notifyChange();
            }
            return;
        }
        // Enable all (filtered if search active, otherwise all)
        if (kb.matches(data, "app.models.enableAll")) {
            const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
            this.enabledIds = enableAll(this.enabledIds, this.allIds, targetIds);
            this.isDirty = true;
            this.refresh();
            this.notifyChange();
            return;
        }
        // Clear all (filtered if search active, otherwise all)
        if (kb.matches(data, "app.models.clearAll")) {
            const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
            this.enabledIds = clearAll(this.enabledIds, this.allIds, targetIds);
            this.isDirty = true;
            this.refresh();
            this.notifyChange();
            return;
        }
        // Toggle provider of current item
        if (kb.matches(data, "app.models.toggleProvider")) {
            const item = this.filteredItems[this.selectedIndex];
            if (item?.model) {
                const provider = item.model.provider;
                const providerIds = this.allIds.filter((id) => this.modelsById.get(id).provider === provider);
                const allEnabled = providerIds.every((id) => isEnabled(this.enabledIds, id));
                this.enabledIds = allEnabled
                    ? clearAll(this.enabledIds, this.allIds, providerIds)
                    : enableAll(this.enabledIds, this.allIds, providerIds);
                this.isDirty = true;
                this.refresh();
                this.notifyChange();
            }
            return;
        }
        // Save/persist to settings
        if (kb.matches(data, "app.models.save")) {
            this.callbacks.onPersist(this.enabledIds === null ? null : [...this.enabledIds]);
            this.isDirty = false;
            this.footerText.setText(this.getFooterText());
            return;
        }
        // Ctrl+C - clear search or cancel if empty
        if (matchesKey(data, Key.ctrl("c"))) {
            if (this.searchInput.getValue()) {
                this.searchInput.setValue("");
                this.refresh();
            }
            else {
                this.callbacks.onCancel();
            }
            return;
        }
        // Escape - cancel
        if (matchesKey(data, Key.escape)) {
            this.callbacks.onCancel();
            return;
        }
        // Pass everything else to search input
        this.searchInput.handleInput(data);
        this.refresh();
    }
    getSearchInput() {
        return this.searchInput;
    }
}
