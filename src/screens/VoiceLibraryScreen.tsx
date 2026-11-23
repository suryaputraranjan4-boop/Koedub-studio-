import React, { useState } from 'react';
import { Lock, Play, Square, VolumeX } from 'lucide-react';
import { useStudio } from '../state/StudioContext';
import {
  NoticeBanner,
  PageHeader,
  SectionTitle,
  StatusText,
  Surface,
} from '../components/StudioPrimitives';

export function VoiceLibraryScreen() {
  const {
    voices,
    characters,
    settings,
    playingVaultKey,
    previewHindiVoice,
    stopAudioPlayback,
    setActiveScreen,
  } = useStudio();
  const [previewBusyId, setPreviewBusyId] = useState<string | null>(null);
  const [previewNotice, setPreviewNotice] = useState<string | null>(null);

  const anyLocalInstalled = voices.some(
    (v) => v.synthesisMode !== 'cloud_prebuilt_voice' && v.installStatus === 'verified_installed'
  );
  const cloudTtsReady =
    settings.cloudTtsEnabled && !settings.offlineOnlyMode && settings.cloudIntelligenceEnabled;

  const handlePreview = async (voiceId: string) => {
    setPreviewNotice(null);
    if (playingVaultKey === `preview:${voiceId}`) {
      stopAudioPlayback();
      return;
    }
    setPreviewBusyId(voiceId);
    try {
      const res = await previewHindiVoice(voiceId);
      if (!res.ok && res.error) {
        setPreviewNotice(res.error);
      }
    } finally {
      setPreviewBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Voice Library"
        subtitle="Manage Hindi Voice IDs backed by Meta MMS-TTS-HIN (VITS ONNX), permanent character locks, and honest DSP preset disclosures."
        action={
          <button
            type="button"
            onClick={() => setActiveScreen('models')}
            className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-800 whitespace-nowrap shrink-0"
          >
            Open Model Manager
          </button>
        }
      />

      <NoticeBanner
        tone={anyLocalInstalled || cloudTtsReady ? 'success' : 'warning'}
        title={
          anyLocalInstalled
            ? 'Offline Meta MMS-TTS Hindi + Optional Cloud Multi-Voices'
            : cloudTtsReady
            ? 'Gemini Cloud Prebuilt Multi-Voices Active (5 Distinct Speakers)'
            : 'Local Hindi TTS Model Not Installed Yet'
        }
        description={
          'Cloud Prebuilt Voices (Kore, Puck, Charon, Fenrir, Zephyr) provide 5 distinct neural voices when Gemini Cloud TTS is enabled. Offline, Meta MMS-TTS-HIN (mms_hin_base) is a single-speaker VITS voice, and the 3 local studio presets transparently apply bounded WSOLA/DSP pitch and rate adjustments.'
        }
      />

      {previewNotice ? (
        <NoticeBanner tone="error" title="Voice Preview Status" description={previewNotice} />
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {voices.map((voice) => {
          const assignedCharacters = characters.filter(
            (c) => c.assignedHindiVoiceId === voice.voiceId
          );
          const isCloudVoice = voice.synthesisMode === 'cloud_prebuilt_voice';
          const canPreview = isCloudVoice
            ? cloudTtsReady
            : voice.installStatus === 'verified_installed';
          const isPlaying = playingVaultKey === `preview:${voice.voiceId}`;
          const isBusy = previewBusyId === voice.voiceId;

          return (
            <Surface key={voice.voiceId}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-slate-900">
                    {voice.displayName}
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5 font-mono">
                    {voice.voiceId} · {voice.locale} · {voice.genderStyle}
                  </p>
                </div>
                <StatusText
                  label={
                    isCloudVoice
                      ? cloudTtsReady
                        ? 'Cloud Multi-Voice'
                        : 'Cloud TTS Off'
                      : voice.installStatus === 'verified_installed'
                      ? 'Ready Offline'
                      : 'Not Installed'
                  }
                  tone={
                    isCloudVoice
                      ? cloudTtsReady
                        ? 'active'
                        : 'muted'
                      : voice.installStatus === 'verified_installed'
                      ? 'nominal'
                      : 'warning'
                  }
                />
              </div>

              <p className="mt-3 text-xs text-slate-700 leading-relaxed">
                {voice.characteristics}
              </p>

              <div className="mt-4 pt-3 border-t border-slate-100 space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">Runtime Engine</span>
                  <span className="text-slate-800 font-medium text-right">{voice.engineRuntime}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">Voice Source Type</span>
                  <span className="text-slate-800 font-medium text-right">
                    {isCloudVoice
                      ? `Gemini Prebuilt Neural Speaker (${voice.cloudVoiceName ?? 'Kore'})`
                      : voice.synthesisMode === 'single_speaker_dsp_preset'
                      ? `Local Single-Speaker DSP Preset (${voice.dspPitchSemitones} st, ${voice.dspRateMultiplier}×)`
                      : 'Local Native Single-Speaker VITS'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">Native Emotion Control</span>
                  <span className="text-slate-600 text-right">
                    {voice.nativeEmotionControl
                      ? 'Supported (Style Prompt + Post-DSP)'
                      : 'No (bounded post-synthesis WSOLA/DSP)'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">Assigned Characters</span>
                  <span className="text-slate-900 font-medium tabular-nums">
                    {assignedCharacters.length}
                  </span>
                </div>
              </div>

              {assignedCharacters.length > 0 ? (
                <div className="mt-3 pt-3 border-t border-slate-100">
                  <p className="text-[11px] font-medium text-slate-500 mb-1.5">
                    Linked Character Profiles
                  </p>
                  <ul className="space-y-1">
                    {assignedCharacters.map((c) => (
                      <li
                        key={c.characterId}
                        className="flex items-center justify-between text-xs text-slate-800"
                      >
                        <span>
                          {c.displayName}{' '}
                          <span className="font-mono text-slate-400">({c.characterId})</span>
                        </span>
                        {c.voiceLocked ? (
                          <span className="inline-flex items-center gap-1 text-blue-700 font-medium">
                            <Lock className="w-3 h-3" aria-hidden="true" />
                            <span>Locked</span>
                          </span>
                        ) : (
                          <span className="text-slate-500">Unlocked</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                {canPreview ? (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handlePreview(voice.voiceId)}
                    className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    {isPlaying ? (
                      <>
                        <Square className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Stop Preview</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>
                          {isBusy
                            ? 'Synthesizing Hindi WAV…'
                            : isCloudVoice
                            ? 'Preview Cloud Hindi Voice'
                            : 'Preview Local Hindi Voice'}
                        </span>
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled
                    aria-label={`Preview ${voice.displayName} currently unavailable`}
                    className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-slate-400 text-xs font-medium inline-flex items-center gap-1.5 cursor-not-allowed whitespace-nowrap"
                  >
                    <VolumeX className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>
                      {isCloudVoice
                        ? 'Enable Cloud TTS in Settings to Preview'
                        : 'Install Meta MMS-TTS Hindi to Preview'}
                    </span>
                  </button>
                )}
              </div>
            </Surface>
          );
        })}
      </div>

      <Surface>
        <SectionTitle
          title="Voice Assignment & Licensing Policy"
          meta="Guarantees consistent character voices across episodes"
        />
        <p className="text-xs text-slate-600 leading-relaxed">
          When a Character Profile locks a Hindi Voice ID, Voice Assignment Agent (#17) preserves that binding across all scenes and future episodes. Meta MMS-TTS-HIN is licensed under CC-BY-NC-4.0 (non-commercial research and personal offline use).
        </p>
      </Surface>
    </div>
  );
}
