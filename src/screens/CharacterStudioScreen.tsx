import React, { useState } from 'react';
import { Lock, Plus, Unlock } from 'lucide-react';
import type { ReviewStatus, SpeakerRoleType } from '../types/domain';
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

const SPEAKER_ROLES: Array<{ value: SpeakerRoleType; label: string }> = [
  { value: 'on_screen', label: 'On-screen Speaker' },
  { value: 'off_screen', label: 'Off-screen Speaker' },
  { value: 'narrator', label: 'Narrator' },
  { value: 'overlapping', label: 'Overlapping Dialogue Speaker' },
  { value: 'ambiguous', label: 'Ambiguous / Needs Identity Review' },
];

export function CharacterStudioScreen() {
  const {
    characters,
    voices,
    activeBundle,
    createCharacter,
    updateCharacter,
    assignVoiceToCharacter,
    addCharacterRelationship,
    addCharacterTrackToTimeline,
  } = useStudio();

  const [selectedCharId, setSelectedCharId] = useState<string | null>(
    characters[0]?.characterId ?? null
  );
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Create Character form state
  const [displayName, setDisplayName] = useState('');
  const [seriesScope, setSeriesScope] = useState(
    activeBundle?.project.seriesTitle ?? ''
  );
  const [visualInput, setVisualInput] = useState('');
  const [speakerIdsInput, setSpeakerIdsInput] = useState('SPK_01');
  const [pitchRange, setPitchRange] = useState('');
  const [timbre, setTimbre] = useState('');
  const [pacing, setPacing] = useState('Measured');
  const [personality, setPersonality] = useState('');
  const [speakingStyle, setSpeakingStyle] = useState('');
  const [speakerRole, setSpeakerRole] = useState<SpeakerRoleType>('on_screen');
  const [assignedVoiceId, setAssignedVoiceId] = useState<string>('');
  const [voiceLocked, setVoiceLocked] = useState(true);
  const [confidencePercent, setConfidencePercent] = useState(85);
  const [ambiguityNote, setAmbiguityNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // Relationship form state
  const [relTargetId, setRelTargetId] = useState('');
  const [relType, setRelType] = useState('');
  const [relRegister, setRelRegister] = useState('Informal (Tum / Tu)');
  const [relNotes, setRelNotes] = useState('');

  const selectedCharacter =
    characters.find((c) => c.characterId === selectedCharId) ?? characters[0] ?? null;

  const handleCreateCharacter = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!displayName.trim()) {
      setFormError('Character display name is required.');
      return;
    }

    const confidence = Math.min(1, Math.max(0, confidencePercent / 100));
    const reviewStatus: ReviewStatus =
      speakerRole === 'ambiguous' || confidence < 0.7 ? 'needs_review' : 'unreviewed';

    const created = await createCharacter({
      displayName,
      seriesScope: seriesScope || activeBundle?.project.seriesTitle || 'Global Series Memory',
      visualDescriptors: visualInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      associatedSpeakerIds: speakerIdsInput
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      pitchRange,
      timbre,
      pacing,
      ageEstimate: 'Unspecified',
      genderPresentation: 'Unspecified',
      assignedHindiVoiceId: assignedVoiceId || null,
      voiceLocked,
      personality,
      speakingStyle,
      speakerRole,
      identityConfidence: confidence,
      reviewStatus,
      ambiguityNote,
    });

    setSelectedCharId(created.characterId);
    setShowCreateForm(false);
    setDisplayName('');
    setVisualInput('');
    setPersonality('');
    setSpeakingStyle('');
    setAmbiguityNote('');
  };

  const handleAddRelationship = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCharacter || !relTargetId || !relType.trim()) return;
    await addCharacterRelationship(
      selectedCharacter.characterId,
      relTargetId,
      relType,
      relRegister,
      relNotes
    );
    setRelTargetId('');
    setRelType('');
    setRelNotes('');
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Character Studio"
        subtitle="Permanent cross-episode Character IDs, speaker associations, Hindi Voice ID locks, personality metadata, and relationship graphs."
        action={
          <button
            type="button"
            onClick={() => setShowCreateForm((v) => !v)}
            className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{showCreateForm ? 'Close Form' : 'New Character Profile'}</span>
          </button>
        }
      />

      <NoticeBanner
        tone="info"
        title="Multimodal Identity & Acoustic Voice Intelligence Active"
        description="Permanent Character Memory integrates with Speaker Diarization (#7), Web Audio DSP Voice Analysis (#8), MediaPipe Face Detection (#5), and Multimodal Face-Voice Matching (#9). Low-confidence, off-screen, and ambiguous speakers are preserved for manual review instead of guessing."
      />

      {showCreateForm ? (
        <Surface>
          <SectionTitle
            title="Create Permanent Character Profile"
            meta="Assigns an immutable Character ID (CHR-...) preserved across episodes"
          />
          <form onSubmit={(e) => void handleCreateCharacter(e)} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label htmlFor="chr-name" className="block text-xs font-medium text-slate-700 mb-1">
                  Display Name
                </label>
                <input
                  id="chr-name"
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Ren Takahashi"
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"
                />
              </div>

              <div>
                <label htmlFor="chr-scope" className="block text-xs font-medium text-slate-700 mb-1">
                  Series Scope
                </label>
                <input
                  id="chr-scope"
                  type="text"
                  value={seriesScope}
                  onChange={(e) => setSeriesScope(e.target.value)}
                  placeholder="e.g. Horizon Chronicles"
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"
                />
              </div>

              <div>
                <label htmlFor="chr-role" className="block text-xs font-medium text-slate-700 mb-1">
                  Speaker Presence Role
                </label>
                <select
                  id="chr-role"
                  value={speakerRole}
                  onChange={(e) => setSpeakerRole(e.target.value as SpeakerRoleType)}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm"
                >
                  {SPEAKER_ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="chr-speakers" className="block text-xs font-medium text-slate-700 mb-1">
                  Associated Speaker IDs (comma-separated)
                </label>
                <input
                  id="chr-speakers"
                  type="text"
                  value={speakerIdsInput}
                  onChange={(e) => setSpeakerIdsInput(e.target.value)}
                  placeholder="SPK_01, SPK_04"
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm font-mono"
                />
              </div>

              <div>
                <label htmlFor="chr-visual" className="block text-xs font-medium text-slate-700 mb-1">
                  Visual Descriptors (supporting evidence)
                </label>
                <input
                  id="chr-visual"
                  type="text"
                  value={visualInput}
                  onChange={(e) => setVisualInput(e.target.value)}
                  placeholder="Dark jacket, silver hair, glasses"
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"
                />
              </div>

              <div>
                <label htmlFor="chr-voice" className="block text-xs font-medium text-slate-700 mb-1">
                  Assigned Hindi Voice ID
                </label>
                <select
                  id="chr-voice"
                  value={assignedVoiceId}
                  onChange={(e) => setAssignedVoiceId(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm"
                >
                  <option value="">Unassigned</option>
                  {voices.map((v) => (
                    <option key={v.voiceId} value={v.voiceId}>
                      {v.voiceId} — {v.displayName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="chr-pitch" className="block text-xs font-medium text-slate-700 mb-1">
                  Voice Pitch / Timbre
                </label>
                <input
                  id="chr-pitch"
                  type="text"
                  value={pitchRange}
                  onChange={(e) => setPitchRange(e.target.value)}
                  placeholder="e.g. Medium-low, crisp"
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"
                />
              </div>

              <div>
                <label htmlFor="chr-personality" className="block text-xs font-medium text-slate-700 mb-1">
                  Personality & Tone
                </label>
                <input
                  id="chr-personality"
                  type="text"
                  value={personality}
                  onChange={(e) => setPersonality(e.target.value)}
                  placeholder="e.g. Calm, analytical, protective"
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"
                />
              </div>

              <div>
                <label htmlFor="chr-style" className="block text-xs font-medium text-slate-700 mb-1">
                  Speaking Style
                </label>
                <input
                  id="chr-style"
                  type="text"
                  value={speakingStyle}
                  onChange={(e) => setSpeakingStyle(e.target.value)}
                  placeholder="e.g. Concise, polite keigo"
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"
                />
              </div>

              <div>
                <label htmlFor="chr-timbre" className="block text-xs font-medium text-slate-700 mb-1">
                  Timbre / Pacing Notes
                </label>
                <input
                  id="chr-timbre"
                  type="text"
                  value={timbre}
                  onChange={(e) => setTimbre(e.target.value)}
                  placeholder="e.g. Warm baritone"
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"
                />
              </div>

              <div>
                <label htmlFor="chr-confidence" className="block text-xs font-medium text-slate-700 mb-1">
                  Identity Confidence ({confidencePercent}%)
                </label>
                <input
                  id="chr-confidence"
                  type="range"
                  min={10}
                  max={100}
                  value={confidencePercent}
                  onChange={(e) => setConfidencePercent(Number(e.target.value))}
                  className="w-full mt-2"
                />
              </div>

              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={voiceLocked}
                    onChange={(e) => setVoiceLocked(e.target.checked)}
                  />
                  <span>Lock Hindi Voice ID permanently across episodes</span>
                </label>
              </div>
            </div>

            <div>
              <label htmlFor="chr-ambiguity" className="block text-xs font-medium text-slate-700 mb-1">
                Ambiguity / Review Note (optional — preserved if identity is uncertain)
              </label>
              <input
                id="chr-ambiguity"
                type="text"
                value={ambiguityNote}
                onChange={(e) => setAmbiguityNote(e.target.value)}
                placeholder="e.g. Similar appearance to twin character; verify speaker pitch in Scene 4"
                className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"
              />
            </div>

            {formError ? (
              <NoticeBanner tone="error" title="Form Validation" description={formError} />
            ) : null}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium whitespace-nowrap"
              >
                Save Permanent Character
              </button>
              <button
                type="button"
                onClick={() => setShowCreateForm(false)}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 whitespace-nowrap"
              >
                Cancel
              </button>
            </div>
          </form>
        </Surface>
      ) : null}

      {characters.length === 0 ? (
        <EmptyState
          title="No permanent characters registered yet"
          description="Create a Character Profile manually to pre-lock Hindi Voice IDs and relationships, or wait for Prompt 2 face-voice matching to detect speakers automatically."
          actionLabel="Create First Character"
          onAction={() => setShowCreateForm(true)}
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Character List */}
          <Surface className="lg:col-span-5">
            <SectionTitle
              title={`Permanent Character Memory (${characters.length})`}
              meta="Stable IDs shared across episodes"
            />
            <ul className="divide-y divide-slate-100">
              {characters.map((ch) => {
                const isSelected = selectedCharacter?.characterId === ch.characterId;
                const confidencePct = Math.round(ch.identityConfidence * 100);
                return (
                  <li key={ch.characterId} className="py-2.5 first:pt-0 last:pb-0">
                    <button
                      type="button"
                      onClick={() => setSelectedCharId(ch.characterId)}
                      className={`w-full text-left p-3 rounded-lg border transition-colors ${
                        isSelected
                          ? 'bg-blue-50/60 border-blue-200'
                          : 'bg-white border-transparent hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-slate-900 truncate">
                          {ch.displayName}
                        </span>
                        <StatusText
                          label={ch.reviewStatus.replace('_', ' ')}
                          tone={
                            ch.reviewStatus === 'approved'
                              ? 'nominal'
                              : ch.reviewStatus === 'needs_review'
                              ? 'warning'
                              : 'muted'
                          }
                        />
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                        <span className="font-mono">{ch.characterId}</span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">{confidencePct}% confidence</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">
                          {ch.assignedHindiVoiceId ?? 'No voice'}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Surface>

          {/* Character Profile Inspector */}
          <div className="lg:col-span-7 space-y-6">
            {selectedCharacter ? (
              <>
                <Surface>
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 pb-4 border-b border-slate-100">
                    <div>
                      <h2 className="text-lg font-semibold text-slate-900">
                        {selectedCharacter.displayName}
                      </h2>
                      <p className="text-xs text-slate-500 mt-0.5 font-mono">
                        {selectedCharacter.characterId} · {selectedCharacter.seriesScope} ·{' '}
                        {selectedCharacter.speakerRole.replace('_', ' ')}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          void updateCharacter({
                            ...selectedCharacter,
                            reviewStatus:
                              selectedCharacter.reviewStatus === 'approved'
                                ? 'needs_review'
                                : 'approved',
                          })
                        }
                        className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-800 whitespace-nowrap"
                      >
                        {selectedCharacter.reviewStatus === 'approved'
                          ? 'Mark Needs Review'
                          : 'Approve Identity'}
                      </button>
                      {activeBundle ? (
                        <button
                          type="button"
                          onClick={() =>
                            void addCharacterTrackToTimeline(
                              activeBundle.project.id,
                              selectedCharacter
                            )
                          }
                          className="min-h-[36px] px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium whitespace-nowrap"
                        >
                          Add Timeline Track
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {selectedCharacter.ambiguityNote ? (
                    <div className="mt-4">
                      <NoticeBanner
                        tone="warning"
                        title="Uncertainty Preserved for Review"
                        description={selectedCharacter.ambiguityNote}
                      />
                    </div>
                  ) : null}

                  <div className="mt-4">
                    <KeyValueList
                      items={[
                        { label: 'Permanent Character ID', value: selectedCharacter.characterId, mono: true },
                        {
                          label: 'Associated Speaker IDs',
                          value:
                            selectedCharacter.associatedSpeakerIds.join(', ') || 'None linked',
                          mono: true,
                        },
                        {
                          label: 'Visual Descriptors',
                          value:
                            selectedCharacter.visualDescriptors.join(' · ') || 'None recorded',
                        },
                        {
                          label: 'Voice Characteristics (DSP)',
                          value: `${selectedCharacter.voiceCharacteristics.pitchRange} · ${selectedCharacter.voiceCharacteristics.timbre} · ${selectedCharacter.voiceCharacteristics.pacing}`,
                        },
                        ...(selectedCharacter.voiceCharacteristics.acousticMeasurementSource ===
                        'web_audio_dsp'
                          ? [
                              {
                                label: 'Acoustic Metrics (Measured)',
                                value: `Centroid ${
                                  selectedCharacter.voiceCharacteristics.spectralCentroidHz ?? '—'
                                } Hz · Energy ${
                                  selectedCharacter.voiceCharacteristics.energyDb ?? '—'
                                } dB · ${
                                  selectedCharacter.voiceCharacteristics.voiceTexture ?? 'Clear'
                                }`,
                                mono: true,
                              },
                              {
                                label: 'Vocal Category Estimate',
                                value:
                                  selectedCharacter.voiceCharacteristics.vocalCategoryEstimate ??
                                  `${selectedCharacter.voiceCharacteristics.ageEstimate} · ${selectedCharacter.voiceCharacteristics.genderPresentation}`,
                              },
                            ]
                          : []),
                        { label: 'Personality', value: selectedCharacter.personality },
                        { label: 'Speaking Style', value: selectedCharacter.speakingStyle },
                        {
                          label: 'Identity Confidence',
                          value: `${Math.round(selectedCharacter.identityConfidence * 100)}%`,
                          mono: true,
                        },
                        {
                          label: 'Assigned Hindi Voice ID',
                          value: selectedCharacter.assignedHindiVoiceId
                            ? `${selectedCharacter.assignedHindiVoiceId} (${
                                selectedCharacter.voiceLocked ? 'Locked' : 'Unlocked'
                              })`
                            : 'Unassigned',
                          mono: true,
                        },
                      ]}
                    />
                  </div>

                  {/* Multimodal Face-Voice Matching Evidence for Active Project */}
                  {activeBundle &&
                  activeBundle.associations.some(
                    (a) =>
                      a.characterId === selectedCharacter.characterId ||
                      selectedCharacter.associatedSpeakerIds.includes(a.speakerId)
                  ) ? (
                    <div className="mt-4 pt-4 border-t border-slate-100">
                      <p className="text-xs font-medium text-slate-500 mb-2">
                        Multimodal Face-Voice Evidence (Active Project)
                      </p>
                      <ul className="space-y-2">
                        {activeBundle.associations
                          .filter(
                            (a) =>
                              a.characterId === selectedCharacter.characterId ||
                              selectedCharacter.associatedSpeakerIds.includes(a.speakerId)
                          )
                          .map((assoc) => (
                            <li
                              key={assoc.id}
                              className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-xs flex flex-wrap items-center justify-between gap-2"
                            >
                              <span className="font-mono text-slate-800">
                                {assoc.speakerId} · Audio {Math.round(assoc.audioEvidenceScore * 100)}% ·
                                Visual {Math.round(assoc.visualEvidenceScore * 100)}% · Mouth{' '}
                                {Math.round(assoc.mouthSyncEvidenceScore * 100)}% · Context{' '}
                                {Math.round(assoc.sceneContextScore * 100)}%
                              </span>
                              <StatusText
                                label={`${assoc.status.replace('_', ' ')} (${Math.round(
                                  assoc.combinedConfidence * 100
                                )}%)`}
                                tone={
                                  assoc.status === 'confirmed'
                                    ? 'nominal'
                                    : assoc.status === 'ambiguous'
                                    ? 'error'
                                    : 'warning'
                                }
                              />
                            </li>
                          ))}
                      </ul>
                    </div>
                  ) : null}

                  {/* Voice Lock Control */}
                  <div className="mt-5 pt-4 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-2 flex-1">
                      <label htmlFor="assign-voice-select" className="text-xs font-medium text-slate-600 whitespace-nowrap">
                        Hindi Voice ID:
                      </label>
                      <select
                        id="assign-voice-select"
                        value={selectedCharacter.assignedHindiVoiceId ?? ''}
                        onChange={(e) =>
                          void assignVoiceToCharacter(
                            selectedCharacter.characterId,
                            e.target.value || null,
                            selectedCharacter.voiceLocked,
                            'Manual reassignment in Character Studio'
                          )
                        }
                        className="h-9 flex-1 max-w-xs px-2.5 rounded-lg border border-slate-300 bg-white text-xs"
                      >
                        <option value="">Unassigned</option>
                        {voices.map((v) => (
                          <option key={v.voiceId} value={v.voiceId}>
                            {v.voiceId} — {v.displayName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        void assignVoiceToCharacter(
                          selectedCharacter.characterId,
                          selectedCharacter.assignedHindiVoiceId,
                          !selectedCharacter.voiceLocked,
                          selectedCharacter.voiceLocked
                            ? 'Voice assignment unlocked by user'
                            : 'Voice assignment locked permanently by user'
                        )
                      }
                      className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-medium text-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
                    >
                      {selectedCharacter.voiceLocked ? (
                        <>
                          <Lock className="w-3.5 h-3.5 text-blue-700" aria-hidden="true" />
                          <span>Voice Locked</span>
                        </>
                      ) : (
                        <>
                          <Unlock className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                          <span>Voice Unlocked</span>
                        </>
                      )}
                    </button>
                  </div>
                </Surface>

                {/* Relationships */}
                <Surface>
                  <SectionTitle
                    title={`Character Relationships (${selectedCharacter.relationships.length})`}
                    meta="Used by Relationship Intelligence (Agent #11) for Hindi honorifics & pronouns"
                  />

                  {selectedCharacter.relationships.length === 0 ? (
                    <p className="text-xs text-slate-500 mb-4">
                      No relationships linked yet. Add relationships when two or more characters exist.
                    </p>
                  ) : (
                    <ul className="divide-y divide-slate-100 mb-4">
                      {selectedCharacter.relationships.map((rel) => (
                        <li key={rel.targetCharacterId} className="py-2.5 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-slate-900">
                              {rel.targetName} ({rel.relationType})
                            </span>
                            <span className="text-slate-600">{rel.politenessRegister}</span>
                          </div>
                          {rel.notes ? (
                            <p className="text-slate-500 mt-0.5">{rel.notes}</p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}

                  {characters.length > 1 ? (
                    <form
                      onSubmit={(e) => void handleAddRelationship(e)}
                      className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-3 border-t border-slate-100"
                    >
                      <select
                        aria-label="Target character"
                        value={relTargetId}
                        onChange={(e) => setRelTargetId(e.target.value)}
                        className="h-9 px-2.5 rounded-lg border border-slate-300 bg-white text-xs"
                      >
                        <option value="">Select character…</option>
                        {characters
                          .filter((c) => c.characterId !== selectedCharacter.characterId)
                          .map((c) => (
                            <option key={c.characterId} value={c.characterId}>
                              {c.displayName}
                            </option>
                          ))}
                      </select>
                      <input
                        type="text"
                        aria-label="Relationship type"
                        value={relType}
                        onChange={(e) => setRelType(e.target.value)}
                        placeholder="Relation (e.g. Mentor)"
                        className="h-9 px-2.5 rounded-lg border border-slate-300 text-xs"
                      />
                      <div className="flex gap-2">
                        <input
                          type="text"
                          aria-label="Politeness register"
                          value={relRegister}
                          onChange={(e) => setRelRegister(e.target.value)}
                          placeholder="Register (Aap / Tum)"
                          className="h-9 flex-1 px-2.5 rounded-lg border border-slate-300 text-xs"
                        />
                        <button
                          type="submit"
                          className="min-h-[36px] px-3 rounded-lg bg-slate-900 text-white text-xs font-medium whitespace-nowrap"
                        >
                          Add
                        </button>
                      </div>
                    </form>
                  ) : null}
                </Surface>
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
