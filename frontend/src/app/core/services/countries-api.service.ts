import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { Observable, finalize, of, shareReplay, tap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { getApiBaseUrl } from '../config/api-url';
import { CountryCatalogResponse, CountryOverviewResponse } from '../models/country.model';

@Injectable({ providedIn: 'root' })
export class CountriesApiService {
  private readonly http = inject(HttpClient);
  private readonly countriesUrl = `${getApiBaseUrl(environment.apiBaseUrl).replace(/\/+$/, '')}/api/countries`;
  readonly overview = signal<CountryOverviewResponse | null>(null);
  private overviewRequest?: Observable<CountryOverviewResponse>;

  getOverview(): Observable<CountryOverviewResponse> {
    const cached = this.overview();
    if (cached) return of(cached);
    return this.overviewRequest ?? this.refreshOverview();
  }

  refreshOverview(): Observable<CountryOverviewResponse> {
    if (this.overviewRequest) return this.overviewRequest;
    const request = this.http.get<CountryOverviewResponse>(this.countriesUrl).pipe(
      tap((overview) => this.overview.set(overview)),
      finalize(() => { if (this.overviewRequest === request) this.overviewRequest = undefined; }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.overviewRequest = request;
    return request;
  }

  getCatalog(): Observable<CountryCatalogResponse> {
    return this.http.get<CountryCatalogResponse>(`${this.countriesUrl}/catalog`);
  }
}
