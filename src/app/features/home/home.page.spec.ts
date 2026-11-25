import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';

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

describe('updatedLabel', () => {
  const noon = new Date(2026, 10, 25, 12).getTime();
  it('says today, yesterday or N days ago by the calendar', () => {
    expect(updatedLabel(new Date(2026, 10, 25, 0, 5).getTime(), noon)).toBe('today');
    expect(updatedLabel(new Date(2026, 10, 24, 23, 59).getTime(), noon)).toBe('yesterday');
    expect(updatedLabel(new Date(2026, 10, 20, 12).getTime(), noon)).toBe('5 days ago');
    expect(updatedLabel(noon + 1000, noon)).toBe('today');
  });
});
