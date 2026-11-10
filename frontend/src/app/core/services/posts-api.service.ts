import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { getApiBaseUrl } from '../config/api-url';
import { PostsQuery, PostsResponse } from '../models/post.model';

@Injectable({ providedIn: 'root' })
export class PostsApiService {
  private readonly http = inject(HttpClient);
  private readonly postsUrl = `${getApiBaseUrl(environment.apiBaseUrl).replace(/\/+$/, '')}/api/posts`;

  getPosts(query: PostsQuery = {}): Observable<PostsResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params = params.set(key, String(value));
    }
    return this.http.get<PostsResponse>(this.postsUrl, { params });
  }
}
