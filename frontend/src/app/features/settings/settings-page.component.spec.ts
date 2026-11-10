import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { LiveNotificationsService } from '../../core/services/live-notifications.service';
import { SettingsPageComponent } from './settings-page.component';

function makePreferences() {
  return signal({ soundEnabled: false, soundType: 'classic', soundVolume: 65, desktopNotificationsEnabled: false });
}

describe('SettingsPageComponent', () => {
  it('uses the existing notification service for sound, volume, preview and desktop preferences', async () => {
    const preferences = makePreferences();
    const permission = signal<NotificationPermission | 'unsupported'>('default');
    const permissionPromptAttempted = signal(false);
    const service = {
      preferences: preferences.asReadonly(),
      desktopPermission: permission.asReadonly(),
      desktopPermissionPromptAttempted: permissionPromptAttempted.asReadonly(),
      setSoundEnabled: vi.fn((value: boolean) => preferences.update((current) => ({ ...current, soundEnabled: value }))),
      setSoundType: vi.fn((value: string) => preferences.update((current) => ({ ...current, soundType: value }))),
      setSoundVolume: vi.fn((value: number) => preferences.update((current) => ({ ...current, soundVolume: value }))),
      previewSound: vi.fn(async () => true),
      setDesktopNotificationsEnabled: vi.fn(async (value: boolean) => preferences.update((current) => ({ ...current, desktopNotificationsEnabled: value }))),
    };
    await TestBed.configureTestingModule({
      imports: [SettingsPageComponent],
      providers: [provideRouter([]), { provide: LiveNotificationsService, useValue: service }],
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsPageComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    const soundToggle = host.querySelector('#settings-sound-toggle') as HTMLInputElement;
    soundToggle.checked = true;
    soundToggle.dispatchEvent(new Event('change'));
    expect(service.setSoundEnabled).toHaveBeenCalledWith(true);
    const soundSelect = host.querySelector('#settings-sound-type') as HTMLSelectElement;
    soundSelect.value = 'digital';
    soundSelect.dispatchEvent(new Event('change'));
    expect(service.setSoundType).toHaveBeenCalledWith('digital');
    const volume = host.querySelector('#settings-sound-volume') as HTMLInputElement;
    volume.value = '42';
    volume.dispatchEvent(new Event('input'));
    expect(service.setSoundVolume).toHaveBeenCalledWith(42);
    (host.querySelector('.preview-button') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(service.previewSound).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('Preview played.');

    const desktopToggle = host.querySelector('#settings-desktop-toggle') as HTMLInputElement;
    desktopToggle.checked = true;
    desktopToggle.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    expect(service.setDesktopNotificationsEnabled).toHaveBeenCalledWith(true);
    expect(host.textContent).toContain('Permission is requested only when desktop notifications are enabled');
    expect(host.querySelector('a[routerLink="/notifications"]')).not.toBeNull();
  });

  it('explains denied and unsupported browser permission states and disables unsupported controls', async () => {
    const permission = signal<NotificationPermission | 'unsupported'>('denied');
    const service = {
      preferences: makePreferences().asReadonly(),
      desktopPermission: permission.asReadonly(),
      desktopPermissionPromptAttempted: signal(true).asReadonly(),
      setSoundEnabled: vi.fn(),
      setSoundType: vi.fn(),
      setSoundVolume: vi.fn(),
      previewSound: vi.fn(async () => false),
      setDesktopNotificationsEnabled: vi.fn(),
    };
    await TestBed.configureTestingModule({
      imports: [SettingsPageComponent],
      providers: [provideRouter([]), { provide: LiveNotificationsService, useValue: service }],
    }).compileComponents();
    const fixture = TestBed.createComponent(SettingsPageComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Permission is blocked by the browser');

    permission.set('unsupported');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('not supported by this browser');
    expect((fixture.nativeElement.querySelector('#settings-desktop-toggle') as HTMLInputElement).disabled).toBe(true);

    (fixture.nativeElement.querySelector('.preview-button') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Audio is unavailable');
  });
});
