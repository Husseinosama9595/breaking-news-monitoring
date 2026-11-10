import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastService } from './toast.service';

describe('ToastService', () => {
  afterEach(() => { vi.useRealTimers(); TestBed.resetTestingModule(); });

  it('supports all toast kinds and keeps loading notifications until dismissed', () => {
    const service = TestBed.inject(ToastService);
    const id = service.show({ kind: 'loading', title: 'Saving', description: 'Updating monitored source.' });
    service.show({ kind: 'success', title: 'Saved' });
    service.show({ kind: 'error', title: 'Failed', persistent: true });
    service.show({ kind: 'warning', title: 'Warning' });
    service.show({ kind: 'info', title: 'Info' });
    expect(service.toasts().map((toast) => toast.kind)).toEqual(['loading', 'success', 'error', 'warning', 'info']);
    expect(service.toasts()[0].persistent).toBe(true);
    service.dismiss(id);
    expect(service.toasts().some((toast) => toast.id === id)).toBe(false);
  });

  it('expires transient toasts, supports actions, and clears timers', () => {
    vi.useFakeTimers();
    const service = TestBed.inject(ToastService);
    const run = vi.fn();
    const id = service.show({ kind: 'info', title: 'Retry available', durationMs: 100, action: { label: 'Retry', run } });
    service.toasts()[0].action?.run();
    expect(run).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(270);
    expect(service.toasts().some((toast) => toast.id === id)).toBe(false);
    service.show({ kind: 'success', title: 'Done' });
    service.clear();
    expect(service.toasts()).toEqual([]);
  });
});
