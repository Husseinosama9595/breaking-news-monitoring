import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authInterceptor } from '../../core/interceptors/auth.interceptor';
import { PostsPageComponent } from './posts-page.component';

const TOKEN_KEY = 'breaking-news-monitor.access-token';
const API_URL = 'http://localhost:3000/api/posts';
const post = {
  _id: 'post-1', username: 'wireDesk', author: { username: 'wireDesk', displayName: 'Wire Desk' },
  text: 'A verified test fixture from the isolated frontend test suite.', publishedAt: '2026-11-10T08:00:00.000Z',
  postUrl: 'https://x.com/wireDesk/status/123', category: 'World News', providerName: 'nitter', priority: 'HIGH',
  processingStatus: 'processed', notificationStatus: 'sent', telegramSent: true, createdAt: '2026-11-10T08:01:00.000Z',
};

describe('PostsPageComponent', () => {
  let fixture: ComponentFixture<PostsPageComponent>;
  let http: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    sessionStorage.setItem(TOKEN_KEY, 'posts-test-token');
    TestBed.configureTestingModule({
      imports: [PostsPageComponent],
      providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(PostsPageComponent);
    fixture.detectChanges();
  });

  afterEach(() => { http.verify(); sessionStorage.clear(); });

  it('keeps the loading state while the posts request is pending', () => {
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Loading collected posts');
    http.expectOne(`${API_URL}?page=1&limit=20`).flush({ posts: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    fixture.detectChanges();
  });

  it('loads real post fields and pagination from the authenticated API', () => {
    const request = http.expectOne(`${API_URL}?page=1&limit=20`);
    expect(request.request.headers.get('Authorization')).toBe('Bearer posts-test-token');
    request.flush({ posts: [post], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    expect(page.textContent).toContain('Wire Desk');
    expect(page.textContent).toContain('World News');
    expect(page.textContent).toContain('HIGH');
    expect(page.textContent).toContain('sent');
    const links = page.querySelectorAll('a[href="https://x.com/wireDesk/status/123"]') as NodeListOf<HTMLAnchorElement>;
    expect(links.length).toBe(2);
    const cardLink = page.querySelector('.post-card-hit-area') as HTMLAnchorElement;
    const footerLink = page.querySelector('.original-action') as HTMLAnchorElement;
    expect(cardLink.target).toBe('_blank');
    expect(cardLink.rel).toContain('noopener');
    expect(cardLink.rel).toContain('noreferrer');
    expect(cardLink.getAttribute('aria-label')).toBe('View original post from @wireDesk');
    expect(footerLink.href).toBe(cardLink.href);
    expect(footerLink.textContent).toContain('View original post');
    const cardClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    expect(cardLink.dispatchEvent(cardClick)).toBe(true);
    expect(cardClick.defaultPrevented).toBe(false);
    expect(page.textContent).toContain('Page 1 of 1');
  });

  it('expands long text and keeps the expand control from activating card navigation', () => {
    const longText = `Breaking update. ${'New details follow. '.repeat(40)}`;
    http.expectOne(`${API_URL}?page=1&limit=20`).flush({
      posts: [{ ...post, text: longText }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
    fixture.detectChanges();
    const card = fixture.nativeElement.querySelector('.post-card') as HTMLElement;
    const navigationEvents: Event[] = [];
    card.addEventListener('click', (event) => navigationEvents.push(event));
    const expand = card.querySelector('.expand-content') as HTMLButtonElement;

    expect(expand.textContent).toContain('Read full post');
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expand.click();
    fixture.detectChanges();

    expect(card.querySelector('.post-text')?.textContent).toBe(longText);
    expect(card.querySelector('.expand-content')?.textContent).toContain('Show less');
    expect(card.querySelector('.expand-content')?.getAttribute('aria-expanded')).toBe('true');
    expect(navigationEvents).toHaveLength(0);
  });

  it('handles missing post fields and unsafe or absent original URLs without broken links', () => {
    http.expectOne(`${API_URL}?page=1&limit=20`).flush({
      posts: [{
        ...post,
        username: null,
        author: null,
        text: null,
        publishedAt: 'invalid-date',
        postUrl: 'https://attacker.example/untrusted',
        category: null,
        providerName: null,
      }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
    fixture.detectChanges();

    const page = fixture.nativeElement as HTMLElement;
    const card = page.querySelector('.post-card') as HTMLElement;
    expect(card.textContent).toContain('Unknown account');
    expect(card.textContent).toContain('Username unavailable');
    expect(card.textContent).toContain('Publication date unavailable');
    expect(card.textContent).toContain('Post text unavailable.');
    expect(card.textContent).toContain('Original link unavailable');
    expect(card.querySelector('.post-card-hit-area')).toBeNull();
    expect(card.querySelector('.original-action')).toBeNull();
    expect(card.querySelectorAll('a[href]')).toHaveLength(0);
  });

  it('shows an empty response state', () => {
    http.expectOne(`${API_URL}?page=1&limit=20`).flush({ posts: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('No posts found');
  });

  it('applies supported filters to the posts request', () => {
    http.expectOne(`${API_URL}?page=1&limit=20`).flush({ posts: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    fixture.detectChanges();
    const username = fixture.nativeElement.querySelector('input[formControlName="username"]') as HTMLInputElement;
    username.value = 'wireDesk';
    username.dispatchEvent(new Event('input'));
    const category = fixture.nativeElement.querySelector('select[formControlName="category"]') as HTMLSelectElement;
    category.value = 'World News';
    category.dispatchEvent(new Event('change'));
    const status = fixture.nativeElement.querySelector('select[formControlName="notificationStatus"]') as HTMLSelectElement;
    status.value = 'sent';
    status.dispatchEvent(new Event('change'));
    (fixture.nativeElement.querySelector('.filter-submit') as HTMLButtonElement).click();
    fixture.detectChanges();
    const filtered = http.expectOne((request) => request.url === API_URL
      && request.params.get('page') === '1'
      && request.params.get('username') === 'wireDesk'
      && request.params.get('category') === 'World News'
      && request.params.get('notificationStatus') === 'sent');
    filtered.flush({ posts: [post], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Wire Desk');
  });

  it('shows an error and retries the same request', () => {
    http.expectOne(`${API_URL}?page=1&limit=20`).flush({ error: 'Post service unavailable' }, { status: 500, statusText: 'Internal Server Error' });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Post service unavailable');
    (fixture.nativeElement.querySelector('.retry-button') as HTMLButtonElement).click();
    fixture.detectChanges();
    http.expectOne(`${API_URL}?page=1&limit=20`).flush({ posts: [post], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Wire Desk');
  });

  it('requests the next page when pagination is used', () => {
    http.expectOne(`${API_URL}?page=1&limit=20`).flush({ posts: [post], pagination: { page: 1, limit: 20, total: 21, totalPages: 2 } });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.pagination-bar button:last-child') as HTMLButtonElement).click();
    fixture.detectChanges();
    const next = http.expectOne(`${API_URL}?page=2&limit=20`);
    next.flush({ posts: [post], pagination: { page: 2, limit: 20, total: 21, totalPages: 2 } });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Page 2 of 2');
  });
});
