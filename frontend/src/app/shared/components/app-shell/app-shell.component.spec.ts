import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../../core/auth/auth.service';
import { CountriesApiService } from '../../../core/services/countries-api.service';
import { LiveNotificationsService } from '../../../core/services/live-notifications.service';
import { ThemeService } from '../../../core/services/theme.service';
import { NotificationCenterComponent } from '../notification-center/notification-center.component';
import { ToastViewportComponent } from '../toast-viewport/toast-viewport.component';
import { AppShellComponent } from './app-shell.component';

@Component({ standalone: true, selector: 'app-notification-center', template: '' })
class NotificationCenterStub {}

@Component({ standalone: true, selector: 'app-toast-viewport', template: '' })
class ToastViewportStub {}

@Component({ standalone: true, template: '' })
class RoutePageStub {}

describe('AppShellComponent global search', () => {
  let fixture: ComponentFixture<AppShellComponent>;
  let router: Router;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      imports: [AppShellComponent],
      providers: [
        provideRouter([
          { path: 'accounts', component: RoutePageStub },
          { path: 'countries/:countryCode', component: RoutePageStub },
        ]),
        { provide: AuthService, useValue: { logout: vi.fn() } },
        { provide: ThemeService, useValue: { theme: signal('light').asReadonly(), toggle: vi.fn() } },
        { provide: LiveNotificationsService, useValue: { connectionState: signal('connected').asReadonly(), start: vi.fn(), stop: vi.fn() } },
        { provide: CountriesApiService, useValue: { overview: signal({ countries: [], unassigned: null }).asReadonly(), getOverview: () => of({ countries: [], unassigned: null }) } },
      ],
    });
    TestBed.overrideComponent(AppShellComponent, {
      remove: { imports: [NotificationCenterComponent, ToastViewportComponent] },
      add: { imports: [NotificationCenterStub, ToastViewportStub] },
    });
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(AppShellComponent);
    router = TestBed.inject(Router);
    fixture.detectChanges();
  });

  afterEach(() => TestBed.resetTestingModule());

  function searchInput(): HTMLInputElement {
    return (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('.global-search input')!;
  }

  function typeQuery(value: string): HTMLFormElement {
    const input = searchInput();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    return (fixture.nativeElement as HTMLElement).querySelector<HTMLFormElement>('.global-search')!;
  }

  it('accepts typed input and submits on Enter with a trimmed query parameter', async () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const form = typeQuery('  Elon  ');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledWith(['/search'], { queryParams: { q: 'Elon' } });
  });

  it('submits from the search button when used on different pages', async () => {
    const navigateByUrl = await router.navigateByUrl('/countries/US');
    expect(navigateByUrl).toBe(true);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    typeQuery('earthquake');
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.global-search button')!.click();
    expect(navigate).toHaveBeenCalledWith(['/search'], { queryParams: { q: 'earthquake' } });
  });

  it('does not navigate for an empty or whitespace-only query', () => {
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    const form = typeQuery('   ');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps the existing dashboard, account, country, post, notification, and settings navigation available', () => {
    const sidebar = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('.sidebar')!;
    const paths = Array.from(sidebar.querySelectorAll<HTMLAnchorElement>('a[routerlink]'), (link) => link.getAttribute('href'));

    expect(sidebar.querySelector('.sidebar-content')).not.toBeNull();
    expect(paths).toContain('/dashboard');
    expect(paths).toContain('/accounts');
    expect(paths).toContain('/posts');
    expect(paths).toContain('/notifications');
    expect(paths).toContain('/settings');
    expect(sidebar.querySelector('.country-nav-toggle')).not.toBeNull();
  });

  it('keeps sign out available and invokes the existing logout behavior', () => {
    const logoutButton = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.logout-button[aria-label="Sign out"]')!;
    expect(logoutButton).toBeTruthy();
    logoutButton.click();
    expect(TestBed.inject(AuthService).logout).toHaveBeenCalledOnce();
  });

  it('preserves collapsed and mobile sidebar toggling while keeping bottom navigation mounted', () => {
    const root = fixture.nativeElement as HTMLElement;
    const sidebar = root.querySelector<HTMLElement>('.sidebar')!;

    root.querySelector<HTMLButtonElement>('.collapse-toggle')!.click();
    fixture.detectChanges();
    expect(sidebar.classList).toContain('collapsed');
    expect(sidebar.querySelector('a[title="Settings"]')).not.toBeNull();
    expect(sidebar.querySelector('.logout-button')).not.toBeNull();

    root.querySelector<HTMLButtonElement>('.menu-toggle')!.click();
    fixture.detectChanges();
    expect(sidebar.classList).toContain('open');
    expect(root.querySelector('.mobile-scrim')?.classList).toContain('visible');
    root.querySelector<HTMLButtonElement>('.mobile-scrim')!.click();
    fixture.detectChanges();
    expect(sidebar.classList).not.toContain('open');
  });

  it('keeps compact mobile branding, menu access, global search, and notification host in the shared header', () => {
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.mobile-brand-mark[routerlink="/dashboard"]')).not.toBeNull();
    expect(root.querySelector('.menu-toggle[aria-label="Toggle navigation"]')).not.toBeNull();
    expect(root.querySelector('.global-search input')).not.toBeNull();
    expect(root.querySelector('app-notification-center')).not.toBeNull();
  });
});
