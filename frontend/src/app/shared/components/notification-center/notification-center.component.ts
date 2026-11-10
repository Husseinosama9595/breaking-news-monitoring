import { DatePipe } from '@angular/common';
import { Component, HostListener, inject, signal } from '@angular/core';
import { LiveNotificationsService } from '../../../core/services/live-notifications.service';
import { LivePostNotification, NotificationSound } from '../../../core/models/live-notification.model';
import { countryFlag } from '../../../core/utils/country-flag';

@Component({
  standalone: true,
  selector: 'app-notification-center',
  imports: [DatePipe],
  templateUrl: './notification-center.component.html',
  styleUrl: './notification-center.component.scss',
})
export class NotificationCenterComponent {
  protected readonly liveNotifications = inject(LiveNotificationsService);
  protected readonly panelOpen = signal(false);
  protected readonly previewMessage = signal('');
  protected readonly countryFlag = countryFlag;

  protected togglePanel(): void {
    this.liveNotifications.refreshDesktopPermission();
    this.panelOpen.update((open) => !open);
  }

  @HostListener('document:pointerdown')
  protected handleUserGesture(): void {
    this.liveNotifications.activateSoundFromUserGesture();
  }

  protected handleSoundChange(event: Event): void {
    const enabled = (event.target as HTMLInputElement).checked;
    this.liveNotifications.setSoundEnabled(enabled);
    this.previewMessage.set('');
  }

  protected handleSoundTypeChange(event: Event): void {
    this.liveNotifications.setSoundType((event.target as HTMLSelectElement).value as NotificationSound);
  }

  protected handleSoundVolumeChange(event: Event): void {
    this.liveNotifications.setSoundVolume(Number((event.target as HTMLInputElement).value));
  }

  protected async handleDesktopChange(event: Event): Promise<void> {
    const enabled = (event.target as HTMLInputElement).checked;
    await this.liveNotifications.setDesktopNotificationsEnabled(enabled);
  }

  protected async previewSound(): Promise<void> {
    const played = await this.liveNotifications.previewSound();
    const volume = this.liveNotifications.preferences().soundVolume;
    this.previewMessage.set(played
      ? 'Preview played.'
      : volume === 0
        ? 'Volume is 0%; raise it to hear the preview.'
        : 'Audio is unavailable, another tone is playing, or playback was blocked.');
  }

  protected desktopPermissionMessage(): string {
    switch (this.liveNotifications.desktopPermission()) {
      case 'granted': return 'Browser permission is allowed.';
      case 'denied': return 'Blocked by your browser. Allow notifications for this site in browser settings, then reopen this panel.';
      case 'unsupported': return 'Desktop notifications are not supported by this browser.';
      default: return this.liveNotifications.desktopPermissionPromptAttempted()
        ? 'No browser decision is saved. If you dismissed the prompt, review this site’s permission in browser settings.'
        : 'Permission is requested only when you enable desktop notifications.';
    }
  }

  protected closePanel(): void {
    this.panelOpen.set(false);
  }

  protected markRead(notification: LivePostNotification): void {
    this.liveNotifications.markRead(notification.postId);
  }

  protected handleNotificationOpen(notification: LivePostNotification): void {
    this.markRead(notification);
    this.closePanel();
  }

  protected connectionLabel(): string {
    switch (this.liveNotifications.connectionState()) {
      case 'connected': return 'Live connection active';
      case 'connecting': return 'Connecting to live updates';
      default: return 'Live updates unavailable; reconnecting';
    }
  }
}
