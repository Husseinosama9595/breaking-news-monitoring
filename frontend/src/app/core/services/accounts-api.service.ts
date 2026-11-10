import { HttpClient } from '@angular/common/http';
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

@Injectable({ providedIn: 'root' })
export class AccountsApiService {
  private readonly http = inject(HttpClient);
  private readonly accountsUrl = `${getApiBaseUrl(environment.apiBaseUrl).replace(/\/+$/, '')}/api/accounts`;

  getAccounts(): Observable<MonitoredAccountsResponse> {
    return this.http.get<MonitoredAccountsResponse>(this.accountsUrl);
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
