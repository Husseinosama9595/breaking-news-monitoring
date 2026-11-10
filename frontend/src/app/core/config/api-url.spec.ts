import { afterEach, describe, expect, it } from 'vitest';
import { getApiBaseUrl, normalizeBackendApiBaseUrl, setRuntimeApiBaseUrl } from './api-url';

describe('runtime API URL configuration', () => {
  afterEach(() => setRuntimeApiBaseUrl(null));

  it('uses same-origin routing when the runtime URL is blank and accepts an HTTPS backend origin', () => {
    expect(normalizeBackendApiBaseUrl('', 'https://dashboard.example/')).toBe('');
    expect(normalizeBackendApiBaseUrl('https://api.example/', 'https://dashboard.example/')).toBe('https://api.example');
  });

  it('rejects insecure remote origins, credentials, query strings, and malformed URLs on HTTPS pages', () => {
    expect(normalizeBackendApiBaseUrl('http://api.example', 'https://dashboard.example/')).toBeNull();
    expect(normalizeBackendApiBaseUrl('https://user:secret@api.example', 'https://dashboard.example/')).toBeNull();
    expect(normalizeBackendApiBaseUrl('https://api.example?key=hidden', 'https://dashboard.example/')).toBeNull();
    expect(normalizeBackendApiBaseUrl('not a url', 'https://dashboard.example/')).toBeNull();
  });

  it('keeps local HTTP development APIs usable and prefers configured runtime URLs', () => {
    expect(normalizeBackendApiBaseUrl('http://localhost:3000', 'http://localhost:4200/')).toBe('http://localhost:3000');
    setRuntimeApiBaseUrl('https://api.example');
    expect(getApiBaseUrl('http://localhost:3000')).toBe('https://api.example');
  });
});
