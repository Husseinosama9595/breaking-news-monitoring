import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { getApiBaseUrl } from '../config/api-url';
import {
  CreateMonitoredAccountRequest,
  MonitoredAccountResponse,
  MonitoredAccountsResponse,
  UpdateMonitoredAccountRequest,
} from '../models/monitored-account.model';

export interface AccountsQuery {
  country?: string;
  search?: string;
  status?: 'enabled' | 'disabled' | 'error';
  page?: number;
  limit?: number;
}

@Injectable({ providedIn: 'root' })
export class AccountsApiService {
  private readonly http = inject(HttpClient);
  private readonly accountsUrl = `${getApiBaseUrl(environment.apiBaseUrl).replace(/\/+$/, '')}/api/accounts`;

  getAccounts(query: AccountsQuery = {}): Observable<MonitoredAccountsResponse> {
    let params = new HttpParams();
    if (query.country) params = params.set('country', query.country);
    if (query.search) params = params.set('search', query.search);
    if (query.status) params = params.set('status', query.status);
    if (query.page !== undefined) params = params.set('page', String(query.page));
    if (query.limit !== undefined) params = params.set('limit', String(query.limit));
    return this.http.get<MonitoredAccountsResponse>(this.accountsUrl, { params });
  }

  getAccount(id: string): Observable<MonitoredAccountResponse> {
    return this.http.get<MonitoredAccountResponse>(`${this.accountsUrl}/${encodeURIComponent(id)}`);
  }

  createAccount(request: CreateMonitoredAccountRequest): Observable<MonitoredAccountResponse> {
    return this.http.post<MonitoredAccountResponse>(this.accountsUrl, request);
  }

  updateAccount(id: string, request: UpdateMonitoredAccountRequest): Observable<MonitoredAccountResponse> {
    return this.http.patch<MonitoredAccountResponse>(`${this.accountsUrl}/${encodeURIComponent(id)}`, request);
  }

  setAccountEnabled(id: string, enabled: boolean): Observable<MonitoredAccountResponse> {
    const action = enabled ? 'enable' : 'disable';
    return this.http.patch<MonitoredAccountResponse>(`${this.accountsUrl}/${encodeURIComponent(id)}/${action}`, {});
  }
}
