let runtimeApiBaseUrl: string | null = null;

/** Validate and normalize a public runtime backend origin. Empty means same-origin API routing. */
export function normalizeBackendApiBaseUrl(value: unknown, pageUrl = window.location.href): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    const page = new URL(pageUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (page.protocol === 'https:' && url.protocol !== 'https:') return null;
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.origin !== page.origin) return null;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function setRuntimeApiBaseUrl(value: string | null): void {
  runtimeApiBaseUrl = value;
}

export function getApiBaseUrl(fallback: string): string {
  return runtimeApiBaseUrl ?? fallback;
}
