import React, { useState } from 'react';
import { Play, RotateCcw, Square } from 'lucide-react';
import { AGENT_REGISTRY } from '../core/agents/registry';
import type { AgentDefinition, PipelineStageGroup } from '../core/agents/types';
import { useStudio } from '../state/StudioContext';
import {
  EmptyState,
  formatShortDate,
  PageHeader,
  SectionTitle,
  StatusText,
  Surface,
  type SemanticTone,
} from '../components/StudioPrimitives';
import { formatBytes } from '../core/storage/mediaInspector';

function mapAgentStatusToDisplay(status: string): { label: string; tone: SemanticTone } {
  switch (status) {
    case 'completed':
      return { label: 'Completed', tone: 'nominal' };
    case 'completed_with_warnings':
      return { label: 'Completed (Warnings)', tone: 'warning' };
    case 'needs_review':
      return { label: 'Needs Review', tone: 'warning' };
    case 'waiting_for_model':
      return { label: 'Waiting for Model', tone: 'warning' };
    case 'running':
      return { label: 'Running', tone: 'active' };
    case 'failed':
      return { label: 'Failed', tone: 'error' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'warning' };
    case 'not_integrated':
      return { label: 'Prompt 3 Pending', tone: 'muted' };
    case 'ready':
      return { label: 'Ready', tone: 'active' };
    default:
      return { label: 'Pending', tone: 'muted' };
  }
}

export function ProcessingCenterScreen() {
  const {
    activeBundle,
    activePlan,
    isPipelineRunning,
    resources,
    runFoundationPipeline,
    cancelActivePipeline,
    setActiveScreen,
  } = useStudio();

  const [selectedAgent, setSelectedAgent] = useState<AgentDefinition>(AGENT_REGISTRY[0]);
  const [stageFilter, setStageFilter] = useState<string>('all');

  if (!activeBundle) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Processing Center"
          subtitle="Master Orchestrator DAG execution, 25-agent status tracking, checkpoints, logs, and 8 GB RAM scheduling telemetry."
        />
        <EmptyState
          title="No active project selected"
          description="Create or select a project to run the dependency-aware Master Orchestrator pipeline and inspect all 25 logical agents."
          actionLabel="Create Project"
          onAction={() => setActiveScreen('import')}
        />
      </div>
    );
  }

  const { project, jobs, agentExecutions, checkpoints, logs } = activeBundle;
  const latestJob = jobs[0] ?? null;

  const execByAgent = new Map<
    string,
    {
      status: string;
      outputSummary: string;
      errorMessage: string | null;
      retryCount: number;
      lastRetryReason: string | null;
      executionEngine: string | null;
    }
  >();
  if (activePlan && activePlan.projectId === project.id) {
    for (const id of activePlan.topologicalOrder) {
      const t = activePlan.tasks[id];
      execByAgent.set(id, {
        status: t.status,
        outputSummary: t.outputSummary,
        errorMessage: t.errorMessage,
        retryCount: t.retryCount ?? 0,
        lastRetryReason: t.lastRetryReason ?? null,
        executionEngine: t.executionEngine ?? null,
      });
    }
  } else if (latestJob) {
    for (const rec of agentExecutions.filter((e) => e.jobId === latestJob.jobId)) {
      execByAgent.set(rec.agentId, {
        status: rec.status,
        outputSummary: rec.outputSummary,
        errorMessage: rec.errorMessage,
        retryCount: rec.retryCount ?? 0,
        lastRetryReason: rec.lastRetryReason ?? null,
        executionEngine: rec.executionEngine ?? null,
      });
    }
  }
  const latestQaCycles = activeBundle.qaReports[0]?.correctionCyclesRun ?? 0;

  const completedCount = AGENT_REGISTRY.filter((a) => {
    const st = execByAgent.get(a.id)?.status;
    return st === 'completed' || st === 'completed_with_warnings' || st === 'needs_review';
  }).length;
  const waitingForModelCount = AGENT_REGISTRY.filter(
    (a) => execByAgent.get(a.id)?.status === 'waiting_for_model'
  ).length;
  const failedCount = AGENT_REGISTRY.filter(
    (a) => execByAgent.get(a.id)?.status === 'failed'
  ).length;
  const notIntegratedCount = AGENT_REGISTRY.filter((a) => {
    const st = execByAgent.get(a.id)?.status;
    return st === 'not_integrated' || (!st && !a.isIntegrated);
  }).length;
  const pendingCount = Math.max(
    0,
    25 - completedCount - waitingForModelCount - failedCount - notIntegratedCount
  );

  const stageGroups: PipelineStageGroup[] = [
    'Orchestration & Resilience',
    'Media Ingestion & Structure',
    'Visual & Speaker Intelligence',
    'Identity & Memory',
    'Language, Context & Emotion',
    'Voice & Timing Synthesis',
    'Audio Preservation, Mixing & QA',
  ];

  const filteredAgents =
    stageFilter === 'all'
      ? AGENT_REGISTRY
      : AGENT_REGISTRY.filter((a) => a.stageGroup === stageFilter);

  const hasCheckpoint = checkpoints.some((c) => c.valid);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Processing Center"
        subtitle={`Project: ${project.name} · Centralized Master Orchestrator governing all 25 specialized logical agents.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            {isPipelineRunning ? (
              <button
                type="button"
                onClick={() => cancelActivePipeline(project.id)}
                className="min-h-[40px] px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 text-white text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <Square className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Cancel Run</span>
              </button>
            ) : (
              <>
                {hasCheckpoint ? (
                  <button
                    type="button"
                    onClick={() => void runFoundationPipeline(project.id, true)}
                    className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Resume from Checkpoint</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void runFoundationPipeline(project.id, false)}
                  className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Play className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{latestJob ? 'Run AI Pipeline Again' : 'Run AI Dubbing Pipeline'}</span>
                </button>
              </>
            )}
          </div>
        }
      />

      {/* Overall Job & Resource Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Pipeline Progress</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums">
            {completedCount} / 25
          </p>
          <div className="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-700 transition-all"
              style={{ width: `${Math.round((completedCount / 25) * 100)}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            {latestJob
              ? latestJob.currentStage
              : 'All 25 agents operational (analysis, collaborative translation, TTS, separation, mixing & QA)'}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Task Breakdown</p>
          <p className="mt-2 text-sm font-semibold text-slate-900 tabular-nums">
            {completedCount} finished · {waitingForModelCount} waiting model
          </p>
          <p className="mt-1 text-xs text-slate-600 tabular-nums">
            {failedCount} failed · {pendingCount} ready/pending · {latestJob?.retryCount ?? 0} retries ·{' '}
            {latestQaCycles} QA auto-fix cycle(s)
          </p>
          {waitingForModelCount > 0 ? (
            <button
              type="button"
              onClick={() => setActiveScreen('models')}
              className="mt-1.5 text-xs font-medium text-blue-700 hover:text-blue-800"
            >
              Download required models in Model Manager →
            </button>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              Bounded transient retries + max 2 QA correction cycles
            </p>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">8 GB RAM Concurrency Policy</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {resources ? `Max ${resources.maxHeavyConcurrency} Heavy` : 'Max 1 Heavy'}
          </p>
          <p className="mt-1 text-xs text-slate-500 tabular-nums">
            Active model RAM: {resources ? `${resources.activeModelMemoryMb} MB` : '0 MB'} ·{' '}
            {resources?.deviceMemoryGb ? `${resources.deviceMemoryGb} GB reported` : 'Device RAM API unavailable'}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Checkpoints & Storage</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums">
            {checkpoints.length} saved
          </p>
          <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            Free: {resources ? formatBytes(resources.storage.availableBytes) : 'Measuring…'}
          </p>
        </div>
      </div>

      {/* 25-Agent Registry & Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <Surface className="lg:col-span-7">
          <SectionTitle
            title="25 Logical Agents & Dependency Graph"
            meta="Select any agent to inspect contracts, dependencies, and recovery policy"
          />

          <div className="flex flex-wrap gap-1.5 mb-4">
            <button
              type="button"
              onClick={() => setStageFilter('all')}
              className={`min-h-[34px] px-3 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                stageFilter === 'all'
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              All (25)
            </button>
            {stageGroups.map((group) => (
              <button
                key={group}
                type="button"
                onClick={() => setStageFilter(group)}
                className={`min-h-[34px] px-3 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  stageFilter === group
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {group}
              </button>
            ))}
          </div>

          <ul className="divide-y divide-slate-100 max-h-[560px] overflow-y-auto pr-1">
            {filteredAgents.map((agent) => {
              const runtime = execByAgent.get(agent.id);
              const effectiveStatus =
                runtime?.status ?? (agent.isIntegrated ? 'ready' : 'not_integrated');
              const display = mapAgentStatusToDisplay(effectiveStatus);
              const isSelected = selectedAgent.id === agent.id;

              return (
                <li key={agent.id} className="py-2 first:pt-0 last:pb-0">
                  <button
                    type="button"
                    onClick={() => setSelectedAgent(agent)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      isSelected
                        ? 'bg-blue-50/60 border-blue-200'
                        : 'bg-white border-transparent hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-slate-900 truncate">
                        <span className="font-mono text-xs text-slate-400 mr-2 tabular-nums">
                          {String(agent.number).padStart(2, '0')}.
                        </span>
                        {agent.name}
                      </span>
                      <StatusText label={display.label} tone={display.tone} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                      <span>{agent.stageGroup}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{agent.memoryTier}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">~{agent.estimatedPeakRamMb} MB peak</span>
                      {runtime?.executionEngine ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-slate-700 font-medium truncate max-w-[260px]">
                            {runtime.executionEngine}
                          </span>
                        </>
                      ) : null}
                      {runtime && runtime.retryCount > 0 ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-amber-700 font-medium tabular-nums">
                            {runtime.retryCount} retr{runtime.retryCount === 1 ? 'y' : 'ies'}
                          </span>
                        </>
                      ) : null}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Surface>

        {/* Agent Contract Inspector + Live Logs */}
        <div className="lg:col-span-5 space-y-6">
          <Surface>
            <SectionTitle
              title={`Agent #${String(selectedAgent.number).padStart(2, '0')}: ${selectedAgent.name}`}
              meta={selectedAgent.integrationMilestone}
            />
            <div className="space-y-3 text-xs">
              <div>
                <p className="font-medium text-slate-500">Responsibility</p>
                <p className="mt-1 text-slate-800 leading-relaxed">
                  {selectedAgent.responsibility}
                </p>
              </div>
              <div className="pt-2 border-t border-slate-100">
                <p className="font-medium text-slate-500">Input Contract</p>
                <p className="mt-1 font-mono text-[11px] text-slate-800 bg-slate-50 p-2 rounded-lg border border-slate-200 break-words">
                  {selectedAgent.inputContract}
                </p>
              </div>
              <div>
                <p className="font-medium text-slate-500">Output Contract</p>
                <p className="mt-1 font-mono text-[11px] text-slate-800 bg-slate-50 p-2 rounded-lg border border-slate-200 break-words">
                  {selectedAgent.outputContract}
                </p>
              </div>
              <div className="pt-2 border-t border-slate-100">
                <p className="font-medium text-slate-500">Dependencies ({selectedAgent.dependsOn.length})</p>
                <p className="mt-1 font-mono text-slate-700">
                  {selectedAgent.dependsOn.length > 0
                    ? selectedAgent.dependsOn.join(', ')
                    : 'None (Root Orchestrator)'}
                </p>
              </div>
              <div className="pt-2 border-t border-slate-100">
                <p className="font-medium text-slate-500">Cancellation Strategy</p>
                <p className="mt-1 text-slate-700 leading-relaxed">
                  {selectedAgent.cancellationStrategy}
                </p>
              </div>
              <div className="pt-2 border-t border-slate-100">
                <p className="font-medium text-slate-500">Recovery Strategy</p>
                <p className="mt-1 text-slate-700 leading-relaxed">
                  {selectedAgent.recoveryStrategy}
                </p>
              </div>
              {execByAgent.get(selectedAgent.id)?.executionEngine ? (
                <div className="pt-2 border-t border-slate-100">
                  <p className="font-medium text-slate-500">Active Engine / Fallback</p>
                  <p className="mt-1 font-mono text-[11px] text-slate-900">
                    {execByAgent.get(selectedAgent.id)?.executionEngine}
                  </p>
                </div>
              ) : null}
              {(execByAgent.get(selectedAgent.id)?.retryCount ?? 0) > 0 ? (
                <div className="pt-2 border-t border-slate-100">
                  <p className="font-medium text-amber-700">
                    Transient Retries ({execByAgent.get(selectedAgent.id)?.retryCount})
                  </p>
                  <p className="mt-1 text-amber-800">
                    {execByAgent.get(selectedAgent.id)?.lastRetryReason}
                  </p>
                </div>
              ) : null}
              {execByAgent.get(selectedAgent.id)?.outputSummary ? (
                <div className="pt-2 border-t border-slate-100">
                  <p className="font-medium text-slate-500">Latest Execution Output</p>
                  <p className="mt-1 text-slate-900">
                    {execByAgent.get(selectedAgent.id)?.outputSummary}
                  </p>
                </div>
              ) : null}
            </div>
          </Surface>

          <Surface>
            <SectionTitle
              title={`Processing Logs (${logs.length})`}
              meta="Persisted locally in processing_logs store"
            />
            {logs.length === 0 ? (
              <p className="text-xs text-slate-500">
                No logs recorded yet. Run the foundation pipeline to observe real Master Orchestrator scheduling events.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 max-h-72 overflow-y-auto text-xs">
                {logs.slice(0, 30).map((log) => (
                  <li key={log.id} className="py-2 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`font-medium ${
                          log.level === 'error'
                            ? 'text-red-700'
                            : log.level === 'warning'
                            ? 'text-amber-700'
                            : 'text-slate-700'
                        }`}
                      >
                        {log.agentId ?? 'system'}
                      </span>
                      <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                        {formatShortDate(log.timestamp)}
                      </span>
                    </div>
                    <p className="text-slate-600 leading-snug">{log.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </Surface>
        </div>
      </div>
    </div>
  );
}
