import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

@Component({
  standalone: true,
  selector: 'app-workspace-placeholder',
  template: `
    <div class="placeholder-page">
      <div class="eyebrow">{{ section }}</div>
      <h2>{{ title }}</h2>
      <p>This workspace view is reserved for a later frontend phase. No backend data or actions are connected.</p>
      <div class="preview-note"><i class="bi bi-info-circle"></i><span>Visual placeholder · integration pending</span></div>
    </div>
  `,
  styles: [`
    :host{display:block}.placeholder-page{min-height:340px;padding:clamp(24px,5vw,42px);border:1px solid #e8e5dc;border-radius:19px;background:#fffefa;box-shadow:var(--app-shadow-card)}.eyebrow{color:#987970;font-size:9px;font-weight:800;letter-spacing:1.35px}h2{margin:10px 0 0;color:#303936;font-size:25px;font-weight:720;letter-spacing:-.7px}.placeholder-page>p{max-width:480px;margin:9px 0 0;color:#7c857d;font-size:12px;line-height:1.65}.preview-note{display:inline-flex;align-items:center;gap:8px;margin-top:25px;padding:9px 12px;border-radius:10px;background:#f2f3ed;color:#737d73;font-size:10px}.preview-note i{color:#6b8a72}
  `],
})
export class WorkspacePlaceholderComponent {
  private readonly route = inject(ActivatedRoute);
  protected readonly title = String(this.route.snapshot.data['pageHeading'] ?? 'Workspace');
  protected readonly section = String(this.route.snapshot.data['pageSection'] ?? 'WORKSPACE');
}
