import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { AccountsApiService } from '../../core/services/accounts-api.service';
import { MonitoredAccount } from '../../core/models/monitored-account.model';
import { MonitoredPost } from '../../core/models/post.model';
import { PostsApiService } from '../../core/services/posts-api.service';
import { Subject, catchError, forkJoin, map, of, switchMap } from 'rxjs';

type SearchResult =
  | { query: string; state: 'empty' }
  | { query: string; state: 'success'; accounts: MonitoredAccount[]; accountTotal: number; posts: MonitoredPost[]; postTotal: number }
  | { query: string; state: 'error'; error: unknown };

@Component({
  standalone: true,
  selector: 'app-global-search-page',
  imports: [DatePipe],
  templateUrl: './global-search-page.component.html',
  styleUrl: './global-search-page.component.scss',
})
export class GlobalSearchPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly accountsApi = inject(AccountsApiService);
  private readonly postsApi = inject(PostsApiService);
  private readonly searchRequests = new Subject<string>();

  protected readonly query = signal('');
  protected readonly accounts = signal<MonitoredAccount[]>([]);
  protected readonly accountTotal = signal(0);
  protected readonly posts = signal<MonitoredPost[]>([]);
  protected readonly postTotal = signal(0);
  protected readonly loading = signal(false);
  protected readonly errorMessage = signal('');

  ngOnInit(): void {
    this.searchRequests.pipe(
      switchMap((query) => {
        this.query.set(query);
        this.accounts.set([]);
        this.accountTotal.set(0);
        this.posts.set([]);
        this.postTotal.set(0);
        this.errorMessage.set('');
        if (!query) {
          this.loading.set(false);
          return of<SearchResult>({ query, state: 'empty' });
        }

        this.loading.set(true);
        return forkJoin({
          accountResponse: this.accountsApi.getAccounts({ search: query, page: 1, limit: 100 }),
          postResponse: this.postsApi.getPosts({ search: query, page: 1, limit: 100 }),
        }).pipe(
          map(({ accountResponse, postResponse }): SearchResult => ({
            query,
            state: 'success',
            accounts: accountResponse.accounts,
            accountTotal: accountResponse.pagination?.total ?? accountResponse.accounts.length,
            posts: postResponse.posts,
            postTotal: postResponse.pagination.total,
          })),
          catchError((error: unknown) => of<SearchResult>({ query, state: 'error', error })),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((result) => {
      if (result.query !== this.query()) return;
      this.loading.set(false);
      if (result.state === 'success') {
        this.accounts.set(result.accounts);
        this.accountTotal.set(result.accountTotal);
        this.posts.set(result.posts);
        this.postTotal.set(result.postTotal);
      } else if (result.state === 'error') {
        this.errorMessage.set(this.apiError(result.error));
      }
    });

    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.searchRequests.next((params.get('q') ?? '').trim());
    });
  }

  protected retry(): void {
    this.searchRequests.next(this.query());
  }

  protected accountProfileUrl(account: MonitoredAccount): string {
    return `https://x.com/${encodeURIComponent(account.username)}`;
  }

  protected originalPostUrl(post: MonitoredPost): string | null {
    const value = post.postUrl?.trim();
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password
        && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase()) ? value : null;
    } catch {
      return null;
    }
  }

  private apiError(error: unknown): string {
    if (error instanceof HttpErrorResponse && typeof error.error?.error === 'string') return error.error.error;
    return 'Could not search sources and posts. Check the API connection and retry.';
  }
}
