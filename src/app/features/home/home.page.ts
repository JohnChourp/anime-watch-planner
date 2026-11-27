import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal } from '@angular/core';
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
import type { ListEntry, ListStatus } from '../../core/list/anilist-list';
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
  protected readonly titleLabels = computed(() => pickerLabels(this.list.entries() ?? []));
  protected readonly editProblems = computed(() => {
    const problems = [];
    for (const [id, edit] of this.list.statusEdits()) {
      if (edit.problem) {
        problems.push({
          id,
          title: this.titleLabels().get(edit.mediaId) ?? `Anime #${edit.mediaId}`,
          message: edit.message,
        });
      }
    }
    return problems;
  });
  protected readonly statuses = [
    { value: 'CURRENT', label: 'Watching' },
    { value: 'PLANNING', label: 'Planning' },
    { value: 'COMPLETED', label: 'Completed' },
    { value: 'REPEATING', label: 'Rewatching' },
    { value: 'PAUSED', label: 'Paused' },
    { value: 'DROPPED', label: 'Dropped' },
  ] as const satisfies readonly { value: ListStatus; label: string }[];
  protected readonly selectedId = linkedSignal<ListEntry[] | null, number | null>({
    source: this.list.entries,
    computation: (entries, previous) => {
      const id = previous?.value ?? null;
      return entries?.some((entry) => entry.id === id) ? id : null;
    },
  });
  protected readonly selected = computed(() => this.list.entries()?.find((entry) => entry.id === this.selectedId()));
  /** "437 anime · updated today", or what is happening while there is no list yet. */
  protected readonly listSummary = computed(() => {
    const entries = this.list.entries();
    const checkedAt = this.list.checkedAt();
    if (!entries || checkedAt === null) {
      if (this.list.refreshing()) {
        return 'Loading your list…';
      }
      return this.list.message() ? null : 'Pull down to load your list.';
    }
    return `${entries.length} anime · updated ${updatedLabel(checkedAt, Math.max(this.list.now(), checkedAt))}`;
  });

  protected async refresh(event: RefresherCustomEvent): Promise<void> {
    try {
      await this.list.refresh();
    } finally {
      await event.target.complete();
    }
  }
}

/** Keep familiar names for unique titles. Use the year and format for namesakes, then the media ID if needed. */
function pickerLabels(entries: ListEntry[]): Map<number, string> {
  const names = entries.map(({ media }) => media.title.english || media.title.romaji || `Anime #${media.id}`);
  const namesakes = duplicates(names);
  const qualified = entries.map(({ media }, i) => {
    const name = names[i];
    if (!namesakes.has(name)) return name;
    const format = media.format === 'MOVIE' ? 'Movie' : media.format?.replaceAll('_', ' ');
    const details = [media.seasonYear, format].filter(Boolean).join(', ');
    return details ? `${name} (${details})` : name;
  });
  const ambiguous = duplicates(qualified);
  const used = new Set(names.filter((name) => !namesakes.has(name)));
  return new Map(
    entries.map(({ media }, i) => {
      let label = qualified[i];
      if (namesakes.has(names[i])) {
        if (ambiguous.has(label) || label === names[i]) label += ` #${media.id}`;
        while (used.has(label)) label += ` #${media.id}`;
        used.add(label);
      }
      return [media.id, label];
    }),
  );
}

function duplicates(labels: string[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) repeated.add(label);
    seen.add(label);
  }
  return repeated;
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
