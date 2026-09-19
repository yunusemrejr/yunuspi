import type { ThinkingLevel } from "@yunuspi/agent-core";
import { Container, type Focusable, SelectList } from "@yunuspi/tui";
/**
 * Component that renders a thinking level selector with borders
 */
export declare class ThinkingSelectorComponent extends Container implements Focusable {
    private searchInput;
    private selectList;
    private selectListChildIndex;
    private allItems;
    private onSelect;
    private onCancel;
    private onSelectAsDefault?;
    private _focused;
    get focused(): boolean;
    set focused(value: boolean);
    constructor(currentLevel: ThinkingLevel, availableLevels: ThinkingLevel[], onSelect: (level: ThinkingLevel) => void, onCancel: () => void, onSelectAsDefault?: (level: ThinkingLevel) => void, defaultThinkingLevel?: ThinkingLevel);
    private buildSelectList;
    private applyFilter;
    handleInput(keyData: string): void;
    getSelectList(): SelectList;
}
