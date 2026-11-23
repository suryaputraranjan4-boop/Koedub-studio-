import type {
  CharacterProfile,
  DialogueSegment,
  VoiceProfile,
} from '../../types/domain';
import type { ProjectBundle } from '../storage/database';

function formatSrtTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3600000);
  const minutes = Math.floor((clamped % 3600000) / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const millis = clamped % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(
    seconds
  ).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

/**
 * Generates standard SubRip (.srt) subtitle file content from synchronized DialogueSegments.
 */
export function buildSrtSubtitles(
  segments: DialogueSegment[],
  language: 'hi' | 'ja' = 'hi'
): string {
  const sorted = [...segments].sort((a, b) => a.finalStartMs - b.finalStartMs);
  const blocks: string[] = [];

  sorted.forEach((seg, idx) => {
    const startMs = language === 'hi' ? seg.finalStartMs : seg.originalStartMs;
    const endMs = Math.max(
      startMs + 200,
      language === 'hi' ? seg.finalEndMs : seg.originalEndMs
    );
    const text = (language === 'hi' ? seg.hindiText : seg.japaneseText).trim();
    if (!text) return;
    blocks.push(
      `${idx + 1}\n${formatSrtTimestamp(startMs)} --> ${formatSrtTimestamp(endMs)}\n${text}\n`
    );
  });

  return blocks.join('\n');
}

/**
 * Builds the complete JSON Production Report & Editable Project Snapshot package
 * (dialogue timestamps, character profiles, permanent voice assignments, collaborative
 * translation audit, QA metrics, and original-vs-dubbed timing comparison).
 */
export function buildProductionReportJson(
  bundle: ProjectBundle,
  characters: CharacterProfile[],
  voices: VoiceProfile[]
): string {
  const voiceById = new Map(voices.map((v) => [v.voiceId, v]));
  const charById = new Map(characters.map((c) => [c.characterId, c]));

  const payload = {
    schemaVersion: 'koedub.production.v3',
    exportedAt: new Date().toISOString(),
    project: bundle.project,
    mediaMetadata: bundle.metadata,
    audioStems: bundle.audioStems,
    soundPreservationEvents: bundle.soundEvents,
    characterVoiceAssignments: characters.map((ch) => ({
      characterId: ch.characterId,
      displayName: ch.displayName,
      seriesScope: ch.seriesScope,
      speakerRole: ch.speakerRole,
      identityConfidence: ch.identityConfidence,
      assignedHindiVoiceId: ch.assignedHindiVoiceId,
      assignedVoiceName: ch.assignedHindiVoiceId
        ? voiceById.get(ch.assignedHindiVoiceId)?.displayName ?? ch.assignedHindiVoiceId
        : null,
      voiceLocked: ch.voiceLocked,
      voiceAssignmentHistory: ch.voiceAssignmentHistory,
    })),
    dialogueAndTimingComparison: bundle.segments.map((seg) => ({
      segmentId: seg.segmentId,
      speakerId: seg.sourceSpeakerId,
      characterName: seg.characterId ? charById.get(seg.characterId)?.displayName ?? null : null,
      originalStartMs: seg.originalStartMs,
      originalEndMs: seg.originalEndMs,
      originalDurationMs: seg.originalDurationMs,
      finalStartMs: seg.finalStartMs,
      finalEndMs: seg.finalEndMs,
      actualGeneratedDurationMs: seg.actualGeneratedDurationMs,
      syncDeltaMs: seg.syncDeltaMs ?? seg.finalStartMs - seg.originalStartMs,
      appliedSpeedMultiplier: seg.appliedSpeedMultiplier ?? 1.0,
      syncStatus: seg.syncStatus,
      timingMatchLabel: seg.timingMatchLabel ?? 'Unresolved',
      japaneseText: seg.japaneseText,
      hindiText: seg.hindiText,
      emotion: seg.emotion,
      collaborativeTranslation: seg.collaborativeMeta ?? null,
      qaStatus: seg.qaStatus,
      reviewStatus: seg.reviewStatus,
    })),
    latestQAReport: bundle.qaReports[0] ?? null,
    timelineSnapshot: {
      tracks: bundle.tracks,
      clips: bundle.clips.map((c) => ({
        clipId: c.clipId,
        trackId: c.trackId,
        segmentId: c.segmentId,
        label: c.label,
        startMs: c.startMs,
        endMs: c.endMs,
        durationMs: c.durationMs,
        volumeDb: c.volumeDb ?? 0,
        fadeInMs: c.fadeInMs ?? 0,
        fadeOutMs: c.fadeOutMs ?? 0,
        hasRealAudio: c.hasRealAudio,
      })),
    },
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Triggers a clean local browser file download (no window.open / alert).
 */
export function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
