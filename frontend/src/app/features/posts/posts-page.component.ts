import { DatePipe, TitleCasePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { PostsApiService } from '../../core/services/posts-api.service';
import { MonitoredPost } from '../../core/models/post.model';
import { isValidApiTimestamp } from '../../core/utils/account-health';

const POST_PREVIEW_LENGTH = 420;

@Component({
  standalone: true,
  selector: 'app-posts-page',
  imports: [DatePipe, TitleCasePipe, ReactiveFormsModule],
  templateUrl: './posts-page.component.html',
  styleUrl: './posts-page.component.scss',
})
export class PostsPageComponent implements OnInit {
  private readonly postsApi = inject(PostsApiService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly formBuilder = inject(NonNullableFormBuilder);
  protected readonly filters = this.formBuilder.group({ username: [''], category: [''], notificationStatus: [''] });
  protected readonly categories = ['World News', 'Politics', 'Military & Security', 'Economy & Finance', 'Technology', 'Business', 'Emergencies', 'Other'];
  protected readonly statuses = ['pending', 'sending', 'sent', 'failed', 'skipped'];
  protected readonly posts = signal<MonitoredPost[]>([]);
  protected readonly page = signal(1);
  protected readonly total = signal(0);
  protected readonly totalPages = signal(0);
  protected readonly loading = signal(true);
  protected readonly loaded = signal(false);
  protected readonly errorMessage = signal('');
  protected readonly expandedPostIds = signal<ReadonlySet<string>>(new Set());
  private activeFilters = { username: '', category: '', notificationStatus: '' };

  ngOnInit(): void { this.loadPosts(); }

  protected applyFilters(): void {
    this.activeFilters = this.filters.getRawValue();
    this.page.set(1);
    this.loadPosts();
  }

  protected clearFilters(): void {
    this.filters.reset({ username: '', category: '', notificationStatus: '' });
    this.activeFilters = { username: '', category: '', notificationStatus: '' };
    this.page.set(1);
    this.loadPosts();
  }

  protected loadPosts(): void {
    this.loading.set(true);
    this.errorMessage.set('');
    this.loaded.set(false);
    this.expandedPostIds.set(new Set());
    this.postsApi.getPosts({ page: this.page(), limit: 20, ...this.activeFilters }).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (response) => {
        this.posts.set(response.posts);
        this.total.set(response.pagination.total);
        this.totalPages.set(response.pagination.totalPages);
        this.page.set(response.pagination.page);
        this.loaded.set(true);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        if (error instanceof HttpErrorResponse && error.error && typeof error.error === 'object' && typeof error.error['error'] === 'string') {
          this.errorMessage.set(error.error['error']);
        } else {
          this.errorMessage.set('Could not load posts. Check the API connection and retry.');
        }
      },
    });
  }

  protected changePage(nextPage: number): void {
    if (this.loading() || nextPage < 1 || nextPage > this.totalPages()) return;
    this.page.set(nextPage);
    this.loadPosts();
  }

  protected originalPostUrl(post: MonitoredPost): string | null {
    const value = post.postUrl?.trim();
    if (!value) return null;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const trustedXHost = ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host);
      return url.protocol === 'https:' && !url.username && !url.password && trustedXHost ? value : null;
    } catch {
      return null;
    }
  }

  protected cardLinkLabel(post: MonitoredPost): string {
    const username = post.username?.trim() || post.author?.username?.trim();
    return username ? `View original post from @${username}` : 'View original post';
  }

  protected authorName(post: MonitoredPost): string {
    return post.author?.displayName?.trim() || (post.username?.trim() ? `@${post.username.trim()}` : 'Unknown account');
  }

  protected usernameLabel(post: MonitoredPost): string {
    const username = post.username?.trim() || post.author?.username?.trim();
    return username ? `@${username}` : 'Username unavailable';
  }

  protected authorInitial(post: MonitoredPost): string | null {
    const name = post.author?.displayName?.trim() || post.username?.trim() || post.author?.username?.trim();
    return name ? name.slice(0, 1).toUpperCase() : null;
  }

  protected postText(post: MonitoredPost): string {
    return post.text?.trim() ? post.text : 'Post text unavailable.';
  }

  protected previewText(post: MonitoredPost): string {
    const text = this.postText(post);
    if (this.expandedPostIds().has(post._id) || text.length <= POST_PREVIEW_LENGTH) return text;
    return `${text.slice(0, POST_PREVIEW_LENGTH).trimEnd()}…`;
  }

  protected needsExpansion(post: MonitoredPost): boolean {
    return this.postText(post).length > POST_PREVIEW_LENGTH;
  }

  protected isExpanded(post: MonitoredPost): boolean {
    return this.expandedPostIds().has(post._id);
  }

  protected toggleExpanded(post: MonitoredPost, event: MouseEvent): void {
    event.stopPropagation();
    const expanded = new Set(this.expandedPostIds());
    if (expanded.has(post._id)) expanded.delete(post._id);
    else expanded.add(post._id);
    this.expandedPostIds.set(expanded);
  }

  protected hasValidTimestamp(value: string | null | undefined): boolean {
    return isValidApiTimestamp(value);
  }
}
