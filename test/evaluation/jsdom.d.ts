/**
 * Minimal jsdom surface the evaluation harness uses.
 *
 * Declared locally rather than adding `@types/jsdom`: the harness needs four
 * members, and a dependency the product does not ship is worth avoiding for a
 * test-only import.
 */
declare module 'jsdom' {
  export class JSDOM {
    constructor(
      html?: string,
      options?: Record<string, unknown> & {
        /** Runs before the document is parsed, so hooks beat the page's scripts. */
        beforeParse?: (window: Record<string, unknown>) => void;
      }
    );
    readonly window: Window &
      typeof globalThis & {
        close(): void;
        document: Document;
        localStorage: Storage;
        sessionStorage: Storage;
      };
  }
}
