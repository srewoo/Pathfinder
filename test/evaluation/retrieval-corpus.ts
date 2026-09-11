/**
 * A small labelled corpus for retrieval evaluation.
 *
 * Representative rather than large: the documents are shaped like real product
 * documentation — an overview page, a how-to, a troubleshooting page, a
 * reference table, a changelog — because the ways retrieval goes wrong are
 * shaped by that. The hard cases are deliberate:
 *
 *   · two pages that share vocabulary but answer different questions
 *     (the *how to export* page and the *export failed* page);
 *   · a page whose title matches a query that it does not actually answer
 *     (the changelog mentioning "export" in passing);
 *   · a query whose answer is split across two pages, so recall can be
 *     distinguished from precision.
 *
 * Labels are the URLs a competent human would accept as answering the query.
 * They are opinions, and the corpus version exists so a change of opinion is a
 * new version rather than a silently moved goalpost.
 */

export const CORPUS_VERSION = '1.0.0';

export interface CorpusDocument {
  url: string;
  title: string;
  section: string;
  content: string;
}

export const CORPUS: CorpusDocument[] = [
  {
    url: 'https://docs.example.test/exports/overview',
    title: 'Exporting data',
    section: 'Exports',
    content:
      'You can export any report as CSV or XLSX. Open the report, choose Export from the ' +
      'toolbar, and pick a format. Exports over 50,000 rows are queued and emailed to you ' +
      'when they finish. Scheduled exports run nightly at 02:00 in the workspace timezone.',
  },
  {
    url: 'https://docs.example.test/exports/troubleshooting',
    title: 'When an export fails',
    section: 'Exports',
    content:
      'A failed export usually means the report timed out. Narrow the date range and try ' +
      'again. If the export finishes but the file is empty, check that your role has access ' +
      'to the underlying records — rows you cannot see are excluded rather than blocked. ' +
      'Repeated failures on the same report should be reported with the export job id.',
  },
  {
    url: 'https://docs.example.test/billing/plans',
    title: 'Plans and limits',
    section: 'Billing',
    content:
      'The Starter plan includes 3 seats and 10 GB of storage. Growth includes 25 seats and ' +
      '200 GB. Exceeding your seat count blocks new invitations but never suspends existing ' +
      'users. Storage overage is billed monthly in 10 GB increments.',
  },
  {
    url: 'https://docs.example.test/billing/invoices',
    title: 'Reading your invoice',
    section: 'Billing',
    content:
      'Invoices are issued on the first of the month and list seats, storage overage, and ' +
      'any one-off charges separately. A credit from a mid-cycle downgrade appears as a ' +
      'negative line on the following invoice rather than as a refund.',
  },
  {
    url: 'https://docs.example.test/accounts/sso',
    title: 'Single sign-on',
    section: 'Accounts',
    content:
      'SSO is available on Growth and above. Configure your identity provider with the ACS ' +
      'URL shown in Settings. Once SSO is enforced, password sign-in is disabled for all ' +
      'members except break-glass administrators, who must use a hardware key.',
  },
  {
    url: 'https://docs.example.test/accounts/roles',
    title: 'Roles and permissions',
    section: 'Accounts',
    content:
      'Viewers can read reports. Editors can create and modify them. Admins manage members, ' +
      'billing and SSO. A role change takes effect on the member next sign-in, not ' +
      'immediately — an active session keeps its old permissions until it ends.',
  },
  {
    url: 'https://docs.example.test/changelog',
    title: 'Changelog',
    section: 'Release notes',
    content:
      'March: faster export queue, new invoice layout, SSO break-glass keys. February: role ' +
      'changes now apply on next sign-in. January: storage overage billing moved to 10 GB ' +
      'increments.',
  },
];

export interface LabelledQuery {
  query: string;
  relevantUrls: string[];
  /** Why these labels, in one line. Makes a disagreement about a label arguable. */
  rationale: string;
}

export const QUERIES: LabelledQuery[] = [
  {
    query: 'how do I export a report as a spreadsheet',
    relevantUrls: ['https://docs.example.test/exports/overview'],
    rationale: 'The overview page describes the export action and its formats. The changelog mentions exports but answers nothing.',
  },
  {
    query: 'my export finished but the file is empty',
    relevantUrls: ['https://docs.example.test/exports/troubleshooting'],
    rationale: 'Shares vocabulary with the overview page; only the troubleshooting page addresses the symptom.',
  },
  {
    query: 'why can a user still do things after I changed their role',
    relevantUrls: ['https://docs.example.test/accounts/roles'],
    rationale: 'The answer — role changes apply at next sign-in — is stated on the roles page. The changelog repeats it without explaining it.',
  },
  {
    query: 'what happens if we go over our seat count',
    relevantUrls: ['https://docs.example.test/billing/plans'],
    rationale: 'The plans page states the consequence explicitly.',
  },
  {
    query: 'how is a mid-cycle downgrade billed',
    relevantUrls: ['https://docs.example.test/billing/invoices'],
    rationale: 'Only the invoices page covers the credit behaviour.',
  },
  {
    query: 'can administrators sign in with a password once SSO is on',
    relevantUrls: ['https://docs.example.test/accounts/sso'],
    rationale: 'The SSO page carries the break-glass exception.',
  },
  {
    query: 'what do I need to be allowed to manage billing and set up SSO',
    relevantUrls: [
      'https://docs.example.test/accounts/roles',
      'https://docs.example.test/accounts/sso',
    ],
    rationale:
      'Split across two pages by design — the role requirement is on one and the plan requirement on the other, so recall and precision separate here.',
  },
];

export const DATASET = {
  name: 'product-docs',
  version: CORPUS_VERSION,
  description:
    'Seven pages of representative product documentation with hand-labelled queries, including near-duplicate vocabulary and one split answer.',
  queries: QUERIES.map((q) => ({ query: q.query, relevantUrls: q.relevantUrls })),
};
