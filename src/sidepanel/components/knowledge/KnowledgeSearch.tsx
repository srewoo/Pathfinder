import { useState, type FormEvent } from 'react';
import { Search, ExternalLink, Clock, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import type { KnowledgeQueryResult, RetrievedPassage } from '../../../core/knowledge/knowledge-query';
import { useKnowledgeStore } from '../../stores/knowledge-store';

/**
 * Query the knowledge base and show what came back — passages, sources,
 * ranking positions and crawl dates.
 *
 * This is the same retrieval that runs inside test generation and the
 * doc-grounded oracle. Exposing it is the point: when a generated expectation
 * cites documentation, this is where a user checks whether the documentation
 * actually says that.
 */
export function KnowledgeSearch() {
  const { searchQuery, searchResult, isSearching, searchError, setSearchQuery, runSearch } =
    useKnowledgeStore();
  const [expanded, setExpanded] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    void runSearch();
  }

  return (
    <div className="space-y-2">
      <form onSubmit={submit} className="flex gap-1.5">
        <label className="sr-only" htmlFor="knowledge-query">
          Search indexed documentation
        </label>
        <input
          id="knowledge-query"
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Ask the indexed docs — e.g. how does checkout handle a declined card"
          className="flex-1 min-w-0 px-2 py-1.5 text-2xs rounded-md bg-surface-2 border border-border text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={isSearching || !searchQuery.trim()}
          className="flex items-center gap-1 px-2 py-1.5 text-2xs font-medium rounded-md bg-primary text-white disabled:opacity-40"
        >
          <Search size={11} />
          {isSearching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {searchError && (
        <p role="alert" className="text-2xs text-danger">
          {searchError}
        </p>
      )}

      {searchResult && <ResultSummary result={searchResult} />}

      {searchResult?.passages.map((p) => (
        <PassageCard
          key={p.id}
          passage={p}
          open={expanded === p.id}
          onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
        />
      ))}
    </div>
  );
}

/**
 * What the query did, in a sentence, plus the corpus it ran against.
 *
 * An empty pane is never an answer: "nothing is indexed", "nothing matched" and
 * "your query cannot be compared against this index" are different problems
 * with different fixes, and only the last one is not solved by rewording.
 */
function ResultSummary({ result }: { result: KnowledgeQueryResult }) {
  const { outcome, index } = result;
  const bad = outcome.kind === 'embedding-mismatch' || outcome.kind === 'unavailable';
  const mixedModels = index.embeddingModels.length > 1;

  return (
    <div
      className={`p-2 rounded-md border text-2xs space-y-1 ${
        bad ? 'bg-warning-bg border-warning-border text-warning-text' : 'bg-surface-2 border-border text-text-secondary'
      }`}
    >
      <p>{explain(result)}</p>
      <p className="text-text-muted">
        Index: {index.vectors} chunk{index.vectors === 1 ? '' : 's'} from {index.documents} document
        {index.documents === 1 ? '' : 's'}
        {index.newestCrawledAt && ` · last crawled ${formatDate(index.newestCrawledAt)}`}
      </p>
      {mixedModels && (
        <p className="flex items-start gap-1 text-warning-text">
          <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
          This index mixes {index.embeddingModels.join(' and ')}. Scores from different models are
          not comparable — re-crawl to rebuild it with one.
        </p>
      )}
      {result.stalePassages > 0 && (
        <p className="text-text-muted">
          {result.stalePassages} of {result.passages.length} passage
          {result.passages.length === 1 ? '' : 's'} come from pages crawled over 90 days ago.
        </p>
      )}
    </div>
  );
}

function PassageCard({
  passage,
  open,
  onToggle,
}: {
  passage: RetrievedPassage;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-start gap-1.5 p-2 text-left"
      >
        {open ? (
          <ChevronDown size={11} className="mt-0.5 flex-shrink-0 text-text-muted" />
        ) : (
          <ChevronRight size={11} className="mt-0.5 flex-shrink-0 text-text-muted" />
        )}
        <span className="flex-1 min-w-0">
          <span className="flex items-baseline gap-1.5">
            <span className="text-2xs font-semibold text-text-muted tabular-nums">
              #{passage.rank}
            </span>
            <span className="text-xs font-medium text-text-primary truncate">{passage.title}</span>
          </span>
          <span className="block text-2xs text-text-muted truncate mt-0.5">
            {passage.breadcrumbPath ?? passage.section ?? passage.url}
          </span>
          <span className="block text-2xs text-text-muted mt-0.5">
            {/* Deliberately worded as a ranking signal. It is a blend of cosine
                similarity and BM25 after diversity re-ranking — it orders these
                passages against each other and means nothing across queries, so
                it must never be shown as a confidence percentage. */}
            ranking signal {passage.rankingScore.toFixed(2)} · chunk {passage.chunkIndex + 1} of{' '}
            {passage.totalChunks}
            {passage.stale && (
              <span className="ml-1 text-warning-text">
                <Clock size={9} className="inline align-[-1px]" /> crawled{' '}
                {formatDate(passage.crawledAt)}
              </span>
            )}
          </span>
        </span>
      </button>

      {open && (
        <div className="px-2 pb-2 space-y-1.5 border-t border-border pt-1.5">
          <p className="text-2xs text-text-secondary whitespace-pre-wrap leading-relaxed">
            {passage.content}
          </p>
          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs text-text-muted font-mono truncate">{passage.url}</span>
            <a
              href={passage.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-2xs text-primary-text hover:underline flex-shrink-0"
            >
              Open source <ExternalLink size={9} />
            </a>
          </div>
          <p className="text-2xs text-text-muted">
            Crawled {formatDate(passage.crawledAt)}
            {passage.embeddingModel && ` · embedded with ${passage.embeddingModel}`}
          </p>
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown date' : d.toLocaleDateString();
}

/**
 * Mirrors `explainOutcome` from the core module.
 *
 * Duplicated deliberately rather than imported: the panel's copy is UI text
 * with a link and a button behind it, and tying it to the string the core
 * module hands to logs and reports would couple two things that should be free
 * to diverge.
 */
function explain(result: KnowledgeQueryResult): string {
  const { outcome, index } = result;
  switch (outcome.kind) {
    case 'results':
      return `${result.passages.length} passage${result.passages.length === 1 ? '' : 's'} matched.`;
    case 'empty-index':
      return 'Nothing is indexed yet. Crawl a documentation site above first.';
    case 'no-match':
      return `Nothing in the ${index.documents} indexed document${
        index.documents === 1 ? '' : 's'
      } scored above the relevance threshold — the documentation may simply not cover this.`;
    case 'embedding-mismatch':
      return `This query embeds to ${outcome.queryDimensions} dimensions but the index was built at ${outcome.indexDimensions}, so they cannot be compared. Rewording will not help — re-crawl with the embedding model currently set in Settings.`;
    case 'unavailable':
      return `Could not run the query: ${outcome.reason}`;
  }
}
