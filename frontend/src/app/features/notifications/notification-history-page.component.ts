import { DatePipe } from '@angular/common';
import { Component, effect, inject, signal } from '@angular/core';
import { LivePostNotification, NotificationHistoryResponse } from '../../core/models/live-notification.model';
import { LiveNotificationsService, safeOriginalPostUrl } from '../../core/services/live-notifications.service';
import { countryFlag } from '../../core/utils/country-flag';
import { CountriesApiService } from '../../core/services/countries-api.service';
import { CountryCatalogItem } from '../../core/models/country.model';
import { NotificationsApiService } from '../../core/services/notifications-api.service';
import { firstValueFrom } from 'rxjs';

@Component({
  standalone: true,
  selector: 'app-notification-history-page',
  imports: [DatePipe],
  templateUrl: './notification-history-page.component.html',
  styleUrl: './notification-history-page.component.scss',
})
export class NotificationHistoryPageComponent {
  protected readonly liveNotifications = inject(LiveNotificationsService);
  private readonly countriesApi = inject(CountriesApiService);
  private readonly notificationsApi = inject(NotificationsApiService);
  protected readonly safeOriginalPostUrl = safeOriginalPostUrl;
  protected readonly countryFlag = countryFlag;
  protected readonly countryFilter = signal('all');
  protected readonly countries = signal<CountryCatalogItem[]>([]);
  protected readonly notifications = signal<LivePostNotification[]>([]);
  protected readonly unreadCount = signal(0);
  protected readonly historyLoading = signal(false);
  protected readonly historyError = signal('');
  protected readonly historyPage = signal(1);
  protected readonly historyTotal = signal(0);
  protected readonly historyTotalPages = signal(0);
  protected readonly markAllPending = signal(false);
  private readonly pendingReadIds = signal<string[]>([]);
  private requestVersion = 0;
  private lastLiveEventId: string | null = null;

  constructor() {
    this.countriesApi.getCatalog().subscribe({ next: (response) => this.countries.set(response.countries), error: () => {} });
    this.loadPage(1);
    effect(() => {
      const event = this.liveNotifications.lastLiveNotification();
      if (!event || event.notificationId === this.lastLiveEventId) return;
      this.lastLiveEventId = event.notificationId;
      // Refresh from REST so country membership comes from the account's current assignment.
      void this.refreshLoadedPages();
    });
  }

  protected markRead(notification: LivePostNotification): void {
    if (this.pendingReadIds().includes(notification.notificationId)) return;
    if (notification.read) return;
    this.pendingReadIds.update((ids) => [...ids, notification.notificationId]);
    const readAt = new Date().toISOString();
    this.notifications.update((items) => items.map((item) => item.notificationId === notification.notificationId
      ? { ...item, read: true, readAt } : item));
    this.unreadCount.update((count) => Math.max(0, count - 1));
    this.notificationsApi.markRead(notification.notificationId).subscribe({
      next: (response) => {
        this.notifications.update((items) => items.map((item) => item.notificationId === response.notification.notificationId
          ? response.notification : item));
        void this.liveNotifications.refreshLoadedHistory();
        void this.refreshLoadedPages();
      },
      error: () => {
        this.notifications.update((items) => items.map((item) => item.notificationId === notification.notificationId
          ? { ...item, read: notification.read, readAt: notification.readAt } : item));
        this.unreadCount.update((count) => count + 1);
        this.pendingReadIds.update((ids) => ids.filter((id) => id !== notification.notificationId));
        this.historyError.set('Could not save the read status. Try again.');
      },
      complete: () => this.pendingReadIds.update((ids) => ids.filter((id) => id !== notification.notificationId)),
    });
  }

  protected markAllRead(): void {
    if (this.markAllPending()) return;
    const previous = this.notifications();
    const previousUnread = this.unreadCount();
    this.markAllPending.set(true);
    const readAt = new Date().toISOString();
    this.notifications.update((items) => items.map((item) => item.read ? item : { ...item, read: true, readAt }));
    this.unreadCount.set(0);
    this.notificationsApi.markAllRead().subscribe({
      next: () => {
        void this.liveNotifications.refreshLoadedHistory();
        this.loadPage(1);
      },
      error: () => {
        this.notifications.set(previous);
        this.unreadCount.set(previousUnread);
        this.markAllPending.set(false);
        this.historyError.set('Could not save read status for all notifications. Try again.');
      },
      complete: () => this.markAllPending.set(false),
    });
  }

  protected loadOlder(): void {
    if (this.historyPage() < this.historyTotalPages() && !this.historyLoading()) {
      void this.loadPage(this.historyPage() + 1, true);
    }
  }

  protected retry(): void {
    void this.refreshLoadedPages();
  }

  protected changeCountry(country: string): void {
    if (country === this.countryFilter()) return;
    this.countryFilter.set(country);
    this.historyPage.set(1);
    this.notifications.set([]);
    this.unreadCount.set(0);
    this.historyTotal.set(0);
    this.historyTotalPages.set(0);
    void this.loadPage(1);
  }

  protected isReadPending(notificationId: string): boolean {
    return this.pendingReadIds().includes(notificationId) || this.liveNotifications.isReadPending(notificationId);
  }

  protected get markAllDisabled(): boolean {
    return this.countryFilter() !== 'all' || this.unreadCount() === 0 || this.markAllPending() || this.liveNotifications.markAllPending();
  }

  private async loadPage(page: number, append = false): Promise<void> {
    const version = ++this.requestVersion;
    this.historyLoading.set(true);
    this.historyError.set('');
    const country = this.countryFilter();
    try {
      const response = await firstValueFrom(this.notificationsApi.getNotifications({
        page,
        limit: 20,
        ...(country === 'all' ? {} : { country }),
      }));
      if (version !== this.requestVersion) return;
      const incoming = response.notifications;
      if (append) {
        const byId = new Map(this.notifications().map((item) => [item.notificationId, item]));
        for (const item of incoming) byId.set(item.notificationId, item);
        this.notifications.set([...byId.values()]);
      } else {
        this.notifications.set(incoming);
      }
      this.unreadCount.set(response.unreadCount);
      this.historyPage.set(page);
      this.historyTotal.set(response.pagination.total);
      this.historyTotalPages.set(response.pagination.totalPages);
    } catch {
      if (version === this.requestVersion) this.historyError.set('Could not load notification history. Check your connection and retry.');
    } finally {
      if (version === this.requestVersion) this.historyLoading.set(false);
    }
  }

  private async refreshLoadedPages(): Promise<void> {
    const version = ++this.requestVersion;
    const pageCount = Math.max(1, this.historyPage());
    const country = this.countryFilter();
    this.historyLoading.set(true);
    this.historyError.set('');
    try {
      const all: LivePostNotification[] = [];
      let latest: NotificationHistoryResponse | null = null;
      for (let page = 1; page <= pageCount; page += 1) {
        latest = await firstValueFrom(this.notificationsApi.getNotifications({
          page,
          limit: 20,
          ...(country === 'all' ? {} : { country }),
        }));
        all.push(...latest.notifications);
      }
      if (version !== this.requestVersion || !latest) return;
      this.notifications.set(all);
      this.unreadCount.set(latest.unreadCount);
      this.historyTotal.set(latest.pagination.total);
      this.historyTotalPages.set(latest.pagination.totalPages);
      this.historyPage.set(Math.min(pageCount, Math.max(1, latest.pagination.totalPages)));
    } catch {
      if (version === this.requestVersion) this.historyError.set('Could not load notification history. Check your connection and retry.');
    } finally {
      if (version === this.requestVersion) this.historyLoading.set(false);
    }
  }
}
