import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, effect, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AccountsApiService } from '../../core/services/accounts-api.service';
import { CountriesApiService } from '../../core/services/countries-api.service';
import { CountrySummary } from '../../core/models/country.model';
import { MonitoredAccount } from '../../core/models/monitored-account.model';
import { MonitoredPost } from '../../core/models/post.model';
import { PostsApiService } from '../../core/services/posts-api.service';
import { LiveNotificationsService } from '../../core/services/live-notifications.service';
import { countryFlag } from '../../core/utils/country-flag';
import { EMPTY, Subject, catchError, debounceTime, distinctUntilChanged, map, of, switchMap } from 'rxjs';

@Component({
  standalone: true,
  selector: 'app-country-feed-page',
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './country-feed-page.component.html',
  styleUrl: './country-feed-page.component.scss',
})
export class CountryFeedPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly formBuilder = inject(FormBuilder);
  private readonly countriesApi = inject(CountriesApiService);
  private readonly accountsApi = inject(AccountsApiService);
  private readonly postsApi = inject(PostsApiService);
  private readonly liveNotifications = inject(LiveNotificationsService);

  protected readonly countryCode = signal('');
  protected readonly summary = signal<CountrySummary | null>(null);
  protected readonly accounts = signal<MonitoredAccount[]>([]);
  protected readonly posts = signal<MonitoredPost[]>([]);
  protected readonly totalPosts = signal(0);
  protected readonly loading = signal(true);
  protected readonly errorMessage = signal('');
  protected readonly page = signal(1);
  protected readonly totalPages = signal(0);
  protected readonly filters = this.formBuilder.nonNullable.group({ search: [''], category: [''], notificationStatus: [''] });
  private activeFilters = { search: '', category: '', notificationStatus: '' };
  private readonly postRequests = new Subject<{ country: string; query: { country: string; page: number; limit: number; search?: string; category?: string; notificationStatus?: string }; key: string } | null>();
  private readonly searchInputs = new Subject<string>();
  private readonly countryRequests = new Subject<{ code: string; force: boolean }>();
  private pendingSearchTerm: string | null = null;

  constructor() {
    effect(() => {
      const event = this.liveNotifications.lastLiveNotification();
      const code = this.countryCode();
      if (!event || !code) return;
      if (event.countryCode === code || (code === 'UNASSIGNED' && !event.countryCode)) {
        this.refreshAfterLiveEvent(code);
      } else if (event.monitoredAccountId) {
        // The event may have captured the old country just before account reassignment.
        this.accountsApi.getAccount(event.monitoredAccountId).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: ({ account }) => {
            const currentCode = account.countryCode ?? 'UNASSIGNED';
            if (currentCode === code) this.refreshAfterLiveEvent(code);
          },
          error: () => {},
        });
      }
    });
  }

  ngOnInit(): void {
    this.postRequests.pipe(
      switchMap((request) => {
        if (!request) return EMPTY;
        return this.postsApi.getPosts(request.query).pipe(
          map((response) => ({ request, response })),
          catchError((error: unknown) => of({ request, error })),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((result) => {
      if (result.request.key !== this.postQueryKey()) return;
      if ('response' in result) {
        this.posts.set(result.response.posts);
        this.totalPosts.set(result.response.pagination.total);
        this.totalPages.set(result.response.pagination.totalPages);
        this.page.set(result.response.pagination.page);
        this.loading.set(false);
      } else {
        this.loading.set(false);
        this.errorMessage.set(this.apiError(result.error));
      }
    });
    this.searchInputs.pipe(
      debounceTime(350),
      map((value) => value.trim()),
      distinctUntilChanged(),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((term) => {
      if (this.pendingSearchTerm !== term) return;
      this.pendingSearchTerm = null;
      if (term === this.activeFilters.search) return;
      this.activeFilters = { ...this.activeFilters, search: term };
      this.page.set(1);
      this.loadCountryPosts();
    });
    this.countryRequests.pipe(
      switchMap(({ code, force }) => {
        const overview$ = force ? this.countriesApi.refreshOverview() : this.countriesApi.getOverview();
        return overview$.pipe(
          switchMap((overview) => {
            const summary = code === 'UNASSIGNED'
              ? overview.unassigned
              : overview.countries.find((country) => country.countryCode === code) ?? null;
            return this.accountsApi.getAccounts({ country: code === 'UNASSIGNED' ? 'unassigned' : code }).pipe(
              map(({ accounts }) => ({ code, summary, accounts })),
            );
          }),
          catchError((error: unknown) => of({ code, error })),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((result) => {
      if (result.code !== this.countryCode()) return;
      if ('error' in result) {
        this.errorMessage.set(this.apiError(result.error));
        this.loading.set(false);
        return;
      }
      this.summary.set(result.summary);
      this.accounts.set(result.accounts);
      this.errorMessage.set('');
    });
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.countryCode.set((params.get('countryCode') ?? '').toUpperCase());
      this.page.set(1);
      const cancelPendingSearch = this.pendingSearchTerm !== null;
      this.pendingSearchTerm = null;
      if (cancelPendingSearch) this.searchInputs.next(this.activeFilters.search);
      this.filters.controls.search.setValue(this.activeFilters.search, { emitEvent: false });
      this.postRequests.next(null);
      this.load();
    });
  }

  protected load(force = false): void {
    const code = this.countryCode();
    if (!code) return;
    this.loading.set(true);
    this.errorMessage.set('');
    this.countryRequests.next({ code, force });
    this.loadCountryPosts();
  }

  protected applyFilters(): void {
    this.activeFilters = { ...this.filters.getRawValue(), search: this.filters.controls.search.value.trim() };
    this.pendingSearchTerm = null;
    this.searchInputs.next(this.activeFilters.search);
    this.page.set(1);
    this.loadCountryPosts();
  }

  protected clearFilters(): void {
    this.filters.reset({ search: '', category: '', notificationStatus: '' });
    this.pendingSearchTerm = null;
    this.searchInputs.next('');
    this.activeFilters = { search: '', category: '', notificationStatus: '' };
    this.page.set(1);
    this.loadCountryPosts();
  }

  protected onSearchInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.filters.controls.search.setValue(value, { emitEvent: false });
    const term = value.trim();
    if (!term) {
      this.clearSearch();
      return;
    }
    if (term === this.activeFilters.search && this.pendingSearchTerm === null) return;
    if (term === this.activeFilters.search && this.pendingSearchTerm !== null) {
      this.pendingSearchTerm = null;
      this.searchInputs.next(term);
      this.loadCountryPosts();
      return;
    }
    this.pendingSearchTerm = term;
    this.loading.set(true);
    this.errorMessage.set('');
    this.postRequests.next(null);
    this.searchInputs.next(term);
  }

  protected clearSearch(): void {
    this.filters.controls.search.setValue('');
    const hadPendingSearch = this.pendingSearchTerm !== null;
    this.pendingSearchTerm = null;
    this.searchInputs.next('');
    if (!this.activeFilters.search && !hadPendingSearch) return;
    this.activeFilters = { ...this.activeFilters, search: '' };
    this.page.set(1);
    this.loadCountryPosts();
  }

  protected changePage(page: number): void {
    this.page.set(page);
    this.loadCountryPosts();
  }

  protected flag = countryFlag;
  protected originalPostUrl(post: MonitoredPost): string | null {
    const value = post.postUrl?.trim();
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password
        && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase()) ? value : null;
    } catch { return null; }
  }

  protected loadCountryPosts(): void {
    const code = this.countryCode();
    const country = code === 'UNASSIGNED' ? 'unassigned' : code;
    if (!country) return;
    this.loading.set(true);
    this.errorMessage.set('');
    const query = {
      country,
      page: this.page(),
      limit: 20,
      ...this.activeFilters,
    };
    this.postRequests.next({ country, query, key: this.postQueryKey() });
  }

  private refreshAfterLiveEvent(code: string): void {
    const country = code === 'UNASSIGNED' ? 'unassigned' : code;
    this.countriesApi.refreshOverview().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (overview) => {
        if (code !== this.countryCode()) return;
        this.summary.set(code === 'UNASSIGNED'
          ? overview.unassigned
          : overview.countries.find((item) => item.countryCode === code) ?? null);
      },
      error: () => {},
    });
    this.loadCountryPosts();
  }

  private postQueryKey(): string {
    return JSON.stringify({ country: this.countryCode(), ...this.activeFilters, page: this.page() });
  }

  private apiError(error: unknown): string {
    if (error instanceof HttpErrorResponse && typeof error.error?.error === 'string') return error.error.error;
    return 'Could not load this country feed. Check the API connection and retry.';
  }
}
