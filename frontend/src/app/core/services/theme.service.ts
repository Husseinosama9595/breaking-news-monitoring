import { Injectable, signal } from '@angular/core';

export type AppTheme = 'light' | 'dark';
const THEME_KEY = 'breaking-news-monitor.theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly themeState = signal<AppTheme>(this.readTheme());
  readonly theme = this.themeState.asReadonly();

  constructor() { this.apply(this.themeState()); }

  toggle(): void { this.setTheme(this.themeState() === 'light' ? 'dark' : 'light'); }

  setTheme(theme: AppTheme): void {
    this.themeState.set(theme);
    this.apply(theme);
    try { globalThis.localStorage?.setItem(THEME_KEY, theme); } catch { /* Keep the active theme in memory if storage is unavailable. */ }
  }

  private readTheme(): AppTheme {
    try { return globalThis.localStorage?.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; }
    catch { return 'light'; }
  }

  private apply(theme: AppTheme): void {
    if (typeof document !== 'undefined') document.documentElement.dataset['theme'] = theme;
  }
}
