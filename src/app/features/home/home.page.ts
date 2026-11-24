import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { IonButton, IonContent, IonHeader, IonSpinner, IonTitle, IonToolbar } from '@ionic/angular';

import { AuthService } from '../../core/auth/auth.service';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonHeader, IonToolbar, IonTitle, IonContent, IonButton, IonSpinner],
})
export class HomePage {
  protected readonly auth = inject(AuthService);
  protected readonly signedInTitle = computed(() => {
    const viewer = this.auth.viewer();
    return viewer ? `Signed in as ${viewer.name}` : 'Signed in to AniList';
  });
  protected readonly signingIn = computed(() => this.auth.status() === 'signingIn');
}
