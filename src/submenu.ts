// src/submenu.ts
// Reusable submenu controller wrapping SelectList.
//
// Solves the SelectList API limitations:
//   - No setItems: recreates the list on toggle (multi-select mode)
//   - No getItems: tracks selection in a Set externally
//   - Preserves scroll position across rebuilds via setSelectedIndex
//   - Single source of truth for open/close/render/handleInput lifecycle
//
// Usage:
//   const submenu = new SubmenuController(theme);
//   submenu.openSingleSelect(items, onSelect);
//   submenu.openMultiSelect(items, selectedValues, onApply);
//   // In render: submenu.render(width) → string[] | null
//   // In handleInput: submenu.handleInput(data) → boolean (true = consumed)

import { SelectList, type SelectItem } from "@earendil-works/pi-tui";

export type SubmenuMode = "provider" | "ids" | "reasoning" | "patterns" | null;

interface SubmenuTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

export class SubmenuController {
  private selectList: SelectList | null = null;
  private theme: SubmenuTheme;
  private selectedIndex = 0;

  // Multi-select state
  private multiSelected = new Set<string>();
  private multiItems: SelectItem[] = [];

  // Callbacks
  private onSelectSingle: ((item: SelectItem) => void) | null = null;
  private onApplyMulti: ((selected: string[]) => void) | null = null;
  private onClose: (() => void) | null = null;

  // Current mode
  public mode: SubmenuMode = null;

  constructor(theme: SubmenuTheme) {
    this.theme = theme;
  }

  /** Open a single-select submenu. onSelect is called immediately on Enter. */
  openSingleSelect(
    items: SelectItem[],
    onSelect: (item: SelectItem) => void,
    onClose?: () => void,
    maxVisible?: number,
  ): void {
    this.close();
    this.mode = "provider"; // caller should set mode after
    this.onSelectSingle = onSelect;
    this.onApplyMulti = null;
    this.onClose = onClose ?? null;
    this.selectedIndex = 0;

    this.selectList = new SelectList(
      items,
      Math.min(items.length, maxVisible ?? 10),
      this.theme,
    );
    this.selectList.onSelect = (item) => {
      onSelect(item);
      this.close();
    };
    this.selectList.onCancel = () => {
      this.close();
    };
  }

  /** Open a multi-select checklist. onApply is called on close with selected values. */
  openMultiSelect(
    items: SelectItem[],
    initiallySelected: Set<string>,
    onApply: (selected: string[]) => void,
    onClose?: () => void,
    maxVisible?: number,
  ): void {
    this.close();
    this.mode = "ids"; // caller should set mode after
    this.onSelectSingle = null;
    this.onApplyMulti = onApply;
    this.onClose = onClose ?? null;
    this.selectedIndex = 0;
    this.multiSelected = new Set(initiallySelected);
    this.multiItems = items;

    this.buildMultiSelectList(maxVisible);
  }

  /** Update multi-select items (e.g. after provider change). Preserves selection. */
  updateMultiItems(
    items: SelectItem[],
    maxVisible?: number,
  ): void {
    this.multiItems = items;
    this.buildMultiSelectList(maxVisible);
  }

  private buildMultiSelectList(maxVisible?: number): void {
    const labeled = this.multiItems.map((item) => ({
      value: item.value,
      label: `${this.multiSelected.has(item.value) ? "✓" : " "} ${item.label}`,
      description: item.description,
    }));

    this.selectList = new SelectList(
      labeled,
      Math.min(labeled.length, maxVisible ?? 12),
      this.theme,
    );
    this.selectList.setSelectedIndex(this.selectedIndex);

    this.selectList.onSelect = (item) => {
      // Toggle
      if (this.multiSelected.has(item.value)) {
        this.multiSelected.delete(item.value);
      } else {
        this.multiSelected.add(item.value);
      }
      // Rebuild (SelectList has no setItems)
      this.buildMultiSelectList(maxVisible);
    };

    this.selectList.onCancel = () => {
      this.applyAndClose();
    };
  }

  /** Close the submenu. Applies multi-select if active. */
  close(): void {
    if (this.onApplyMulti && this.multiSelected.size >= 0) {
      this.onApplyMulti([...this.multiSelected]);
    }
    this.selectList = null;
    this.onSelectSingle = null;
    this.onApplyMulti = null;
    const cb = this.onClose;
    this.onClose = null;
    this.mode = null;
    cb?.();
  }

  /** Force-close without applying multi-select (e.g. on Escape). */
  cancel(): void {
    this.selectList = null;
    this.onSelectSingle = null;
    this.onApplyMulti = null;
    this.mode = null;
    this.onClose?.();
    this.onClose = null;
  }

  /** Apply multi-select and close. */
  private applyAndClose(): void {
    if (this.onApplyMulti) {
      this.onApplyMulti([...this.multiSelected]);
    }
    this.selectList = null;
    this.onSelectSingle = null;
    this.onApplyMulti = null;
    this.mode = null;
    this.onClose?.();
    this.onClose = null;
  }

  /** Render the submenu. Returns lines or null if no submenu is open. */
  render(width: number): string[] | null {
    if (!this.selectList) return null;
    return this.selectList.render(width);
  }

  /**
   * Handle keyboard input. Returns true if consumed.
   * For single-select: Enter selects, Escape cancels.
   * For multi-select: Enter toggles, Escape applies and closes.
   */
  handleInput(data: string): boolean {
    if (!this.selectList) return false;

    // Track position before input
    const sel = this.selectList.getSelectedItem?.();
    if (sel) {
      // Find index in the original items (multi) or current items
      this.selectedIndex = Math.max(0,
        this.multiItems.findIndex((i) => i.value === sel.value) >= 0
          ? this.multiItems.findIndex((i) => i.value === sel.value)
          : this.selectedIndex
      );
    }

    this.selectList.handleInput(data);

    // Update tracked index after input
    const newSel = this.selectList.getSelectedItem?.();
    if (newSel && this.mode === "ids") {
      const idx = this.multiItems.findIndex((i) => i.value === newSel.value);
      if (idx >= 0) this.selectedIndex = idx;
    }

    return true;
  }

  /** Whether a submenu is currently open. */
  get isOpen(): boolean {
    return this.selectList !== null;
  }
}
