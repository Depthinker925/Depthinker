import { ItemView, WorkspaceLeaf } from "obsidian";
import type { App } from "obsidian";
import type { DepthinkerSettings } from "./types";
import type { DayStore } from "./storage";
import type { DailyNotesConfig } from "./diary";
import { CalendarView } from "./calendar";
import { ReportView } from "./report";
import { t } from "./i18n";

/** The focus statistics panel. */
export const FOCUS_VIEW_TYPE = "depthinker-focus-view";

export interface FocusDeps {
  app: App;
  storage: DayStore;
  getSettings: () => DepthinkerSettings;
  getDiaryConfig: () => DailyNotesConfig;
}

/**
 * The focus statistics, on their own in the right sidebar.
 *
 * Both widgets are the ones the plugin already had: the last seven days as a bar chart,
 * and the month calendar where a day shows how much was focused and opens that day's
 * records — including a way into the diary note for that date.
 */
export class FocusStatsSidebarView extends ItemView {
  private report: ReportView | null = null;
  private calendar: CalendarView | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private deps: FocusDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return FOCUS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return t("stats.title");
  }

  getIcon(): string {
    return "target";
  }

  async onOpen(): Promise<void> {
    this.build();
  }

  refresh(): void {
    this.build();
  }

  async onClose(): Promise<void> {
    this.report = null;
    this.calendar = null;
    this.containerEl.empty();
  }

  private build(): void {
    const root = this.containerEl;
    root.empty();
    root.addClass("dep-sidebar-view");

    const section = root.createDiv({ cls: "dep-sidebar-section" });
    const body = section.createDiv({ cls: "dep-sidebar-body" });

    const reportBox = body.createDiv({ cls: "dep-report-box" });
    this.report = new ReportView(reportBox, {
      storage: this.deps.storage,
      getSettings: this.deps.getSettings,
    });
    this.report.refresh();

    const calendarBox = body.createDiv({ cls: "dep-calendar-box" });
    this.calendar = new CalendarView(calendarBox, {
      app: this.deps.app,
      storage: this.deps.storage,
      getSettings: this.deps.getSettings,
      getDiaryConfig: this.deps.getDiaryConfig,
      onChanged: () => this.refresh(),
    });
    this.calendar.refresh();
  }
}
