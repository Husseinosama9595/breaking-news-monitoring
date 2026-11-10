export type LiveEventsConnectionState = 'disconnected' | 'connecting' | 'connected';
export type DesktopNotificationPermission = NotificationPermission | 'unsupported';
export type NotificationSound = 'email' | 'classic' | 'digital' | 'double-tone';

export interface NotificationPreferences {
  soundEnabled: boolean;
  soundType: NotificationSound;
  soundVolume: number;
  desktopNotificationsEnabled: boolean;
}

/** Validated, in-memory dashboard notification created from an SSE post event. */
export interface LivePostNotification {
  eventId: string;
  notificationId: string;
  postId: string;
  username: string;
  displayName: string | null;
  textPreview: string;
  postUrl: string | null;
  publishedAt: string | null;
  detectedAt: string;
  readAt: string | null;
  category: string | null;
  monitoredAccountId?: string | null;
  countryCode?: string | null;
  countryName?: string | null;
  read: boolean;
}

export interface NotificationPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface NotificationHistoryResponse {
  notifications: LivePostNotification[];
  pagination: NotificationPagination;
  unreadCount: number;
  serverTime: string;
}

export interface NotificationResponse {
  notification: LivePostNotification;
}

export interface MarkAllNotificationsReadResponse {
  updatedCount: number;
  unreadCount: number;
}
