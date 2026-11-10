import { Injectable, signal } from '@angular/core';

export type ToastKind = 'success' | 'error' | 'warning' | 'info' | 'loading';
export interface ToastAction { label: string; run: () => void; }
export interface AppToast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  persistent: boolean;
  action?: ToastAction;
}
export interface ShowToastOptions {
  kind: ToastKind;
  title: string;
  description?: string;
  durationMs?: number;
  persistent?: boolean;
  action?: ToastAction;
}

const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 4200, error: 6500, warning: 5500, info: 4500, loading: 0,
};

@Injectable({ providedIn: 'root' })
export class ToastService {
  private sequence = 0;
  private readonly toastState = signal<AppToast[]>([]);
  private readonly leavingState = signal<number[]>([]);
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly toasts = this.toastState.asReadonly();
  readonly leavingIds = this.leavingState.asReadonly();

  show(options: ShowToastOptions): number {
    const id = ++this.sequence;
    const persistent = options.persistent ?? options.kind === 'loading';
    const toast: AppToast = { id, kind: options.kind, title: options.title, description: options.description, persistent, action: options.action };
    const current = this.toastState();
    if (current.length >= 5) this.dismiss(current[0].id);
    this.toastState.update((items) => [...items.slice(-4), toast]);
    const duration = options.durationMs ?? DEFAULT_DURATION[options.kind];
    if (!persistent && duration > 0) this.timers.set(id, setTimeout(() => this.dismissAnimated(id), duration));
    return id;
  }

  isLeaving(id: number): boolean { return this.leavingState().includes(id); }

  dismissAnimated(id: number): void {
    if (!this.toastState().some((toast) => toast.id === id) || this.isLeaving(id)) return;
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.leavingState.update((ids) => [...ids, id]);
    this.timers.set(id, setTimeout(() => this.dismiss(id), 170));
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.leavingState.update((ids) => ids.filter((leavingId) => leavingId !== id));
    this.toastState.update((items) => items.filter((toast) => toast.id !== id));
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.toastState.set([]);
    this.leavingState.set([]);
  }
}
