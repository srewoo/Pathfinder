import { describe, it, expect } from 'vitest';
import { isPseudoClickable } from '../../../src/content/element-detector';

/** Build a detached element with optional children/text/attrs for the heuristic. */
function makeEl(tag: string, opts: { text?: string; cursor?: string; onclick?: boolean; childTags?: string[] } = {}): HTMLElement {
  const el = document.createElement(tag);
  if (opts.text) el.textContent = opts.text;
  if (opts.cursor) el.style.cursor = opts.cursor;
  if (opts.onclick) el.setAttribute('onclick', 'doThing()');
  for (const c of opts.childTags ?? []) el.appendChild(document.createElement(c));
  return el;
}

describe('isPseudoClickable (div-based button heuristic)', () => {
  it('given a div with an onclick attribute and short text then it is clickable', () => {
    expect(isPseudoClickable(makeEl('div', { text: 'Open', onclick: true }))).toBe(true);
  });

  it('given a span with cursor:pointer and short text then it is clickable', () => {
    expect(isPseudoClickable(makeEl('span', { text: 'Toggle', cursor: 'pointer' }))).toBe(true);
  });

  it('given a plain div with no click signal then it is NOT clickable', () => {
    expect(isPseudoClickable(makeEl('div', { text: 'Just text' }))).toBe(false);
  });

  it('given a non-candidate tag (section) then it is NOT clickable', () => {
    expect(isPseudoClickable(makeEl('section', { text: 'x', onclick: true }))).toBe(false);
  });

  it('given a container with more than 2 children then it is skipped as a layout wrapper', () => {
    expect(isPseudoClickable(makeEl('div', { text: 'wrap', cursor: 'pointer', childTags: ['span', 'span', 'span'] }))).toBe(false);
  });

  it('given a pointer wrapper around a real interactive element then it is skipped', () => {
    const wrap = makeEl('div', { cursor: 'pointer' });
    const btn = document.createElement('button');
    btn.textContent = 'Real';
    wrap.appendChild(btn);
    expect(isPseudoClickable(wrap)).toBe(false);
  });

  it('given empty or very long text then it is NOT clickable', () => {
    expect(isPseudoClickable(makeEl('div', { text: '', onclick: true }))).toBe(false);
    expect(isPseudoClickable(makeEl('div', { text: 'x'.repeat(100), onclick: true }))).toBe(false);
  });
});
