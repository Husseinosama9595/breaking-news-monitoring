import { Component, inject } from '@angular/core';
import { AppToast, ToastService } from '../../../core/services/toast.service';

@Component({
  standalone: true,
  selector: 'app-toast-viewport',
  templateUrl: './toast-viewport.component.html',
  styleUrl: './toast-viewport.component.scss',
})
export class ToastViewportComponent {
  protected readonly toastService = inject(ToastService);

  protected iconFor(toast: AppToast): string {
    switch (toast.kind) {
      case 'success': return 'bi-check-circle-fill';
      case 'error': return 'bi-exclamation-octagon-fill';
      case 'warning': return 'bi-exclamation-triangle-fill';
      case 'loading': return 'bi-arrow-repeat';
      default: return 'bi-info-circle-fill';
    }
  }

  protected runAction(toast: AppToast): void {
    toast.action?.run();
    this.toastService.dismissAnimated(toast.id);
  }
}
