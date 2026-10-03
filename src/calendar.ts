import { App, Modal, setIcon } from "obsidian";
import type { DayRecord, DepthinkerSettings } from "./types";
import { t, monthTitle, weekdays } from "./i18n";
import {
  clock,
  formatDuration,
  monthDays,
  monthOffset,
  pomodoroRecords,
  sortRecords,
  sumFocusDuration,
  sumRestDuration,
  todayKey,
  weekDays,
} from "./utils";
import type { DayStore } from "./storage";
import { openDeleteConfirm, openRecordModal } from "./modal";
import type { DailyNotesConfig } from "./diary";
import { diaryPath, openDiaryForDate } from "./diary";

interface CalendarDeps {
  app: App;
  storage: DayStore;
  getSettings: () => DepthinkerSettings;
  getDiaryConfig: () => DailyNotesConfig;
  onChanged: () => void;
}

export class CalendarView {
  private renderToken = 0;
  private year: number;
  private month: number;

  constructor(
    private root: HTMLElement,
    private deps: CalendarDeps,
  ) {
    const now = new Date();
    this.year = now.getFullYear();
    this.month = now.getMonth();
  }

  refresh(): void {
    this.render();
  }

  render(): void {
    this.root.empty();
    const settings = this.deps.getSettings();
    this.renderStats();
    this.renderSplitStats();
    this.renderNav();
    this.renderWeekdayHeader(settings.weekStart);
    this.renderGrid(settings.weekStart);
    void this.fillAsync();
  }

  private renderStats(): void {
    const container = this.root.createDiv({ cls: "dtimer-stats" });
    const card = (labelKey: string) => {
      const el = container.createDiv({ cls: "dtimer-stat" });
      el.createSpan({ cls: "dtimer-stat-value", text: "\u2014" });
      el.createSpan({ cls: "dtimer-stat-label", text: t(labelKey) });
      return el;
    };
    card("stats.today");
    card("stats.week");
    card("stats.month");
    card("stats.streak");
  }

  /** Focus time and rest time, for this week and for this month. */
  private renderSplitStats(): void {
    const panel = this.root.createDiv({ cls: "dtimer-splitstats" });
    panel.createDiv({ cls: "dtimer-splitstats-title", text: t("stats.focusRestHeading") });
    const grid = panel.createDiv({ cls: "dtimer-splitstats-grid" });
    this.buildSplitColumn(grid, "week", t("stats.week"));
    this.buildSplitColumn(grid, "month", t("stats.month"));
  }

  private buildSplitColumn(grid: HTMLElement, period: "week" | "month", title: string): void {
    const col = grid.createDiv({ cls: "dtimer-splitstats-col" });
    col.createDiv({ cls: "dtimer-splitstats-col-title", text: title });
    const list = col.createDiv({ cls: "dtimer-splitstats-list" });
    for (const kind of ["focus", "rest"] as const) {
      const row = list.createDiv({ cls: `dtimer-splitstats-row dtimer-splitstats-${kind}` });
      row.createSpan({
        cls: "dtimer-splitstats-label",
        text: t(kind === "focus" ? "stats.focusTotal" : "stats.restTotal"),
      });
      const value = row.createSpan({ cls: "dtimer-splitstats-value", text: "\u2014" });
      value.setAttribute("data-kind", `${period}-${kind}`);
    }
  }

  private renderNav(): void {
    const nav = this.root.createDiv({ cls: "dtimer-cal-nav" });
    const prev = nav.createEl("button", { cls: "dtimer-cal-btn" });
    prev.setAttribute("aria-label", t("calendar.prev"));
    setIcon(prev, "chevron-left");
    prev.addEventListener("click", () => this.shiftMonth(-1));

    nav.createDiv({ cls: "dtimer-cal-label", text: monthTitle(this.year, this.month) });

    const next = nav.createEl("button", { cls: "dtimer-cal-btn" });
    next.setAttribute("aria-label", t("calendar.next"));
    setIcon(next, "chevron-right");
    next.addEventListener("click", () => this.shiftMonth(1));

    const today = nav.createEl("button", { cls: "dtimer-cal-btn dtimer-cal-today" });
    today.setText(t("calendar.today"));
    today.addEventListener("click", () => this.goToToday());
  }

  private shiftMonth(delta: number): void {
    const d = new Date(this.year, this.month + delta, 1);
    this.year = d.getFullYear();
    this.month = d.getMonth();
    this.render();
  }

  private goToToday(): void {
    const now = new Date();
    this.year = now.getFullYear();
    this.month = now.getMonth();
    this.render();
  }

  private renderWeekdayHeader(weekStart: number): void {
    const row = this.root.createDiv({ cls: "dtimer-cal-weekdays" });
    const names = weekdays();
    for (let i = 0; i < 7; i++) {
      row.createSpan({ cls: "dtimer-cal-weekday", text: names[(weekStart + i) % 7] });
    }
  }

  /** Date plus a dot; the dot is the only place the amount of focus shows. */
  private renderGrid(weekStart: number): void {
    const grid = this.root.createDiv({ cls: "dtimer-cal-grid" });
    const offset = monthOffset(this.year, this.month, weekStart);
    for (let i = 0; i < offset; i++) grid.createDiv({ cls: "dtimer-day dtimer-day-blank" });

    const days = monthDays(this.year, this.month);
    const today = todayKey();
    for (const key of days) {
      const cell = grid.createDiv({ cls: "dtimer-day" });
      cell.setAttribute("data-day", key);
      if (key === today) cell.addClass("dtimer-day-today");
      cell.createSpan({ cls: "dtimer-day-num", text: String(Number.parseInt(key.slice(8, 10), 10)) });
      cell.createSpan({ cls: "dtimer-day-dot" });
      cell.addEventListener("click", () => this.openDay(key));
    }
  }

  private openDay(key: string): void {
    new DayDetailModal(this.deps.app, key, {
      storage: this.deps.storage,
      getSettings: this.deps.getSettings,
      getDiaryConfig: this.deps.getDiaryConfig,
      onChanged: () => {
        this.deps.onChanged();
        this.render();
      },
    }).open();
  }

  private async fillAsync(): Promise<void> {
    const token = ++this.renderToken;
    const settings = this.deps.getSettings();
    const monthKeys = monthDays(this.year, this.month);
    const weekKeys = weekDays(todayKey(), settings.weekStart);

    const [monthMap, weekMap] = await Promise.all([
      this.deps.storage.getDays(monthKeys),
      this.deps.storage.getDays(weekKeys),
    ]);
    if (token !== this.renderToken) return;

    const goal = Math.max(1, settings.dailyGoalMinutes * 60);
    for (const key of monthKeys) {
      const cell = this.root.querySelector(`.dtimer-day[data-day="${key}"]`);
      if (!cell) continue;
      const records = monthMap.get(key) ?? [];
      const focusSec = sumFocusDuration(records);
      const level = focusSec === 0 ? 0 : Math.min(4, Math.ceil((focusSec / goal) * 4));
      cell.addClass(`dtimer-heat-${level}`);
      cell.setAttribute("aria-label", focusSec > 0 ? formatDuration(focusSec) : key);
    }

    void this.fillStats(token, monthMap, weekMap);
    this.fillSplitStats(token, monthMap, weekMap);
  }

  private async fillStats(token: number, monthMap: Map<string, DayRecord[]>, weekMap: Map<string, DayRecord[]>): Promise<void> {
    const todayFocus = sumFocusDuration(weekMap.get(todayKey()) ?? []);
    const weekFocus = [...weekMap.values()].reduce((sum, records) => sum + sumFocusDuration(records), 0);
    const monthFocus = [...monthMap.values()].reduce((sum, records) => sum + sumFocusDuration(records), 0);
    const streak = await this.deps.storage.getStreak();
    if (token !== this.renderToken) return;

    const values = this.root.querySelectorAll(".dtimer-stat-value");
    if (values.length >= 4) {
      values[0].textContent = formatDuration(todayFocus);
      values[1].textContent = formatDuration(weekFocus);
      values[2].textContent = formatDuration(monthFocus);
      values[3].textContent = t("stats.streakValue", { days: streak });
    }
  }

  private fillSplitStats(token: number, monthMap: Map<string, DayRecord[]>, weekMap: Map<string, DayRecord[]>): void {
    const total = (map: Map<string, DayRecord[]>, sum: (records: DayRecord[]) => number): number => {
      let result = 0;
      for (const records of map.values()) result += sum(records);
      return result;
    };
    const values: Array<[string, number]> = [
      ["week-focus", total(weekMap, sumFocusDuration)],
      ["week-rest", total(weekMap, sumRestDuration)],
      ["month-focus", total(monthMap, sumFocusDuration)],
      ["month-rest", total(monthMap, sumRestDuration)],
    ];
    if (token !== this.renderToken) return;

    for (const [kind, sec] of values) {
      const el = this.root.querySelector(`.dtimer-splitstats-value[data-kind="${kind}"]`);
      if (el) el.textContent = formatDuration(sec);
    }
  }
}

interface DayDetailDeps {
  storage: DayStore;
  getSettings: () => DepthinkerSettings;
  getDiaryConfig: () => DailyNotesConfig;
  onChanged: () => void;
}

/** What a day holds: its records, plus a way into that day's diary note. */
class DayDetailModal extends Modal {
  private token = 0;

  constructor(
    app: App,
    private dayKey: string,
    private deps: DayDetailDeps,
  ) {
    super(app);
  }

  onOpen(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const token = ++this.token;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("dep-day-modal");
    this.titleEl.setText(this.dayKey);

    const records = await this.deps.storage.getDay(this.dayKey);
    if (token !== this.token) return;

    const actions = contentEl.createDiv({ cls: "dep-day-actions" });
    const addFocus = actions.createEl("button", { cls: "dep-day-btn" });
    addFocus.setText(t("calendar.add"));
    addFocus.addEventListener("click", () => this.openModal({ defaultType: "focus" }));

    const addRest = actions.createEl("button", { cls: "dep-day-btn" });
    addRest.setText(t("calendar.addRest"));
    addRest.addEventListener("click", () => this.openModal({ defaultType: "rest" }));

    const diaryBtn = actions.createEl("button", { cls: "dep-day-btn dep-day-btn-diary" });
    const config = this.deps.getDiaryConfig();
    const path = diaryPath(config, this.dayKey);
    const exists = this.app.vault.getAbstractFileByPath(path) !== null;
    diaryBtn.setText(exists ? t("calendar.openDiary") : t("calendar.createDiary"));
    diaryBtn.addEventListener("click", () => {
      void openDiaryForDate(this.app, config, this.dayKey);
      this.close();
    });

    if (records.length === 0) {
      contentEl.createDiv({ cls: "dtimer-detail-empty", text: t("calendar.empty") });
      return;
    }

    const focusSec = sumFocusDuration(records);
    const restSec = sumRestDuration(records);
    const total = contentEl.createDiv({ cls: "dtimer-detail-total" });
    total.setText(t("calendar.dayTotal", { duration: formatDuration(focusSec) }));
    const pomodoros = pomodoroRecords(records).length;
    total.createSpan({ cls: "dtimer-detail-rest-total", text: `\u00B7 ${t("stats.pomodoros", { count: pomodoros })}` });
    if (restSec > 0) {
      total.createSpan({ cls: "dtimer-detail-rest-total", text: `\u00B7 ${t("record.rest")} ${formatDuration(restSec)}` });
    }

    const list = contentEl.createDiv({ cls: "dtimer-session-list" });
    for (const record of sortRecords(records)) this.renderRow(list, record);
  }

  private renderRow(container: HTMLElement, record: DayRecord): void {
    const row = container.createDiv({ cls: record.kind === "rest" ? "dtimer-session dtimer-session-rest" : "dtimer-session" });
    const info = row.createDiv({ cls: "dtimer-session-info" });
    info.createSpan({ cls: "dtimer-session-range" }).setText(`${clock(record.start)} \u2013 ${clock(record.end)}`);

    const meta = info.createSpan({ cls: "dtimer-session-meta" });
    if (record.kind === "rest") {
      meta.setText(`${t("record.rest")} \u00B7 ${record.tag} \u00B7 ${formatDuration(record.durationSec)}`);
    } else {
      const label = record.mode === "stopwatch" ? t("mode.stopwatch") : t(`phase.${record.phase ?? "focus"}`);
      const parts = [formatDuration(record.durationSec), label, record.tag];
      if (!record.completed) parts.push(t("calendar.incomplete"));
      meta.setText(parts.join(" \u00B7 "));
    }

    const actions = row.createDiv({ cls: "dtimer-session-actions" });
    const edit = actions.createEl("button", { cls: "dtimer-icon-btn" });
    edit.setAttribute("aria-label", t("calendar.editAria"));
    setIcon(edit, "pencil");
    edit.addEventListener("click", () => this.openModal({ existing: record, defaultType: record.kind }));

    const del = actions.createEl("button", { cls: "dtimer-icon-btn dtimer-icon-danger" });
    del.setAttribute("aria-label", t("calendar.deleteAria"));
    setIcon(del, "trash");
    del.addEventListener("click", () => {
      openDeleteConfirm(this.app, this.dayKey, record, () => {
        this.deps.storage.deleteRecord(this.dayKey, record.id).then(
          () => {
            this.deps.onChanged();
            void this.render();
          },
          (err) => console.error(err),
        );
      });
    });
  }

  private openModal(options: { existing?: DayRecord; defaultType: "focus" | "rest" }): void {
    openRecordModal({
      app: this.app,
      storage: this.deps.storage,
      getSettings: this.deps.getSettings,
      existing: options.existing,
      dayKey: this.dayKey,
      defaultType: options.defaultType,
      onChanged: () => {
        this.deps.onChanged();
        void this.render();
      },
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
