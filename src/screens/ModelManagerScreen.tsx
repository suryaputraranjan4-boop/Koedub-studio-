import React, { useState } from 'react';
import { Download, ExternalLink, ShieldCheck, Trash2 } from 'lucide-react';
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

export function ModelManagerScreen() {
  const { models, modelDownloadProgress, downloadModel, verifyModelCache, removeModel } = useStudio();
  const [stageFilter, setStageFilter] = useState<'all' | 'Prompt 2' | 'Prompt 3'>('all');
  const [selectedId, setSelectedId] = useState<string>(models[0]?.id ?? '');
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<{
    tone: 'success' | 'error';
    title: string;
    description: string;
  } | null>(null);

  const filteredModels =
    stageFilter === 'all'
      ? models
      : models.filter((m) => m.integrationStage === stageFilter);

  const selectedModel =
    models.find((m) => m.id === selectedId) ?? filteredModels[0] ?? null;

  const installedCount = models.filter(
    (m) => m.installStatus === 'installed_verified'
  ).length;
  const prompt2Count = models.filter((m) => m.integrationStage === 'Prompt 2').length;

  const activeProgress = selectedModel ? modelDownloadProgress[selectedModel.id] : undefined;
  const anyDownloading = Object.keys(modelDownloadProgress).length > 0;

  const handleDownload = async (modelId: string) => {
    setActionNotice(null);
    const res = await downloadModel(modelId);
    setActionNotice({
      tone: res.ok ? 'success' : 'error',
      title: res.ok ? 'Offline Model Verified' : 'Model Download / Verification Failed',
      description: res.message,
    });
  };

  const handleVerifyCache = async (modelId: string) => {
    setActionNotice(null);
    setVerifyingId(modelId);
    try {
      const res = await verifyModelCache(modelId);
      setActionNotice({
        tone: res.ok ? 'success' : 'error',
        title: res.ok ? 'Cache Integrity Verified' : 'Model Cache Missing / Repair Needed',
        description: res.message,
      });
    } finally {
      setVerifyingId(null);
    }
  };

  const handleRemove = async (modelId: string, name: string) => {
    setActionNotice(null);
    await removeModel(modelId);
    setActionNotice({
      tone: 'success',
      title: 'Local Model Cache Removed',
      description: `${name} was removed from browser Cache API storage.`,
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Model Manager"
        subtitle="Verified open-source offline AI models (ONNX Runtime Web & MediaPipe TFLite WASM). Downloads occur strictly on user action and cache locally for offline inference."
      />

      <NoticeBanner
        tone="info"
        title="Offline-First Model Verification & License Transparency"
        description={`${prompt2Count} Prompt 2 core dubbing models + Prompt 3 Qwen2.5-0.5B-Instruct Local LLM (ONNX q4) & Built-In Acoustic DSP engines are registered. Once downloaded and verified, models run offline with strict 8 GB RAM single-heavy-model unloading. Note: Meta NLLB-200 and Meta MMS-TTS-HIN are CC-BY-NC-4.0 (non-commercial research/personal use).`}
      />

      {actionNotice ? (
        <NoticeBanner
          tone={actionNotice.tone}
          title={actionNotice.title}
          description={actionNotice.description}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
          {(['all', 'Prompt 2', 'Prompt 3'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setStageFilter(tab)}
              className={`min-h-[36px] px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                stageFilter === tab
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab === 'all' ? `All Models (${models.length})` : `${tab} Models`}
            </button>
          ))}
        </div>

        <p className="text-xs text-slate-500 tabular-nums">
          Verified offline:{' '}
          <span className="font-semibold text-slate-900">{installedCount}</span> / {models.length}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <Surface className="lg:col-span-6">
          <SectionTitle
            title="Registered AI Models & Reserved Slots"
            meta="Select any model to inspect architecture, license, RAM budget, and download controls"
          />
          <ul className="divide-y divide-slate-100">
            {filteredModels.map((model) => {
              const isSelected = selectedModel?.id === model.id;
              const progress = modelDownloadProgress[model.id];
              return (
                <li key={model.id} className="py-2.5 first:pt-0 last:pb-0">
                  <button
                    type="button"
                    onClick={() => setSelectedId(model.id)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      isSelected
                        ? 'bg-blue-50/60 border-blue-200'
                        : 'bg-white border-transparent hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-900 truncate">
                        {model.name}
                      </span>
                      <StatusText
                        label={
                          progress
                            ? `${progress.percent}%`
                            : model.checksumStatus === 'cache_missing'
                            ? 'Cache Evicted'
                            : model.installStatus === 'installed_verified'
                            ? 'Ready Offline'
                            : model.repoId
                            ? 'Not Installed'
                            : 'Built-In DSP'
                        }
                        tone={
                          progress
                            ? 'active'
                            : model.checksumStatus === 'cache_missing'
                            ? 'error'
                            : model.installStatus === 'installed_verified'
                            ? 'nominal'
                            : 'warning'
                        }
                      />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                      <span className="font-mono">{model.category}</span>
                      <span aria-hidden="true">·</span>
                      <span>{model.license}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">
                        {model.fileSizeBytes === 0
                          ? '0 B (Built-In)'
                          : model.fileSizeBytes
                          ? formatBytes(model.fileSizeBytes)
                          : 'Pending'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">
                        RAM: {model.estimatedMemoryMb ? `~${model.estimatedMemoryMb} MB` : 'TBD'}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Surface>

        <Surface className="lg:col-span-6">
          {selectedModel ? (
            <>
              <SectionTitle
                title={selectedModel.name}
                meta={`${selectedModel.integrationStage} · ${selectedModel.architecture ?? selectedModel.category}`}
              />

              {selectedModel.commercialUseNote ? (
                <div className="mb-4">
                  <NoticeBanner
                    tone={
                      selectedModel.license.includes('NC') ? 'warning' : 'info'
                    }
                    title={`License & Permitted Use: ${selectedModel.license}`}
                    description={selectedModel.commercialUseNote}
                  />
                </div>
              ) : null}

              {selectedModel.lastError ? (
                <div className="mb-4">
                  <NoticeBanner
                    tone="error"
                    title="Last Download / Verification Error"
                    description={selectedModel.lastError}
                  />
                </div>
              ) : null}

              {activeProgress ? (
                <div className="mb-4 p-3 rounded-lg bg-blue-50/70 border border-blue-200 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-blue-900 truncate">
                      {activeProgress.text}
                    </span>
                    <span className="font-mono font-semibold text-blue-900 tabular-nums">
                      {activeProgress.percent}%
                    </span>
                  </div>
                  <div className="h-1.5 bg-blue-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-700 transition-all"
                      style={{ width: `${activeProgress.percent}%` }}
                    />
                  </div>
                </div>
              ) : null}

              <KeyValueList
                items={[
                  { label: 'Model Category', value: selectedModel.category, mono: true },
                  {
                    label: 'Official Repository / Source',
                    value: selectedModel.repoId ?? selectedModel.officialSource,
                    mono: Boolean(selectedModel.repoId),
                  },
                  {
                    label: 'Architecture',
                    value: selectedModel.architecture ?? 'Unassigned',
                  },
                  { label: 'License', value: selectedModel.license },
                  {
                    label: 'Supported Languages',
                    value: selectedModel.supportedLanguages.join(', '),
                    mono: true,
                  },
                  {
                    label: 'Android / ARM Compatibility',
                    value: selectedModel.androidArmCompatibility,
                  },
                  {
                    label: 'Runtime Engine',
                    value: selectedModel.runtimeCompatibility,
                  },
                  {
                    label: 'Approx. Download Size',
                    value:
                      selectedModel.fileSizeBytes === 0
                        ? '0 B (Built-In Web Audio DSP)'
                        : selectedModel.fileSizeBytes !== null
                        ? formatBytes(selectedModel.fileSizeBytes)
                        : 'Native Android Bundle',
                    mono: true,
                  },
                  {
                    label: 'Estimated Peak RAM',
                    value:
                      selectedModel.estimatedMemoryMb !== null
                        ? `${selectedModel.estimatedMemoryMb} MB`
                        : 'Pending benchmark',
                    mono: true,
                  },
                  { label: 'Quantization', value: selectedModel.quantization },
                  {
                    label: 'Offline Cache Status',
                    value: selectedModel.availabilityStatus.replace(/_/g, ' '),
                  },
                  {
                    label: 'Integrity / Checksum Mode',
                    value:
                      selectedModel.checksumStatus === 'verified_sha256'
                        ? 'SHA-256 Digest Verified (Web Crypto)'
                        : selectedModel.checksumStatus === 'cache_missing'
                        ? 'Browser Cache Missing — Re-Download Required'
                        : selectedModel.runtimeVerified
                        ? 'Runtime-Verified (No Published Checksum)'
                        : 'Unverified / Not Downloaded',
                  },
                  {
                    label: 'Computed SHA-256 Digest',
                    value:
                      selectedModel.integrityHashSha256 &&
                      /^[a-f0-9]{64}$/i.test(selectedModel.integrityHashSha256)
                        ? selectedModel.integrityHashSha256
                        : selectedModel.repoId
                        ? 'None (click Verify Cache after download)'
                        : 'N/A (Built-In Web Audio DSP)',
                    mono: true,
                  },
                ]}
              />

              <p className="mt-4 pt-3 border-t border-slate-100 text-xs text-slate-600 leading-relaxed">
                {selectedModel.notes}
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-2.5">
                {selectedModel.repoId ? (
                  <>
                    {selectedModel.installStatus === 'installed_verified' &&
                    selectedModel.checksumStatus !== 'cache_missing' ? (
                      <>
                        <button
                          type="button"
                          disabled={anyDownloading || verifyingId === selectedModel.id}
                          onClick={() => void handleVerifyCache(selectedModel.id)}
                          className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-800 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
                        >
                          <ShieldCheck className="w-3.5 h-3.5 text-emerald-700" aria-hidden="true" />
                          <span>
                            {verifyingId === selectedModel.id ? 'Verifying Cache…' : 'Verify Cache & SHA-256'}
                          </span>
                        </button>
                        <button
                          type="button"
                          disabled={anyDownloading}
                          onClick={() => void handleRemove(selectedModel.id, selectedModel.name)}
                          className="min-h-[40px] px-4 py-2 rounded-lg border border-red-200 hover:bg-red-50 disabled:opacity-50 text-red-700 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Remove Local Cache</span>
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={anyDownloading}
                        onClick={() => void handleDownload(selectedModel.id)}
                        className="min-h-[40px] px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <Download className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>
                          {activeProgress
                            ? `Downloading (${activeProgress.percent}%)…`
                            : selectedModel.checksumStatus === 'cache_missing'
                            ? 'Repair & Re-Download Model'
                            : 'Download & Verify Offline'}
                        </span>
                      </button>
                    )}

                    {selectedModel.downloadUrl ? (
                      <a
                        href={selectedModel.downloadUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="min-h-[40px] px-3.5 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <span>Official Source</span>
                        <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                      </a>
                    ) : null}
                  </>
                ) : (
                  <span className="min-h-[40px] px-4 py-2 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 text-xs font-medium inline-flex items-center whitespace-nowrap">
                    Built-In Web Audio DSP Active Offline
                  </span>
                )}
              </div>
            </>
          ) : (
            <p className="text-xs text-slate-500">Select a model to inspect metadata.</p>
          )}
        </Surface>
      </div>
    </div>
  );
}
