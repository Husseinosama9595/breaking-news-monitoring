import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { getApiBaseUrl } from '../config/api-url';
import {
  MarkAllNotificationsReadResponse,
  NotificationHistoryResponse,
  NotificationResponse,
} from '../models/live-notification.model';

export interface NotificationHistoryQuery {
  page?: number;
  limit?: number;
  since?: string;
}

@Injectable({ providedIn: 'root' })
export class NotificationsApiService {
  private readonly http = inject(HttpClient);
  private readonly notificationsUrl = `${getApiBaseUrl(environment.apiBaseUrl).replace(/\/+$/, '')}/api/notifications`;

  getNotifications(query: NotificationHistoryQuery = {}): Observable<NotificationHistoryResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params = params.set(key, String(value));
    }
    return this.http.get<NotificationHistoryResponse>(this.notificationsUrl, { params });
  }

  getUnreadCount(): Observable<{ unreadCount: number }> {
    return this.http.get<{ unreadCount: number }>(`${this.notificationsUrl}/unread-count`);
  }

  markRead(notificationId: string): Observable<NotificationResponse> {
    return this.http.patch<NotificationResponse>(`${this.notificationsUrl}/${encodeURIComponent(notificationId)}/read`, {});
  }

  markAllRead(): Observable<MarkAllNotificationsReadResponse> {
    return this.http.patch<MarkAllNotificationsReadResponse>(`${this.notificationsUrl}/read-all`, {});
  }
}
