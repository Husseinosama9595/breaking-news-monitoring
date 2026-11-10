import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, DestroyRef, effect, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { AccountsApiService } from '../../core/services/accounts-api.service';
import { MonitoredAccount } from '../../core/models/monitored-account.model';
import { accountFeedFreshness, isValidApiTimestamp } from '../../core/utils/account-health';
import { PostsApiService } from '../../core/services/posts-api.service';
import { MonitoredPost } from '../../core/models/post.model';
import { CountriesApiService } from '../../core/services/countries-api.service';
import { CountryOverviewResponse } from '../../core/models/country.model';
import { countryFlag } from '../../core/utils/country-flag';
import { LiveNotificationsService } from '../../core/services/live-notifications.service';

@Component({
  standalone: true,
  selector: 'app-dashboard-page',
  imports: [DatePipe, RouterLink],
  templateUrl: './dashboard-page.component.html',
  styleUrl: './dashboard-page.component.scss',
})
export class DashboardPageComponent implements OnInit {
  private readonly accountsApi = inject(AccountsApiService);
  private readonly postsApi = inject(PostsApiService);
  private readonly countriesApi = inject(CountriesApiService);
  private readonly liveNotifications = inject(LiveNotificationsService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly accounts = signal<MonitoredAccount[]>([]);
  protected readonly accountsLoading = signal(true);
  protected readonly accountsLoaded = signal(false);
  protected readonly accountsError = signal('');
  protected readonly totalAccounts = computed(() => this.accounts().length);
  protected readonly activeAccounts = computed(() => this.accounts().filter(
    (account) => account.enabled && account.monitoringStatus === 'active',
  ).length);
  protected readonly disabledAccounts = computed(() => this.accounts().filter((account) => !account.enabled).length);
  protected readonly visibleAccounts = () => this.accounts().slice(0, 5);
  protected readonly remainingAccountCount = () => Math.max(0, this.accounts().length - 5);
  protected readonly posts = signal<MonitoredPost[]>([]);
  protected readonly postsLoading = signal(true);
  protected readonly postsLoaded = signal(false);
  protected readonly postsError = signal('');
  protected readonly totalPosts = signal<number | null>(null);
  protected readonly countryOverview = signal<CountryOverviewResponse | null>(null);
  protected readonly countriesLoading = signal(true);
  protected readonly countriesError = signal('');
  protected readonly countryFlag = countryFlag;

  constructor() {
    effect(() => {
      if (!this.liveNotifications.lastLiveNotification()) return;
      this.loadPosts();
      this.loadCountries();
    });
  }

  protected hasValidPostTimestamp(value: string | null | undefined): boolean {
    return isValidApiTimestamp(value);
  }

  protected feedFreshness(account: MonitoredAccount): 'fresh' | 'stale' | 'empty' | 'unknown' {
    return accountFeedFreshness(account);
  }

  protected freshnessLabel(account: MonitoredAccount): string {
    const freshness = this.feedFreshness(account);
    return freshness[0].toUpperCase() + freshness.slice(1);
  }

  protected hasValidTimestamp(value: string | null | undefined): boolean {
    return isValidApiTimestamp(value);
  }

  protected pollStatusLabel(account: MonitoredAccount): string {
    switch (account.pollHealth?.lastStatus) {
      case 'success': return 'Poll succeeded';
      case 'failed': return 'Poll failed';
      default: return 'Not polled';
    }
  }

  ngOnInit(): void {
    this.refreshDashboard(false);
  }

  protected refreshDashboard(forceCountryRefresh = true): void {
    this.loadAccounts();
    this.loadPosts();
    this.loadCountries(forceCountryRefresh);
  }

  protected loadCountries(force = true): void {
    this.countriesLoading.set(true);
    this.countriesError.set('');
    (force ? this.countriesApi.refreshOverview() : this.countriesApi.getOverview()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (overview) => { this.countryOverview.set(overview); this.countriesLoading.set(false); },
      error: () => { this.countriesError.set('Could not load country summaries.'); this.countriesLoading.set(false); },
    });
  }

  protected loadAccounts(): void {
    this.accountsLoading.set(true);
    this.accountsError.set('');
    this.accountsLoaded.set(false);
    this.accountsApi.getAccounts().pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (response) => {
        this.accounts.set(response.accounts);
        this.accountsLoaded.set(true);
        this.accountsLoading.set(false);
      },
      error: (error: unknown) => {
        this.accountsLoading.set(false);
        this.accountsError.set(this.getAccountsError(error));
      },
    });
  }

  protected loadPosts(): void {
    this.postsLoading.set(true);
    this.postsError.set('');
    this.postsLoaded.set(false);
    this.postsApi.getPosts({ page: 1, limit: 5 }).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (response) => {
        this.posts.set(response.posts);
        this.totalPosts.set(response.pagination.total);
        this.postsLoaded.set(true);
        this.postsLoading.set(false);
      },
      error: (error: unknown) => {
        this.postsLoading.set(false);
        this.postsError.set(this.getApiError(error, 'Could not load recent posts. Check the API connection and retry.'));
      },
    });
  }

  private getAccountsError(error: unknown): string {
    if (error instanceof HttpErrorResponse && error.error && typeof error.error === 'object') {
      const message = error.error['error'];
      if (typeof message === 'string') return message;
    }
    return 'Could not load monitored accounts. Check the API connection and retry.';
  }

  private getApiError(error: unknown, fallback: string): string {
    if (error instanceof HttpErrorResponse && error.error && typeof error.error === 'object') {
      const message = error.error['error'];
      if (typeof message === 'string') return message;
    }
    return fallback;
  }
}
