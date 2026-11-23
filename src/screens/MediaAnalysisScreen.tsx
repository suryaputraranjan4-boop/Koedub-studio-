import React from 'react';
import { Play } from 'lucide-react';
import { useStudio } from '../state/StudioContext';
import {
  EmptyState,
  KeyValueList,
  NoticeBanner,
  PageHeader,
  SectionTitle,
  StatusText,
  Surface,
} from '../components/StudioPrimitives';
import { formatBytes } from '../core/storage/mediaInspector';
import { formatTimecode } from '../core/timeline/timelineEngine';

export function MediaAnalysisScreen() {
  const {
    activeBundle,
    setActiveScreen,
    runFoundationPipeline,
    isPipelineRunning,
  } = useStudio();

  if (!activeBundle) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Media Analysis"
          subtitle="Inspect technical media structure, scene-analysis readiness, audio-analysis status, and frame-extraction pipelines."
        />
        <EmptyState
          title="No active project selected"
          description="Create or select a project and import a video or audio file to inspect media metadata and analysis stages."
          actionLabel="Go to Media Import"
          onAction={() => setActiveScreen('import')}
        />
      </div>
    );
  }

  const {
    project,
    media,
    metadata,
    scenes,
    frames,
    soundEvents,
    audioStems,
    agentExecutions,
  } = activeBundle;

  const latestExecByAgent = new Map(
    agentExecutions.map((rec) => [rec.agentId, rec])
  );

  const mediaAnalyzerExec = latestExecByAgent.get('media_analyzer');
  const sceneExec = latestExecByAgent.get('scene_detection');
  const frameExec = latestExecByAgent.get('frame_extraction');
  const diarizationExec = latestExecByAgent.get('speaker_diarization');
  const soundClassExec = latestExecByAgent.get('sound_classification');
  const separationExec = latestExecByAgent.get('audio_separation');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Media Analysis"
        subtitle={`Project: ${project.name} · Technical container inspection and chunked analysis boundaries.`}
        action={
          media ? (
            <button
              type="button"
              disabled={isPipelineRunning}
              onClick={() => void runFoundationPipeline(project.id, false)}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white text-xs font-medium inline-flex items-center gap-2 whitespace-nowrap shrink-0"
            >
              <Play className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{isPipelineRunning ? 'Analyzing…' : 'Run Media Analyzer'}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setActiveScreen('import')}
              className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium whitespace-nowrap shrink-0"
            >
              Import Media File
            </button>
          )
        }
      />

      {!media ? (
        <EmptyState
          title="No media imported into this project"
          description="Import an anime episode or spoken audio file first so Media Analyzer can inspect duration, container headers, and generate chunk boundaries."
          actionLabel="Import Media"
          onAction={() => setActiveScreen('import')}
        />
      ) : (
        <>
          {/* 4 Sub-Stage Status Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-slate-500">Container &amp; Metadata</p>
                <StatusText
                  label={
                    mediaAnalyzerExec?.status === 'failed'
                      ? 'Failed'
                      : metadata
                      ? 'Analyzed'
                      : 'Pending'
                  }
                  tone={
                    mediaAnalyzerExec?.status === 'failed'
                      ? 'error'
                      : metadata
                      ? 'nominal'
                      : 'muted'
                  }
                />
              </div>
              <p className="mt-2 text-lg font-semibold text-slate-900 font-mono tabular-nums">
                {metadata ? formatTimecode(metadata.durationMs) : 'Unprobed'}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Agent #2 · {media.chunkPlan.length} overlapping processing chunk(s)
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-slate-500">Scenes &amp; Keyframes</p>
                <StatusText
                  label={
                    scenes.length > 0 || frames.length > 0
                      ? 'Detected'
                      : sceneExec?.status === 'waiting_for_model'
                      ? 'Model Needed'
                      : 'Ready'
                  }
                  tone={
                    scenes.length > 0 || frames.length > 0
                      ? 'nominal'
                      : sceneExec?.status === 'waiting_for_model'
                      ? 'warning'
                      : 'muted'
                  }
                />
              </div>
              <p className="mt-2 text-lg font-semibold text-slate-900 tabular-nums">
                {scenes.length} scenes · {frames.length} frames
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {frameExec?.outputSummary || sceneExec?.outputSummary || 'Agents #3–4 ready to run'}
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-slate-500">Diarization &amp; Speakers</p>
                <StatusText
                  label={
                    activeBundle.speakers.length > 0
                      ? 'Diarized'
                      : diarizationExec?.status === 'waiting_for_model'
                      ? 'Model Needed'
                      : 'Ready'
                  }
                  tone={
                    activeBundle.speakers.length > 0
                      ? 'nominal'
                      : diarizationExec?.status === 'waiting_for_model'
                      ? 'warning'
                      : 'muted'
                  }
                />
              </div>
              <p className="mt-2 text-lg font-semibold text-slate-900 tabular-nums">
                {activeBundle.speakers.length} speakers
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {diarizationExec?.outputSummary || 'Agent #7 PyAnnote ONNX speaker segmentation'}
              </p>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-slate-500">Sound Events &amp; Stems</p>
                <StatusText
                  label={
                    soundEvents.length > 0 || audioStems.length > 0
                      ? 'Separated'
                      : soundClassExec?.status === 'completed'
                      ? 'Classified'
                      : 'Ready'
                  }
                  tone={
                    soundEvents.length > 0 || audioStems.length > 0
                      ? 'nominal'
                      : 'muted'
                  }
                />
              </div>
              <p className="mt-2 text-lg font-semibold text-slate-900 tabular-nums">
                {soundEvents.length} regions · {audioStems.length} stems
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {separationExec?.outputSummary ||
                  soundClassExec?.outputSummary ||
                  'Agents #21–22 preserve songs, music, SFX & ambience'}
              </p>
            </div>
          </div>

          {mediaAnalyzerExec?.errorMessage ? (
            <NoticeBanner
              tone="error"
              title="Media Analyzer Reported an Error"
              description={mediaAnalyzerExec.errorMessage}
            />
          ) : null}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <Surface className="lg:col-span-5">
              <SectionTitle
                title="Stored Media Metadata"
                meta="Persisted in media_metadata store"
              />
              {metadata ? (
                <KeyValueList
                  items={[
                    { label: 'File Name', value: media.fileName },
                    { label: 'Media Kind', value: media.mediaKind },
                    { label: 'Container', value: metadata.containerFormat },
                    { label: 'File Size', value: formatBytes(media.sizeBytes), mono: true },
                    { label: 'Duration', value: formatTimecode(metadata.durationMs), mono: true },
                    {
                      label: 'Estimated Bitrate',
                      value: metadata.bitrateKbps ? `${metadata.bitrateKbps} kbps` : 'Unavailable',
                      mono: true,
                    },
                    {
                      label: 'Video Resolution',
                      value:
                        metadata.widthPx && metadata.heightPx
                          ? `${metadata.widthPx} × ${metadata.heightPx}`
                          : 'Unavailable',
                      mono: true,
                    },
                    {
                      label: 'Frame Rate',
                      value: metadata.frameRateFps ? `${metadata.frameRateFps} fps` : 'Unavailable',
                      mono: true,
                    },
                    {
                      label: 'Sample Rate',
                      value: metadata.sampleRateHz ? `${metadata.sampleRateHz} Hz` : 'Unavailable',
                      mono: true,
                    },
                    {
                      label: 'Audio Channels',
                      value: metadata.channels ? `${metadata.channels}` : 'Unavailable',
                      mono: true,
                    },
                  ]}
                />
              ) : (
                <p className="text-xs text-slate-500">Metadata record not created yet.</p>
              )}
              {metadata?.decoderNotes ? (
                <p className="mt-4 pt-3 border-t border-slate-100 text-xs text-slate-500 leading-relaxed">
                  {metadata.decoderNotes}
                </p>
              ) : null}
            </Surface>

            <Surface className="lg:col-span-7">
              <SectionTitle
                title={`Overlapping Chunk Processing Plan (${media.chunkPlan.length})`}
                meta={`Chunk window: ${Math.round(media.chunkDurationMs / 1000)}s · Overlap: ${Math.round(
                  media.chunkOverlapMs / 1000
                )}s · Prevents loading full files into 8 GB device RAM`}
              />
              {media.chunkPlan.length === 0 ? (
                <p className="text-xs text-slate-500 leading-relaxed">
                  No chunk intervals calculated because the browser decoder could not read total duration for this container (for example MKV on Chromium). Once a container demuxer runs in Prompt 2, chunk ranges populate automatically.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500">
                        <th className="py-2 pr-3 font-medium">Chunk</th>
                        <th className="py-2 pr-3 font-medium">Core Window</th>
                        <th className="py-2 pr-3 font-medium">Overlap Bounds</th>
                        <th className="py-2 font-medium text-right">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                      {media.chunkPlan.slice(0, 16).map((chunk) => (
                        <tr key={chunk.index}>
                          <td className="py-2 pr-3 text-slate-700">#{chunk.index + 1}</td>
                          <td className="py-2 pr-3 text-slate-900">
                            {formatTimecode(chunk.startMs)} – {formatTimecode(chunk.endMs)}
                          </td>
                          <td className="py-2 pr-3 text-slate-500">
                            {formatTimecode(chunk.overlapStartMs)} – {formatTimecode(chunk.overlapEndMs)}
                          </td>
                          <td className="py-2 text-right font-sans text-slate-600">
                            {chunk.status}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {media.chunkPlan.length > 16 ? (
                    <p className="mt-2 text-xs text-slate-500">
                      Showing first 16 of {media.chunkPlan.length} chunks.
                    </p>
                  ) : null}
                </div>
              )}
            </Surface>
          </div>

          {soundEvents.length > 0 ? (
            <Surface>
              <SectionTitle
                title={`Sound Classification & Preservation Map (${soundEvents.length})`}
                meta="Agent #21 distinguishes spoken dialogue from protected songs, background music, SFX, and ambience"
              />
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2 pr-3 font-medium">Window</th>
                      <th className="py-2 pr-3 font-medium">Category</th>
                      <th className="py-2 pr-3 font-medium">Centroid / Energy</th>
                      <th className="py-2 font-medium text-right">Preservation Policy</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {soundEvents.slice(0, 20).map((ev) => (
                      <tr key={ev.id}>
                        <td className="py-2 pr-3 font-mono tabular-nums text-slate-700">
                          {formatTimecode(ev.startMs)} – {formatTimecode(ev.endMs)}
                        </td>
                        <td className="py-2 pr-3 font-medium text-slate-900 capitalize">
                          {ev.label} ({Math.round(ev.confidence * 100)}%)
                        </td>
                        <td className="py-2 pr-3 font-mono tabular-nums text-slate-500">
                          {ev.spectralCentroidHz} Hz · {ev.energyDb} dBFS
                        </td>
                        <td className="py-2 text-right">
                          <StatusText
                            label={ev.preserveOriginal ? 'Preserve Original' : 'Dubbed Dialogue'}
                            tone={ev.preserveOriginal ? 'nominal' : 'active'}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Surface>
          ) : null}
        </>
      )}
    </div>
  );
}
