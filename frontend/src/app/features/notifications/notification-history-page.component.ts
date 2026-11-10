import { DatePipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { LivePostNotification } from '../../core/models/live-notification.model';
import { LiveNotificationsService, safeOriginalPostUrl } from '../../core/services/live-notifications.service';

@Component({
  standalone: true,
  selector: 'app-notification-history-page',
  imports: [DatePipe],
  templateUrl: './notification-history-page.component.html',
  styleUrl: './notification-history-page.component.scss',
})
export class NotificationHistoryPageComponent {
  protected readonly liveNotifications = inject(LiveNotificationsService);
  protected readonly safeOriginalPostUrl = safeOriginalPostUrl;

  protected markRead(notification: LivePostNotification): void {
    this.liveNotifications.markRead(notification.notificationId);
  }

  protected markAllRead(): void {
    this.liveNotifications.markAllRead();
  }

  protected loadOlder(): void {
    void this.liveNotifications.loadOlderNotifications();
  }

  protected retry(): void {
    void this.liveNotifications.retryHistoryLoad();
  }
}
