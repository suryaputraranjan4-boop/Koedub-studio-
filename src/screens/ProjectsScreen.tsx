import React, { useState } from 'react';
import { Edit3, Play, Trash2 } from 'lucide-react';
import { useStudio } from '../state/StudioContext';
import {
  EmptyState,
  formatShortDate,
  KeyValueList,
  mapProjectStatusTone,
  PageHeader,
  SectionTitle,
  StatusText,
  Surface,
} from '../components/StudioPrimitives';
import { formatBytes } from '../core/storage/mediaInspector';
import { formatTimecode } from '../core/timeline/timelineEngine';

export function ProjectsScreen() {
  const {
    projects,
    activeProjectId,
    activeBundle,
    setActiveProjectId,
    setActiveScreen,
    renameProject,
    deleteProject,
    runFoundationPipeline,
    isPipelineRunning,
  } = useStudio();

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleteOriginalMedia, setDeleteOriginalMedia] = useState(false);

  const selectedProject = activeBundle?.project ?? null;

  const startRename = (id: string, currentName: string) => {
    setRenamingId(id);
    setRenameDraft(currentName);
  };

  const commitRename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renamingId || !renameDraft.trim()) return;
    await renameProject(renamingId, renameDraft);
    setRenamingId(null);
    setRenameDraft('');
  };

  const confirmDelete = async () => {
    if (!deleteTargetId) return;
    await deleteProject(deleteTargetId, deleteOriginalMedia);
    setDeleteTargetId(null);
    setDeleteOriginalMedia(false);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        subtitle="Manage local dubbing projects, inspect checkpoints, resume interrupted runs, and review version history."
      />

      {projects.length === 0 ? (
        <EmptyState
          title="No projects stored locally"
          description="Start by creating a project in Media Import. Your project metadata, checkpoints, and original media are stored locally in IndexedDB."
          actionLabel="Import Media & Create Project"
          onAction={() => setActiveScreen('import')}
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Project List */}
          <Surface className="lg:col-span-5">
            <SectionTitle
              title={`Project Directory (${projects.length})`}
              meta="Select a project to inspect details and history"
            />
            <ul className="divide-y divide-slate-100">
              {projects.map((project) => {
                const isSelected = project.id === activeProjectId;
                return (
                  <li key={project.id} className="py-3 first:pt-0 last:pb-0">
                    <div
                      className={`p-3 rounded-lg border transition-colors ${
                        isSelected
                          ? 'bg-blue-50/60 border-blue-200'
                          : 'bg-white border-transparent hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => void setActiveProjectId(project.id)}
                          className="text-left min-w-0 flex-1"
                        >
                          <p className="text-sm font-semibold text-slate-900 truncate">
                            {project.name}
                          </p>
                          <p className="text-xs text-slate-500 mt-0.5 truncate">
                            {project.seriesTitle} · {project.episodeLabel} ·{' '}
                            <span className="font-mono uppercase">
                              {project.sourceLanguage}→{project.targetLanguage}
                            </span>
                          </p>
                        </button>
                        <StatusText
                          label={project.status.replace('_', ' ')}
                          tone={mapProjectStatusTone(project.status)}
                        />
                      </div>

                      <div className="mt-2.5 flex items-center justify-between gap-2 text-xs text-slate-500">
                        <span className="truncate">{project.lastStageLabel}</span>
                        <span className="tabular-nums shrink-0">
                          {formatShortDate(project.updatedAt)}
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Surface>

          {/* Selected Project Details */}
          <div className="lg:col-span-7 space-y-6">
            {selectedProject && activeBundle ? (
              <>
                <Surface>
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 pb-4 border-b border-slate-100">
                    <div className="min-w-0">
                      {renamingId === selectedProject.id ? (
                        <form onSubmit={(e) => void commitRename(e)} className="flex items-center gap-2">
                          <label htmlFor="rename-project-input" className="sr-only">
                            New project name
                          </label>
                          <input
                            id="rename-project-input"
                            type="text"
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            className="h-9 px-3 rounded-lg border border-slate-300 text-sm text-slate-900"
                            autoFocus
                          />
                          <button
                            type="submit"
                            className="min-h-[36px] px-3 py-1.5 rounded-lg bg-blue-700 text-white text-xs font-medium whitespace-nowrap"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setRenamingId(null)}
                            className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 whitespace-nowrap"
                          >
                            Cancel
                          </button>
                        </form>
                      ) : (
                        <>
                          <h2 className="text-lg font-semibold text-slate-900">
                            {selectedProject.name}
                          </h2>
                          <p className="text-xs text-slate-500 mt-0.5 font-mono">
                            {selectedProject.id} · {selectedProject.workingDirectoryPath}
                          </p>
                        </>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => startRename(selectedProject.id, selectedProject.name)}
                        aria-label={`Rename ${selectedProject.name}`}
                        className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Rename</span>
                      </button>

                      <button
                        type="button"
                        disabled={isPipelineRunning}
                        onClick={async () => {
                          setActiveScreen('processing');
                          await runFoundationPipeline(
                            selectedProject.id,
                            Boolean(selectedProject.lastCheckpointId)
                          );
                        }}
                        className="min-h-[38px] px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-xs font-medium text-white inline-flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <Play className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>
                          {selectedProject.lastCheckpointId ? 'Resume Pipeline' : 'Run Pipeline'}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setDeleteTargetId(selectedProject.id)}
                        aria-label={`Delete ${selectedProject.name}`}
                        className="min-h-[38px] px-3 py-1.5 rounded-lg border border-red-200 hover:bg-red-50 text-xs font-medium text-red-700 inline-flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Delete</span>
                      </button>
                    </div>
                  </div>

                  {/* Delete Confirmation Inline Panel */}
                  {deleteTargetId === selectedProject.id ? (
                    <div
                      role="alertdialog"
                      aria-label="Confirm project deletion"
                      className="mt-4 p-4 rounded-xl bg-red-50 border border-red-200 space-y-3"
                    >
                      <p className="text-sm font-semibold text-red-900">
                        Delete project &ldquo;{selectedProject.name}&rdquo;?
                      </p>
                      <p className="text-xs text-red-800 leading-relaxed">
                        This removes project metadata, segments, jobs, checkpoints, and temporary processing files. Permanent Character Memory profiles remain preserved for future episodes.
                      </p>
                      <label className="flex items-start gap-2.5 text-xs text-red-900 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={deleteOriginalMedia}
                          onChange={(e) => setDeleteOriginalMedia(e.target.checked)}
                          className="mt-0.5 rounded border-red-300"
                        />
                        <span>
                          Also remove preserved original imported media blob from local storage (unchecked keeps original media protected).
                        </span>
                      </label>
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => void confirmDelete()}
                          className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-red-700 hover:bg-red-800 text-white text-xs font-medium whitespace-nowrap"
                        >
                          Confirm Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTargetId(null)}
                          className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-white border border-slate-300 text-slate-700 text-xs font-medium whitespace-nowrap"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-4">
                    <KeyValueList
                      items={[
                        { label: 'Status', value: selectedProject.status.replace('_', ' ') },
                        {
                          label: 'Language Direction',
                          value: `${selectedProject.sourceLanguage.toUpperCase()} → ${selectedProject.targetLanguage.toUpperCase()}`,
                          mono: true,
                        },
                        {
                          label: 'Media Category',
                          value: selectedProject.mediaCategory.replace('_', ' '),
                        },
                        {
                          label: 'Imported Media',
                          value: activeBundle.media
                            ? `${activeBundle.media.fileName} (${formatBytes(activeBundle.media.sizeBytes)})`
                            : 'No media imported yet',
                        },
                        {
                          label: 'Media Duration',
                          value: activeBundle.metadata
                            ? formatTimecode(activeBundle.metadata.durationMs)
                            : 'Not analyzed',
                          mono: true,
                        },
                        {
                          label: 'Latest Processing Checkpoint',
                          value: selectedProject.lastCheckpointId ?? 'None recorded',
                          mono: true,
                        },
                        {
                          label: 'Dialogue Segments / Timeline Clips',
                          value: `${activeBundle.segments.length} segments · ${activeBundle.clips.length} clips`,
                          mono: true,
                        },
                        {
                          label: 'Last Updated',
                          value: formatShortDate(selectedProject.updatedAt),
                          mono: true,
                        },
                      ]}
                    />
                  </div>
                </Surface>

                <Surface>
                  <SectionTitle
                    title="Project History & Recovery Checkpoints"
                    meta="Persisted version snapshots and recoverable stage checkpoints"
                  />
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <h3 className="text-xs font-semibold text-slate-700 mb-2">
                        Project Versions ({activeBundle.versions.length})
                      </h3>
                      {activeBundle.versions.length === 0 ? (
                        <p className="text-xs text-slate-500">No versions recorded.</p>
                      ) : (
                        <ul className="divide-y divide-slate-100">
                          {activeBundle.versions.map((ver) => (
                            <li key={ver.id} className="py-2 text-xs">
                              <p className="font-medium text-slate-900">{ver.label}</p>
                              <p className="text-slate-600 mt-0.5">{ver.summary}</p>
                              <p className="text-slate-400 mt-0.5 font-mono tabular-nums">
                                {formatShortDate(ver.createdAt)}
                              </p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div>
                      <h3 className="text-xs font-semibold text-slate-700 mb-2">
                        Checkpoints ({activeBundle.checkpoints.length})
                      </h3>
                      {activeBundle.checkpoints.length === 0 ? (
                        <p className="text-xs text-slate-500">
                          No checkpoints saved yet. Run the foundation pipeline to create recovery checkpoints.
                        </p>
                      ) : (
                        <ul className="divide-y divide-slate-100">
                          {activeBundle.checkpoints.slice(0, 6).map((ckpt) => (
                            <li key={ckpt.id} className="py-2 text-xs">
                              <p className="font-mono text-slate-800">{ckpt.id}</p>
                              <p className="text-slate-600 mt-0.5">
                                {ckpt.notes} · {ckpt.completedAgentIds.length} stages saved
                              </p>
                              <p className="text-slate-400 mt-0.5 tabular-nums">
                                {formatShortDate(ckpt.savedAt)}
                              </p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </Surface>
              </>
            ) : (
              <EmptyState
                title="Select a project"
                description="Choose a project from the directory to view its metadata, checkpoints, and history."
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
