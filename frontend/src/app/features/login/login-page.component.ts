import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { finalize } from 'rxjs';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';

@Component({
  standalone: true,
  selector: 'app-login-page',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './login-page.component.html',
  styleUrl: './login-page.component.scss',
})
export class LoginPageComponent {
  private readonly formBuilder = inject(NonNullableFormBuilder);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly form = this.formBuilder.group({
    username: ['', [Validators.required, Validators.maxLength(100)]],
    password: ['', [Validators.required, Validators.maxLength(256)]],
  });
  protected readonly passwordVisible = signal(false);
  protected readonly submitting = signal(false);
  protected readonly submitted = signal(false);
  protected readonly errorMessage = signal('');

  protected submit(): void {
    if (this.submitting()) return;
    this.submitted.set(true);
    this.errorMessage.set('');
    this.form.markAllAsTouched();
    if (this.form.invalid) return;

    this.submitting.set(true);
    this.auth.login(this.form.getRawValue()).pipe(
      finalize(() => this.submitting.set(false)),
    ).subscribe({
      next: () => { void this.router.navigateByUrl('/dashboard'); },
      error: (error: unknown) => this.errorMessage.set(this.getErrorMessage(error)),
    });
  }

  protected togglePasswordVisibility(): void {
    this.passwordVisible.update((visible) => !visible);
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 0) return 'Could not reach the backend. Check that the local API is running.';
      const backendMessage = error.error && typeof error.error === 'object'
        ? error.error['error']
        : null;
      if (typeof backendMessage === 'string') return backendMessage;
      return 'Sign-in failed. Check your username and password, then try again.';
    }
    if (error instanceof Error) return error.message;
    return 'Sign-in failed. Please try again.';
  }
}
