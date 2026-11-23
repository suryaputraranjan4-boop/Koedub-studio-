import React, { useState } from 'react';
import { CheckCircle2, Cloud, RefreshCw, Trash2 } from 'lucide-react';
import type { CollaborationMode, LanguageCode, StorageNamespace } from '../types/domain';
import { useStudio } from '../state/StudioContext';
import {
  KeyValueList,
  NoticeBanner,
  PageHeader,
  SectionTitle,
  StatusText,
  Surface,
} from '../components/StudioPrimitives';
import { formatBytes } from '../core/storage/mediaInspector';
import { DB_NAME, DB_VERSION } from '../core/storage/database';

const NAMESPACE_LABELS: Record<StorageNamespace, { title: string; detail: string }> = {
  original_media: {
    title: '1. Original Imported Media',
    detail: 'Immutable source files; never removed by temporary cleanup.',
  },
  project_metadata: {
    title: '2. Project Metadata',
    detail: 'Structured IndexedDB stores (projects, segments, characters, sound events, QA, logs).',
  },
  generated_audio: {
    title: '3. Generated Audio & Stems',
    detail: 'Synthesized Hindi TTS utterances and separated dialogue/background stems.',
  },
  temp_processing: {
    title: '4. Temporary Processing Data',
    detail: 'Extracted keyframes & scratch buffers safe to purge.',
  },
  installed_models: {
    title: '5. Installed Model Files',
    detail: 'Verified offline ONNX/TFLite model weights cached locally.',
  },
  exported_results: {
    title: '6. Exported Results',
    detail: 'Rendered final dubbed Hindi WAV master mixes ready for download.',
  },
};

const COLLABORATION_MODE_OPTIONS: Array<{ value: CollaborationMode; label: string }> = [
  { value: 'complementary', label: 'B. Complementary (Local Simple · Gemini Complex)' },
  { value: 'draft_and_review', label: 'C. Draft & Review (Local Draft → Gemini Polish)' },
  { value: 'parallel', label: 'A. Parallel Collaboration (Local + Gemini Merged)' },
  { value: 'alternatives', label: 'D. Multiple Alternatives (Select Preferred Option)' },
  { value: 'disagreement_resolution', label: 'E. Disagreement Resolution (Flag Conflicts)' },
  { value: 'sequential', label: 'F. Sequential Pipeline (Local First → Optional Cloud)' },
  { value: 'offline_local', label: 'G. Pure Offline Local Mode (Zero Cloud Requests)' },
];

export function SettingsStorageScreen() {
  const {
    settings,
    resources,
    geminiStatus,
    updateSettings,
    refreshResources,
    refreshGeminiStatus,
    purgeTemporaryStorage,
    requestPersistentStorage,
  } = useStudio();

  const [purgeMessage, setPurgeMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [testingCloud, setTestingCloud] = useState(false);
  const [persistingStorage, setPersistingStorage] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshResources();
    } finally {
      setRefreshing(false);
    }
  };

  const handleTestGeminiConnection = async () => {
    setTestingCloud(true);
    try {
      await refreshGeminiStatus(true);
    } finally {
      setTestingCloud(false);
    }
  };

  const handlePurgeTemp = async () => {
    const reclaimed = await purgeTemporaryStorage();
    setPurgeMessage(
      `Cleared temporary processing files (${formatBytes(reclaimed)} reclaimed). Preserved original imported media untouched.`
    );
  };

  const handleRequestPersistent = async () => {
    setPersistingStorage(true);
    try {
      const res = await requestPersistentStorage();
      setPurgeMessage(res.message);
    } finally {
      setPersistingStorage(false);
    }
  };

  const textModelOptions =
    geminiStatus?.availableTextModels && geminiStatus.availableTextModels.length > 0
      ? geminiStatus.availableTextModels
      : ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
  const ttsModelOptions =
    geminiStatus?.availableTtsModels && geminiStatus.availableTtsModels.length > 0
      ? geminiStatus.availableTtsModels
      : ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'];

  const namespaces = resources?.storage.namespaces;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings & Storage"
        subtitle="Manage hybrid Gemini + local intelligence settings, 6-namespace storage isolation, 8 GB RAM scheduling guardrails, and offline privacy controls."
        action={
          <button
            type="button"
            disabled={refreshing}
            onClick={() => void handleRefresh()}
            className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{refreshing ? 'Measuring…' : 'Refresh Device Metrics'}</span>
          </button>
        }
      />

      {purgeMessage ? (
        <NoticeBanner tone="success" title="Temporary Storage Cleaned" description={purgeMessage} />
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Hybrid Cloud Intelligence + Storage Isolation + Device Info */}
        <div className="lg:col-span-6 space-y-6">
          <Surface>
            <SectionTitle
              title="Hybrid Cloud Intelligence (Server-Side Gemini)"
              meta="Optional collaborative reasoning & expressive TTS via secure /api/gemini/* proxy"
              action={
                <StatusText
                  label={
                    settings.offlineOnlyMode
                      ? 'Offline Only'
                      : geminiStatus?.verified
                      ? 'Verified Live'
                      : geminiStatus?.configured
                      ? 'Configured'
                      : 'Not Configured'
                  }
                  tone={
                    settings.offlineOnlyMode
                      ? 'muted'
                      : geminiStatus?.verified
                      ? 'nominal'
                      : geminiStatus?.configured
                      ? 'active'
                      : 'warning'
                  }
                />
              }
            />

            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-800 inline-flex items-center gap-1.5">
                    <Cloud className="w-3.5 h-3.5 text-blue-700" aria-hidden="true" />
                    Server Environment Credential Status
                  </span>
                  <button
                    type="button"
                    disabled={testingCloud}
                    onClick={() => void handleTestGeminiConnection()}
                    className="min-h-[32px] px-3 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-100 disabled:opacity-50 text-xs font-medium text-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-blue-700" aria-hidden="true" />
                    <span>{testingCloud ? 'Testing…' : 'Test Connection'}</span>
                  </button>
                </div>
                <p className="text-slate-600 leading-relaxed">
                  {geminiStatus?.message ??
                    'Checking server-side Gemini proxy status…'}
                </p>
                <p className="text-[11px] text-slate-500">
                  Security: API keys are never entered in the browser UI or stored in IndexedDB. Configure{' '}
                  <span className="font-mono">GEMINI_API_KEY</span> securely via{' '}
                  <strong className="text-slate-700">Settings &gt; Secrets</strong>.
                </p>
              </div>

              <div className="space-y-3">
                <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.cloudIntelligenceEnabled}
                    onChange={(e) =>
                      void updateSettings({ cloudIntelligenceEnabled: e.target.checked })
                    }
                    className="mt-0.5"
                  />
                  <span>
                    <strong className="text-slate-900">Enable Hybrid Gemini Collaboration</strong> —
                    Collaborate with Gemini for complex anime idioms, timing-constrained rewrites, and semantic QA when online.
                  </span>
                </label>

                <div className="space-y-3">
                  <div>
                    <label
                      htmlFor="pref-collab-mode"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Collaboration Mode (A–G)
                    </label>
                    <select
                      id="pref-collab-mode"
                      value={settings.collaborationMode}
                      onChange={(e) =>
                        void updateSettings({
                          collaborationMode: e.target.value as CollaborationMode,
                        })
                      }
                      className="w-full h-10 px-2.5 rounded-lg border border-slate-300 bg-white text-xs"
                    >
                      {COLLABORATION_MODE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="pref-gemini-model"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Primary Gemini Reasoning Model
                    </label>
                    <select
                      id="pref-gemini-model"
                      value={settings.preferredGeminiModel}
                      onChange={(e) =>
                        void updateSettings({ preferredGeminiModel: e.target.value })
                      }
                      className="w-full h-10 px-2.5 rounded-lg border border-slate-300 bg-white text-xs font-mono"
                    >
                      {textModelOptions.map((m) => (
                        <option key={m} value={m}>
                          {m}
                          {m === 'gemini-4-hydrogen' ? ' (Recommended)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.cloudTtsEnabled}
                    onChange={(e) =>
                      void updateSettings({ cloudTtsEnabled: e.target.checked })
                    }
                    className="mt-0.5"
                  />
                  <span>
                    <strong className="text-slate-900">Enable Optional Gemini Cloud TTS</strong> —
                    Use expressive multi-voice Gemini Cloud TTS when online instead of local Meta MMS-TTS-HIN.
                  </span>
                </label>

                <div>
                  <label
                    htmlFor="pref-cloud-tts-model"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Optional Gemini Cloud TTS Model
                  </label>
                  <select
                    id="pref-cloud-tts-model"
                    value={settings.preferredCloudTtsModel}
                    onChange={(e) =>
                      void updateSettings({ preferredCloudTtsModel: e.target.value })
                    }
                    className="w-full h-10 px-2.5 rounded-lg border border-slate-300 bg-white text-xs font-mono"
                  >
                    {ttsModelOptions.map((m) => (
                      <option key={m} value={m}>
                        {m}
                        {m === 'gemini-3.8-flash-lite-tts' ? ' (Low Latency)' : ' (Expressive)'}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="pt-2 border-t border-slate-100 space-y-2.5">
                  <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                    Cloud Payload Privacy Controls
                  </p>
                  <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.allowSendDialogueTextToCloud}
                      onChange={(e) =>
                        void updateSettings({ allowSendDialogueTextToCloud: e.target.checked })
                      }
                      className="mt-0.5"
                    />
                    <span>
                      Allow sending dialogue transcript &amp; character register text to server-side Gemini proxy (never raw media files).
                    </span>
                  </label>
                  <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.allowSendKeyframesToCloud}
                      onChange={(e) =>
                        void updateSettings({ allowSendKeyframesToCloud: e.target.checked })
                      }
                      className="mt-0.5"
                    />
                    <span>
                      Allow optional extracted scene keyframes for visual ambiguity assistance (default off).
                    </span>
                  </label>
                </div>

                {geminiStatus?.usage ? (
                  <div className="pt-2 border-t border-slate-100">
                    <KeyValueList
                      items={[
                        {
                          label: 'Model Discovery Source',
                          value:
                            geminiStatus.modelDiscoverySource === 'live_api'
                              ? 'Live Gemini API (models.list)'
                              : 'Verified Model Registry',
                        },
                        {
                          label: 'This Session Gemini Requests',
                          value: `${geminiStatus.usage.totalRequests} reasoning · ${geminiStatus.usage.ttsRequests} TTS`,
                          mono: true,
                        },
                        {
                          label: 'This Session Token Accounting',
                          value: `${geminiStatus.usage.totalInputTokens} in · ${geminiStatus.usage.totalOutputTokens} out`,
                          mono: true,
                        },
                        {
                          label: 'Last Active Cloud Model',
                          value: geminiStatus.usage.lastModelUsed ?? 'None used yet',
                          mono: true,
                        },
                      ]}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </Surface>

          <Surface>
            <SectionTitle
              title="Separated Local Storage Architecture"
              meta={
                resources?.storage.measurementSource === 'navigator_storage_api'
                  ? 'Measured via Navigator Storage API + local vault byte accounting'
                  : 'Measured via local vault byte accounting'
              }
            />

            <KeyValueList
              items={[
                {
                  label: 'Origin Quota',
                  value: resources ? formatBytes(resources.storage.quotaBytes) : 'Measuring…',
                  mono: true,
                },
                {
                  label: 'Origin Used',
                  value: resources ? formatBytes(resources.storage.usageBytes) : 'Measuring…',
                  mono: true,
                },
                {
                  label: 'Available Local Space',
                  value: resources ? formatBytes(resources.storage.availableBytes) : 'Measuring…',
                  mono: true,
                },
                {
                  label: 'Browser Persistence Mode',
                  value: resources?.storagePersisted
                    ? 'Persistent Granted (Eviction Protected)'
                    : 'Best-Effort (Browser May Evict Under Pressure)',
                },
              ]}
            />

            <div className="mt-4 pt-4 border-t border-slate-100 space-y-3">
              {(Object.keys(NAMESPACE_LABELS) as StorageNamespace[]).map((ns) => (
                <div key={ns} className="flex items-start justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900">{NAMESPACE_LABELS[ns].title}</p>
                    <p className="text-slate-500 mt-0.5">{NAMESPACE_LABELS[ns].detail}</p>
                  </div>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums shrink-0">
                    {namespaces ? formatBytes(namespaces[ns]) : '0 B'}
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-5 pt-4 border-t border-slate-100 flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => void handlePurgeTemp()}
                className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <Trash2 className="w-3.5 h-3.5 text-slate-600" aria-hidden="true" />
                <span>Clear Temporary Processing Data Only</span>
              </button>
              {!resources?.storagePersisted ? (
                <button
                  type="button"
                  disabled={persistingStorage}
                  onClick={() => void handleRequestPersistent()}
                  className="min-h-[40px] px-4 py-2 rounded-lg border border-blue-200 bg-blue-50 hover:bg-blue-100 disabled:opacity-50 text-xs font-medium text-blue-800 whitespace-nowrap"
                >
                  {persistingStorage ? 'Requesting…' : 'Request Persistent Storage'}
                </button>
              ) : null}
            </div>
          </Surface>
        </div>

        {/* Right: Processing, Language, Resource, Device Info & Privacy Settings */}
        <div className="lg:col-span-6 space-y-6">
          <Surface>
            <SectionTitle
              title="Processing & Resource Preferences"
              meta="Persisted immediately to local app_settings store"
            />
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label
                    htmlFor="pref-source-lang"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Default Source Language
                  </label>
                  <select
                    id="pref-source-lang"
                    value={settings.defaultSourceLanguage}
                    onChange={(e) =>
                      void updateSettings({
                        defaultSourceLanguage: e.target.value as LanguageCode,
                      })
                    }
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm"
                  >
                    <option value="ja">Japanese (ja)</option>
                    <option value="en">English (en)</option>
                    <option value="ko">Korean (ko)</option>
                    <option value="zh">Chinese (zh)</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="pref-target-lang"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Default Target Language
                  </label>
                  <select
                    id="pref-target-lang"
                    value={settings.defaultTargetLanguage}
                    onChange={(e) =>
                      void updateSettings({
                        defaultTargetLanguage: e.target.value as LanguageCode,
                      })
                    }
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm"
                  >
                    <option value="hi">Hindi (hi)</option>
                    <option value="en">English (en)</option>
                    <option value="es">Spanish (es)</option>
                    <option value="fr">French (fr)</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="pref-chunk-sec"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Chunk Processing Window (sec)
                  </label>
                  <input
                    id="pref-chunk-sec"
                    type="number"
                    min={10}
                    max={120}
                    value={settings.chunkDurationSec}
                    onChange={(e) =>
                      void updateSettings({
                        chunkDurationSec: Math.max(10, Number(e.target.value) || 30),
                      })
                    }
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm font-mono tabular-nums"
                  />
                </div>

                <div>
                  <label
                    htmlFor="pref-overlap-sec"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Chunk Overlap (sec)
                  </label>
                  <input
                    id="pref-overlap-sec"
                    type="number"
                    min={0}
                    max={10}
                    value={settings.chunkOverlapSec}
                    onChange={(e) =>
                      void updateSettings({
                        chunkOverlapSec: Math.max(0, Number(e.target.value) || 2),
                      })
                    }
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm font-mono tabular-nums"
                  />
                </div>

                <div>
                  <label
                    htmlFor="pref-timing-ms"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Preferred Timing Tolerance (ms)
                  </label>
                  <select
                    id="pref-timing-ms"
                    value={settings.preferredTimingAdjustmentMs}
                    onChange={(e) =>
                      void updateSettings({
                        preferredTimingAdjustmentMs: Number(e.target.value),
                      })
                    }
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm font-mono"
                  >
                    <option value={200}>±200 ms (Strict)</option>
                    <option value={300}>±300 ms (Balanced Default)</option>
                    <option value={400}>±400 ms (Flexible)</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="pref-heavy-models"
                    className="block text-xs font-medium text-slate-700 mb-1"
                  >
                    Max Concurrent Heavy Models
                  </label>
                  <select
                    id="pref-heavy-models"
                    value={settings.maxConcurrentHeavyModels}
                    onChange={(e) =>
                      void updateSettings({
                        maxConcurrentHeavyModels: Number(e.target.value) === 2 ? 2 : 1,
                      })
                    }
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm"
                  >
                    <option value={1}>1 Heavy Model (Recommended for 8 GB RAM)</option>
                    <option value={2}>2 Heavy Models (Requires ≥12 GB measured RAM)</option>
                  </select>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 space-y-3">
                <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.autoUnloadUnusedModels}
                    onChange={(e) =>
                      void updateSettings({ autoUnloadUnusedModels: e.target.checked })
                    }
                    className="mt-0.5"
                  />
                  <span>
                    <strong className="text-slate-900">Unload Unused Models Immediately</strong> —
                    Release inference weights between pipeline stages to stay within 8 GB RAM.
                  </span>
                </label>

                <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.pauseOnLowBattery}
                    onChange={(e) =>
                      void updateSettings({ pauseOnLowBattery: e.target.checked })
                    }
                    className="mt-0.5"
                  />
                  <span>
                    <strong className="text-slate-900">Pause Safely on Low Battery</strong> —
                    Save checkpoint and pause heavy work below {settings.lowBatteryThresholdPercent}% when battery telemetry is available.
                  </span>
                </label>
              </div>
            </div>
          </Surface>

          <Surface>
            <SectionTitle
              title="Local-First Privacy Controls"
              meta="Zero automatic media uploads"
            />
            <div className="space-y-3">
              <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.offlineOnlyMode}
                  onChange={(e) =>
                    void updateSettings({ offlineOnlyMode: e.target.checked })
                  }
                  className="mt-0.5"
                />
                <span>
                  <strong className="text-slate-900">Strict Offline Processing Mode</strong> —
                  Disable all cloud intelligence and cloud TTS calls; run exclusively on local ONNX/TFLite models and Web Audio DSP.
                </span>
              </label>

              <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.preserveOriginalMediaAlways}
                  onChange={(e) =>
                    void updateSettings({ preserveOriginalMediaAlways: e.target.checked })
                  }
                  className="mt-0.5"
                />
                <span>
                  <strong className="text-slate-900">Protect Original Imported Media</strong> —
                  Keep source video/audio immutable in isolated original_media storage during all processing and cleanup operations.
                </span>
              </label>
            </div>
          </Surface>

          <Surface>
            <SectionTitle
              title="Device Resource & Runtime Info"
              meta="Honest runtime capability inspection"
            />
            <KeyValueList
              items={[
                {
                  label: 'Reported Device Memory',
                  value:
                    resources?.deviceMemoryGb !== null && resources
                      ? `${resources.deviceMemoryGb} GB (navigator.deviceMemory)`
                      : 'Unavailable in this browser runtime',
                  mono: true,
                },
                {
                  label: 'Effective Heavy Model Concurrency',
                  value: resources ? `${resources.maxHeavyConcurrency} model(s)` : '1 model',
                  mono: true,
                },
                {
                  label: 'Battery State',
                  value: resources?.batterySupported
                    ? `${resources.batteryLevelPercent}% (${
                        resources.batteryCharging ? 'Charging' : 'On Battery'
                      })`
                    : 'Battery API unsupported in this browser',
                  mono: true,
                },
                {
                  label: 'Thermal Telemetry',
                  value: 'Unavailable in web runtime (requires native Android PowerManager)',
                },
                {
                  label: 'Local Database Engine',
                  value: `IndexedDB (${DB_NAME} · Schema v${DB_VERSION} · 25 entity stores)`,
                  mono: true,
                },
                {
                  label: 'Execution Environment',
                  value: 'Vite + React 19 Local-First Studio + Express Gemini Proxy',
                },
              ]}
            />
          </Surface>
        </div>
      </div>
    </div>
  );
}
