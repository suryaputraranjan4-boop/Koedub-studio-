import React, { useState } from 'react';
import {
  BookOpen,
  Check,
  Clock,
  Play,
  Plus,
  Sparkles,
  Square,
  Trash2,
  Volume2,
} from 'lucide-react';
import type { DialogueSegment, PronunciationEntry } from '../types/domain';
import { useStudio } from '../state/StudioContext';
import {
  EmptyState,
  NoticeBanner,
  PageHeader,
  SectionTitle,
  StatusText,
  Surface,
} from '../components/StudioPrimitives';
import { formatTimecode } from '../core/timeline/timelineEngine';

export function TranslationStudioScreen() {
  const {
    activeBundle,
    characters,
    models,
    pronunciations,
    settings,
    geminiStatus,
    playingVaultKey,
    setActiveScreen,
    createDialogueSegment,
    updateDialogueSegment,
    deleteDialogueSegment,
    synthesizeSingleSegment,
    collaborateOnSegment,
    playVaultAudio,
    stopAudioPlayback,
    addPronunciationEntry,
    deletePronunciationEntry,
  } = useStudio();

  const [showAddForm, setShowAddForm] = useState(false);
  const [speakerId, setSpeakerId] = useState('SPK_01');
  const [characterId, setCharacterId] = useState('');
  const [startSec, setStartSec] = useState('0.0');
  const [endSec, setEndSec] = useState('3.2');
  const [japaneseText, setJapaneseText] = useState('');
  const [hindiText, setHindiText] = useState('');
  const [emotion, setEmotion] = useState('Calm');
  const [formError, setFormError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editHindiDraft, setEditHindiDraft] = useState('');
  const [editJapaneseDraft, setEditJapaneseDraft] = useState('');
  const [synthBusyId, setSynthBusyId] = useState<string | null>(null);
  const [collabBusyId, setCollabBusyId] = useState<string | null>(null);
  const [synthNotice, setSynthNotice] = useState<{
    tone: 'success' | 'error' | 'info';
    title: string;
    description: string;
  } | null>(null);

  // Pronunciation dictionary state
  const [pronSource, setPronSource] = useState('');
  const [pronTarget, setPronTarget] = useState('');
  const [pronCategory, setPronCategory] =
    useState<PronunciationEntry['category']>('character_name');

  const ttsInstalled =
    models.find((m) => m.id === 'model_mms_tts_hin')?.installStatus ===
    'installed_verified';
  const cloudTtsReady =
    settings.cloudTtsEnabled &&
    settings.cloudIntelligenceEnabled &&
    !settings.offlineOnlyMode &&
    Boolean(geminiStatus?.configured);
  const canSynthesizeTts = ttsInstalled || cloudTtsReady;

  if (!activeBundle) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Translation Studio"
          subtitle="Manage Japanese source transcriptions, hybrid collaborative Hindi translations, pronunciation rules, timing fit, and Hindi WAV synthesis."
        />
        <EmptyState
          title="No active project selected"
          description="Create or select a project to view and edit dialogue segments."
          actionLabel="Go to Projects"
          onAction={() => setActiveScreen('projects')}
        />
      </div>
    );
  }

  const { project, segments, contextSnapshot } = activeBundle;

  const handleAddSegment = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const startMs = Math.round(parseFloat(startSec) * 1000);
    const endMs = Math.round(parseFloat(endSec) * 1000);

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      setFormError('End time must be strictly greater than start time (in seconds).');
      return;
    }
    if (!japaneseText.trim() && !hindiText.trim()) {
      setFormError('Enter Japanese source text or Hindi translation text.');
      return;
    }

    await createDialogueSegment({
      projectId: project.id,
      sourceSpeakerId: speakerId,
      characterId: characterId || null,
      originalStartMs: startMs,
      originalEndMs: endMs,
      japaneseText,
      hindiText,
      primaryEmotion: emotion,
      emotionIntensity: 0.5,
    });

    setShowAddForm(false);
    setJapaneseText('');
    setHindiText('');
    setStartSec(((endMs + 400) / 1000).toFixed(1));
    setEndSec(((endMs + 3400) / 1000).toFixed(1));
  };

  const handleAddPronunciation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pronSource.trim() || !pronTarget.trim()) return;
    await addPronunciationEntry({
      sourceTerm: pronSource,
      targetHindiForm: pronTarget,
      category: pronCategory,
      seriesScope: project.seriesTitle || 'Global',
    });
    setPronSource('');
    setPronTarget('');
  };

  const beginEdit = (seg: DialogueSegment) => {
    setEditingId(seg.segmentId);
    setEditJapaneseDraft(seg.japaneseText);
    setEditHindiDraft(seg.hindiText);
  };

  const saveEdit = async (seg: DialogueSegment) => {
    await updateDialogueSegment({
      ...seg,
      japaneseText: editJapaneseDraft.trim(),
      hindiText: editHindiDraft.trim(),
    });
    setEditingId(null);
  };

  const applyAlternative = async (seg: DialogueSegment, altText: string) => {
    await updateDialogueSegment({
      ...seg,
      hindiText: altText,
      collaborativeMeta: seg.collaborativeMeta
        ? {
            ...seg.collaborativeMeta,
            selectedSource: 'user',
            disagreementFlag: false,
            updatedAt: new Date().toISOString(),
          }
        : seg.collaborativeMeta,
    });
    setSynthNotice({
      tone: 'success',
      title: 'Applied Hindi Alternative',
      description: `Updated ${seg.segmentId} with selected Hindi adaptation.`,
    });
  };

  const toggleApproval = async (seg: DialogueSegment) => {
    await updateDialogueSegment({
      ...seg,
      reviewStatus: seg.reviewStatus === 'approved' ? 'needs_review' : 'approved',
    });
  };

  const handleSynthesize = async (segmentId: string) => {
    setSynthNotice(null);
    setSynthBusyId(segmentId);
    try {
      const res = await synthesizeSingleSegment(segmentId);
      setSynthNotice({
        tone: res.ok ? 'success' : 'error',
        title: res.ok ? 'Hindi WAV Synthesized & Synchronized' : 'TTS Synthesis Unavailable',
        description: res.message,
      });
    } finally {
      setSynthBusyId(null);
    }
  };

  const handleCollaborate = async (
    segmentId: string,
    taskType: 'translate_and_adapt' | 'concise_timing_rewrite'
  ) => {
    setSynthNotice(null);
    setCollabBusyId(segmentId);
    try {
      const res = await collaborateOnSegment(segmentId, taskType);
      setSynthNotice({
        tone: res.ok ? 'info' : 'error',
        title:
          taskType === 'concise_timing_rewrite'
            ? 'Concise Timing Adaptation Complete'
            : 'Hybrid Intelligence Collaboration Complete',
        description: res.message,
      });
    } finally {
      setCollabBusyId(null);
    }
  };

  const handlePlayGenerated = async (vaultKey: string) => {
    if (playingVaultKey === vaultKey) {
      stopAudioPlayback();
      return;
    }
    const res = await playVaultAudio(vaultKey);
    if (!res.ok && res.error) {
      setSynthNotice({
        tone: 'error',
        title: 'Playback Failed',
        description: res.error,
      });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Translation Studio"
        subtitle={`Project: ${project.name} (${project.sourceLanguage.toUpperCase()} → ${project.targetLanguage.toUpperCase()}) · Hybrid Gemini + Local LLM collaboration (${settings.collaborationMode.replace(/_/g, ' ')}), pronunciation dictionary, timing fit, and Hindi WAV synthesis.`}
        action={
          <button
            type="button"
            onClick={() => setShowAddForm((v) => !v)}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{showAddForm ? 'Close Form' : 'Add Dialogue Segment'}</span>
          </button>
        }
      />

      {synthNotice ? (
        <NoticeBanner
          tone={synthNotice.tone}
          title={synthNotice.title}
          description={synthNotice.description}
        />
      ) : null}

      {contextSnapshot ? (
        <NoticeBanner
          tone="info"
          title={`Context Intelligence Active (${contextSnapshot.characterBriefs.length} Character Briefs · ${contextSnapshot.terminology.length} Glossary Rules)`}
          description={`Sliding dialogue window: ${contextSnapshot.windowSize} turns across ${contextSnapshot.sceneCount} scene(s). Collaboration mode: ${settings.collaborationMode.replace(/_/g, ' ')} · Cloud Intelligence: ${settings.cloudIntelligenceEnabled && !settings.offlineOnlyMode ? (geminiStatus?.configured ? 'Connected' : 'Local Fallback') : 'Offline Only'}.`}
        />
      ) : null}

      {showAddForm ? (
        <Surface>
          <SectionTitle
            title="Add Persistent Dialogue Segment"
            meta="Creates independent segment metadata + timeline clip (silence remains empty intervals)"
          />
          <form onSubmit={(e) => void handleAddSegment(e)} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <div>
                <label htmlFor="seg-speaker" className="block text-xs font-medium text-slate-700 mb-1">
                  Source Speaker ID
                </label>
                <input
                  id="seg-speaker"
                  type="text"
                  value={speakerId}
                  onChange={(e) => setSpeakerId(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm font-mono"
                />
              </div>

              <div>
                <label htmlFor="seg-char" className="block text-xs font-medium text-slate-700 mb-1">
                  Character Profile
                </label>
                <select
                  id="seg-char"
                  value={characterId}
                  onChange={(e) => setCharacterId(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm"
                >
                  <option value="">Unmatched Speaker</option>
                  {characters.map((c) => (
                    <option key={c.characterId} value={c.characterId}>
                      {c.displayName} ({c.characterId})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="seg-start" className="block text-xs font-medium text-slate-700 mb-1">
                  Start (sec)
                </label>
                <input
                  id="seg-start"
                  type="number"
                  step="0.1"
                  min="0"
                  value={startSec}
                  onChange={(e) => setStartSec(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm font-mono tabular-nums"
                />
              </div>

              <div>
                <label htmlFor="seg-end" className="block text-xs font-medium text-slate-700 mb-1">
                  End (sec)
                </label>
                <input
                  id="seg-end"
                  type="number"
                  step="0.1"
                  min="0.1"
                  value={endSec}
                  onChange={(e) => setEndSec(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm font-mono tabular-nums"
                />
              </div>

              <div>
                <label htmlFor="seg-emotion" className="block text-xs font-medium text-slate-700 mb-1">
                  Emotion
                </label>
                <select
                  id="seg-emotion"
                  value={emotion}
                  onChange={(e) => setEmotion(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm"
                >
                  <option value="Calm">Calm</option>
                  <option value="Happy">Happy</option>
                  <option value="Sad">Sad</option>
                  <option value="Angry">Angry</option>
                  <option value="Fearful">Fearful</option>
                  <option value="Surprised">Surprised</option>
                  <option value="Excited">Excited</option>
                  <option value="Confident">Confident</option>
                  <option value="Whispering">Whispering</option>
                  <option value="Shouting">Shouting</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="seg-jp" className="block text-xs font-medium text-slate-700 mb-1">
                  Source Japanese Transcription
                </label>
                <textarea
                  id="seg-jp"
                  rows={2}
                  value={japaneseText}
                  onChange={(e) => setJapaneseText(e.target.value)}
                  placeholder="例: ここから先は俺が引き受ける。"
                  className="w-full p-3 rounded-lg border border-slate-300 text-sm"
                />
              </div>
              <div>
                <label htmlFor="seg-hi" className="block text-xs font-medium text-slate-700 mb-1">
                  Hindi Translation
                </label>
                <textarea
                  id="seg-hi"
                  rows={2}
                  value={hindiText}
                  onChange={(e) => setHindiText(e.target.value)}
                  placeholder="उदाहरण: यहाँ से आगे की ज़िम्मेदारी मेरी है।"
                  className="w-full p-3 rounded-lg border border-slate-300 text-sm"
                />
              </div>
            </div>

            {formError ? (
              <NoticeBanner tone="error" title="Segment Validation" description={formError} />
            ) : null}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium whitespace-nowrap"
              >
                Save Dialogue Segment
              </button>
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 whitespace-nowrap"
              >
                Cancel
              </button>
            </div>
          </form>
        </Surface>
      ) : null}

      <Surface>
        <SectionTitle
          title={`Dialogue Segments (${segments.length})`}
          meta="Ordered chronologically · Real WAV timing match, collaborative adaptation alternatives, and synthesis controls"
        />

        {segments.length === 0 ? (
          <EmptyState
            title="No dialogue segments in this project yet"
            description="Run the 25-agent AI Dubbing Pipeline in Processing Center to transcribe Japanese dialogue, or add a manual segment now."
            actionLabel="Add First Dialogue Segment"
            onAction={() => setShowAddForm(true)}
          />
        ) : (
          <ul className="divide-y divide-slate-200">
            {segments.map((seg) => {
              const matchedChar = characters.find((c) => c.characterId === seg.characterId);
              const isEditing = editingId === seg.segmentId;
              const isSynthBusy = synthBusyId === seg.segmentId;
              const isCollabBusy = collabBusyId === seg.segmentId;
              const isPlaying =
                seg.generatedAudioRef !== null && playingVaultKey === seg.generatedAudioRef;
              const collab = seg.collaborativeMeta ?? null;

              return (
                <li key={seg.segmentId} className="py-4 first:pt-0 last:pb-0 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-slate-600">
                      <span className="font-mono font-semibold text-slate-900">
                        {seg.segmentId}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums text-slate-700">
                        {formatTimecode(seg.originalStartMs)} – {formatTimecode(seg.originalEndMs)} (
                        {(seg.originalDurationMs / 1000).toFixed(2)}s)
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-medium text-slate-800">
                        {matchedChar ? matchedChar.displayName : seg.sourceSpeakerId}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        Emotion: {seg.emotion.primaryEmotion}
                        {seg.emotion.secondaryEmotion
                          ? ` / ${seg.emotion.secondaryEmotion}`
                          : ''}{' '}
                        ({Math.round((seg.emotion.intensity ?? 0.5) * 100)}%)
                      </span>
                      {seg.asrConfidence !== undefined && seg.asrConfidence !== null ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            ASR {Math.round(seg.asrConfidence * 100)}%
                          </span>
                        </>
                      ) : null}
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">
                        Voice: {seg.assignedHindiVoiceId ?? 'Unassigned'}
                      </span>
                    </div>

                    <div className="flex items-center gap-3">
                      {seg.timingMatchLabel ? (
                        <StatusText
                          label={`Timing: ${seg.timingMatchLabel}`}
                          tone={
                            seg.timingMatchLabel === 'Matched'
                              ? 'nominal'
                              : seg.timingMatchLabel === 'Close Match'
                              ? 'active'
                              : 'warning'
                          }
                        />
                      ) : null}
                      <StatusText
                        label={seg.reviewStatus.replace('_', ' ')}
                        tone={
                          seg.reviewStatus === 'approved'
                            ? 'nominal'
                            : seg.reviewStatus === 'needs_review'
                            ? 'warning'
                            : 'muted'
                        }
                      />
                    </div>
                  </div>

                  {isEditing ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-medium text-slate-500 mb-1">
                          Japanese Source
                        </label>
                        <textarea
                          rows={2}
                          value={editJapaneseDraft}
                          onChange={(e) => setEditJapaneseDraft(e.target.value)}
                          className="w-full p-2.5 rounded-lg border border-slate-300 text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-slate-500 mb-1">
                          Hindi Translation
                        </label>
                        <textarea
                          rows={2}
                          value={editHindiDraft}
                          onChange={(e) => setEditHindiDraft(e.target.value)}
                          className="w-full p-2.5 rounded-lg border border-slate-300 text-sm"
                        />
                      </div>
                      <div className="md:col-span-2 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void saveEdit(seg)}
                          className="min-h-[36px] px-3.5 py-1.5 rounded-lg bg-blue-700 text-white text-xs font-medium"
                        >
                          Save Changes
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="min-h-[36px] px-3.5 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-700"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <p className="text-[11px] font-medium text-slate-400">Japanese Source</p>
                        <p className="mt-1 text-sm text-slate-900 leading-relaxed">
                          {seg.japaneseText || '— (empty)'}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] font-medium text-slate-400">Hindi Translation</p>
                        <p className="mt-1 text-sm text-slate-900 leading-relaxed">
                          {seg.hindiText || '— (translation missing)'}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Collaborative Intelligence Metadata & Alternatives */}
                  {collab ? (
                    <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 space-y-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-slate-800">
                          Collaborative Intelligence · {collab.modelUsed ?? 'Local Offline'} ·{' '}
                          <span className="font-mono text-slate-500">
                            {collab.mode.replace(/_/g, ' ')}
                          </span>
                        </span>
                        <span className="text-slate-500">
                          {collab.cloudReviewPending
                            ? 'Cloud Review Pending (Offline)'
                            : collab.disagreementFlag
                            ? 'Disagreement Flagged — Choose Preferred Line'
                            : 'Aligned'}
                        </span>
                      </div>
                      {collab.culturalNote ? (
                        <p className="text-slate-600 leading-relaxed">
                          Note: {collab.culturalNote}
                        </p>
                      ) : null}
                      {collab.alternatives.length > 0 ? (
                        <div className="space-y-1.5 pt-1 border-t border-slate-200">
                          <p className="text-[11px] font-medium text-slate-500">
                            Alternative Hindi Adaptations ({collab.alternatives.length})
                          </p>
                          <div className="space-y-1.5">
                            {collab.alternatives.map((alt) => (
                              <div
                                key={alt.id}
                                className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-white border border-slate-200 rounded-md px-2.5 py-1.5"
                              >
                                <div className="min-w-0">
                                  <span className="font-medium text-slate-700 mr-2">
                                    {alt.label}:
                                  </span>
                                  <span className="text-slate-900">{alt.hindiText}</span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => void applyAlternative(seg, alt.hindiText)}
                                  className="min-h-[30px] px-2.5 py-1 rounded-md border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-800 text-[11px] font-medium whitespace-nowrap shrink-0"
                                >
                                  Use This
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {seg.emotion.deliveryNotes || seg.actingDirective ? (
                    <p className="text-[11px] text-slate-500">
                      {seg.emotion.deliveryNotes ? `Emotion cues: ${seg.emotion.deliveryNotes}` : ''}
                      {seg.actingDirective
                        ? ` · Acting DSP: ${seg.actingDirective.speakingRateMultiplier}× rate, ${seg.actingDirective.pitchShiftSemitones} st, ${seg.actingDirective.gainDbAdjustment} dB (${seg.actingDirective.deliveryStyle})`
                        : ''}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                    <span className="text-slate-500 font-mono tabular-nums">
                      Timeline: {formatTimecode(seg.finalStartMs)} – {formatTimecode(seg.finalEndMs)} · Sync: {seg.syncStatus}
                      {seg.actualGeneratedDurationMs !== null
                        ? ` · WAV: ${(seg.actualGeneratedDurationMs / 1000).toFixed(2)}s`
                        : ''}
                      {seg.syncDeltaMs !== undefined && seg.syncDeltaMs !== null
                        ? ` (${seg.syncDeltaMs >= 0 ? '+' : ''}${seg.syncDeltaMs}ms)`
                        : ''}
                      {seg.appliedSpeedMultiplier !== undefined && seg.appliedSpeedMultiplier !== null
                        ? ` · ${seg.appliedSpeedMultiplier}×`
                        : ''}
                    </span>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => beginEdit(seg)}
                        className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 font-medium"
                      >
                        Edit Text
                      </button>

                      <button
                        type="button"
                        disabled={isCollabBusy || (!seg.japaneseText.trim() && !seg.hindiText.trim())}
                        onClick={() => void handleCollaborate(seg.segmentId, 'translate_and_adapt')}
                        className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 text-slate-800 font-medium inline-flex items-center gap-1"
                      >
                        <Sparkles className="w-3.5 h-3.5 text-blue-700" aria-hidden="true" />
                        <span>{isCollabBusy ? 'Collaborating…' : 'Collaborate'}</span>
                      </button>

                      <button
                        type="button"
                        disabled={isCollabBusy || (!seg.japaneseText.trim() && !seg.hindiText.trim())}
                        onClick={() => void handleCollaborate(seg.segmentId, 'concise_timing_rewrite')}
                        className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 disabled:opacity-40 text-slate-700 font-medium inline-flex items-center gap-1"
                      >
                        <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Concise Fit</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => void toggleApproval(seg)}
                        className="min-h-[34px] px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 font-medium inline-flex items-center gap-1"
                      >
                        <Check className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{seg.reviewStatus === 'approved' ? 'Unapprove' : 'Approve'}</span>
                      </button>

                      {seg.generatedAudioRef ? (
                        <button
                          type="button"
                          onClick={() => void handlePlayGenerated(seg.generatedAudioRef!)}
                          className="min-h-[34px] px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-medium inline-flex items-center gap-1"
                        >
                          {isPlaying ? (
                            <>
                              <Square className="w-3 h-3" aria-hidden="true" />
                              <span>Stop WAV</span>
                            </>
                          ) : (
                            <>
                              <Play className="w-3 h-3" aria-hidden="true" />
                              <span>Play WAV</span>
                            </>
                          )}
                        </button>
                      ) : null}

                      <button
                        type="button"
                        disabled={!canSynthesizeTts || !seg.hindiText.trim() || isSynthBusy}
                        onClick={() => void handleSynthesize(seg.segmentId)}
                        title={
                          cloudTtsReady
                            ? 'Synthesize Hindi WAV via Gemini Cloud TTS'
                            : ttsInstalled
                            ? 'Synthesize real 16 kHz Hindi WAV offline using Meta MMS-TTS-HIN'
                            : 'Download Meta MMS-TTS Hindi in Model Manager or enable Gemini Cloud TTS in Settings'
                        }
                        className={`min-h-[34px] px-2.5 py-1 rounded-lg border font-medium inline-flex items-center gap-1 ${
                          canSynthesizeTts && seg.hindiText.trim()
                            ? 'border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-800'
                            : 'border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed'
                        }`}
                      >
                        <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>
                          {isSynthBusy
                            ? 'Synthesizing…'
                            : canSynthesizeTts
                            ? seg.generatedAudioRef
                              ? 'Regenerate WAV'
                              : cloudTtsReady
                              ? 'Synthesize (Gemini TTS)'
                              : 'Synthesize Hindi WAV'
                            : 'Install MMS-TTS Hindi'}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => void deleteDialogueSegment(seg.segmentId)}
                        aria-label={`Delete segment ${seg.segmentId}`}
                        className="min-h-[34px] px-2.5 py-1 rounded-lg border border-red-200 hover:bg-red-50 text-red-700 font-medium inline-flex items-center gap-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Remove</span>
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Surface>

      {/* Persistent Pronunciation Dictionary (Agent #15) */}
      <Surface>
        <SectionTitle
          title={`Pronunciation Dictionary (${pronunciations.length})`}
          meta="Persistent local rules applied by Pronunciation Agent (#15) across Japanese names, places, fictional terms, and English loanwords"
        />

        <form
          onSubmit={(e) => void handleAddPronunciation(e)}
          className="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-4"
        >
          <input
            type="text"
            aria-label="Source term (Japanese or English)"
            value={pronSource}
            onChange={(e) => setPronSource(e.target.value)}
            placeholder="Source term (e.g. 東京 / Sensor)"
            className="h-9 px-3 rounded-lg border border-slate-300 text-xs"
          />
          <input
            type="text"
            aria-label="Target Hindi pronunciation form"
            value={pronTarget}
            onChange={(e) => setPronTarget(e.target.value)}
            placeholder="Hindi Devanagari (e.g. टोक्यो / सेंसर)"
            className="h-9 px-3 rounded-lg border border-slate-300 text-xs"
          />
          <select
            aria-label="Pronunciation category"
            value={pronCategory}
            onChange={(e) =>
              setPronCategory(e.target.value as PronunciationEntry['category'])
            }
            className="h-9 px-2.5 rounded-lg border border-slate-300 bg-white text-xs"
          >
            <option value="character_name">Character Name</option>
            <option value="place">Place Name</option>
            <option value="fictional_term">Fictional / Anime Term</option>
            <option value="english_loanword">English Loanword</option>
            <option value="repeated_word">Repeated Phrase</option>
          </select>
          <button
            type="submit"
            className="min-h-[36px] px-3 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
          >
            <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Add Rule</span>
          </button>
        </form>

        {pronunciations.length === 0 ? (
          <p className="text-xs text-slate-500">
            No custom pronunciation rules stored yet. Add character names, places, or English loanwords to enforce consistent Devanagari Hindi spelling and TTS pronunciation.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100 text-xs">
            {pronunciations.map((entry) => (
              <li
                key={entry.id}
                className="py-2 flex items-center justify-between gap-3"
              >
                <div className="flex flex-wrap items-center gap-x-2">
                  <span className="font-semibold text-slate-900">{entry.sourceTerm}</span>
                  <span className="text-slate-400">→</span>
                  <span className="font-medium text-blue-800">{entry.targetHindiForm}</span>
                  <span className="text-slate-400">·</span>
                  <span className="font-mono text-slate-500">
                    {entry.category.replace('_', ' ')}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void deletePronunciationEntry(entry.id)}
                  className="text-red-700 hover:text-red-800 font-medium"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </Surface>
    </div>
  );
}
