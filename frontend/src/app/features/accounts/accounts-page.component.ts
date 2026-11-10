import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { accountFeedFreshness, isValidApiTimestamp } from '../../core/utils/account-health';
import { AccountsApiService, AccountsQuery } from '../../core/services/accounts-api.service';
import { AccountCategory, CreateMonitoredAccountRequest, MonitoredAccount, UpdateMonitoredAccountRequest } from '../../core/models/monitored-account.model';
import { ToastService } from '../../core/services/toast.service';
import { ActivatedRoute } from '@angular/router';
import { CountriesApiService } from '../../core/services/countries-api.service';
import { CountryCatalogItem } from '../../core/models/country.model';
import { countryFlag } from '../../core/utils/country-flag';
import { LiveNotificationsService } from '../../core/services/live-notifications.service';
import { EMPTY, Subject, catchError, debounceTime, distinctUntilChanged, map, of, switchMap } from 'rxjs';

const CATEGORIES: AccountCategory[] = [
  'World News', 'Politics', 'Military & Security', 'Economy & Finance',
  'Technology', 'Business', 'Emergencies', 'Other',
];

@Component({
  standalone: true,
  selector: 'app-accounts-page',
  imports: [DatePipe, ReactiveFormsModule],
  templateUrl: './accounts-page.component.html',
  styleUrl: './accounts-page.component.scss',
})
export class AccountsPageComponent implements OnInit {
  private readonly accountsApi = inject(AccountsApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly formBuilder = inject(FormBuilder);
  private readonly toasts = inject(ToastService);
  private readonly route = inject(ActivatedRoute);
  private readonly countriesApi = inject(CountriesApiService);
  private readonly liveNotifications = inject(LiveNotificationsService);
  private readonly accountRequests = new Subject<{ query: AccountsQuery; key: string } | null>();
  private readonly searchInputs = new Subject<string>();
  private pendingSearchTerm: string | null = null;

  protected readonly accounts = signal<MonitoredAccount[]>([]);
  protected readonly loading = signal(true);
  protected readonly loaded = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly categories = CATEGORIES;
  protected readonly countryOptions = signal<CountryCatalogItem[]>([]);
  protected readonly countryFilter = signal('');
  protected readonly statusFilter = signal('all');
  protected readonly countryFlag = countryFlag;
  protected readonly countryCounts = computed(() => this.countriesApi.overview());
  protected readonly visibleAccounts = computed(() => this.accounts());
  protected readonly totalAccounts = signal(0);
  protected readonly page = signal(1);
  protected readonly totalPages = signal(0);
  protected readonly activeSearch = signal('');
  protected readonly searchForm = this.formBuilder.nonNullable.group({ search: [''] });
  protected readonly form = this.formBuilder.nonNullable.group({
    username: ['', [Validators.required, Validators.pattern(/^@?[A-Za-z0-9_]{1,15}$/)]],
    displayName: ['', [Validators.maxLength(120)]],
    category: ['Other' as AccountCategory, Validators.required],
    providerName: [''],
    countrySelection: [''],
  });
  protected readonly formOpen = signal(false);
  protected readonly editingAccount = signal<MonitoredAccount | null>(null);
  protected readonly saving = signal(false);
  protected readonly rowBusyId = signal('');
  protected readonly mutationError = signal('');
  protected readonly successMessage = signal('');

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
      case 'success': return 'Succeeded';
      case 'failed': return 'Failed';
      default: return 'Not polled';
    }
  }

  ngOnInit(): void {
    const initialCountry = this.route.snapshot.queryParamMap.get('country') ?? '';
    this.countryFilter.set(initialCountry);
    this.countriesApi.getCatalog().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (response) => this.countryOptions.set(response.countries), error: () => {} });
    this.countriesApi.getOverview().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => {}, error: () => {} });
    this.accountRequests.pipe(
      switchMap((request) => {
        if (!request) return EMPTY;
        return this.accountsApi.getAccounts(request.query).pipe(
          map((response) => ({ request, response })),
          catchError((error: unknown) => of({ request, error })),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((result) => {
      if (result.request.key !== this.accountQueryKey()) return;
      if ('response' in result) {
        const response = result.response;
        this.accounts.set(response.accounts);
        this.totalAccounts.set(response.pagination?.total ?? response.accounts.length);
        this.totalPages.set(response.pagination?.totalPages ?? (response.accounts.length ? 1 : 0));
        this.page.set(response.pagination?.page ?? 1);
        this.loaded.set(true);
        this.loading.set(false);
      } else {
        this.loading.set(false);
        this.errorMessage.set(this.getErrorMessage(result.error));
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
      if (term === this.activeSearch()) return;
      this.activeSearch.set(term);
      this.page.set(1);
      this.loadAccounts();
    });
    this.loadAccounts();
  }

  protected loadAccounts(): void {
    this.loading.set(true);
    this.errorMessage.set('');
    this.loaded.set(false);
    const query: AccountsQuery = {
      ...(this.countryFilter() ? { country: this.countryFilter() } : {}),
      ...(this.activeSearch() ? { search: this.activeSearch() } : {}),
      ...(this.statusFilter() !== 'all' ? { status: this.statusFilter() as 'enabled' | 'disabled' | 'error' } : {}),
      page: this.page(),
      limit: 20,
    };
    this.accountRequests.next({ query, key: this.accountQueryKey() });
  }

  protected setCountryFilter(value: string): void {
    this.commitPendingSearch();
    this.countryFilter.set(value);
    this.page.set(1);
    this.loadAccounts();
  }

  protected setStatusFilter(value: string): void {
    this.commitPendingSearch();
    this.statusFilter.set(value);
    this.page.set(1);
    this.loadAccounts();
  }

  protected onSearchInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchForm.controls.search.setValue(value, { emitEvent: false });
    const term = value.trim();
    if (!term) {
      this.clearSearch();
      return;
    }
    if (term === this.activeSearch() && this.pendingSearchTerm === null) return;
    if (term === this.activeSearch() && this.pendingSearchTerm !== null) {
      this.pendingSearchTerm = null;
      this.searchInputs.next(term);
      this.loadAccounts();
      return;
    }
    this.pendingSearchTerm = term;
    this.loading.set(true);
    this.loaded.set(false);
    this.errorMessage.set('');
    this.accountRequests.next(null);
    this.searchInputs.next(term);
  }

  protected clearSearch(): void {
    this.searchForm.controls.search.setValue('');
    const hadPendingSearch = this.pendingSearchTerm !== null;
    this.pendingSearchTerm = null;
    this.searchInputs.next('');
    if (!this.activeSearch() && !hadPendingSearch) return;
    this.activeSearch.set('');
    this.page.set(1);
    this.loadAccounts();
  }

  protected changePage(page: number): void {
    if (this.loading() || page < 1 || page > this.totalPages()) return;
    this.page.set(page);
    this.loadAccounts();
  }

  protected countryLabel(account: MonitoredAccount): string {
    return account.countryName ?? (account.countryCode ? account.countryCode : 'Unassigned');
  }

  protected countryOptionLabel(country: CountryCatalogItem): string { return `${country.countryName} · ${country.countryCode}`; }

  protected openCreateForm(): void {
    this.editingAccount.set(null);
    this.mutationError.set('');
    this.form.reset({ username: '', displayName: '', category: 'Other', providerName: '', countrySelection: '' });
    this.formOpen.set(true);
  }

  protected openEditForm(account: MonitoredAccount): void {
    this.editingAccount.set(account);
    this.mutationError.set('');
    this.form.reset({
      username: account.username,
      displayName: account.displayName ?? '',
      category: account.category,
      providerName: account.providerName,
      countrySelection: account.countryCode ? `${account.countryName || account.countryCode} · ${account.countryCode}` : '',
    });
    this.formOpen.set(true);
  }

  protected closeForm(): void {
    if (this.saving()) return;
    this.formOpen.set(false);
    this.mutationError.set('');
  }

  protected submitForm(): void {
    if (this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    const username = value.username.trim().replace(/^@/, '');
    const countryCode = this.parseCountrySelection(value.countrySelection);
    if (countryCode === undefined) {
      this.mutationError.set('Choose a country from the suggestions, or leave it blank for Unassigned.');
      return;
    }
    const request: CreateMonitoredAccountRequest = {
      username,
      displayName: value.displayName.trim() || null,
      category: value.category,
      countryCode,
      ...(value.providerName ? { providerName: value.providerName } : {}),
    };
    const editing = this.editingAccount();
    this.saving.set(true);
    this.mutationError.set('');
    this.successMessage.set('');
    const operation = editing
      ? this.accountsApi.updateAccount(editing._id, request satisfies UpdateMonitoredAccountRequest)
      : this.accountsApi.createAccount(request);
    operation.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.saving.set(false);
        this.formOpen.set(false);
        this.successMessage.set(editing ? 'Account updated.' : 'Account added.');
        this.toasts.show({ kind: 'success', title: editing ? 'Account updated' : 'Account added', description: `@${username} is in the monitored account roster.` });
        this.loadAccounts();
        this.countriesApi.refreshOverview().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => {}, error: () => {} });
        if (editing && (editing.countryCode ?? null) !== countryCode) void this.liveNotifications.refreshLoadedHistory();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.mutationError.set(this.getErrorMessage(error, 'Could not save this account.'));
        this.toasts.show({ kind: 'error', title: 'Account could not be saved', description: this.mutationError() });
      },
    });
  }

  protected toggleEnabled(account: MonitoredAccount): void {
    if (this.rowBusyId()) return;
    this.rowBusyId.set(account._id);
    this.mutationError.set('');
    this.successMessage.set('');
    this.accountsApi.setAccountEnabled(account._id, !account.enabled)
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => {
          this.rowBusyId.set('');
          this.successMessage.set(account.enabled ? 'Monitoring disabled.' : 'Monitoring enabled.');
          this.toasts.show({ kind: 'success', title: account.enabled ? 'Monitoring paused' : 'Monitoring enabled', description: `@${account.username} was updated.` });
          this.loadAccounts();
          this.countriesApi.refreshOverview().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: () => {}, error: () => {} });
        },
        error: (error: unknown) => {
          this.rowBusyId.set('');
          this.mutationError.set(this.getErrorMessage(error, 'Could not update monitoring status.'));
          this.toasts.show({ kind: 'error', title: 'Monitoring status could not be updated', description: this.mutationError() });
        },
      });
  }

  protected fieldInvalid(field: 'username' | 'displayName' | 'category'): boolean {
    const control = this.form.controls[field];
    return control.invalid && (control.touched || control.dirty);
  }

  private parseCountrySelection(value: string): string | null | undefined {
    const selection = value.trim();
    if (!selection) return null;
    const code = /·\s*([A-Z]{2})$/.exec(selection)?.[1];
    return code && this.countryOptions().some((country) => country.countryCode === code && this.countryOptionLabel(country) === selection)
      ? code
      : undefined;
  }

  private getErrorMessage(error: unknown, fallback = 'Could not load monitored accounts. Check the API connection and retry.'): string {
    if (error instanceof HttpErrorResponse && error.error && typeof error.error === 'object') {
      const message = error.error['error'];
      if (typeof message === 'string') return message;
    }
    return fallback;
  }

  private commitPendingSearch(): void {
    const term = this.searchForm.controls.search.value.trim();
    if (this.pendingSearchTerm === null) return;
    this.pendingSearchTerm = null;
    this.searchInputs.next(term);
    if (term !== this.activeSearch()) this.activeSearch.set(term);
    this.page.set(1);
  }

  private accountQueryKey(): string {
    return JSON.stringify({
      country: this.countryFilter(), search: this.activeSearch(), status: this.statusFilter(), page: this.page(),
    });
  }
}
