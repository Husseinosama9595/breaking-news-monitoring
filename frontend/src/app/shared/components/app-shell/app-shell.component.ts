import { ChangeDetectorRef, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, startWith } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { LiveNotificationsService } from '../../../core/services/live-notifications.service';
import { ThemeService } from '../../../core/services/theme.service';
import { CountriesApiService } from '../../../core/services/countries-api.service';
import { countryFlag } from '../../../core/utils/country-flag';
import { NotificationCenterComponent } from '../notification-center/notification-center.component';
import { ToastViewportComponent } from '../toast-viewport/toast-viewport.component';

@Component({
  standalone: true,
  selector: 'app-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, NotificationCenterComponent, ToastViewportComponent],
  templateUrl: './app-shell.component.html',
  styleUrl: './app-shell.component.scss',
})
export class AppShellComponent {
  protected readonly sidebarOpen = signal(false);
  protected readonly sidebarCollapsed = signal(false);
  protected readonly pageTitle = signal('Overview');
  protected readonly pageSection = signal('COMMAND CENTER');
  protected readonly globalSearchQuery = signal('');

  private readonly router = inject(Router);
  private readonly activatedRoute = inject(ActivatedRoute);
  protected readonly auth = inject(AuthService);
  protected readonly theme = inject(ThemeService);
  protected readonly liveNotifications = inject(LiveNotificationsService);
  protected readonly countriesApi = inject(CountriesApiService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    try { this.sidebarCollapsed.set(globalThis.localStorage?.getItem('breaking-news-monitor.sidebar-collapsed') === 'true'); }
    catch { this.sidebarCollapsed.set(false); }
    this.liveNotifications.start();
    this.loadCountryNavigation();
    this.destroyRef.onDestroy(() => this.liveNotifications.stop());
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      startWith(null),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(() => this.updatePageContext());
  }

  protected closeSidebar(): void {
    this.sidebarOpen.set(false);
  }

  protected toggleSidebar(): void {
    this.sidebarOpen.update((open) => !open);
  }

  protected toggleCollapsed(): void {
    this.sidebarCollapsed.update((collapsed) => !collapsed);
    try { globalThis.localStorage?.setItem('breaking-news-monitor.sidebar-collapsed', String(this.sidebarCollapsed())); }
    catch { /* The layout remains usable when browser storage is unavailable. */ }
  }

  protected connectionLabel(): string {
    const state = this.liveNotifications.connectionState();
    return state === 'connected' ? 'Live updates connected' : state === 'connecting' ? 'Connecting to live updates' : 'Live updates reconnecting';
  }

  protected logout(): void {
    this.auth.logout();
  }

  protected updateGlobalSearch(event: Event): void {
    this.globalSearchQuery.set((event.target as HTMLInputElement).value);
  }

  protected submitGlobalSearch(event: Event): void {
    event.preventDefault();
    const query = this.globalSearchQuery().trim();
    if (!query) return;
    void this.router.navigate(['/search'], { queryParams: { q: query } });
    this.closeSidebar();
  }

  protected readonly countryFlag = countryFlag;
  protected readonly countries = () => this.countriesApi.overview()?.countries ?? [];
  protected readonly unassignedCountry = () => this.countriesApi.overview()?.unassigned;
  protected readonly countriesExpanded = signal(true);
  protected readonly allCountriesExpanded = signal(false);
  protected readonly visibleCountries = () => this.allCountriesExpanded() ? this.countries() : this.countries().slice(0, 8);

  protected toggleCountryNavigation(): void {
    this.countriesExpanded.update((expanded) => !expanded);
  }

  protected toggleAllCountries(): void { this.allCountriesExpanded.update((expanded) => !expanded); }

  private loadCountryNavigation(): void {
    this.countriesApi.getOverview().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => {}, error: () => {} });
  }

  private updatePageContext(): void {
    let route = this.activatedRoute;
    while (route.firstChild) route = route.firstChild;
    const data = route?.snapshot?.data ?? {};
    this.pageTitle.set(String(data['pageHeading'] ?? 'Overview'));
    this.pageSection.set(String(data['pageSection'] ?? 'COMMAND CENTER'));
    this.changeDetector.markForCheck();
  }
}
