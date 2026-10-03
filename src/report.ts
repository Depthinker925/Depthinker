import type { DepthinkerSettings } from "./types";
import type { DayStore } from "./storage";
import { t, weekdays } from "./i18n";
import { addDays, formatDuration, parseDateKey, pomodoroRecords, sumFocusDuration, todayKey } from "./utils";

interface ReportDeps {
  storage: DayStore;
  getSettings: () => DepthinkerSettings;
}

export class ReportView {
  constructor(
    private root: HTMLElement,
    private deps: ReportDeps,
  ) {}

  refresh(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const root = this.root;
    root.empty();
    root.addClass("dep-report");

    const days: string[] = [];
    for (let i = 6; i >= 0; i--) days.push(addDays(todayKey(), -i));
    const map = await this.deps.storage.getDays(days);
    const values = days.map((d) => sumFocusDuration(map.get(d) ?? []));
    // Stopwatch runs are not pomodoros, so they stay out of the count.
    const sessionCount = days.reduce((sum, d) => sum + pomodoroRecords(map.get(d) ?? []).length, 0);
    const max = Math.max(1, ...values);
    const weekTotal = values.reduce((a, b) => a + b, 0);

    root.createDiv({ cls: "dep-report-title", text: t("report.heading") });

    this.renderStats(root, weekTotal, sessionCount);
    this.renderChart(root, days, values, max);
  }

  private renderStats(root: HTMLElement, weekTotal: number, sessionCount: number): void {
    const stats = root.createDiv({ cls: "dep-report-stats" });
    const cards: Array<{ label: string; value: string }> = [
      { label: t("report.totalWeek"), value: formatDuration(weekTotal) },
      { label: t("report.sessions"), value: String(sessionCount) },
      { label: t("report.avg"), value: formatDuration(Math.round(weekTotal / 7)) },
    ];
    for (const card of cards) {
      const el = stats.createDiv({ cls: "dep-report-stat" });
      el.createDiv({ cls: "dep-report-stat-value", text: card.value });
      el.createDiv({ cls: "dep-report-stat-label", text: card.label });
    }
  }

  private renderChart(root: HTMLElement, days: string[], values: number[], max: number): void {
    const chart = root.createDiv({ cls: "dep-report-chart" });
    const weekName = weekdays();
    const today = todayKey();

    for (let i = 0; i < 7; i++) {
      const col = chart.createDiv({ cls: "dep-report-col" });
      const valueText = values[i] > 0 ? formatDuration(values[i]) : "";
      col.createDiv({ cls: "dep-report-value", text: valueText });

      const barWrap = col.createDiv({ cls: "dep-report-bar-wrap" });
      const bar = barWrap.createDiv({ cls: "dep-report-bar" });
      const pct = values[i] > 0 ? Math.max(6, Math.round((values[i] / max) * 100)) : 0;
      bar.style.setProperty("--dep-report-bar-height", `${pct}%`);
      if (days[i] === today) bar.addClass("dep-report-bar-today");

      const d = parseDateKey(days[i]);
      const label = days[i] === today ? t("habit.today") : weekName[d.getDay()];
      col.createDiv({ cls: "dep-report-day", text: label });
    }
  }
}
