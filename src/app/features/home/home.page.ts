import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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
}
