import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { LivePostNotification, NotificationHistoryResponse } from '../../core/models/live-notification.model';
import { LiveNotificationsService } from '../../core/services/live-notifications.service';
import { CountriesApiService } from '../../core/services/countries-api.service';
import { NotificationsApiService } from '../../core/services/notifications-api.service';
import { NotificationHistoryPageComponent } from './notification-history-page.component';

function makeNotification(postId: string, options: Partial<LivePostNotification> = {}): LivePostNotification {
  return {
    eventId: postId, notificationId: postId, postId, username: 'SignalDesk', displayName: 'Signal Desk',
    textPreview: `Update ${postId}`, postUrl: `https://x.com/SignalDesk/status/${postId}`,
    publishedAt: '2026-11-10T12:00:00.000Z', detectedAt: '2026-11-10T12:00:01.000Z',
    readAt: null, category: 'World News', countryCode: null, countryName: null, read: false, ...options,
  };
}

function response(items: LivePostNotification[], options: Partial<NotificationHistoryResponse> = {}): NotificationHistoryResponse {
  return {
    notifications: items,
    pagination: { page: 1, limit: 20, total: items.length, totalPages: items.length ? 1 : 0 },
    unreadCount: items.filter((item) => !item.read).length,
    serverTime: '2026-11-10T12:01:00.000Z',
    ...options,
  };
}

function configure(api: object) {
  const live = {
    lastLiveNotification: signal<LivePostNotification | null>(null).asReadonly(),
    connectionState: signal('connected').asReadonly(),
    historyActionError: signal('').asReadonly(),
    markAllPending: signal(false).asReadonly(),
    isReadPending: () => false,
    refreshLoadedHistory: vi.fn(async () => {}),
  };
  const countries = { getCatalog: () => of({ countries: [
    { countryCode: 'IR', countryName: 'Iran' }, { countryCode: 'US', countryName: 'United States' },
  ] }) };
  return TestBed.configureTestingModule({
    imports: [NotificationHistoryPageComponent],
    providers: [
      provideHttpClient(),
      { provide: LiveNotificationsService, useValue: live },
      { provide: CountriesApiService, useValue: countries },
      { provide: NotificationsApiService, useValue: api },
    ],
  }).compileComponents().then(() => ({ live }));
}

describe('NotificationHistoryPageComponent', () => {
  it('loads persisted records from the API without replaying live notification effects', async () => {
    const items = [
      makeNotification('post-1'),
      makeNotification('post-2', { read: true, readAt: '2026-11-10T12:00:00.000Z', postUrl: 'https://attacker.example/not-x' }),
    ];
    const api = { getNotifications: vi.fn(() => of(response(items))), markRead: vi.fn(), markAllRead: vi.fn() };
    const { live } = await configure(api);
    const fixture = TestBed.createComponent(NotificationHistoryPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('saved by the backend');
    expect(host.querySelectorAll('.notification-item')).toHaveLength(2);
    expect(host.querySelector('.notification-item.is-unread')?.textContent).toContain('Unread');
    expect(host.querySelector('.notification-item:not(.is-unread)')?.textContent).toContain('Read');
    expect(host.querySelector('a[href="https://x.com/SignalDesk/status/post-1"]')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(host.querySelectorAll('a[href]')).toHaveLength(1);
    expect(host.textContent).toContain('Original link unavailable');
    expect(host.textContent).toContain('Published');
    expect(host.textContent).toContain('Received');
    expect(host.textContent).toContain('1 unread');
    expect(live.refreshLoadedHistory).not.toHaveBeenCalled();
  });

  it('uses backend country filtering before pagination and shows complete server unread counts', async () => {
    const iran = makeNotification('iran-1', { countryCode: 'IR', countryName: 'Iran' });
    const olderIran = makeNotification('iran-2', { countryCode: 'IR', countryName: 'Iran', read: true });
    const us = makeNotification('us-1', { countryCode: 'US', countryName: 'United States' });
    const api = {
      getNotifications: vi.fn(({ country, page }: { country?: string; page?: number } = {}) => {
        if (country === 'IR' && page === 2) return of(response([olderIran], {
          pagination: { page: 2, limit: 20, total: 21, totalPages: 2 }, unreadCount: 7,
        }));
        if (country === 'IR') return of(response([iran], {
          pagination: { page: 1, limit: 20, total: 21, totalPages: 2 }, unreadCount: 7,
        }));
        return of(response([us]));
      }),
      markRead: vi.fn(), markAllRead: vi.fn(),
    };
    await configure(api);
    const fixture = TestBed.createComponent(NotificationHistoryPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const select = host.querySelector('.country-history-filter select') as HTMLSelectElement;
    select.value = 'IR';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(api.getNotifications).toHaveBeenLastCalledWith({ page: 1, limit: 20, country: 'IR' });
    expect(host.querySelectorAll('.notification-item')).toHaveLength(1);
    expect(host.textContent).toContain('Update iran-1');
    expect(host.textContent).not.toContain('Update us-1');
    expect(host.textContent).toContain('7 unread');
    expect(host.textContent).toContain('1 displayed of 21');
    expect((host.querySelector('.mark-all-button') as HTMLButtonElement).disabled).toBe(true);

    (host.querySelector('.load-older-row button') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.getNotifications).toHaveBeenLastCalledWith({ page: 2, limit: 20, country: 'IR' });
    expect(host.querySelectorAll('.notification-item')).toHaveLength(2);
    expect(host.textContent).toContain('Update iran-2');
  });

  it('resets to page one and removes the country query when the filter is cleared', async () => {
    const api = { getNotifications: vi.fn(() => of(response([]))), markRead: vi.fn(), markAllRead: vi.fn() };
    await configure(api);
    const fixture = TestBed.createComponent(NotificationHistoryPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const select = fixture.nativeElement.querySelector('.country-history-filter select') as HTMLSelectElement;
    select.value = 'unassigned';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    select.value = 'all';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(api.getNotifications).toHaveBeenLastCalledWith({ page: 1, limit: 20 });
  });

  it('shows an honest empty state for an empty server result', async () => {
    const api = { getNotifications: vi.fn(() => of(response([]))), markRead: vi.fn(), markAllRead: vi.fn() };
    await configure(api);
    const fixture = TestBed.createComponent(NotificationHistoryPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No notifications yet');
    expect(fixture.nativeElement.querySelectorAll('.notification-item')).toHaveLength(0);
  });

  it('refreshes complete unread totals after persisted read and read-all operations', async () => {
    const unread1 = makeNotification('read-1');
    const unread2 = makeNotification('read-2');
    const read1 = { ...unread1, read: true, readAt: '2026-11-10T12:05:00.000Z' };
    const read2 = { ...unread2, read: true, readAt: '2026-11-10T12:06:00.000Z' };
    const api = {
      getNotifications: vi.fn()
        .mockReturnValueOnce(of(response([unread1, unread2], { unreadCount: 2 })))
        .mockReturnValueOnce(of(response([read1, unread2], { unreadCount: 1 })))
        .mockReturnValue(of(response([read1, read2], { unreadCount: 0 }))),
      markRead: vi.fn(() => of({ notification: read1 })),
      markAllRead: vi.fn(() => of({ updatedCount: 1, unreadCount: 0 })),
    };
    await configure(api);
    const fixture = TestBed.createComponent(NotificationHistoryPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    let host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('Update read-1');
    const readButton = host.querySelector('.mark-read-button') as HTMLButtonElement | null;
    expect(readButton).not.toBeNull();
    readButton?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('1 unread');
    expect(api.markRead).toHaveBeenCalledWith('read-1');
    (host.querySelector('.mark-all-button') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.markAllRead).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('0 unread');
  });

  it('shows retry state after an API failure and retries through the same server query', async () => {
    const api = { getNotifications: vi.fn().mockReturnValueOnce(throwError(() => new Error('network'))).mockReturnValue(of(response([]))), markRead: vi.fn(), markAllRead: vi.fn() };
    await configure(api);
    const fixture = TestBed.createComponent(NotificationHistoryPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Could not load notification history');
    (fixture.nativeElement.querySelector('.history-error button') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(api.getNotifications).toHaveBeenCalledTimes(2);
  });
});
