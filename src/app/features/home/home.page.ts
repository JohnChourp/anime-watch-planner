import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  IonButton,
  IonContent,
  IonHeader,
  IonRefresher,
  IonRefresherContent,
  IonSpinner,
  IonTitle,
  IonToolbar,
  type RefresherCustomEvent,
} from '@ionic/angular';

import { AuthService } from '../../core/auth/auth.service';
import { ListService } from '../../core/list/list.service';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonHeader, IonToolbar, IonTitle, IonContent, IonButton, IonSpinner, IonRefresher, IonRefresherContent],
})
export class HomePage {
  protected readonly auth = inject(AuthService);
  protected readonly signedInTitle = computed(() => {
    const viewer = this.auth.viewer();
    return viewer ? `Signed in as ${viewer.name}` : 'Signed in to AniList';
  });
  protected readonly signingIn = computed(() => this.auth.status() === 'signingIn');

  protected readonly list = inject(ListService);
  /** "437 anime · updated today", or what is happening while there is no list yet. */
  protected readonly listSummary = computed(() => {
    const entries = this.list.entries();
    const fetchedAt = this.list.fetchedAt();
    if (!entries || fetchedAt === null) {
      return this.list.refreshing() ? 'Loading your list…' : 'Pull down to load your list.';
    }
    return `${entries.length} anime · updated ${updatedLabel(fetchedAt, Date.now())}`;
  });

  protected async refresh(event: RefresherCustomEvent): Promise<void> {
    try {
      await this.list.refresh();
    } finally {
      await event.target.complete();
    }
  }
}

/** "today", "yesterday" or "N days ago", by the calendar on this device. */
export function updatedLabel(fetchedAt: number, now: number): string {
  const day = (ms: number) => {
    const d = new Date(ms);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
  };
  const days = day(now) - day(fetchedAt);
  if (days <= 0) {
    return 'today';
  }
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
