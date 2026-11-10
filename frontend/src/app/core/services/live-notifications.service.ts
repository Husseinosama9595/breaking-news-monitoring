import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { NotificationsApiService } from './notifications-api.service';
import {
  DesktopNotificationPermission,
  LiveEventsConnectionState,
  LivePostNotification,
  NotificationSound,
  NotificationPreferences,
} from '../models/live-notification.model';
import { environment } from '../../../environments/environment';
import { getApiBaseUrl } from '../config/api-url';

const MAX_VISIBLE_TOASTS = 3;
const TOAST_DURATION_MS = 8_000;
const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const PREFERENCES_STORAGE_KEY = 'breaking-news-monitor.notification-preferences';
const PERMISSION_PROMPT_STORAGE_KEY = 'breaking-news-monitor.desktop-permission-prompted';
const DESKTOP_NOTIFICATION_DURATION_MS = 8_000;
const SOUND_COOLDOWN_MS = 800;

const DEFAULT_PREFERENCES: NotificationPreferences = {
  soundEnabled: false,
  soundType: 'classic',
  soundVolume: 65,
  desktopNotificationsEnabled: false,
};
const INITIAL_HISTORY_LIMIT = 50;
const RECOVERY_PAGE_LIMIT = 100;
const NOTIFICATION_SOUNDS: NotificationSound[] = ['email', 'classic', 'digital', 'double-tone'];
const SOUND_PATTERNS: Record<NotificationSound, Array<{ frequency: number; offset: number; duration: number; level: number; waveform: OscillatorType }>> = {
  email: [
    { frequency: 880, offset: 0, duration: 0.16, level: 0.72, waveform: 'sine' },
    { frequency: 1174.66, offset: 0.13, duration: 0.25, level: 0.78, waveform: 'sine' },
  ],
  classic: [
    { frequency: 783.99, offset: 0, duration: 0.3, level: 0.58, waveform: 'triangle' },
    { frequency: 987.77, offset: 0.12, duration: 0.37, level: 0.7, waveform: 'sine' },
    { frequency: 1174.66, offset: 0.24, duration: 0.48, level: 0.62, waveform: 'sine' },
  ],
  digital: [
    { frequency: 1046.5, offset: 0, duration: 0.09, level: 0.75, waveform: 'sine' },
    { frequency: 1567.98, offset: 0.1, duration: 0.1, level: 0.66, waveform: 'triangle' },
    { frequency: 1318.51, offset: 0.22, duration: 0.18, level: 0.62, waveform: 'sine' },
  ],
  'double-tone': [
    { frequency: 587.33, offset: 0, duration: 0.25, level: 0.58, waveform: 'sine' },
    { frequency: 783.99, offset: 0.18, duration: 0.34, level: 0.62, waveform: 'sine' },
  ],
};

interface ParsedSseEvent {
  event: string;
  data: string;
}

/** Split only complete SSE frames, retaining an incomplete frame across fetch chunks. */
export function splitSseFrames(value: string): { frames: string[]; remainder: string } {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const pieces = normalized.split('\n\n');
  return { frames: pieces.slice(0, -1), remainder: pieces.at(-1) ?? '' };
}

/** Parse an SSE frame without evaluating or interpreting its data as markup. */
export function parseSseFrame(frame: string): ParsedSseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function validDate(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function readPreferences(): NotificationPreferences {
  try {
    const stored = globalThis.localStorage?.getItem(PREFERENCES_STORAGE_KEY);
    if (!stored) return { ...DEFAULT_PREFERENCES };
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFERENCES };
    const values = parsed as Record<string, unknown>;
    return {
      soundEnabled: values['soundEnabled'] === true,
      desktopNotificationsEnabled: values['desktopNotificationsEnabled'] === true,
      soundType: NOTIFICATION_SOUNDS.includes(values['soundType'] as NotificationSound)
        ? values['soundType'] as NotificationSound
        : DEFAULT_PREFERENCES.soundType,
      soundVolume: typeof values['soundVolume'] === 'number' && Number.isFinite(values['soundVolume'])
        ? Math.max(0, Math.min(100, Math.round(values['soundVolume'])))
        : DEFAULT_PREFERENCES.soundVolume,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function readPermissionPromptAttempted(): boolean {
  try { return globalThis.localStorage?.getItem(PERMISSION_PROMPT_STORAGE_KEY) === 'true'; }
  catch { return false; }
}

export function safeOriginalPostUrl(value: unknown): string | null {
  const url = safeHttpsUrl(value);
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host) ? url : null;
  } catch {
    return null;
  }
}

function normalizeNotification(value: unknown): LivePostNotification | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Record<string, unknown>;
  const postId = typeof event['postId'] === 'string' ? event['postId'].trim() : '';
  const username = typeof event['username'] === 'string' ? event['username'].trim().replace(/^@/, '') : '';
  const textPreview = typeof event['textPreview'] === 'string' ? event['textPreview'].trim() : '';
  const detectedAt = validDate(event['detectedAt']);
  if (!postId || !username || !textPreview || !detectedAt) return null;
  const notificationId = typeof event['notificationId'] === 'string' && event['notificationId'].trim()
    ? event['notificationId'].trim()
    : typeof event['eventId'] === 'string' && event['eventId'].trim() ? event['eventId'].trim() : postId;
  const eventId = typeof event['eventId'] === 'string' && event['eventId'].trim() ? event['eventId'].trim() : notificationId;
  const displayName = typeof event['displayName'] === 'string' && event['displayName'].trim()
    ? event['displayName'].trim().slice(0, 120)
    : null;
  const category = typeof event['category'] === 'string' && event['category'].trim()
    ? event['category'].trim().slice(0, 100)
    : null;
  return {
    eventId: eventId.slice(0, 128),
    notificationId: notificationId.slice(0, 128),
    postId: postId.slice(0, 128),
    username: username.slice(0, 100),
    displayName,
    textPreview: textPreview.slice(0, 500),
    postUrl: safeOriginalPostUrl(event['postUrl']),
    publishedAt: validDate(event['publishedAt']),
    detectedAt,
    readAt: validDate(event['readAt']),
    category,
    read: event['read'] === true || validDate(event['readAt']) !== null,
  };
}

@Injectable({ providedIn: 'root' })
export class LiveNotificationsService {
  private readonly auth = inject(AuthService);
  private readonly notificationsApi = inject(NotificationsApiService);
  private readonly streamUrl = `${getApiBaseUrl(environment.apiBaseUrl).replace(/\/+$/, '')}/api/events/stream`;
  private readonly notificationState = signal<LivePostNotification[]>([]);
  private readonly unreadCountState = signal(0);
  private readonly historyLoadingState = signal(false);
  private readonly historyErrorState = signal('');
  private readonly historyActionErrorState = signal('');
  private readonly historyPageState = signal(1);
  private readonly historyHasMoreState = signal(false);
  private readonly historyTotalState = signal(0);
  private readonly pendingReadState = signal<string[]>([]);
  private readonly markAllPendingState = signal(false);
  private readonly toastIdState = signal<string[]>([]);
  private readonly connectionStateState = signal<LiveEventsConnectionState>('disconnected');
  private readonly preferencesState = signal<NotificationPreferences>(readPreferences());
  private readonly desktopPermissionState = signal<DesktopNotificationPermission>(this.readDesktopPermission());
  private readonly desktopPermissionPromptAttemptedState = signal(readPermissionPromptAttempted());
  private readonly seenPostIds = new Set<string>();
  private readonly toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly desktopNotifications = new Map<string, Notification>();
  private readonly desktopNotificationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly bufferedEvents: LivePostNotification[] = [];
  private audioContext: AudioContext | null = null;
  private soundUnlocked = false;
  private soundInProgress = false;
  private lastSoundAt = 0;
  private running = false;
  private controller: AbortController | null = null;
  private historyInitialized = false;
  private synchronizing = false;
  private lastConnectionAt: string | null = null;

  readonly notifications = this.notificationState.asReadonly();
  readonly toastIds = this.toastIdState.asReadonly();
  readonly connectionState = this.connectionStateState.asReadonly();
  readonly preferences = this.preferencesState.asReadonly();
  readonly desktopPermission = this.desktopPermissionState.asReadonly();
  readonly desktopPermissionPromptAttempted = this.desktopPermissionPromptAttemptedState.asReadonly();
  readonly unreadCount = this.unreadCountState.asReadonly();
  readonly historyLoading = this.historyLoadingState.asReadonly();
  readonly historyError = this.historyErrorState.asReadonly();
  readonly historyActionError = this.historyActionErrorState.asReadonly();
  readonly historyPage = this.historyPageState.asReadonly();
  readonly historyHasMore = this.historyHasMoreState.asReadonly();
  readonly historyTotal = this.historyTotalState.asReadonly();
  readonly pendingReadIds = this.pendingReadState.asReadonly();
  readonly markAllPending = this.markAllPendingState.asReadonly();
  readonly toastNotifications = computed(() => {
    const ids = new Set(this.toastIdState());
    return this.notificationState().filter((notification) => ids.has(notification.postId));
  });

  /** Start one authenticated fetch-based SSE connection for the protected shell lifetime. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.runConnectionLoop();
  }

  /** Stop reconnects and abort the current fetch/stream. */
  stop(): void {
    this.running = false;
    this.controller?.abort();
    this.controller = null;
    this.connectionStateState.set('disconnected');
    this.closeDesktopNotifications();
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
    this.soundUnlocked = false;
    this.soundInProgress = false;
    this.lastSoundAt = 0;
  }

  setSoundEnabled(enabled: boolean): void {
    this.updatePreferences({ soundEnabled: enabled });
    if (enabled) void this.unlockAudio();
  }

  setSoundType(soundType: NotificationSound): void {
    if (NOTIFICATION_SOUNDS.includes(soundType)) this.updatePreferences({ soundType });
  }

  setSoundVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.updatePreferences({ soundVolume: Math.max(0, Math.min(100, Math.round(volume))) });
  }

  /** Called from a user gesture so saved sound preferences can unlock after a refresh. */
  activateSoundFromUserGesture(): void {
    if (this.preferencesState().soundEnabled) void this.unlockAudio();
  }

  /** Preview is an explicit user action and works even when event sounds are disabled. */
  async previewSound(): Promise<boolean> {
    if (!await this.unlockAudio()) return false;
    return this.playSound();
  }

  async setDesktopNotificationsEnabled(enabled: boolean): Promise<void> {
    this.updatePreferences({ desktopNotificationsEnabled: enabled });
    if (!enabled) {
      this.closeDesktopNotifications();
      return;
    }

    this.refreshDesktopPermission();
    if (this.desktopPermissionState() === 'default' && !this.desktopPermissionPromptAttemptedState()
      && typeof Notification !== 'undefined') {
      this.desktopPermissionPromptAttemptedState.set(true);
      try { globalThis.localStorage?.setItem(PERMISSION_PROMPT_STORAGE_KEY, 'true'); }
      catch { /* The in-memory guard still prevents repeated prompts this session. */ }
      try {
        this.desktopPermissionState.set(await Notification.requestPermission());
      } catch {
        this.refreshDesktopPermission();
      }
    }
  }

  refreshDesktopPermission(): void {
    this.desktopPermissionState.set(this.readDesktopPermission());
  }

  markRead(postId: string): void {
    if (this.markAllPendingState()) return;
    const target = this.notificationState().find((item) => item.notificationId === postId || item.postId === postId);
    if (!target || target.read || this.pendingReadState().includes(target.notificationId)) return;
    const readAt = new Date().toISOString();
    this.pendingReadState.update((ids) => [...ids, target.notificationId]);
    this.historyActionErrorState.set('');
    this.notificationState.update((items) => items.map((item) => item.notificationId === target.notificationId
      ? { ...item, read: true, readAt } : item));
    this.unreadCountState.update((count) => Math.max(0, count - 1));
    void firstValueFrom(this.notificationsApi.markRead(target.notificationId)).then((response) => {
      const saved = normalizeNotification(response.notification);
      if (saved) this.mergeNotifications([saved]);
    }).catch(() => {
      this.notificationState.update((items) => items.map((item) => item.notificationId === target.notificationId
        ? { ...item, read: false, readAt: null } : item));
      this.unreadCountState.update((count) => count + 1);
      this.historyActionErrorState.set('Could not save the read status. Your change was reverted; try again.');
    }).finally(() => {
      this.pendingReadState.update((ids) => ids.filter((id) => id !== target.notificationId));
    });
  }

  markAllRead(): void {
    if (this.markAllPendingState() || this.pendingReadState().length > 0 || this.unreadCountState() === 0) return;
    const previous = this.notificationState();
    const previousUnread = this.unreadCountState();
    const readAt = new Date().toISOString();
    this.markAllPendingState.set(true);
    this.historyActionErrorState.set('');
    this.notificationState.update((items) => items.map((item) => item.read ? item : { ...item, read: true, readAt }));
    this.unreadCountState.set(0);
    void firstValueFrom(this.notificationsApi.markAllRead()).then((response) => {
      this.unreadCountState.set(response.unreadCount);
    }).catch(() => {
      const priorById = new Map(previous.map((item) => [item.notificationId, item]));
      const current = this.notificationState();
      const newUnread = current.filter((item) => !priorById.has(item.notificationId) && !item.read).length;
      const restored = new Map(previous.map((item) => [item.notificationId, item]));
      for (const item of current) if (!restored.has(item.notificationId)) restored.set(item.notificationId, item);
      this.notificationState.set([...restored.values()].sort((left, right) =>
        Date.parse(right.detectedAt) - Date.parse(left.detectedAt) || right.notificationId.localeCompare(left.notificationId)));
      this.unreadCountState.set(previousUnread + newUnread);
      this.historyActionErrorState.set('Could not save read status for all notifications. Your changes were reverted; try again.');
    }).finally(() => this.markAllPendingState.set(false));
  }

  isReadPending(notificationId: string): boolean {
    return this.pendingReadState().includes(notificationId);
  }

  async loadOlderNotifications(): Promise<void> {
    if (this.historyLoadingState() || !this.historyHasMoreState()) return;
    const page = this.historyPageState() + 1;
    this.historyLoadingState.set(true);
    this.historyErrorState.set('');
    try {
      const response = await firstValueFrom(this.notificationsApi.getNotifications({ page, limit: INITIAL_HISTORY_LIMIT }));
      this.mergeNotifications(response.notifications.map(normalizeNotification).filter((item): item is LivePostNotification => item !== null));
      this.unreadCountState.set(response.unreadCount);
      this.historyPageState.set(page);
      this.historyHasMoreState.set(page < response.pagination.totalPages);
      this.historyTotalState.set(response.pagination.total);
    } catch {
      this.historyErrorState.set('Could not load older notifications. Check your connection and retry.');
    } finally {
      this.historyLoadingState.set(false);
    }
  }

  async retryHistoryLoad(): Promise<void> {
    const connectionAt = this.lastConnectionAt ?? new Date().toISOString();
    this.synchronizing = true;
    await this.synchronizeNotifications(connectionAt);
    this.synchronizing = false;
    this.flushBufferedEvents(connectionAt);
  }

  dismissToast(postId: string): void {
    const timer = this.toastTimers.get(postId);
    if (timer) clearTimeout(timer);
    this.toastTimers.delete(postId);
    this.toastIdState.update((ids) => ids.filter((id) => id !== postId));
  }

  private async runConnectionLoop(): Promise<void> {
    let retryAttempt = 0;
    while (this.running) {
      const controller = new AbortController();
      this.controller = controller;
      try {
        const token = this.auth.getAccessToken();
        if (!token) {
          this.running = false;
          this.controller = null;
          break;
        }
        this.connectionStateState.set('connecting');
        const response = await fetch(this.streamUrl, {
          method: 'GET',
          headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
          cache: 'no-store',
          credentials: 'omit',
          mode: 'cors',
          signal: controller.signal,
        });
        if (!this.running) break;
        if (response.status === 401) {
          this.running = false;
          this.controller = null;
          this.auth.handleUnauthorized();
          break;
        }
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
          throw new Error('SSE stream unavailable');
        }
        this.connectionStateState.set('connected');
        retryAttempt = 0;
        this.synchronizing = true;
        let resolveConnected!: (value: string | null) => void;
        const connected = new Promise<string | null>((resolve) => { resolveConnected = resolve; });
        const stream = this.readStream(response.body, resolveConnected);
        const connectedAt = await Promise.race([connected, stream.then(() => null)]);
        if (!connectedAt) throw new Error('SSE connection did not provide a connection frame');
        await this.synchronizeNotifications(connectedAt);
        this.synchronizing = false;
        this.flushBufferedEvents(connectedAt);
        await stream;
      } catch {
        if (!this.running) {
          this.controller = null;
          break;
        }
        this.connectionStateState.set('disconnected');
      }

      if (this.running) {
        this.connectionStateState.set('disconnected');
        const delayMs = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * (2 ** Math.min(retryAttempt, 6)));
        retryAttempt += 1;
        await this.delayOrAbort(delayMs, controller.signal);
      }
      if (this.controller === controller) this.controller = null;
    }
    this.connectionStateState.set('disconnected');
  }

  private async readStream(body: ReadableStream<Uint8Array>, onConnected: (connectedAt: string | null) => void): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (this.running) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const split = splitSseFrames(buffer);
        buffer = split.remainder;
        for (const frame of split.frames) this.handleFrame(frame, onConnected);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleFrame(frame: string, onConnected: (connectedAt: string | null) => void): void {
    const parsed = parseSseFrame(frame);
    if (!parsed) return;
    if (parsed.event === 'connected') {
      try {
        const payload: unknown = JSON.parse(parsed.data);
        const connectedAt = payload && typeof payload === 'object'
          ? validDate((payload as Record<string, unknown>)['connectedAt']) : null;
        onConnected(connectedAt);
      } catch { onConnected(null); }
      return;
    }
    if (parsed.event !== 'post') return;
    try {
      const notification = normalizeNotification(JSON.parse(parsed.data));
      if (!notification) return;
      if (this.synchronizing) this.bufferedEvents.push(notification);
      else this.addNotification(notification);
    } catch {
      // Ignore malformed or incomplete events; SSE availability is non-critical to the dashboard.
    }
  }

  private addNotification(notification: LivePostNotification): void {
    if (this.seenPostIds.has(notification.notificationId)) return;
    this.seenPostIds.add(notification.notificationId);
    this.mergeNotifications([notification]);
    if (!notification.read) this.unreadCountState.update((count) => count + 1);
    this.playSoundForNewPost();
    this.showDesktopNotification(notification);

    const ids = [...this.toastIdState(), notification.postId];
    const expiredIds = ids.slice(0, Math.max(0, ids.length - MAX_VISIBLE_TOASTS));
    for (const id of expiredIds) this.dismissToast(id);
    this.toastIdState.update((current) => [...current.filter((id) => id !== notification.postId), notification.postId]);
    const timer = setTimeout(() => this.dismissToast(notification.postId), TOAST_DURATION_MS);
    this.toastTimers.set(notification.postId, timer);
  }

  private mergeNotifications(incoming: LivePostNotification[]): void {
    const byId = new Map(this.notificationState().map((item) => [item.notificationId, item]));
    for (const item of incoming) {
      byId.set(item.notificationId, item);
      this.seenPostIds.add(item.notificationId);
    }
    this.notificationState.set([...byId.values()].sort((left, right) =>
      Date.parse(right.detectedAt) - Date.parse(left.detectedAt) || right.notificationId.localeCompare(left.notificationId)));
  }

  private async synchronizeNotifications(connectedAt: string): Promise<void> {
    const priorConnectionAt = this.lastConnectionAt;
    const initial = !this.historyInitialized;
    this.historyLoadingState.set(initial || this.notificationState().length === 0);
    this.historyErrorState.set('');
    try {
      const latest = await firstValueFrom(this.notificationsApi.getNotifications({ page: 1, limit: INITIAL_HISTORY_LIMIT }));
      const latestItems = latest.notifications.map(normalizeNotification).filter((item): item is LivePostNotification => item !== null);
      this.mergeNotifications(latestItems);
      this.unreadCountState.set(latest.unreadCount);
      const currentPage = this.historyPageState();
      this.historyHasMoreState.set(currentPage < latest.pagination.totalPages);
      this.historyTotalState.set(latest.pagination.total);

      if (priorConnectionAt) {
        let page = 1;
        let response = await firstValueFrom(this.notificationsApi.getNotifications({ page, limit: RECOVERY_PAGE_LIMIT, since: priorConnectionAt }));
        const recovered = [...response.notifications];
        while (page < response.pagination.totalPages) {
          page += 1;
          response = await firstValueFrom(this.notificationsApi.getNotifications({ page, limit: RECOVERY_PAGE_LIMIT, since: priorConnectionAt }));
          recovered.push(...response.notifications);
        }
        this.mergeNotifications(recovered.map(normalizeNotification).filter((item): item is LivePostNotification => item !== null));
        this.unreadCountState.set(response.unreadCount);
      }
      this.historyInitialized = true;
      this.lastConnectionAt = connectedAt;
    } catch {
      this.historyErrorState.set('Could not synchronize notification history. Live updates remain connected; history will retry after reconnection.');
    } finally {
      this.lastConnectionAt = connectedAt;
      this.historyLoadingState.set(false);
    }
  }

  private flushBufferedEvents(connectedAt: string): void {
    const events = this.bufferedEvents.splice(0);
    const boundary = Date.parse(connectedAt);
    for (const event of events) {
      if (this.seenPostIds.has(event.notificationId)) continue;
      if (Number.isFinite(boundary) && Date.parse(event.detectedAt) < boundary) continue;
      this.addNotification(event);
    }
  }

  private updatePreferences(patch: Partial<NotificationPreferences>): void {
    this.preferencesState.update((current) => ({ ...current, ...patch }));
    try {
      globalThis.localStorage?.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(this.preferencesState()));
    } catch {
      // Preferences remain available in memory if browser storage is disabled or full.
    }
  }

  private readDesktopPermission(): DesktopNotificationPermission {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  }

  private async unlockAudio(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    try {
      const browserWindow = window as Window & { webkitAudioContext?: typeof AudioContext };
      const AudioContextConstructor = window.AudioContext ?? browserWindow.webkitAudioContext;
      if (!AudioContextConstructor) return false;
      this.audioContext ??= new AudioContextConstructor();
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      this.soundUnlocked = this.audioContext.state === 'running';
      return this.soundUnlocked;
    } catch {
      this.soundUnlocked = false;
      return false;
    }
  }

  private playSoundForNewPost(): void {
    if (!this.preferencesState().soundEnabled || !this.soundUnlocked) return;
    this.playSound();
  }

  private playSound(): boolean {
    const context = this.audioContext;
    const now = Date.now();
    const preferences = this.preferencesState();
    if (!context || !this.soundUnlocked || this.soundInProgress || now - this.lastSoundAt < SOUND_COOLDOWN_MS
      || preferences.soundVolume <= 0) return false;
    const pattern = SOUND_PATTERNS[preferences.soundType];
    const masterAmplitude = 0.18 * (preferences.soundVolume / 100) ** 2;
    const oscillators: OscillatorNode[] = [];
    let remaining = pattern.length;
    try {
      const start = context.currentTime;
      this.soundInProgress = true;
      for (const note of pattern) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const noteStart = start + note.offset;
        const attack = Math.min(0.014, note.duration / 5);
        const peak = Math.max(0.0001, masterAmplitude * note.level);
        oscillator.type = note.waveform;
        oscillator.frequency.setValueAtTime(note.frequency, noteStart);
        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.exponentialRampToValueAtTime(peak, noteStart + attack);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.001), noteStart + note.duration);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
          remaining -= 1;
          if (remaining === 0) this.soundInProgress = false;
        };
        oscillators.push(oscillator);
        oscillator.start(noteStart);
        oscillator.stop(noteStart + note.duration + 0.01);
      }
      this.lastSoundAt = now;
      return true;
    } catch {
      for (const oscillator of oscillators) {
        try { oscillator.stop(); oscillator.disconnect(); } catch { /* Best-effort cleanup after a partial audio failure. */ }
      }
      this.soundInProgress = false;
      return false;
    }
  }

  private showDesktopNotification(notification: LivePostNotification): void {
    if (!this.preferencesState().desktopNotificationsEnabled || this.desktopPermissionState() !== 'granted'
      || typeof Notification === 'undefined') return;
    try {
      const desktopNotification = new Notification('New post detected', {
        body: `@${notification.username}: ${notification.textPreview.slice(0, 140)}`,
        tag: `post-${notification.postId}`,
        silent: true,
        ...(notification.publishedAt ? { timestamp: Date.parse(notification.publishedAt) } : {}),
        data: { postUrl: safeOriginalPostUrl(notification.postUrl) },
      });
      this.desktopNotifications.set(notification.postId, desktopNotification);
      this.desktopNotificationTimers.set(notification.postId, setTimeout(() => {
        desktopNotification.close();
        this.cleanupDesktopNotification(notification.postId);
      }, DESKTOP_NOTIFICATION_DURATION_MS));
      desktopNotification.onclick = () => {
        const postUrl = safeOriginalPostUrl(desktopNotification.data?.postUrl);
        try { window.focus(); } catch { /* The browser may disallow focusing a background tab. */ }
        if (postUrl) {
          try { window.open(postUrl, '_blank', 'noopener,noreferrer'); } catch { /* Pop-up restrictions are browser controlled. */ }
        }
        desktopNotification.close();
      };
      desktopNotification.onclose = () => this.cleanupDesktopNotification(notification.postId);
      desktopNotification.onerror = () => this.cleanupDesktopNotification(notification.postId);
    } catch {
      // Desktop notifications are optional; browser API failures must not affect the dashboard.
    }
  }

  private cleanupDesktopNotification(postId: string): void {
    const timer = this.desktopNotificationTimers.get(postId);
    if (timer) clearTimeout(timer);
    this.desktopNotificationTimers.delete(postId);
    this.desktopNotifications.delete(postId);
  }

  private closeDesktopNotifications(): void {
    for (const [postId, notification] of this.desktopNotifications) {
      try { notification.close(); } catch { /* Browser notification APIs can fail during teardown. */ }
      this.cleanupDesktopNotification(postId);
    }
  }

  private delayOrAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, milliseconds);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
  }
}
