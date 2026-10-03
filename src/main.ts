import { Notice, Platform, Plugin } from "obsidian";
import type { DepthinkerPluginData, DepthinkerSettings, FocusPhase, FocusRecord } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { initLocale, t } from "./i18n";
import { DayStore } from "./storage";
import { TimerEngine } from "./engine";
import { SIDEBAR_VIEW_TYPE, TIMER_VIEW_TYPE, TimerSidebarView } from "./sidebar-view";
import { FOCUS_VIEW_TYPE, FocusStatsSidebarView } from "./focus-view";
import { DepthinkerSettingTab } from "./settings-tab";
import { openRecordModal } from "./modal";
import { disposeAudio, playChime, vibrate } from "./audio";
import { loadDailyNotesConfig, openDiaryForDate } from "./diary";
import type { DailyNotesConfig } from "./diary";
import { formatClock, formatDuration, todayKey } from "./utils";

/**
 * Depthinker Timer.
 *
 * 3.0 is the timer and nothing else: one panel in the right sidebar, a status bar readout,
 * three commands and a settings tab. Everything else the plugin used to carry — the
 * workbench, the task tree, the notes panel, the focus statistics and the background
 * counter — has been removed.
 */
export default class DepthinkerPlugin extends Plugin {
  settings: DepthinkerSettings = { ...DEFAULT_SETTINGS };
  storage!: DayStore;
  engine!: TimerEngine;

  private statusBar: HTMLElement | null = null;
  private diaryConfig: DailyNotesConfig = { folder: "", format: "YYYY-MM-DD", template: "" };

  async onload(): Promise<void> {
    initLocale();
    const loaded = (await this.loadData()) as Partial<DepthinkerPluginData> | null;
    this.settings = readSettings(loaded?.settings);

    this.storage = new DayStore(this.app, () => this.settings);
    this.engine = new TimerEngine(() => this.settings, this.buildHooks());
    this.diaryConfig = await loadDailyNotesConfig(this.app, this.settings);

    this.registerView(TIMER_VIEW_TYPE, (leaf) => new TimerSidebarView(leaf, this.timerDeps()));
    // The merged 1.x panel is still registered so a leaf saved back then still resolves;
    // it opens as the timer.
    this.registerView(SIDEBAR_VIEW_TYPE, (leaf) => new TimerSidebarView(leaf, this.timerDeps()));
    this.registerView(FOCUS_VIEW_TYPE, (leaf) => new FocusStatsSidebarView(leaf, this.focusDeps()));

    this.addSettingTab(
      new DepthinkerSettingTab(this.app, this, {
        getSettings: () => this.settings,
        saveSettings: () => this.persist(),
        refreshTimer: () => this.refreshTimers(),
        samplePath: () => this.storage.samplePath(),
      }),
    );

    this.addCommands();

    if (Platform.isDesktop) {
      this.statusBar = this.addStatusBarItem();
      this.statusBar.addClass("dep-status");
      this.statusBar.setAttribute("aria-label", t("status.idle"));
      this.updateStatus();
    }

    if (this.engine.restore(loaded?.runtime ?? null) === "completed") {
      new Notice(t("notice.recovered"));
    }

    this.registerTickLoop();
    this.registerWindowEvents();

    this.addRibbonIcon("timer", t("ribbon.timer"), () => void this.activatePanel());
    this.addRibbonIcon("target", t("ribbon.focusStats"), () => void this.activateFocusPanel());
    if (this.settings.openOnStartup) this.openOnReady();
  }

  onunload(): void {
    // Keep the running session, so it can be picked up again on the next start.
    void this.persist();
    disposeAudio();
  }

  private openOnReady(): void {
    const ready = () => void this.activatePanel();
    if (this.app.workspace.layoutReady) ready();
    else this.app.workspace.onLayoutReady(ready);
  }

  private persist(): Promise<void> {
    return this.saveData({
      settings: this.settings,
      runtime: this.engine.exportRuntime(),
    });
  }

  private timerDeps() {
    return {
      engine: this.engine,
      getSettings: () => this.settings,
    };
  }

  private focusDeps() {
    return {
      app: this.app,
      storage: this.storage,
      getSettings: () => this.settings,
      getDiaryConfig: () => this.diaryConfig,
    };
  }

  /** Every open timer panel, whichever of the two view types it was created as. */
  private timerViews(): TimerSidebarView[] {
    const out: TimerSidebarView[] = [];
    for (const type of [TIMER_VIEW_TYPE, SIDEBAR_VIEW_TYPE]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        if (leaf.view instanceof TimerSidebarView) out.push(leaf.view);
      }
    }
    return out;
  }

  /** The focus statistics panel, which redraws after a record was added or edited. */
  private refreshFocus(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(FOCUS_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof FocusStatsSidebarView) view.refresh();
    }
  }

  /**
   * Timer state changed (start/stop/mode, or a recovery was resolved). Every panel on
   * screen re-renders, so two open panels can never disagree about a running session.
   */
  private refreshTimers(): void {
    for (const view of this.timerViews()) view.refreshTimer();
    this.updateStatus();
  }

  /** Per-second repaint: no re-render, only the numbers. */
  private refreshTimerTicks(): void {
    for (const view of this.timerViews()) view.onTick();
  }

  private buildHooks() {
    return {
      onSessionRecorded: (record: FocusRecord) => {
        void this.storage.addRecord(record).then(() => this.refreshFocus());
        if (this.settings.showNotice) new Notice(t("notice.saved", { duration: formatDuration(record.durationSec) }));
        this.cue();
      },
      onSessionTooShort: (seconds: number) => {
        new Notice(t("notice.tooShort", { seconds: this.settings.minSessionSeconds }));
      },
      onPhaseComplete: (phase: FocusPhase) => {
        this.cue();
        if (phase !== "focus" && this.settings.showNotice) new Notice(t("notice.breakDone"));
      },
      onStateChange: () => {
        this.refreshTimers();
        void this.persist();
      },
    };
  }

  private cue(): void {
    if (this.settings.playSound) {
      try {
        playChime();
      } catch {
        /* no-op */
      }
    }
    if (this.settings.vibrate) vibrate();
  }

  private addCommands(): void {
    this.addCommand({
      id: "open-timer",
      name: t("command.openTimer"),
      callback: () => void this.activatePanel(),
    });
    // Mirrors the single word under the gauge: start while idle, end while a session runs.
    this.addCommand({
      id: "start-stop",
      name: t("command.startStop"),
      callback: () => (this.engine.isActive ? this.engine.stop() : this.engine.start()),
    });
    this.addCommand({
      id: "add-manual",
      name: t("command.addManual"),
      callback: () =>
        openRecordModal({
          app: this.app,
          storage: this.storage,
          getSettings: () => this.settings,
          dayKey: todayKey(),
          defaultType: "focus",
          onChanged: () => {
            this.refreshTimers();
            this.refreshFocus();
          },
        }),
    });
    this.addCommand({
      id: "open-focus-stats",
      name: t("command.openFocusStats"),
      callback: () => void this.activateFocusPanel(),
    });
    this.addCommand({
      id: "open-diary",
      name: t("command.diary"),
      callback: () => void openDiaryForDate(this.app, this.diaryConfig, todayKey()),
    });
  }

  /** Opens the timer panel, by default in the right sidebar. */
  private activatePanel(): Promise<void> {
    return this.activateSidebar([TIMER_VIEW_TYPE, SIDEBAR_VIEW_TYPE], TIMER_VIEW_TYPE, "timer");
  }

  /** Opens the focus statistics panel next to the timer. */
  private activateFocusPanel(): Promise<void> {
    return this.activateSidebar([FOCUS_VIEW_TYPE], FOCUS_VIEW_TYPE, "focus statistics");
  }

  private async activateSidebar(existingTypes: string[], openType: string, label: string): Promise<void> {
    const { workspace } = this.app;
    try {
      for (const type of existingTypes) {
        const existing = workspace.getLeavesOfType(type);
        if (existing.length > 0) {
          await workspace.revealLeaf(existing[0]);
          return;
        }
      }
      // The right sidebar leaf is missing when that sidebar has never been opened,
      // so fall back to creating it — and to a normal tab if that also fails.
      const leaf = workspace.getRightLeaf(false) ?? workspace.getRightLeaf(true) ?? workspace.getLeaf("tab");
      if (!leaf) return;
      await leaf.setViewState({ type: openType, active: true });
      await workspace.revealLeaf(leaf);
    } catch (err) {
      console.error(`Depthinker: failed to open the ${label} panel`, err);
    }
  }

  private registerTickLoop(): void {
    this.registerInterval(
      window.setInterval(() => {
        this.engine.tick();
        this.refreshTimerTicks();
        this.updateStatus();
      }, 1000),
    );
  }

  private registerWindowEvents(): void {
    const onWake = () => {
      this.engine.tick();
      this.refreshTimerTicks();
      this.updateStatus();
    };
    window.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    this.register(() => {
      window.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    });
  }

  private updateStatus(): void {
    if (!this.statusBar) return;
    const snapshot = this.engine.snapshot();
    if (snapshot.state === "idle") {
      this.statusBar.setText(t("status.idle"));
      return;
    }
    const value = snapshot.mode === "stopwatch" ? snapshot.elapsedSec : snapshot.remainingSec;
    const prefix = snapshot.mode === "stopwatch" ? "" : `${t(`phase.${snapshot.phase}`)} `;
    this.statusBar.setText(`${prefix}${formatClock(value)}`);
  }
}

/**
 * Reads only the fields this version knows about, so a data file written by 1.x or 2.0
 * cannot smuggle settings for features that no longer exist back into the plugin.
 */
function readSettings(raw: Partial<DepthinkerSettings> | undefined): DepthinkerSettings {
  const source = (raw ?? {}) as Partial<Record<keyof DepthinkerSettings, unknown>>;
  const num = (key: keyof DepthinkerSettings, min: number): number => {
    const value = Number(source[key]);
    return Number.isFinite(value) ? Math.max(min, Math.round(value)) : DEFAULT_SETTINGS[key] as number;
  };
  const flag = (key: keyof DepthinkerSettings): boolean =>
    typeof source[key] === "boolean" ? (source[key] as boolean) : (DEFAULT_SETTINGS[key] as boolean);

  return {
    focusMinutes: num("focusMinutes", 1),
    shortBreakMinutes: num("shortBreakMinutes", 1),
    longBreakMinutes: num("longBreakMinutes", 1),
    longBreakInterval: num("longBreakInterval", 1),
    autoCycle: flag("autoCycle"),
    defaultMode: source.defaultMode === "stopwatch" ? "stopwatch" : "pomodoro",
    minSessionSeconds: num("minSessionSeconds", 0),
    dailyGoalMinutes: num("dailyGoalMinutes", 0),
    playSound: flag("playSound"),
    vibrate: flag("vibrate"),
    showNotice: flag("showNotice"),
    dataFolder: typeof source.dataFolder === "string" ? source.dataFolder : DEFAULT_SETTINGS.dataFolder,
    weekStart: Number(source.weekStart) === 0 ? 0 : 1,
    dailyNotesFolder:
      typeof source.dailyNotesFolder === "string" ? source.dailyNotesFolder : DEFAULT_SETTINGS.dailyNotesFolder,
    dailyNotesFormat:
      typeof source.dailyNotesFormat === "string" ? source.dailyNotesFormat : DEFAULT_SETTINGS.dailyNotesFormat,
    openOnStartup: flag("openOnStartup"),
  };
}
