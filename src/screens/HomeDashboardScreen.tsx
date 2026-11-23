import React from 'react';
import { ArrowRight, AudioWaveform } from 'lucide-react';
import { useStudio } from '../state/StudioContext';
import {
  EmptyState,
  formatShortDate,
  mapProjectStatusTone,
  PageHeader,
  SectionTitle,
  StatusText,
  Surface,
} from '../components/StudioPrimitives';
import { formatBytes } from '../core/storage/mediaInspector';
import { AGENT_REGISTRY } from '../core/agents/registry';

export function HomeDashboardScreen() {
  const {
    projects,
    allJobs,
    models,
    resources,
    settings,
    geminiStatus,
    setActiveProjectId,
    setActiveScreen,
    isPipelineRunning,
  } = useStudio();

  const resumableProjects = projects.filter(
    (p) =>
      p.status === 'imported' ||
      p.status === 'paused' ||
      p.status === 'interrupted' ||
      p.status === 'needs_review' ||
      p.status === 'processing'
  );
  const completedProjects = projects.filter((p) => p.status === 'completed');
  const failedOrInterruptedJobs = allJobs.filter(
    (j) => j.status === 'Failed' || j.status === 'Cancelled' || j.status === 'Paused'
  );
  const installedModelsCount = models.filter(
    (m) => m.installStatus === 'installed_verified'
  ).length;
  const operationalAgentsCount = AGENT_REGISTRY.filter(
    (a) => a.isIntegrated
  ).length;

  const openProjectInScreen = async (
    projectId: string,
    screen: 'projects' | 'processing' | 'audio_studio'
  ) => {
    await setActiveProjectId(projectId);
    setActiveScreen(screen);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Home Dashboard"
        subtitle="Local-first Japanese → Hindi dubbing workstation. All media and project databases stay on this device."
        action={
          <button
            type="button"
            onClick={() => setActiveScreen('audio_studio')}
            className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-800 inline-flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
          >
            <AudioWaveform className="w-3.5 h-3.5 text-slate-600" aria-hidden="true" />
            <span>Open Audio Studio</span>
          </button>
        }
      />

      {/* Top 4 KPI Summary Strip (clean single-level grid, tabular numerals, zero pills) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Processing Status</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums">
            {isPipelineRunning ? 'Running' : `${operationalAgentsCount} / 25`}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {isPipelineRunning
              ? 'Master Orchestrator active'
              : `All 25 AI & audio production agents operational · ${
                  settings.offlineOnlyMode
                    ? 'Offline Mode'
                    : geminiStatus?.configured
                    ? 'Hybrid Gemini Ready'
                    : 'Local Ready'
                }`}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Available Local Storage</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 font-mono tabular-nums">
            {resources ? formatBytes(resources.storage.availableBytes) : 'Measuring…'}
          </p>
          <p className="mt-1 text-xs text-slate-500 tabular-nums">
            {resources?.storage.usageBytes !== null && resources
              ? `${formatBytes(resources.storage.usageBytes)} used in local origin`
              : 'Origin storage estimate unavailable'}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Installed Models</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums">
            {installedModelsCount} / {models.length}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Offline ONNX/TFLite weights + built-in acoustic DSP modules
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Local Projects</p>
          <p className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums">
            {projects.length}
          </p>
          <p className="mt-1 text-xs text-slate-500 tabular-nums">
            {completedProjects.length} completed · {resumableProjects.length} resumable ·{' '}
            {failedOrInterruptedJobs.length} interrupted
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Recent Projects & Continue Processing */}
        <div className="lg:col-span-7 space-y-6">
          <Surface>
            <SectionTitle
              title="Recent Projects"
              meta="Stored in local IndexedDB with separated original media"
              action={
                <button
                  type="button"
                  onClick={() => setActiveScreen('projects')}
                  className="text-xs font-medium text-blue-700 hover:text-blue-800 inline-flex items-center gap-1 whitespace-nowrap"
                >
                  <span>View all</span>
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              }
            />

            {projects.length === 0 ? (
              <EmptyState
                title="No local dubbing projects yet"
                description="Create a project and import an anime episode or audio file to initialize metadata probing, overlapping chunk plans, and timeline tracks."
                actionLabel="Create First Project"
                onAction={() => setActiveScreen('import')}
              />
            ) : (
              <ul className="divide-y divide-slate-100">
                {projects.slice(0, 5).map((project) => (
                  <li
                    key={project.id}
                    className="py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => void openProjectInScreen(project.id, 'projects')}
                        className="text-sm font-semibold text-slate-900 hover:text-blue-700 text-left truncate block max-w-full"
                      >
                        {project.name}
                      </button>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500">
                        <span>{project.seriesTitle}</span>
                        <span aria-hidden="true">·</span>
                        <span>{project.episodeLabel}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono uppercase">
                          {project.sourceLanguage}→{project.targetLanguage}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">{formatShortDate(project.updatedAt)}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <StatusText
                        label={project.status.replace('_', ' ')}
                        tone={mapProjectStatusTone(project.status)}
                      />
                      <button
                        type="button"
                        onClick={() => void openProjectInScreen(project.id, 'processing')}
                        className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap"
                      >
                        Pipeline
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Surface>

          <Surface>
            <SectionTitle
              title="Continue Processing"
              meta="Projects with imported media or saved recovery checkpoints"
            />
            {resumableProjects.length === 0 ? (
              <p className="text-xs text-slate-500">
                No projects currently waiting to resume. Import media into a project to start the dependency-aware pipeline.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {resumableProjects.slice(0, 4).map((project) => (
                  <li
                    key={project.id}
                    className="py-3 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">
                        {project.name}
                      </p>
                      <p className="text-xs text-slate-500 truncate mt-0.5">
                        {project.lastStageLabel}
                        {project.lastCheckpointId
                          ? ` · Checkpoint ${project.lastCheckpointId.slice(-8)}`
                          : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void openProjectInScreen(project.id, 'processing')}
                      className="min-h-[36px] px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium whitespace-nowrap shrink-0"
                    >
                      Continue
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Surface>
        </div>

        {/* Right Column: Completed, Interrupted Jobs, and Model Summary */}
        <div className="lg:col-span-5 space-y-6">
          <Surface>
            <SectionTitle
              title="Failed or Interrupted Jobs"
              meta="Jobs preserved safely for checkpoint-based retry"
            />
            {failedOrInterruptedJobs.length === 0 ? (
              <p className="text-xs text-slate-500">
                No failed, paused, or cancelled jobs recorded in the local job store.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {failedOrInterruptedJobs.slice(0, 5).map((job) => (
                  <li key={job.jobId} className="py-3 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono text-slate-700 truncate">
                        {job.jobId}
                      </span>
                      <StatusText
                        label={job.status}
                        tone={job.status === 'Failed' ? 'error' : 'warning'}
                      />
                    </div>
                    <p className="text-xs text-slate-600">{job.currentStage}</p>
                    {job.errorMessage ? (
                      <p className="text-xs text-red-700">{job.errorMessage}</p>
                    ) : null}
                    <div className="pt-1">
                      <button
                        type="button"
                        onClick={() => void openProjectInScreen(job.projectId, 'processing')}
                        className="text-xs font-medium text-blue-700 hover:text-blue-800"
                      >
                        Inspect & retry from checkpoint →
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Surface>

          <Surface>
            <SectionTitle
              title="Completed Projects"
              meta="Projects whose full dubbing & QA export pipeline completed"
            />
            {completedProjects.length === 0 ? (
              <p className="text-xs text-slate-500">
                0 completed projects yet. Run the 25-agent pipeline and render the final Hindi dub master in Audio Studio to mark a project ready for export.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {completedProjects.map((p) => (
                  <li key={p.id} className="py-2.5 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-slate-900 truncate">{p.name}</span>
                    <button
                      type="button"
                      onClick={() => void openProjectInScreen(p.id, 'audio_studio')}
                      className="text-xs font-medium text-blue-700 hover:text-blue-800 whitespace-nowrap"
                    >
                      Open Studio
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Surface>

          <Surface>
            <SectionTitle
              title="Installed Model Summary"
              meta="Offline-capable model slots"
              action={
                <button
                  type="button"
                  onClick={() => setActiveScreen('models')}
                  className="text-xs font-medium text-blue-700 hover:text-blue-800 whitespace-nowrap"
                >
                  Model Manager
                </button>
              }
            />
            <p className="text-xs text-slate-600 leading-relaxed">
              {installedModelsCount} of {models.length} registered models and DSP engines are ready offline. Download Whisper Small ONNX, PyAnnote Segmentation, MediaPipe BlazeFace, NLLB-200-600M, Meta MMS-TTS Hindi, or Qwen2.5-0.5B-Instruct Local LLM in Model Manager for full offline Japanese → Hindi dubbing.
            </p>
          </Surface>
        </div>
      </div>
    </div>
  );
}
