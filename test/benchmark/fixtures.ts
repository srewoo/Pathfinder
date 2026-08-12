/**
 * Benchmark fixtures (fix.md §10).
 *
 * Each fixture is a small app in TWO variants:
 *   - `correct`  — behaves properly. Any test failure here is a FALSE POSITIVE.
 *   - `broken`   — one deliberately injected defect. Catching it is RECALL.
 *
 * Pairing is what makes the false-positive rate measurable at all. A suite of
 * broken-only fixtures can only ever report recall, and recall alone is the
 * metric a noisy tool optimises while becoming useless.
 *
 * An "app" is HTML plus a `wire()` function that attaches behaviour. Behaviour
 * lives in JS rather than inline `<script>` because jsdom does not execute
 * scripts from `innerHTML` — and being explicit about the app's logic makes the
 * injected defect reviewable in the diff between the two variants.
 */

export type DefectClass =
  | 'validation-bypass'
  | 'broken-link'
  | 'server-error-on-submit'
  | 'a11y-missing-label'
  | 'dead-button'
  | 'state-not-persisted'
  // ── State-diff oracle classes ──
  | 'success-without-persistence'
  | 'success-over-failure';

export interface AppVariant {
  html: string;
  /** Attach behaviour. `record` simulates the app's own network calls. */
  wire: (doc: Document, record: (r: { url: string; method: string; status: number }) => void) => void;
}

export interface Fixture {
  id: string;
  description: string;
  defect: DefectClass;
  /** What a detector must report for the defect to count as caught. */
  expectedSignal: string;
  correct: AppVariant;
  broken: AppVariant;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const signupHtml = (opts: { label?: boolean } = {}) => `
  <main>
    <h1>Sign up</h1>
    <form id="signup" novalidate>
      ${opts.label === false
        ? '<input id="email" name="email" type="email" required maxlength="40" data-testid="email" />'
        : '<label for="email">Email</label>\n       <input id="email" name="email" type="email" required maxlength="40" data-testid="email" />'}
      <label for="pw">Password</label>
      <input id="pw" name="pw" type="password" required minlength="8" data-testid="password" />
      <!-- type=button, not submit: jsdom lacks requestSubmit, and this app
           validates in its click handler regardless. -->
      <button type="button" data-testid="submit">Create account</button>
    </form>
    <div id="banner" role="status" hidden></div>
    <div id="error" role="alert" hidden></div>
  </main>`;

function showSuccess(doc: Document): void {
  const b = doc.getElementById('banner');
  if (!b) return;
  b.hidden = false;
  b.textContent = 'Account created successfully';
}

function showError(doc: Document, message: string): void {
  const e = doc.getElementById('error');
  if (!e) return;
  e.hidden = false;
  e.textContent = message;
}

/** Server-side style validation the app SHOULD apply. */
function validateSignup(doc: Document): string | null {
  const email = (doc.getElementById('email') as HTMLInputElement | null)?.value ?? '';
  const pw = (doc.getElementById('pw') as HTMLInputElement | null)?.value ?? '';
  if (!email.trim()) return 'Email is required';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'Email is not valid';
  if (email.length > 40) return 'Email is too long';
  if (!pw) return 'Password is required';
  if (pw.length < 8) return 'Password is too short';
  return null;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

export const FIXTURES: readonly Fixture[] = [
  {
    id: 'signup-validation',
    description: 'Signup form must reject invalid input',
    defect: 'validation-bypass',
    expectedSignal: 'success shown despite invalid input',
    correct: {
      html: signupHtml(),
      wire(doc) {
        doc.getElementById('signup')?.addEventListener('click', (ev) => {
          const t = ev.target as HTMLElement;
          if (t.getAttribute('data-testid') !== 'submit') return;
          ev.preventDefault();
          const problem = validateSignup(doc);
          if (problem) showError(doc, problem);
          else showSuccess(doc);
        });
      },
    },
    broken: {
      html: signupHtml(),
      wire(doc) {
        // DEFECT: accepts anything. The classic "client validates, server
        // doesn't" bug — the form has `required` and `type=email`, but the
        // handler never checks, so a malformed email creates an account.
        doc.getElementById('signup')?.addEventListener('click', (ev) => {
          const t = ev.target as HTMLElement;
          if (t.getAttribute('data-testid') !== 'submit') return;
          ev.preventDefault();
          showSuccess(doc);
        });
      },
    },
  },

  {
    id: 'signup-maxlength',
    description: 'Signup form must reject an over-long email',
    defect: 'validation-bypass',
    expectedSignal: 'success shown for value over maxlength',
    correct: {
      html: signupHtml(),
      wire(doc) {
        doc.getElementById('signup')?.addEventListener('click', (ev) => {
          const t = ev.target as HTMLElement;
          if (t.getAttribute('data-testid') !== 'submit') return;
          ev.preventDefault();
          const problem = validateSignup(doc);
          if (problem) showError(doc, problem);
          else showSuccess(doc);
        });
      },
    },
    broken: {
      html: signupHtml(),
      wire(doc) {
        // DEFECT: length is never checked, so a 41-char email is accepted even
        // though maxlength=40 is declared.
        doc.getElementById('signup')?.addEventListener('click', (ev) => {
          const t = ev.target as HTMLElement;
          if (t.getAttribute('data-testid') !== 'submit') return;
          ev.preventDefault();
          const email = (doc.getElementById('email') as HTMLInputElement).value;
          const pw = (doc.getElementById('pw') as HTMLInputElement).value;
          if (!email || !pw || pw.length < 8 || !email.includes('@')) {
            showError(doc, 'Invalid');
            return;
          }
          showSuccess(doc);
        });
      },
    },
  },

  {
    id: 'server-error-on-submit',
    description: 'Valid submission must not return a 500',
    defect: 'server-error-on-submit',
    expectedSignal: 'POST returned 500',
    correct: {
      html: signupHtml(),
      wire(doc, record) {
        doc.getElementById('signup')?.addEventListener('click', (ev) => {
          const t = ev.target as HTMLElement;
          if (t.getAttribute('data-testid') !== 'submit') return;
          ev.preventDefault();
          if (validateSignup(doc)) {
            showError(doc, 'Invalid');
            return;
          }
          record({ url: 'https://fixture.test/api/signup', method: 'POST', status: 201 });
          showSuccess(doc);
        });
      },
    },
    broken: {
      html: signupHtml(),
      wire(doc, record) {
        // DEFECT: the endpoint 500s. The UI still claims success, which is the
        // combination that makes this invisible to DOM-only assertions.
        doc.getElementById('signup')?.addEventListener('click', (ev) => {
          const t = ev.target as HTMLElement;
          if (t.getAttribute('data-testid') !== 'submit') return;
          ev.preventDefault();
          if (validateSignup(doc)) {
            showError(doc, 'Invalid');
            return;
          }
          record({ url: 'https://fixture.test/api/signup', method: 'POST', status: 500 });
          showSuccess(doc);
        });
      },
    },
  },

  {
    id: 'dead-button',
    description: 'The primary action button must do something',
    defect: 'dead-button',
    expectedSignal: 'click produced no observable change',
    correct: {
      html: `
        <main>
          <button data-testid="save">Save</button>
          <div id="out" role="status" hidden></div>
        </main>`,
      wire(doc) {
        // Neutral observable change, NOT a success claim. An earlier version said
        // "Saved successfully" with nothing persisted — which is exactly the
        // success-without-persistence defect, so the oracle correctly flagged this
        // "correct" app. A fixture must contain exactly one defect.
        doc.querySelector('[data-testid="save"]')?.addEventListener('click', () => {
          const o = doc.getElementById('out');
          if (o) {
            o.hidden = false;
            o.textContent = 'Details panel opened';
          }
        });
      },
    },
    broken: {
      html: `
        <main>
          <button data-testid="save">Save</button>
          <div id="out" role="status" hidden></div>
        </main>`,
      // DEFECT: no handler at all — the button is inert.
      wire() {},
    },
  },

  {
    id: 'state-not-persisted',
    description: 'A saved value must survive a re-render',
    defect: 'state-not-persisted',
    expectedSignal: 'value absent after re-render',
    correct: {
      html: `
        <main>
          <label for="name">Name</label>
          <input data-testid="name" id="name" />
          <button data-testid="save">Save</button>
          <button data-testid="reload">Reload</button>
          <div id="shown" role="status" hidden></div>
        </main>`,
      wire(doc) {
        let saved = '';
        doc.querySelector('[data-testid="save"]')?.addEventListener('click', () => {
          saved = (doc.getElementById('name') as HTMLInputElement).value;
        });
        doc.querySelector('[data-testid="reload"]')?.addEventListener('click', () => {
          const s = doc.getElementById('shown');
          if (s) {
            s.hidden = false;
            s.textContent = saved;
          }
        });
      },
    },
    broken: {
      html: `
        <main>
          <label for="name">Name</label>
          <input data-testid="name" id="name" />
          <button data-testid="save">Save</button>
          <button data-testid="reload">Reload</button>
          <div id="shown" role="status" hidden></div>
        </main>`,
      wire(doc) {
        // DEFECT: save never records the value, so reload shows nothing.
        doc.querySelector('[data-testid="save"]')?.addEventListener('click', () => {
          /* dropped on the floor */
        });
        doc.querySelector('[data-testid="reload"]')?.addEventListener('click', () => {
          const s = doc.getElementById('shown');
          if (s) {
            s.hidden = false;
            s.textContent = '';
          }
        });
      },
    },
  },

  {
    id: 'a11y-missing-label',
    description: 'Every input must have an accessible name',
    defect: 'a11y-missing-label',
    expectedSignal: 'input has no accessible name',
    correct: { html: signupHtml(), wire() {} },
    // DEFECT: the email input loses its <label>, so it has no accessible name.
    broken: { html: signupHtml({ label: false }), wire() {} },
  },

  {
    id: 'optimistic-save',
    description: 'Saving must actually reach the server, not just render success',
    defect: 'success-without-persistence',
    expectedSignal: 'success shown with zero network requests and no storage write',
    correct: {
      html: `
        <main>
          <label for="note">Note</label>
          <input id="note" data-testid="note" />
          <button type="button" data-testid="save">Save</button>
          <div id="banner" role="status" hidden></div>
        </main>`,
      wire(doc, record) {
        doc.querySelector('[data-testid="save"]')?.addEventListener('click', () => {
          record({ url: 'https://fixture.test/api/notes', method: 'POST', status: 201 });
          const b = doc.getElementById('banner');
          if (b) { b.hidden = false; b.textContent = 'Note saved successfully'; }
        });
      },
    },
    broken: {
      html: `
        <main>
          <label for="note">Note</label>
          <input id="note" data-testid="note" />
          <button type="button" data-testid="save">Save</button>
          <div id="banner" role="status" hidden></div>
        </main>`,
      wire(doc) {
        // DEFECT: renders success and never contacts the server. The classic
        // optimistic-UI data-loss bug — a "success banner is visible" assertion
        // passes while the note is gone on reload.
        doc.querySelector('[data-testid="save"]')?.addEventListener('click', () => {
          const b = doc.getElementById('banner');
          if (b) { b.hidden = false; b.textContent = 'Note saved successfully'; }
        });
      },
    },
  },

  {
    id: 'success-over-500',
    description: 'A failed save must not be reported as success',
    defect: 'success-over-failure',
    expectedSignal: 'success message shown over a 5xx response',
    correct: {
      html: `
        <main>
          <button type="button" data-testid="save">Save</button>
          <div id="banner" role="status" hidden></div>
        </main>`,
      wire(doc, record) {
        // The correct app simply succeeds. An earlier version of this fixture had
        // the correct variant return 500 while surfacing the error nicely — but a
        // 5xx IS a defect regardless of how gracefully it is displayed, so
        // detectServerErrors reported it and the fixture registered a false
        // positive against itself. A fixture must contain exactly one defect.
        doc.querySelector('[data-testid="save"]')?.addEventListener('click', () => {
          record({ url: 'https://fixture.test/api/save', method: 'POST', status: 200 });
          const b = doc.getElementById('banner');
          if (b) { b.hidden = false; b.textContent = 'Saved successfully'; }
        });
      },
    },
    broken: {
      html: `
        <main>
          <button type="button" data-testid="save">Save</button>
          <div id="banner" role="status" hidden></div>
        </main>`,
      wire(doc, record) {
        // DEFECT: ignores the response status and claims success anyway.
        doc.querySelector('[data-testid="save"]')?.addEventListener('click', () => {
          record({ url: 'https://fixture.test/api/save', method: 'POST', status: 500 });
          const b = doc.getElementById('banner');
          if (b) { b.hidden = false; b.textContent = 'Saved successfully'; }
        });
      },
    },
  },

  {
    id: 'client-side-only-save',
    description: 'A local-first app persists to storage, not the server',
    defect: 'success-without-persistence',
    expectedSignal: 'success shown with no persistence of any kind',
    correct: {
      // TRAP for the success-without-persistence oracle: shows success and makes
      // ZERO network requests, which is correct for a local-first app. The oracle
      // must see the storage write and stay quiet.
      html: `
        <main>
          <label for="draft">Draft</label>
          <input id="draft" data-testid="draft" />
          <button type="button" data-testid="save">Save</button>
          <div id="banner" role="status" hidden></div>
        </main>`,
      wire(doc) {
        doc.querySelector('[data-testid="save"]')?.addEventListener('click', () => {
          const v = (doc.getElementById('draft') as HTMLInputElement)?.value ?? '';
          localStorage.setItem('draft', v);
          const b = doc.getElementById('banner');
          if (b) { b.hidden = false; b.textContent = 'Draft saved successfully'; }
        });
      },
    },
    broken: {
      html: `
        <main>
          <label for="draft">Draft</label>
          <input id="draft" data-testid="draft" />
          <button type="button" data-testid="save">Save</button>
          <div id="banner" role="status" hidden></div>
        </main>`,
      wire(doc) {
        // DEFECT: claims success, writes neither to storage nor the server.
        doc.querySelector('[data-testid="save"]')?.addEventListener('click', () => {
          const b = doc.getElementById('banner');
          if (b) { b.hidden = false; b.textContent = 'Draft saved successfully'; }
        });
      },
    },
  },

  {
    id: 'stale-banner',
    description: 'A banner already on screen says nothing about a new action',
    defect: 'success-without-persistence',
    expectedSignal: 'success shown with no persistence of any kind',
    correct: {
      // TRAP: a success banner from an EARLIER action is visible before the click.
      // Treating it as evidence about this click is how a stale message makes a
      // broken action look fine — the oracle must only consider NEW messages.
      html: `
        <main>
          <button type="button" data-testid="save">Save</button>
          <div id="banner" role="status">Saved successfully</div>
          <div id="out" hidden></div>
        </main>`,
      wire(doc) {
        // This click legitimately does something benign and unrelated.
        doc.querySelector('[data-testid="save"]')?.addEventListener('click', () => {
          const o = doc.getElementById('out');
          if (o) { o.hidden = false; o.textContent = 'Panel opened'; }
        });
      },
    },
    broken: {
      html: `
        <main>
          <button type="button" data-testid="save">Save</button>
          <div id="banner" role="status" hidden></div>
        </main>`,
      wire(doc) {
        // DEFECT: a genuinely new success claim with nothing behind it.
        doc.querySelector('[data-testid="save"]')?.addEventListener('click', () => {
          const b = doc.getElementById('banner');
          if (b) { b.hidden = false; b.textContent = 'Saved successfully'; }
        });
      },
    },
  },

  {
    id: 'broken-link',
    description: 'Navigation links must resolve',
    defect: 'broken-link',
    expectedSignal: 'link target returns 404',
    correct: {
      html: `
        <nav>
          <a href="/home" data-testid="home">Home</a>
          <a href="/settings" data-testid="settings">Settings</a>
        </nav>`,
      wire(_doc, record) {
        record({ url: 'https://fixture.test/home', method: 'GET', status: 200 });
        record({ url: 'https://fixture.test/settings', method: 'GET', status: 200 });
      },
    },
    broken: {
      html: `
        <nav>
          <a href="/home" data-testid="home">Home</a>
          <a href="/settings" data-testid="settings">Settings</a>
        </nav>`,
      wire(_doc, record) {
        // DEFECT: /settings 404s.
        record({ url: 'https://fixture.test/home', method: 'GET', status: 200 });
        record({ url: 'https://fixture.test/settings', method: 'GET', status: 404 });
      },
    },
  },
];

/** Mount a variant into the ambient document and wire its behaviour. */
export function mount(
  variant: AppVariant,
  record: (r: { url: string; method: string; status: number }) => void
): void {
  document.body.innerHTML = variant.html;
  variant.wire(document, record);
}

export function fixtureById(id: string): Fixture {
  const f = FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`No fixture "${id}"`);
  return f;
}
