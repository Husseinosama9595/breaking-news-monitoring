import { Routes } from '@angular/router';
import { authGuard, loginGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/login/login-page.component').then((module) => module.LoginPageComponent),
    canActivate: [loginGuard],
    title: 'Sign in | Breaking News Monitor',
  },
  {
    path: '',
    loadComponent: () => import('./shared/components/app-shell/app-shell.component').then((module) => module.AppShellComponent),
    canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        loadComponent: () => import('./features/dashboard/dashboard-page.component').then((module) => module.DashboardPageComponent),
        title: 'Overview | Breaking News Monitor',
        data: { pageHeading: 'Overview', pageSection: 'COMMAND CENTER' },
      },
      {
        path: 'accounts',
        loadComponent: () => import('./features/accounts/accounts-page.component').then((module) => module.AccountsPageComponent),
        title: 'Monitored Accounts | Breaking News Monitor',
        data: { pageHeading: 'Monitored Accounts', pageSection: 'SOURCES' },
      },
      {
        path: 'countries/:countryCode',
        loadComponent: () => import('./features/countries/country-feed-page.component').then((module) => module.CountryFeedPageComponent),
        data: { pageHeading: 'Country Feed', pageSection: 'COUNTRY MONITORING' },
      },
      {
        path: 'posts',
        loadComponent: () => import('./features/posts/posts-page.component').then((module) => module.PostsPageComponent),
        title: 'Live Feed | Breaking News Monitor',
        data: { pageHeading: 'Live Feed', pageSection: 'INTELLIGENCE FEED' },
      },
      {
        path: 'notifications',
        loadComponent: () => import('./features/notifications/notification-history-page.component').then((module) => module.NotificationHistoryPageComponent),
        title: 'Notification History | Breaking News Monitor',
        data: { pageHeading: 'Notification History', pageSection: 'DELIVERY' },
      },
      {
        path: 'settings',
        loadComponent: () => import('./features/settings/settings-page.component').then((module) => module.SettingsPageComponent),
        title: 'Settings | Breaking News Monitor',
        data: { pageHeading: 'Settings', pageSection: 'PREFERENCES' },
      },
    ],
  },
  { path: '**', redirectTo: 'dashboard' },
];
