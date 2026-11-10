import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveNotificationsService, parseSseFrame, splitSseFrames } from './live-notifications.service';
import { NotificationHistoryQuery, NotificationsApiService } from './notifications-api.service';
import { LivePostNotification, NotificationHistoryResponse } from '../models/live-notification.model';

const TOKEN_KEY = 'breaking-news-monitor.access-token';
const CONNECTED_AT = '2026-11-10T12:00:00.000Z';

function historyResponse(notifications: LivePostNotification[] = [], unreadCount = notifications.filter((item) => !item.read).length): NotificationHistoryResponse {
  return {
    notifications,
    pagination: { page: 1, limit: 50, total: notifications.length, totalPages: notifications.length ? 1 : 0 },
    unreadCount,
    serverTime: '2026-11-10T12:00:05.000Z',
  };
}

function makeStoredNotification(postId: string, read = false): LivePostNotification {
  return {
    eventId: postId, notificationId: postId, postId, username: 'SignalDesk', displayName: 'Signal Desk',
    textPreview: `Stored ${postId}`, postUrl: `https://x.com/SignalDesk/status/${postId}`,
    publishedAt: '2026-11-10T11:59:00.000Z', detectedAt: '2026-11-10T11:59:30.000Z',
    readAt: read ? '2026-11-10T12:00:00.000Z' : null, category: 'World News', read,
  };
}

function makeApiMock() {
  return {
    getNotifications: vi.fn((_query: NotificationHistoryQuery = {}) => of(historyResponse())),
    getUnreadCount: vi.fn(() => of({ unreadCount: 0 })),
    markRead: vi.fn((id: string) => of({ notification: makeStoredNotification(id, true) })),
    markAllRead: vi.fn(() => of({ updatedCount: 0, unreadCount: 0 })),
  };
}

function configureTestBed(api = makeApiMock()) {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideRouter([]), { provide: NotificationsApiService, useValue: api }],
  });
  return api;
}

function streamResponse(frames: string[], signal?: AbortSignal, closeAfterFrames = false): Response {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      controller.enqueue(new TextEncoder().encode(`event: connected\ndata: ${JSON.stringify({ connectedAt: CONNECTED_AT })}\n\n`));
      for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
      if (closeAfterFrames) controller.close();
    },
  });
  signal?.addEventListener('abort', () => controller.close(), { once: true });
  return {
    status: 200,
    ok: true,
    headers: new Headers({ 'content-type': 'text/event-stream; charset=utf-8' }),
    body,
  } as Response;
}

function postFrame(postId: string, overrides: Record<string, unknown> = {}): string {
  return `event: post\ndata: ${JSON.stringify({
    eventId: postId,
    notificationId: postId,
    postId,
    username: 'SignalDesk',
    textPreview: `Update ${postId}`,
    postUrl: `https://x.com/SignalDesk/status/${postId}`,
    publishedAt: '2026-11-10T12:00:00.000Z',
    detectedAt: '2026-11-10T12:00:01.000Z',
    category: 'World News',
    ...overrides,
  })}\n\n`;
}

function installAudioMock() {
  const oscillators: Array<{
    onended: (() => void) | null;
    start: ReturnType<typeof vi.fn>;
    frequency: { setValueAtTime: ReturnType<typeof vi.fn> };
  }> = [];
  const gains: Array<{ gain: { exponentialRampToValueAtTime: ReturnType<typeof vi.fn> } }> = [];
  const contexts: Array<{ createOscillator: ReturnType<typeof vi.fn>; createGain: ReturnType<typeof vi.fn> }> = [];
  class MockAudioContext {
    state = 'running';
    currentTime = 1;
    destination = {};
    createOscillator = vi.fn(() => {
      const oscillator = {
        type: 'sine',
        frequency: { setValueAtTime: vi.fn() },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
        onended: null as (() => void) | null,
      };
      oscillators.push(oscillator);
      return oscillator;
    });
    createGain = vi.fn(() => {
      const gain = { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
      gains.push(gain);
      return gain;
    });
    resume = vi.fn(async () => undefined);
    close = vi.fn(async () => { this.state = 'closed'; });
    constructor() { contexts.push(this); }
  }
  vi.stubGlobal('AudioContext', MockAudioContext);
  return { contexts, oscillators, gains, AudioContextConstructor: MockAudioContext };
}

function installNotificationMock(permission: NotificationPermission) {
  const instances: Array<MockNotification> = [];
  class MockNotification {
    static permission = permission;
    static requestPermission = vi.fn(async () => {
      MockNotification.permission = 'granted';
      return MockNotification.permission;
    });
    onclick: ((this: Notification, ev: Event) => unknown) | null = null;
    onclose: ((this: Notification, ev: Event) => unknown) | null = null;
    onerror: ((this: Notification, ev: Event) => unknown) | null = null;
    data: unknown;
    close = vi.fn(() => this.onclose?.call(this as unknown as Notification, new Event('close')));
    constructor(readonly title: string, readonly options: NotificationOptions) {
      this.data = options.data;
      instances.push(this);
    }
  }
  vi.stubGlobal('Notification', MockNotification);
  return { instances, MockNotification };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(predicate()).toBe(true);
}

describe('LiveNotificationsService', () => {
  let service: LiveNotificationsService;
  let api: ReturnType<typeof makeApiMock>;

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    api = configureTestBed();
    service = TestBed.inject(LiveNotificationsService);
  });

  afterEach(() => {
    service.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('opens an authenticated SSE stream and adds a new notification once by post ID', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'unit-test-jwt');
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => streamResponse([
      'event: connected\ndata: {}\n\n',
      postFrame('post-101'),
      postFrame('post-101'),
    ], init?.signal as AbortSignal | undefined));
    vi.stubGlobal('fetch', request);

    service.start();
    await until(() => service.notifications().length === 1);

    expect(request).toHaveBeenCalledTimes(1);
    const [url, options] = request.mock.calls[0];
    expect(String(url)).toBe('http://localhost:3000/api/events/stream');
    expect(options?.headers).toEqual({ Accept: 'text/event-stream', Authorization: 'Bearer unit-test-jwt' });
    expect(service.connectionState()).toBe('connected');
    expect(service.notifications()[0]).toMatchObject({ postId: 'post-101', username: 'SignalDesk', read: false });
    expect(service.unreadCount()).toBe(1);
    expect(service.toastNotifications()).toHaveLength(1);
  });

  it('restores persistent history and unread count silently without sound or desktop alerts', async () => {
    const { oscillators } = installAudioMock();
    const { instances } = installNotificationMock('granted');
    const stored = makeStoredNotification('stored-on-load');
    api.getNotifications.mockReturnValue(of({
      ...historyResponse([stored], 1),
      pagination: { page: 1, limit: 50, total: 63, totalPages: 2 },
    }));
    service.setSoundEnabled(true);
    await service.setDesktopNotificationsEnabled(true);
    sessionStorage.setItem(TOKEN_KEY, 'unit-test-jwt');
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => streamResponse([], init?.signal as AbortSignal | undefined)));

    service.start();
    await until(() => service.notifications().length === 1);

    expect(api.getNotifications).toHaveBeenCalledWith({ page: 1, limit: 50 });
    expect(service.notifications()[0].notificationId).toBe('stored-on-load');
    expect(service.unreadCount()).toBe(1);
    expect(service.historyHasMore()).toBe(true);
    expect(service.toastNotifications()).toHaveLength(0);
    expect(oscillators).toHaveLength(0);
    expect(instances).toHaveLength(0);
  });

  it('loads older pages and persists read-one and read-all actions through the API', async () => {
    const first = makeStoredNotification('history-one');
    const older = makeStoredNotification('history-older');
    api.getNotifications.mockReturnValueOnce(of({
      ...historyResponse([first], 2),
      pagination: { page: 1, limit: 50, total: 51, totalPages: 2 },
    })).mockReturnValueOnce(of({
      ...historyResponse([older], 2),
      pagination: { page: 2, limit: 50, total: 51, totalPages: 2 },
    }));
    sessionStorage.setItem(TOKEN_KEY, 'unit-test-jwt');
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => streamResponse([], init?.signal as AbortSignal | undefined)));
    service.start();
    await until(() => service.notifications().length === 1);

    await service.loadOlderNotifications();
    expect(api.getNotifications).toHaveBeenLastCalledWith({ page: 2, limit: 50 });
    expect(service.notifications().map((item) => item.notificationId)).toEqual(['history-one', 'history-older']);
    service.markRead('history-one');
    await vi.waitFor(() => expect(api.markRead).toHaveBeenCalledWith('history-one'));
    await vi.waitFor(() => expect(service.notifications().find((item) => item.notificationId === 'history-one')?.read).toBe(true));
    await vi.waitFor(() => expect(service.isReadPending('history-one')).toBe(false));
    expect(service.unreadCount()).toBe(1);
    service.markAllRead();
    await vi.waitFor(() => expect(api.markAllRead).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(service.unreadCount()).toBe(0));
  });

  it('reconciles missed notifications on SSE reconnect without replaying new-alert effects', async () => {
    vi.useFakeTimers();
    const missed = makeStoredNotification('missed-during-disconnect');
    api.getNotifications.mockImplementation((query: NotificationHistoryQuery | undefined) => query?.since
      ? of(historyResponse([missed], 1))
      : of(historyResponse()));
    sessionStorage.setItem(TOKEN_KEY, 'unit-test-jwt');
    const request = vi.fn()
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => streamResponse([], init?.signal as AbortSignal | undefined, true))
      .mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => streamResponse([], init?.signal as AbortSignal | undefined));
    vi.stubGlobal('fetch', request);
    service.start();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(api.getNotifications).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(api.getNotifications).toHaveBeenCalledWith({ page: 1, limit: 100, since: CONNECTED_AT }));

    expect(service.notifications().some((item) => item.notificationId === 'missed-during-disconnect')).toBe(true);
    expect(service.unreadCount()).toBe(1);
    expect(service.toastNotifications()).toHaveLength(0);
  });

  it('buffers SSE events during REST hydration and suppresses a duplicate returned by both paths', async () => {
    const arriving = makeStoredNotification('race-notification');
    api.getNotifications.mockReturnValue(of(historyResponse([arriving], 1)));
    sessionStorage.setItem(TOKEN_KEY, 'unit-test-jwt');
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => streamResponse([
      postFrame('race-notification', { detectedAt: '2026-11-10T12:00:01.000Z' }),
    ], init?.signal as AbortSignal | undefined)));
    service.start();
    await until(() => service.notifications().length === 1);

    expect(service.toastNotifications()).toHaveLength(0);
    expect(service.notifications()).toHaveLength(1);
    expect(service.unreadCount()).toBe(1);
  });

  it('shows a history error and restores silently after a successful manual retry', async () => {
    const stored = makeStoredNotification('restored-after-retry');
    api.getNotifications.mockReturnValueOnce(throwError(() => new Error('network unavailable')))
      .mockReturnValue(of(historyResponse([stored], 1)));
    sessionStorage.setItem(TOKEN_KEY, 'unit-test-jwt');
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => streamResponse([], init?.signal as AbortSignal | undefined)));
    service.start();
    await until(() => Boolean(service.historyError()));
    expect(service.connectionState()).toBe('connected');

    await service.retryHistoryLoad();
    expect(service.historyError()).toBe('');
    expect(service.notifications().map((item) => item.notificationId)).toContain('restored-after-retry');
    expect(service.toastNotifications()).toHaveLength(0);
    expect(service.unreadCount()).toBe(1);
  });

  it('rolls back an optimistic read when the backend rejects the update', async () => {
    const stored = makeStoredNotification('read-failure');
    api.getNotifications.mockReturnValue(of(historyResponse([stored], 1)));
    api.markRead.mockReturnValue(throwError(() => new Error('database unavailable')));
    sessionStorage.setItem(TOKEN_KEY, 'unit-test-jwt');
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => streamResponse([], init?.signal as AbortSignal | undefined)));
    service.start();
    await until(() => service.notifications().length === 1);
    service.markRead('read-failure');
    await until(() => Boolean(service.historyActionError()));

    expect(service.notifications()[0].read).toBe(false);
    expect(service.unreadCount()).toBe(1);
    expect(service.historyActionError()).toContain('change was reverted');
  });

  it('ignores malformed payloads and unsafe original URLs', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'unit-test-jwt');
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => streamResponse([
      'event: post\ndata: {bad json}\n\n',
      postFrame('post-unsafe', { postUrl: 'javascript:alert(1)' }),
      postFrame('', { username: '', detectedAt: 'not-a-date' }),
    ], init?.signal as AbortSignal | undefined)));

    service.start();
    await until(() => service.connectionState() === 'connected');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.notifications()).toHaveLength(1);
    expect(service.notifications()[0].postUrl).toBeNull();
  });

  it('reconnects after a stream error and stops when asked', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(TOKEN_KEY, 'unit-test-jwt');
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => streamResponse(
        [postFrame('post-after-reconnect')], init?.signal as AbortSignal | undefined,
      ));
    vi.stubGlobal('fetch', request);

    service.start();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(service.notifications()).toHaveLength(1));
    expect(service.toastNotifications()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(service.toastNotifications()).toHaveLength(0);

    service.stop();
    expect(service.connectionState()).toBe('disconnected');
  });

  it('does not replay an already displayed post as new after reconnect', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(TOKEN_KEY, 'unit-test-jwt');
    const persisted = makeStoredNotification('post-reconnect-duplicate');
    api.getNotifications.mockReturnValueOnce(of(historyResponse())).mockReturnValue(of(historyResponse([persisted], 1)));
    const request = vi.fn()
      .mockResolvedValueOnce(streamResponse([postFrame('post-reconnect-duplicate')], undefined, true))
      .mockResolvedValueOnce(streamResponse([postFrame('post-reconnect-duplicate')], undefined, true))
      .mockRejectedValue(new Error('temporary network failure'));
    vi.stubGlobal('fetch', request);

    service.start();
    await vi.waitFor(() => expect(service.notifications()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(service.connectionState()).toBe('disconnected'));
    expect(service.notifications()).toHaveLength(1);
    expect(service.toastNotifications()).toHaveLength(1);
    expect(service.unreadCount()).toBe(1);
    service.stop();
  });

  it('stays disconnected and does not fetch when there is no session token', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    service.start();
    await until(() => service.connectionState() === 'disconnected');
    expect(request).not.toHaveBeenCalled();
  });

  it('defaults both channels off and persists only notification preferences locally', async () => {
    expect(service.preferences()).toEqual({
      soundEnabled: false, soundType: 'classic', soundVolume: 65, desktopNotificationsEnabled: false,
    });
    service.setSoundEnabled(true);
    service.setSoundType('email');
    service.setSoundVolume(42);
    await service.setDesktopNotificationsEnabled(true);
    expect(JSON.parse(localStorage.getItem('breaking-news-monitor.notification-preferences') ?? '{}'))
      .toEqual({ soundEnabled: true, soundType: 'email', soundVolume: 42, desktopNotificationsEnabled: true });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();

    TestBed.resetTestingModule();
    api = configureTestBed();
    service = TestBed.inject(LiveNotificationsService);
    expect(service.preferences()).toEqual({
      soundEnabled: true, soundType: 'email', soundVolume: 42, desktopNotificationsEnabled: true,
    });
  });

  it('validates sound selection and clamps volume between zero and one hundred', () => {
    service.setSoundType('digital');
    service.setSoundVolume(135);
    expect(service.preferences().soundType).toBe('digital');
    expect(service.preferences().soundVolume).toBe(100);
    service.setSoundVolume(-5);
    expect(service.preferences().soundVolume).toBe(0);
    service.setSoundVolume(Number.NaN);
    expect(service.preferences().soundVolume).toBe(0);
    service.setSoundType('unsupported' as never);
    expect(service.preferences().soundType).toBe('digital');
  });

  it('supplies new sound defaults when loading preferences saved by the earlier version', () => {
    localStorage.setItem('breaking-news-monitor.notification-preferences', JSON.stringify({
      soundEnabled: true,
      desktopNotificationsEnabled: false,
    }));
    TestBed.resetTestingModule();
    api = configureTestBed();
    service = TestBed.inject(LiveNotificationsService);
    expect(service.preferences()).toEqual({
      soundEnabled: true, soundType: 'classic', soundVolume: 65, desktopNotificationsEnabled: false,
    });
  });

  it('does not create audio until a user enables or previews sound, and handles unavailable audio', async () => {
    const { contexts, oscillators } = installAudioMock();
    expect(service.preferences().soundEnabled).toBe(false);
    expect(contexts).toHaveLength(0);
    expect(await service.previewSound()).toBe(true);
    expect(contexts).toHaveLength(1);
    expect(oscillators).toHaveLength(3);

    service.stop();
    TestBed.resetTestingModule();
    api = configureTestBed();
    service = TestBed.inject(LiveNotificationsService);
    vi.stubGlobal('AudioContext', undefined);
    const unavailable = await service.previewSound();
    expect(unavailable).toBe(false);
  });

  it('does not play sound for new posts while sound is disabled', async () => {
    const { contexts } = installAudioMock();
    sessionStorage.setItem(TOKEN_KEY, 'unit-test-jwt');
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => streamResponse(
      [postFrame('post-muted')], init?.signal as AbortSignal | undefined,
    )));
    service.start();
    await until(() => service.notifications().length === 1);
    expect(service.preferences().soundEnabled).toBe(false);
    expect(contexts).toHaveLength(0);
  });

  it('uses the legacy WebKit AudioContext constructor when the standard name is absent', async () => {
    const { contexts, AudioContextConstructor } = installAudioMock();
    vi.stubGlobal('AudioContext', undefined);
    const browserWindow = window as Window & { webkitAudioContext?: typeof AudioContext };
    browserWindow.webkitAudioContext = AudioContextConstructor as unknown as typeof AudioContext;
    try {
      expect(await service.previewSound()).toBe(true);
      expect(contexts).toHaveLength(1);
    } finally {
      delete browserWindow.webkitAudioContext;
    }
  });

  it('previews the selected sound using the selected volume', async () => {
    const { contexts, oscillators, gains } = installAudioMock();
    service.setSoundType('digital');
    service.setSoundVolume(30);
    expect(await service.previewSound()).toBe(true);
    expect(contexts).toHaveLength(1);
    expect(oscillators).toHaveLength(3);
    expect(oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(1046.5, 1);
    expect(gains[0].gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.18 * 0.3 ** 2 * 0.75, expect.any(Number));
  });

  it('handles audio playback failures without throwing', async () => {
    class BrokenAudioContext {
      state = 'running';
      createOscillator(): never { throw new Error('audio output failed'); }
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => undefined);
    }
    vi.stubGlobal('AudioContext', BrokenAudioContext);
    expect(await service.previewSound()).toBe(false);
  });

  it('survives local storage failures while keeping preference changes in memory', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    service.setSoundEnabled(true);
    expect(service.preferences().soundEnabled).toBe(true);
  });

  it('requests desktop permission only after explicit enable and does not repeat the request', async () => {
    const { MockNotification } = installNotificationMock('default');
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
    await service.setDesktopNotificationsEnabled(true);
    expect(MockNotification.requestPermission).toHaveBeenCalledOnce();
    expect(service.desktopPermission()).toBe('granted');

    await service.setDesktopNotificationsEnabled(false);
    await service.setDesktopNotificationsEnabled(true);
    expect(MockNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it('keeps denied permission separate from the stored desktop preference', async () => {
    installNotificationMock('denied');
    await service.setDesktopNotificationsEnabled(true);
    expect(service.preferences().desktopNotificationsEnabled).toBe(true);
    expect(service.desktopPermission()).toBe('denied');
  });

  it('does not show desktop notifications when the preference is disabled', async () => {
    const { instances } = installNotificationMock('granted');
    sessionStorage.setItem(TOKEN_KEY, 'unit-test-jwt');
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => streamResponse(
      [postFrame('post-desktop-off')], init?.signal as AbortSignal | undefined,
    )));
    service.start();
    await until(() => service.notifications().length === 1);
    expect(instances).toHaveLength(0);
  });

  it('handles unsupported desktop notifications without requesting permission', async () => {
    vi.stubGlobal('Notification', undefined);
    service.refreshDesktopPermission();
    expect(service.desktopPermission()).toBe('unsupported');
    expect(service.preferences().desktopNotificationsEnabled).toBe(false);
    await service.setDesktopNotificationsEnabled(true);
    expect(service.desktopPermission()).toBe('unsupported');
  });

  it('shows one desktop notification per new post and opens only a validated X URL on click', async () => {
    const { instances } = installNotificationMock('granted');
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await service.setDesktopNotificationsEnabled(true);
    sessionStorage.setItem(TOKEN_KEY, 'unit-test-jwt');
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => streamResponse([
      postFrame('post-desktop-1'), postFrame('post-desktop-1'),
      postFrame('post-desktop-2', { postUrl: 'https://attacker.example/path' }),
    ], init?.signal as AbortSignal | undefined)));

    service.start();
    await until(() => service.notifications().length === 2);
    expect(instances).toHaveLength(2);
    expect(instances[0].title).toBe('New post detected');
    expect(instances[0].options.body).toContain('@SignalDesk');
    expect((instances[0].options.body ?? '').length).toBeLessThanOrEqual(153);
    expect(instances[0].options.silent).toBe(true);

    instances[0].onclick?.call(instances[0] as unknown as Notification, new Event('click'));
    expect(focus).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith('https://x.com/SignalDesk/status/post-desktop-1', '_blank', 'noopener,noreferrer');
    instances[1].onclick?.call(instances[1] as unknown as Notification, new Event('click'));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('plays at most one quiet sound for rapid unique events and no sound for duplicates', async () => {
    const { contexts, oscillators } = installAudioMock();
    service.setSoundEnabled(true);
    sessionStorage.setItem(TOKEN_KEY, 'unit-test-jwt');
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => streamResponse([
      postFrame('post-sound-1'), postFrame('post-sound-1'), postFrame('post-sound-2'),
    ], init?.signal as AbortSignal | undefined)));
    service.start();

    await until(() => service.notifications().length === 2);
    expect(contexts).toHaveLength(1);
    expect(oscillators).toHaveLength(3);
    expect(oscillators[0].start).toHaveBeenCalledOnce();
  });

  it('updates unread state and supports marking one or all notifications as read', async () => {
    sessionStorage.setItem(TOKEN_KEY, 'unit-test-jwt');
    // The stream's event state is exercised by the connection test; here invoke a short stream.
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => streamResponse(
      [postFrame('post-read-1'), postFrame('post-read-2')], init?.signal as AbortSignal | undefined,
    )));
    service.start();

    await until(() => service.notifications().length === 2);
    service.markRead('post-read-1');
    expect(service.unreadCount()).toBe(1);
    await vi.waitFor(() => expect(service.isReadPending('post-read-1')).toBe(false));
    service.markAllRead();
    expect(service.unreadCount()).toBe(0);
    await vi.waitFor(() => expect(api.markAllRead).toHaveBeenCalledOnce());
  });
});

describe('SSE parser helpers', () => {
  it('retains incomplete frames and joins multiline data fields', () => {
    const first = splitSseFrames('event: post\ndata: {"x":\n');
    expect(first.frames).toEqual([]);
    const second = splitSseFrames(`${first.remainder}data: 1}\n\n: heartbeat\n\n`);
    expect(second.frames).toHaveLength(2);
    expect(parseSseFrame(second.frames[0])).toEqual({ event: 'post', data: '{"x":\n1}' });
    expect(parseSseFrame(second.frames[1])).toBeNull();
  });
});
