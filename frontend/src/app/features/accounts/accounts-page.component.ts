import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { accountFeedFreshness, isValidApiTimestamp } from '../../core/utils/account-health';
import { AccountsApiService } from '../../core/services/accounts-api.service';
import { AccountCategory, CreateMonitoredAccountRequest, MonitoredAccount, UpdateMonitoredAccountRequest } from '../../core/models/monitored-account.model';

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

  protected readonly accounts = signal<MonitoredAccount[]>([]);
  protected readonly loading = signal(true);
  protected readonly loaded = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly categories = CATEGORIES;
  protected readonly form = this.formBuilder.nonNullable.group({
    username: ['', [Validators.required, Validators.pattern(/^@?[A-Za-z0-9_]{1,15}$/)]],
    displayName: ['', [Validators.maxLength(120)]],
    category: ['Other' as AccountCategory, Validators.required],
    providerName: [''],
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
    this.loadAccounts();
  }

  protected loadAccounts(): void {
    this.loading.set(true);
    this.errorMessage.set('');
    this.loaded.set(false);
    this.accountsApi.getAccounts().pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (response) => {
        this.accounts.set(response.accounts);
        this.loaded.set(true);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.errorMessage.set(this.getErrorMessage(error));
      },
    });
  }

  protected openCreateForm(): void {
    this.editingAccount.set(null);
    this.mutationError.set('');
    this.form.reset({ username: '', displayName: '', category: 'Other', providerName: '' });
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
    const request: CreateMonitoredAccountRequest = {
      username,
      displayName: value.displayName.trim() || null,
      category: value.category,
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
        this.loadAccounts();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.mutationError.set(this.getErrorMessage(error, 'Could not save this account.'));
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
          this.loadAccounts();
        },
        error: (error: unknown) => {
          this.rowBusyId.set('');
          this.mutationError.set(this.getErrorMessage(error, 'Could not update monitoring status.'));
        },
      });
  }

  protected fieldInvalid(field: 'username' | 'displayName' | 'category'): boolean {
    const control = this.form.controls[field];
    return control.invalid && (control.touched || control.dirty);
  }

  private getErrorMessage(error: unknown, fallback = 'Could not load monitored accounts. Check the API connection and retry.'): string {
    if (error instanceof HttpErrorResponse && error.error && typeof error.error === 'object') {
      const message = error.error['error'];
      if (typeof message === 'string') return message;
    }
    return fallback;
  }
}
