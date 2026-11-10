import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { LivePostNotification } from '../../core/models/live-notification.model';
import { LiveNotificationsService } from '../../core/services/live-notifications.service';
import { NotificationHistoryPageComponent } from './notification-history-page.component';

function makeNotification(postId: string, options: Partial<LivePostNotification> = {}): LivePostNotification {
  return {
    eventId: postId,
    notificationId: postId,
    postId,
    username: 'SignalDesk',
    displayName: 'Signal Desk',
    textPreview: `Update ${postId}`,
    postUrl: `https://x.com/SignalDesk/status/${postId}`,
    publishedAt: '2026-11-10T12:00:00.000Z',
    detectedAt: '2026-11-10T12:00:01.000Z',
    readAt: options.read ? '2026-11-10T12:05:00.000Z' : null,
    category: 'World News',
    read: false,
    ...options,
  };
}

describe('NotificationHistoryPageComponent', () => {
  it('renders persisted notifications with read state and only validated original links', async () => {
    const items = signal([
      makeNotification('post-1'),
      makeNotification('post-2', { read: true, postUrl: 'https://attacker.example/not-x' }),
      makeNotification('post-3'),
    ]);
    const service = {
      notifications: items.asReadonly(),
      unreadCount: computed(() => items().filter((item) => !item.read).length),
      connectionState: signal('connected').asReadonly(),
      historyLoading: signal(false).asReadonly(),
      historyError: signal('').asReadonly(),
      historyActionError: signal('').asReadonly(),
      historyHasMore: signal(false).asReadonly(),
      historyTotal: signal(3).asReadonly(),
      markAllPending: signal(false).asReadonly(),
      isReadPending: () => false,
      markRead: vi.fn((postId: string) => items.update((current) => current.map((item) =>
        item.postId === postId ? { ...item, read: true } : item,
      ))),
      markAllRead: vi.fn(() => items.update((current) => current.map((item) => ({ ...item, read: true })))),
    };
    await TestBed.configureTestingModule({
      imports: [NotificationHistoryPageComponent],
      providers: [{ provide: LiveNotificationsService, useValue: service }],
    }).compileComponents();

    const fixture = TestBed.createComponent(NotificationHistoryPageComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('saved by the backend');
    expect(host.querySelectorAll('.notification-item')).toHaveLength(3);
    expect(host.querySelector('.notification-item.is-unread')?.textContent).toContain('Unread');
    expect(host.querySelector('.notification-item:not(.is-unread)')?.textContent).toContain('Read');
    expect(host.querySelector('a[href="https://x.com/SignalDesk/status/post-1"]')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(host.querySelectorAll('a[href]')).toHaveLength(2);
    expect(host.textContent).toContain('Original link unavailable');
    expect(host.textContent).toContain('Published');
    expect(host.textContent).toContain('Received');

    (host.querySelector('.mark-read-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(service.markRead).toHaveBeenCalledWith('post-1');
    expect(host.querySelectorAll('.mark-read-button')).toHaveLength(1);
    (host.querySelector('.mark-all-button') as HTMLButtonElement).click();
    expect(service.markAllRead).toHaveBeenCalledOnce();
  });

  it('shows connection and empty states without implying that old history can be loaded', async () => {
    const connection = signal('connecting');
    const service = {
      notifications: signal<LivePostNotification[]>([]).asReadonly(),
      unreadCount: signal(0).asReadonly(),
      connectionState: connection.asReadonly(),
      historyLoading: signal(false).asReadonly(),
      historyError: signal('').asReadonly(),
      historyActionError: signal('').asReadonly(),
      historyHasMore: signal(false).asReadonly(),
      historyTotal: signal(0).asReadonly(),
      markAllPending: signal(false).asReadonly(),
      isReadPending: () => false,
      markRead: vi.fn(),
      markAllRead: vi.fn(),
      retryHistoryLoad: vi.fn(),
      loadOlderNotifications: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [NotificationHistoryPageComponent],
      providers: [{ provide: LiveNotificationsService, useValue: service }],
    }).compileComponents();
    const fixture = TestBed.createComponent(NotificationHistoryPageComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Loading notification history');

    connection.set('connected');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No notifications yet');
    expect((fixture.nativeElement.querySelector('.mark-all-button') as HTMLButtonElement).disabled).toBe(true);
  });
});
