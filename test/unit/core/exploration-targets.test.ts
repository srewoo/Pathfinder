import { describe, it, expect } from 'vitest';
import { selectExplorationTargets } from '../../../src/core/explorer/page-scanner';
import type { InteractiveElement } from '../../../src/storage/schemas';

const el = (partial: Partial<InteractiveElement>): InteractiveElement =>
  ({ selector: 'x', tag: 'button', visible: true, ...partial } as unknown as InteractiveElement);

describe('selectExplorationTargets — off-viewport coverage', () => {
  it('given an off-viewport clickable element when selecting then it IS included as a target', () => {
    const targets = selectExplorationTargets(
      [el({ selector: '#below-fold', tag: 'button', text: 'Load more', visible: false })],
      new Set(),
    );
    expect(targets.map((t) => t.selector)).toContain('#below-fold');
  });

  it('given a mix when selecting then in-viewport elements are clicked before off-viewport ones', () => {
    const targets = selectExplorationTargets(
      [
        el({ selector: '#offscreen', tag: 'button', text: 'B', visible: false }),
        el({ selector: '#onscreen', tag: 'button', text: 'A', visible: true }),
      ],
      new Set(),
    );
    expect(targets[0].selector).toBe('#onscreen');
    expect(targets[1].selector).toBe('#offscreen');
  });

  it('given a div-based clickable (role=button synthesised by the detector) then it is a target', () => {
    const targets = selectExplorationTargets(
      [el({ selector: '.card', tag: 'div', role: 'button', text: 'Open card', visible: true })],
      new Set(),
    );
    expect(targets.map((t) => t.selector)).toContain('.card');
  });

  it('given navigation links and buttons then nav is prioritised first', () => {
    const targets = selectExplorationTargets(
      [
        el({ selector: '#btn', tag: 'button', text: 'Do' }),
        el({ selector: '#link', tag: 'a', text: 'Go' }),
      ],
      new Set(),
    );
    expect(targets[0].selector).toBe('#link');
  });

  it('given a dangerous action by default then it is excluded', () => {
    const targets = selectExplorationTargets(
      [el({ selector: '#del', tag: 'button', text: 'Delete account' })],
      new Set(),
    );
    expect(targets).toHaveLength(0);
  });

  it('given includeDangerous then dangerous actions are included', () => {
    const targets = selectExplorationTargets(
      [el({ selector: '#del', tag: 'button', text: 'Delete account' })],
      new Set(),
      { includeDangerous: true },
    );
    expect(targets.map((t) => t.selector)).toContain('#del');
  });

  it('given already-visited or disabled elements then they are excluded', () => {
    const targets = selectExplorationTargets(
      [
        el({ selector: '#seen', tag: 'button', text: 'Seen' }),
        el({ selector: '#disabled', tag: 'button', text: 'Off', disabled: true }),
      ],
      new Set(['#seen']),
    );
    expect(targets).toHaveLength(0);
  });

  it('given more candidates than maxTargets then the result is capped', () => {
    const many = Array.from({ length: 150 }, (_, i) => el({ selector: `#b${i}`, tag: 'button', text: `B${i}` }));
    expect(selectExplorationTargets(many, new Set(), { maxTargets: 100 })).toHaveLength(100);
  });
});
