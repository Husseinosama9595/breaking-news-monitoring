import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { LivePostNotification } from '../../../core/models/live-notification.model';
import { LiveNotificationsService } from '../../../core/services/live-notifications.service';
import { NotificationCenterComponent } from './notification-center.component';

function notification(postId: string, read = false): LivePostNotification {
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
    readAt: read ? '2026-11-10T12:05:00.000Z' : null,
    category: 'World News',
    read,
  };
}

describe('NotificationCenterComponent', () => {
  it('shows unread count, supports marking one/all read, and links to the original post', async () => {
    const items = signal([notification('post-1'), notification('post-2')]);
    const toasts = signal<string[]>(['post-1']);
    const preferences = signal({ soundEnabled: false, soundType: 'classic', soundVolume: 65, desktopNotificationsEnabled: false });
    const service = {
      notifications: items.asReadonly(),
      toastIds: toasts.asReadonly(),
      connectionState: signal('connected').asReadonly(),
      preferences: preferences.asReadonly(),
      desktopPermission: signal('denied').asReadonly(),
      desktopPermissionPromptAttempted: signal(true).asReadonly(),
      historyActionError: signal('').asReadonly(),
      markAllPending: signal(false).asReadonly(),
      isReadPending: () => false,
      unreadCount: () => items().filter((item) => !item.read).length,
      toastNotifications: () => items().filter((item) => toasts().includes(item.postId)),
      refreshDesktopPermission: vi.fn(),
      activateSoundFromUserGesture: vi.fn(),
      setSoundEnabled: vi.fn((enabled: boolean) => preferences.update((current) => ({ ...current, soundEnabled: enabled }))),
      setSoundType: vi.fn((soundType: string) => preferences.update((current) => ({ ...current, soundType }))),
      setSoundVolume: vi.fn((soundVolume: number) => preferences.update((current) => ({ ...current, soundVolume }))),
      setDesktopNotificationsEnabled: vi.fn(async (enabled: boolean) => preferences.update((current) => ({ ...current, desktopNotificationsEnabled: enabled }))),
      previewSound: vi.fn(async () => true),
      markRead: vi.fn((postId: string) => items.update((current) => current.map((item) =>
        item.postId === postId ? { ...item, read: true } : item,
      ))),
      markAllRead: vi.fn(() => items.update((current) => current.map((item) => ({ ...item, read: true })))),
      dismissToast: vi.fn((postId: string) => toasts.update((current) => current.filter((id) => id !== postId))),
    };
    await TestBed.configureTestingModule({
      imports: [NotificationCenterComponent],
      providers: [{ provide: LiveNotificationsService, useValue: service }],
    }).compileComponents();

    const fixture = TestBed.createComponent(NotificationCenterComponent);
    fixture.detectChanges();
    const bell = fixture.nativeElement.querySelector('.notification-bell') as HTMLButtonElement;
    expect(bell.getAttribute('aria-label')).toContain('2 unread');
    expect(fixture.nativeElement.querySelector('.post-toast')?.textContent).toContain('New post detected');
    expect(fixture.nativeElement.textContent).not.toContain('Blocked by your browser');

    (fixture.nativeElement.querySelector('.toast-dismiss') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(service.dismissToast).toHaveBeenCalledWith('post-1');
    expect(fixture.nativeElement.querySelector('.post-toast')).toBeNull();

    bell.click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.notification-preferences summary') as HTMLElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.permission-status')?.textContent).toContain('Blocked by your browser');
    const soundToggle = fixture.nativeElement.querySelector('#sound-notifications-toggle') as HTMLInputElement;
    soundToggle.checked = true;
    soundToggle.dispatchEvent(new Event('change'));
    expect(service.setSoundEnabled).toHaveBeenCalledWith(true);
    const soundSelect = fixture.nativeElement.querySelector('#notification-sound-type') as HTMLSelectElement;
    soundSelect.value = 'digital';
    soundSelect.dispatchEvent(new Event('change'));
    expect(service.setSoundType).toHaveBeenCalledWith('digital');
    const volumeSlider = fixture.nativeElement.querySelector('#notification-sound-volume') as HTMLInputElement;
    volumeSlider.value = '42';
    volumeSlider.dispatchEvent(new Event('input'));
    expect(service.setSoundVolume).toHaveBeenCalledWith(42);
    (fixture.nativeElement.querySelector('.preview-sound') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(service.previewSound).toHaveBeenCalledOnce();
    const desktopToggle = fixture.nativeElement.querySelector('#desktop-notifications-toggle') as HTMLInputElement;
    desktopToggle.checked = true;
    desktopToggle.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(service.setDesktopNotificationsEnabled).toHaveBeenCalledWith(true);
    (fixture.nativeElement.querySelector('.notification-preferences summary') as HTMLElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.notification-list li')).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('.notification-copy a')?.getAttribute('href'))
      .toBe('https://x.com/SignalDesk/status/post-1');
    expect(fixture.nativeElement.querySelector('.notification-copy a')?.getAttribute('target')).toBe('_blank');

    (fixture.nativeElement.querySelector('.mark-one') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(service.markRead).toHaveBeenCalledWith('post-1');
    expect(bell.getAttribute('aria-label')).toContain('1 unread');

    (fixture.nativeElement.querySelector('.mark-all') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(service.markAllRead).toHaveBeenCalledOnce();
    expect(bell.getAttribute('aria-label')).toContain('0 unread');
  });

  it('shows a clear empty state when there is no notification history', async () => {
    const service = {
      notifications: signal<LivePostNotification[]>([]).asReadonly(),
      toastIds: signal<string[]>([]).asReadonly(),
      connectionState: signal('disconnected').asReadonly(),
      preferences: signal({ soundEnabled: false, soundType: 'classic', soundVolume: 65, desktopNotificationsEnabled: false }).asReadonly(),
      desktopPermission: signal('unsupported').asReadonly(),
      desktopPermissionPromptAttempted: signal(false).asReadonly(),
      historyActionError: signal('').asReadonly(),
      markAllPending: signal(false).asReadonly(),
      isReadPending: () => false,
      unreadCount: () => 0,
      toastNotifications: () => [],
      refreshDesktopPermission: vi.fn(),
      activateSoundFromUserGesture: vi.fn(),
      setSoundEnabled: vi.fn(),
      setSoundType: vi.fn(),
      setSoundVolume: vi.fn(),
      setDesktopNotificationsEnabled: vi.fn(),
      previewSound: vi.fn(async () => false),
      markRead: vi.fn(),
      markAllRead: vi.fn(),
      dismissToast: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [NotificationCenterComponent],
      providers: [{ provide: LiveNotificationsService, useValue: service }],
    }).compileComponents();
    const fixture = TestBed.createComponent(NotificationCenterComponent);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.notification-bell') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.panel-empty')?.textContent).toContain('No notifications yet');
    (fixture.nativeElement.querySelector('.notification-preferences summary') as HTMLElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#desktop-notifications-toggle')?.disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('.permission-status')?.textContent).toContain('not supported');
  });
});
