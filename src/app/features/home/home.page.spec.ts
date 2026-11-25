import { signal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';

import { AuthService } from '../../core/auth/auth.service';
import { ListService } from '../../core/list/list.service';

import { HomePage, updatedLabel } from './home.page';

describe('HomePage', () => {
  let component: HomePage;
  let fixture: ComponentFixture<HomePage>;

  beforeEach(async () => {
    fixture = TestBed.createComponent(HomePage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});

describe('HomePage list summary', () => {
  it('says when the list was last checked, not when it was last fetched in full', () => {
    const noon = new Date(2026, 10, 25, 12).getTime();
    const list = {
      entries: signal([{}, {}, {}]),
      fetchedAt: signal(noon - 10 * 86_400_000),
      checkedAt: signal(noon - 60_000),
      refreshing: signal(false),
      message: signal<string | null>(null),
      now: signal(noon),
      refresh: async () => undefined,
    };
    const auth = { status: signal('signedIn'), viewer: signal({ id: 7, name: 'me' }), message: signal(null) };
    TestBed.overrideProvider(ListService, { useValue: list });
    TestBed.overrideProvider(AuthService, { useValue: auth });
    const fixture = TestBed.createComponent(HomePage);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.summary')?.textContent).toContain(
      '3 anime · updated today',
    );
  });
});

describe('updatedLabel', () => {
  const noon = new Date(2026, 10, 25, 12).getTime();
  it('says today, yesterday or N days ago by the calendar', () => {
    expect(updatedLabel(new Date(2026, 10, 25, 0, 5).getTime(), noon)).toBe('today');
    expect(updatedLabel(new Date(2026, 10, 24, 23, 59).getTime(), noon)).toBe('yesterday');
    expect(updatedLabel(new Date(2026, 10, 20, 12).getTime(), noon)).toBe('5 days ago');
    expect(updatedLabel(noon + 1000, noon)).toBe('today');
  });
});
