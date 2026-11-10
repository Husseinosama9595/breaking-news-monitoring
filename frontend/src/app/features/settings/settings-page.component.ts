import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LiveNotificationsService } from '../../core/services/live-notifications.service';
import { NotificationSound } from '../../core/models/live-notification.model';

@Component({
  standalone: true,
  selector: 'app-settings-page',
  imports: [RouterLink],
  templateUrl: './settings-page.component.html',
  styleUrl: './settings-page.component.scss',
})
export class SettingsPageComponent {
  protected readonly liveNotifications = inject(LiveNotificationsService);
  protected readonly previewMessage = signal('');

  protected handleSoundChange(event: Event): void {
    this.liveNotifications.setSoundEnabled((event.target as HTMLInputElement).checked);
    this.previewMessage.set('');
  }

  protected handleSoundTypeChange(event: Event): void {
    this.liveNotifications.setSoundType((event.target as HTMLSelectElement).value as NotificationSound);
  }

  protected handleVolumeChange(event: Event): void {
    this.liveNotifications.setSoundVolume(Number((event.target as HTMLInputElement).value));
  }

  protected async previewSound(): Promise<void> {
    const played = await this.liveNotifications.previewSound();
    const volume = this.liveNotifications.preferences().soundVolume;
    this.previewMessage.set(played
      ? 'Preview played.'
      : volume === 0
        ? 'Volume is 0%; raise it to hear the preview.'
        : 'Audio is unavailable or playback was blocked.');
  }

  protected async handleDesktopChange(event: Event): Promise<void> {
    await this.liveNotifications.setDesktopNotificationsEnabled((event.target as HTMLInputElement).checked);
  }

  protected permissionMessage(): string {
    switch (this.liveNotifications.desktopPermission()) {
      case 'granted': return 'Browser permission is allowed.';
      case 'denied': return 'Permission is blocked by the browser. Change this site’s permission in browser settings.';
      case 'unsupported': return 'Desktop notifications are not supported by this browser.';
      default: return this.liveNotifications.desktopPermissionPromptAttempted()
        ? 'No browser decision is saved. Review this site’s permission in browser settings if the prompt was dismissed.'
        : 'Permission is requested only when desktop notifications are enabled.';
    }
  }
}
