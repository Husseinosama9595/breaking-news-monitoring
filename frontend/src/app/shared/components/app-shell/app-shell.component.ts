import { ChangeDetectorRef, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, startWith } from 'rxjs';
import { AuthService } from '../../../core/auth/auth.service';
import { LiveNotificationsService } from '../../../core/services/live-notifications.service';
import { NotificationCenterComponent } from '../notification-center/notification-center.component';

@Component({
  standalone: true,
  selector: 'app-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, NotificationCenterComponent],
  templateUrl: './app-shell.component.html',
  styleUrl: './app-shell.component.scss',
})
export class AppShellComponent {
  protected readonly sidebarOpen = signal(false);
  protected readonly pageTitle = signal('Overview');
  protected readonly pageSection = signal('COMMAND CENTER');

  private readonly router = inject(Router);
  private readonly activatedRoute = inject(ActivatedRoute);
  protected readonly auth = inject(AuthService);
  private readonly liveNotifications = inject(LiveNotificationsService);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.liveNotifications.start();
    this.destroyRef.onDestroy(() => this.liveNotifications.stop());
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      startWith(null),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(() => this.updatePageContext());
  }

  protected closeSidebar(): void {
    this.sidebarOpen.set(false);
  }

  protected toggleSidebar(): void {
    this.sidebarOpen.update((open) => !open);
  }

  protected logout(): void {
    this.auth.logout();
  }

  private updatePageContext(): void {
    let route = this.activatedRoute;
    while (route.firstChild) route = route.firstChild;
    const data = route?.snapshot?.data ?? {};
    this.pageTitle.set(String(data['pageHeading'] ?? 'Overview'));
    this.pageSection.set(String(data['pageSection'] ?? 'COMMAND CENTER'));
    this.changeDetector.markForCheck();
  }
}
