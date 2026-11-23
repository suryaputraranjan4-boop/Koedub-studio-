import React, { useState } from 'react';
import { AudioWaveform, CheckSquare, FileText } from 'lucide-react';
import type { QAIssue } from '../types/domain';
import { useStudio } from '../state/StudioContext';
import {
  EmptyState,
  formatShortDate,
  KeyValueList,
  NoticeBanner,
  PageHeader,
  SectionTitle,
  StatusText,
  Surface,
} from '../components/StudioPrimitives';
import { formatTimecode } from '../core/timeline/timelineEngine';

export function QualityAssuranceScreen() {
  const {
    activeBundle,
    runStructuralQACheck,
    setActiveScreen,
    jumpToAudioStudioClip,
  } = useStudio();
  const [running, setRunning] = useState(false);

  if (!activeBundle) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Quality Assurance"
          subtitle="Full acoustic, structural, and semantic QA auditing: peak/RMS loudness, clipping verification, timing tolerance, sound preservation, and character consistency."
        />
        <EmptyState
          title="No active project selected"
          description="Select or create a project to run Full Acoustic & Semantic Quality Assurance."
          actionLabel="Go to Projects"
          onAction={() => setActiveScreen('projects')}
        />
      </div>
    );
  }

  const { project, segments, qaReports } = activeBundle;
  const latestReport = qaReports[0] ?? null;
  const acoustic = latestReport?.acousticMetrics ?? null;

  const failedIssues =
    latestReport?.issues.filter((i) => i.severity === 'error') ?? [];
  const warningIssues =
    latestReport?.issues.filter((i) => i.severity === 'warning') ?? [];
  const reviewIssues =
    latestReport?.issues.filter((i) => i.severity === 'review_required') ?? [];

  const handleRunQA = async () => {
    setRunning(true);
    try {
      await runStructuralQACheck(project.id);
    } finally {
      setRunning(false);
    }
  };

  const renderIssueMeta = (issue: QAIssue) => (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 font-mono">
      {issue.responsibleAgent ? <span>Agent: {issue.responsibleAgent}</span> : null}
      {issue.resolutionState ? (
        <span>· State: {issue.resolutionState.replace(/_/g, ' ')}</span>
      ) : null}
      {issue.evidence ? <span className="truncate max-w-full">· {issue.evidence}</span> : null}
    </div>
  );

  const renderIssueActions = (issue: QAIssue) => {
    if (!issue.segmentId && !issue.clipId) return null;
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => jumpToAudioStudioClip(issue.clipId ?? null, issue.segmentId)}
          className="min-h-[30px] px-2.5 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-[11px] font-medium inline-flex items-center gap-1"
        >
          <AudioWaveform className="w-3 h-3" aria-hidden="true" />
          <span>Open in Audio Studio</span>
        </button>
        {issue.segmentId ? (
          <button
            type="button"
            onClick={() => setActiveScreen('translation')}
            className="min-h-[30px] px-2.5 py-1 rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-[11px] font-medium inline-flex items-center gap-1"
          >
            <FileText className="w-3 h-3" aria-hidden="true" />
            <span>Edit in Translation</span>
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Quality Assurance"
        subtitle={`Project: ${project.name} · Full acoustic PCM verification (peak/RMS dBFS, zero-clipping, WAV integrity), sound preservation, timing sync, and semantic consistency audit.`}
        action={
          <button
            type="button"
            disabled={running}
            onClick={() => void handleRunQA()}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <CheckSquare className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{running ? 'Running Full QA…' : 'Run Full Acoustic & Semantic QA'}</span>
          </button>
        }
      />

      {/* QA Overview KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Checked Segments</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums">
            {latestReport ? latestReport.checkedSegmentCount : segments.length}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {latestReport
              ? `Last run ${formatShortDate(latestReport.createdAt)}`
              : 'Audit not run yet'}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Failed Items</p>
          <p className="mt-2 text-2xl font-semibold text-red-700 tabular-nums">
            {failedIssues.length}
          </p>
          <p className="mt-1 text-xs text-slate-500">Blocking acoustic or translation errors</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Warnings</p>
          <p className="mt-2 text-2xl font-semibold text-amber-700 tabular-nums">
            {warningIssues.length}
          </p>
          <p className="mt-1 text-xs text-slate-500">Timing drift, unmixed stems, or loudness notes</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Review Required</p>
          <p className="mt-2 text-2xl font-semibold text-blue-700 tabular-nums">
            {reviewIssues.length}
          </p>
          <p className="mt-1 text-xs text-slate-500">Character identity, voices, or translation disagreements</p>
        </div>
      </div>

      {/* Acoustic QA Metrics Card */}
      {acoustic ? (
        <Surface>
          <SectionTitle
            title="Measured Acoustic QA Metrics"
            meta={`Verified directly on PCM waveform (${acoustic.measuredStemVaultKey ?? 'active audio stem'})`}
            action={
              <StatusText
                label={
                  acoustic.clippingSampleCount === 0 && acoustic.exportIntegrityVerified
                    ? 'Acoustic Pass'
                    : 'Acoustic Attention Needed'
                }
                tone={
                  acoustic.clippingSampleCount === 0 && acoustic.exportIntegrityVerified
                    ? 'nominal'
                    : 'error'
                }
              />
            }
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <KeyValueList
              items={[
                {
                  label: 'Master Format',
                  value: `${acoustic.channels ?? 1}ch ${
                    (acoustic.channels ?? 1) >= 2 ? 'Stereo' : 'Mono'
                  } · ${acoustic.sampleRate ?? 0} Hz`,
                  mono: true,
                },
                {
                  label: 'True Peak Level',
                  value: `${acoustic.peakDbfs} dBFS`,
                  mono: true,
                },
                {
                  label: 'Integrated RMS Level',
                  value: `${acoustic.rmsDbfs} dBFS`,
                  mono: true,
                },
                {
                  label: 'Clipping Samples (|x| ≥ 0.995)',
                  value: `${acoustic.clippingSampleCount}`,
                  mono: true,
                },
              ]}
            />
            <KeyValueList
              items={[
                {
                  label: 'Measured Silence Ratio',
                  value: `${Math.round(acoustic.silenceRatio * 100)}%`,
                  mono: true,
                },
                {
                  label: 'Residual Dialogue Leakage',
                  value:
                    latestReport?.residualDialogueLeakageDb !== null &&
                    latestReport?.residualDialogueLeakageDb !== undefined
                      ? `${latestReport.residualDialogueLeakageDb} dB`
                      : 'Unmeasured',
                  mono: true,
                },
                {
                  label: 'WAV Export Integrity',
                  value: acoustic.exportIntegrityVerified ? 'Verified RIFF/PCM' : 'Unverified',
                },
                {
                  label: 'QA Auto-Correction Cycles',
                  value: `${latestReport?.correctionCyclesRun ?? 0} / 2 max`,
                  mono: true,
                },
              ]}
            />
          </div>
          {latestReport?.semanticQAResult ? (
            <div className="mt-4 pt-3 border-t border-slate-100 text-xs text-slate-600 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-slate-800">
                  Independent Semantic QA Pass
                </span>
                <StatusText
                  label={
                    latestReport.semanticQAResult.executed
                      ? `Executed (${latestReport.semanticQAResult.engine ?? 'Gemini'})`
                      : 'Not Executed'
                  }
                  tone={latestReport.semanticQAResult.executed ? 'nominal' : 'muted'}
                />
              </div>
              <p className="leading-relaxed">
                {latestReport.semanticReviewSummary}
              </p>
            </div>
          ) : null}
        </Surface>
      ) : null}

      {latestReport?.checksEvaluated && latestReport.checksEvaluated.length > 0 ? (
        <Surface>
          <SectionTitle
            title={`18-Point Production QA Checklist (${latestReport.checksEvaluated.length} Evaluated)`}
            meta="Each criterion reports measured evidence independently — zero silent skips"
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
            {latestReport.checksEvaluated.map((chk) => (
              <div
                key={chk.id}
                className="flex items-start justify-between gap-3 p-2.5 rounded-lg border border-slate-200 bg-slate-50/50 text-xs"
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">{chk.label}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5 break-words">{chk.evidence}</p>
                </div>
                <StatusText
                  label={chk.status.replace('_', ' ')}
                  tone={
                    chk.status === 'passed'
                      ? 'nominal'
                      : chk.status === 'failed'
                      ? 'error'
                      : chk.status === 'warning' || chk.status === 'review_required'
                      ? 'warning'
                      : 'muted'
                  }
                />
              </div>
            ))}
          </div>
        </Surface>
      ) : null}

      {latestReport ? (
        <NoticeBanner
          tone="info"
          title="QA Audit Summary"
          description={latestReport.engineNote}
        />
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <Surface className="lg:col-span-6">
          <SectionTitle
            title="Segment-Level QA Status"
            meta="Evaluates translation, timing tolerance, voice assignment, and real WAV audio"
          />
          {segments.length === 0 ? (
            <EmptyState
              title="No dialogue segments to evaluate"
              description="Add dialogue segments in Translation Studio or run the pipeline, then run Full Acoustic & Semantic QA."
              actionLabel="Open Translation Studio"
              onAction={() => setActiveScreen('translation')}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-3 font-medium">Segment</th>
                    <th className="py-2 pr-3 font-medium">Window</th>
                    <th className="py-2 pr-3 font-medium">Sync</th>
                    <th className="py-2 font-medium text-right">QA Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {segments.map((seg) => (
                    <tr key={seg.segmentId}>
                      <td className="py-2.5 pr-3 font-mono text-slate-900">
                        <button
                          type="button"
                          onClick={() => jumpToAudioStudioClip(null, seg.segmentId)}
                          className="hover:text-blue-700 underline-offset-2 hover:underline"
                        >
                          {seg.segmentId}
                        </button>
                      </td>
                      <td className="py-2.5 pr-3 font-mono tabular-nums text-slate-600">
                        {formatTimecode(seg.finalStartMs)} – {formatTimecode(seg.finalEndMs)}
                      </td>
                      <td className="py-2.5 pr-3 text-slate-600">
                        {seg.timingMatchLabel ?? seg.syncStatus}
                      </td>
                      <td className="py-2.5 text-right">
                        <StatusText
                          label={seg.qaStatus.replace('_', ' ')}
                          tone={
                            seg.qaStatus === 'passed'
                              ? 'nominal'
                              : seg.qaStatus === 'failed'
                              ? 'error'
                              : seg.qaStatus === 'warning' || seg.qaStatus === 'needs_review'
                              ? 'warning'
                              : 'muted'
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Surface>

        <Surface className="lg:col-span-6 space-y-5">
          <div>
            <SectionTitle
              title={`Failed Segments & Blocking Errors (${failedIssues.length})`}
              meta="Must be resolved prior to final export"
            />
            {failedIssues.length === 0 ? (
              <p className="text-xs text-slate-500">No blocking errors flagged in latest report.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-xs">
                {failedIssues.map((issue) => (
                  <li key={issue.id} className="py-2.5 text-red-800">
                    <div>
                      <span className="font-semibold capitalize">
                        {issue.category.replace('_', ' ')}:
                      </span>{' '}
                      {issue.message}
                    </div>
                    {renderIssueMeta(issue)}
                    {renderIssueActions(issue)}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="pt-4 border-t border-slate-100">
            <SectionTitle
              title={`Warnings (${warningIssues.length})`}
              meta="Timing drift, unmixed audio stems, or acoustic balance notices"
            />
            {warningIssues.length === 0 ? (
              <p className="text-xs text-slate-500">No warnings recorded.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-xs">
                {warningIssues.map((issue) => (
                  <li key={issue.id} className="py-2.5 text-amber-900">
                    <div>
                      <span className="font-semibold capitalize">
                        {issue.category.replace('_', ' ')}:
                      </span>{' '}
                      {issue.message}
                    </div>
                    {renderIssueMeta(issue)}
                    {renderIssueActions(issue)}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="pt-4 border-t border-slate-100">
            <SectionTitle
              title={`Review-Required Items (${reviewIssues.length})`}
              meta="Ambiguous characters, unassigned voices, or collaborative translation disagreements"
            />
            {reviewIssues.length === 0 ? (
              <p className="text-xs text-slate-500">No review-required items queued.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-xs">
                {reviewIssues.map((issue) => (
                  <li key={issue.id} className="py-2.5 text-slate-800">
                    <div>
                      <span className="font-semibold capitalize">
                        {issue.category.replace('_', ' ')}:
                      </span>{' '}
                      {issue.message}
                    </div>
                    {renderIssueMeta(issue)}
                    {renderIssueActions(issue)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Surface>
      </div>
    </div>
  );
}
