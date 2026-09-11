import { Eye, BookOpen, PlayCircle, ExternalLink } from 'lucide-react';
import type { Flow } from '../../../storage/schemas';
import type { FlowProvenance as Provenance } from '../../../core/flow/flow-provenance';
import { describeProvenance } from '../../../core/flow/flow-provenance';
import { Badge } from '../shared/Badge';

/**
 * Three rows, never one badge.
 *
 * A single "verified" chip is the thing this component exists not to be. A flow
 * whose steps were observed, whose expectations are guesses, and which has
 * never been replayed is three different states of knowledge, and merging them
 * produces exactly the false confidence the rest of the product works to avoid.
 */
export function FlowProvenancePanel({
  flow,
  provenance,
}: {
  flow: Flow;
  provenance: Provenance;
}) {
  const lines = describeProvenance(provenance);
  const { replay } = provenance;
  // The business outcome the flow exists to check — the last step that states
  // one. A flow whose steps all describe clicks and none an outcome is a
  // sequence of actions, not a test of anything, and showing that is the point.
  const outcome = [...flow.steps].reverse().find((s) => s.expectedOutcome)?.expectedOutcome;

  return (
    <div className="space-y-1.5 rounded-md border border-border bg-surface-1 p-2">
      <Row
        icon={<Eye size={10} />}
        label="Observed"
        badge={
          provenance.inferredSteps === 0 && provenance.totalSteps > 0 ? (
            <Badge variant="success">all steps seen</Badge>
          ) : (
            <Badge variant="warning">{provenance.inferredSteps} inferred</Badge>
          )
        }
        detail={lines.observed}
      />

      <Row
        icon={<BookOpen size={10} />}
        label="Documented"
        badge={
          provenance.documentationRefs > 0 ? (
            <Badge variant="neutral">{provenance.documentationRefs} passage
              {provenance.documentationRefs === 1 ? '' : 's'}</Badge>
          ) : (
            <Badge variant="warning">none</Badge>
          )
        }
        detail={lines.documented}
      />

      <Row
        icon={<PlayCircle size={10} />}
        label="Replayed"
        badge={<Badge variant={replayVariant(replay.kind)}>{replayLabel(replay.kind)}</Badge>}
        detail={lines.replay}
      />

      {outcome && (
        <p className="border-t border-border pt-1.5 text-2xs text-text-secondary">
          <span className="font-medium">Expected outcome:</span> {outcome}
        </p>
      )}

      {flow.knowledgeRefs && flow.knowledgeRefs.length > 0 && (
        <ul className="space-y-0.5 border-t border-border pt-1.5">
          {flow.knowledgeRefs.map((ref) => (
            <li key={`${ref.url}-${ref.section ?? ''}`} className="text-2xs text-text-muted">
              <a
                href={ref.url}
                target="_blank"
                rel="noreferrer"
                className="text-primary-text hover:underline inline-flex items-center gap-1"
              >
                {ref.section || ref.url}
                <ExternalLink size={8} />
              </a>
              {/* Labelled as a ranking signal for the same reason it is in the
                  knowledge panel: it orders passages within one retrieval and
                  is not a probability that the documentation is right. */}
              <span className="ml-1">· ranking signal {ref.score.toFixed(2)}</span>
              {ref.snippet && (
                <span className="block text-text-muted/80 mt-0.5 line-clamp-2">{ref.snippet}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({
  icon,
  label,
  badge,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  badge: React.ReactNode;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-1.5">
      <span className="text-text-muted mt-0.5 flex-shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-2xs font-medium text-text-secondary">{label}</span>
          {badge}
        </span>
        <p className="text-2xs text-text-muted mt-0.5">{detail}</p>
      </div>
    </div>
  );
}

function replayLabel(kind: Provenance['replay']['kind']): string {
  switch (kind) {
    case 'validated':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'stale':
      return 'out of date';
    case 'never-run':
      return 'never run';
  }
}

function replayVariant(kind: Provenance['replay']['kind']): 'success' | 'warning' | 'error' | 'neutral' {
  switch (kind) {
    case 'validated':
      return 'success';
    case 'failed':
      return 'error';
    case 'stale':
      return 'warning';
    case 'never-run':
      return 'neutral';
  }
}
