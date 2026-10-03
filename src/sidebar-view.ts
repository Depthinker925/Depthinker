import { ItemView, WorkspaceLeaf } from "obsidian";
import type { DepthinkerSettings } from "./types";
import type { TimerEngine } from "./engine";
import { TimerPanel } from "./timer-panel";
import { t } from "./i18n";

/** The timer panel. */
export const TIMER_VIEW_TYPE = "depthinker-timer-view";
/**
 * The single merged panel from 1.x. Still registered so a leaf saved back then resolves,
 * and it now opens as the timer.
 */
export const SIDEBAR_VIEW_TYPE = "depthinker-sidebar-view";

export interface SidebarDeps {
  engine: TimerEngine;
  getSettings: () => DepthinkerSettings;
}

/**
 * The timer, on its own, in the right sidebar.
 *
 * A circle with the time in the middle and the mode written small underneath. There is no
 * button: pressing the time starts a session, pressing it again ends one.
 */
export class TimerSidebarView extends ItemView {
  private timerPanel: TimerPanel | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private deps: SidebarDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return TIMER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("view.timer");
  }

  getIcon(): string {
    return "timer";
  }

  async onOpen(): Promise<void> {
    this.build();
  }

  /** Full rebuild — used when a setting that changes the panel changes. */
  refresh(): void {
    this.build();
  }

  /** Only the numbers change while the clock runs. */
  refreshTimer(): void {
    this.timerPanel?.refresh();
  }

  onTick(): void {
    this.timerPanel?.onTick();
  }

  async onClose(): Promise<void> {
    this.timerPanel = null;
    this.containerEl.empty();
  }

  private build(): void {
    const root = this.containerEl;
    root.empty();
    root.addClass("dep-sidebar-view");

    const section = root.createDiv({ cls: "dep-sidebar-section" });
    const body = section.createDiv({ cls: "dep-sidebar-body" });
    this.timerPanel = new TimerPanel(body, {
      engine: this.deps.engine,
      getSettings: this.deps.getSettings,
    });
    this.timerPanel.refresh();
  }
}
