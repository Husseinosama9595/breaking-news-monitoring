import { normalizeBackendApiBaseUrl, setRuntimeApiBaseUrl } from './app/core/config/api-url';
import { environment } from './environments/environment';

async function bootstrap(): Promise<void> {
  if (environment.production) {
    try {
      const response = await fetch('/runtime-config.json', { cache: 'no-store' });
      if (response.ok) {
        const configuration: unknown = await response.json();
        if (configuration && typeof configuration === 'object') {
          const apiBaseUrl = normalizeBackendApiBaseUrl((configuration as Record<string, unknown>)['apiBaseUrl']);
          if (apiBaseUrl !== null) setRuntimeApiBaseUrl(apiBaseUrl);
        }
      }
    } catch {
      // Empty production API origin uses same-origin /api routes; hosting can provide a runtime config file.
    }
  }

  const [{ bootstrapApplication }, { appConfig }, { App }] = await Promise.all([
    import('@angular/platform-browser'),
    import('./app/app.config'),
    import('./app/app'),
  ]);
  await bootstrapApplication(App, appConfig);
}

void bootstrap().catch((error: unknown) => console.error('Application startup failed.', error));
