export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface SessionResponse {
  authenticated: boolean;
}

export type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated';
