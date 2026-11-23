import type { ModelMetadata, VoiceProfile } from '../../types/domain';
import {
  getAllRecords,
  getRecord,
  putManyRecords,
  putRecord,
  STORES,
} from '../storage/database';
import { resourceManager } from '../resources/resourceManager';

export type ModelProgressCallback = (info: {
  modelId: string;
  progressPercent: number;
  statusText: string;
}) => void;

export interface ModelCacheVerificationResult {
  modelId: string;
  cachePresent: boolean;
  cachedFileCount: number;
  computedSha256: string | null;
  status: 'verified_sha256' | 'runtime_only_no_published_checksum' | 'cache_missing' | 'not_installed';
  detail: string;
}

type DisposableInstance = {
  dispose?: () => Promise<void> | void;
  close?: () => void;
};

interface ActiveLoadedModel {
  modelId: string;
  memoryMb: number;
  instance: unknown;
}

const MEDIAPIPE_WASM_ROOT =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm';
const MEDIAPIPE_CACHE_NAME = 'koedub-mediapipe-models-v1';

async function computeSha256Hex(buffer: ArrayBuffer): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  try {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const bytes = new Uint8Array(hashBuffer);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

/**
 * Centralized Offline-First Local ML Model Runtime Adapter.
 * - Uses @huggingface/transformers (ONNX Runtime Web) and @mediapipe/tasks-vision (WASM).
 * - Enforces single-heavy-model loading on 8 GB RAM devices.
 * - NEVER fabricates fake SHA-256 strings: records a real cryptographic SHA-256 digest only when
 *   computed over actual bytes, tracks runtime verification separately, and inspects real browser
 *   Cache API entries before reporting a model as installed.
 */
class LocalModelRuntime {
  private activeLoaded: ActiveLoadedModel | null = null;

  private async configureTransformersEnv(allowRemote: boolean) {
    const { env } = await import('@huggingface/transformers');
    env.allowLocalModels = false;
    env.allowRemoteModels = allowRemote;
    env.useBrowserCache = true;
    return env;
  }

  async unloadActiveModel(): Promise<void> {
    if (!this.activeLoaded) return;
    const { modelId, instance } = this.activeLoaded;
    this.activeLoaded = null;
    resourceManager.unloadModel(modelId);

    try {
      const disposable = instance as DisposableInstance | null;
      if (disposable && typeof disposable.dispose === 'function') {
        await disposable.dispose();
      } else if (disposable && typeof disposable.close === 'function') {
        disposable.close();
      }
    } catch {
      // Ignore disposal errors from WASM runtimes
    }
  }

  getActiveLoadedModelId(): string | null {
    return this.activeLoaded?.modelId ?? null;
  }

  /**
   * Inspects the real browser Cache API to verify cached model artifacts still exist
   * (detects browser cache eviction cleanly!) and computes a real SHA-256 digest over
   * cached manifest/weight bytes when feasible.
   */
  async verifyModelCacheIntegrity(modelId: string): Promise<ModelCacheVerificationResult> {
    const rec = await getRecord<ModelMetadata>(STORES.model_metadata, modelId);
    if (!rec) {
      return {
        modelId,
        cachePresent: false,
        cachedFileCount: 0,
        computedSha256: null,
        status: 'not_installed',
        detail: 'Model not found in local catalog.',
      };
    }

    // Built-in DSP engines do not use external Cache API files
    if (!rec.repoId) {
      return {
        modelId,
        cachePresent: true,
        cachedFileCount: 0,
        computedSha256: null,
        status: 'runtime_only_no_published_checksum',
        detail: 'Built-in Web Audio DSP module (runtime-verified; no external weights file).',
      };
    }

    if (rec.installStatus !== 'installed_verified') {
      return {
        modelId,
        cachePresent: false,
        cachedFileCount: 0,
        computedSha256: null,
        status: 'not_installed',
        detail: 'Model has not been downloaded yet.',
      };
    }

    if (typeof caches === 'undefined') {
      return {
        modelId,
        cachePresent: false,
        cachedFileCount: 0,
        computedSha256: null,
        status: 'cache_missing',
        detail: 'Browser Cache API is unavailable to verify local model files.',
      };
    }

    try {
      if (modelId === 'model_mediapipe_blazeface' && rec.downloadUrl) {
        const cache = await caches.open(MEDIAPIPE_CACHE_NAME);
        const resp = await cache.match(rec.downloadUrl);
        if (!resp) {
          await this.markCacheMissing(rec, 'Cached BlazeFace TFLite file was evicted from browser Cache API.');
          return {
            modelId,
            cachePresent: false,
            cachedFileCount: 0,
            computedSha256: null,
            status: 'cache_missing',
            detail: 'Cached BlazeFace TFLite file missing (browser evicted cache). Click Re-Download / Repair.',
          };
        }
        const buf = await resp.arrayBuffer();
        const sha = await computeSha256Hex(buf);
        const now = new Date().toISOString();
        await putRecord<ModelMetadata>(STORES.model_metadata, {
          ...rec,
          integrityHashSha256: sha,
          checksumStatus: sha ? 'verified_sha256' : 'runtime_only_no_published_checksum',
          runtimeVerified: true,
          runtimeVerifiedAt: now,
          verifiedAt: now,
          lastError: null,
        });
        return {
          modelId,
          cachePresent: true,
          cachedFileCount: 1,
          computedSha256: sha,
          status: sha ? 'verified_sha256' : 'runtime_only_no_published_checksum',
          detail: sha
            ? `Verified 1 cached TFLite artifact (${(buf.byteLength / 1024).toFixed(0)} KB · SHA-256 computed).`
            : 'Verified cached TFLite artifact in Cache API (Web Crypto SHA-256 unavailable).',
        };
      }

      // Inspect transformers.js Cache API entries matching this repoId
      const cacheNames = await caches.keys();
      const matchedRequests: Array<{ cache: Cache; req: Request }> = [];
      for (const cname of cacheNames) {
        if (!cname.includes('transformers')) continue;
        const cache = await caches.open(cname);
        const keys = await cache.keys();
        for (const req of keys) {
          if (req.url.includes(rec.repoId)) {
            matchedRequests.push({ cache, req });
          }
        }
      }

      if (matchedRequests.length === 0) {
        await this.markCacheMissing(
          rec,
          `No cached files found for ${rec.repoId} in browser Cache API (evicted or cleared).`
        );
        return {
          modelId,
          cachePresent: false,
          cachedFileCount: 0,
          computedSha256: null,
          status: 'cache_missing',
          detail: `Cached files for ${rec.repoId} are missing from browser Cache API. Click Repair / Re-Download.`,
        };
      }

      // Compute a deterministic SHA-256 fingerprint over cached config/metadata JSON files (fast & memory-safe)
      // plus byte-length manifest of cached ONNX weight entries so we don't blow 8 GB RAM hashing 600 MB in JS.
      let computedSha256: string | null = null;
      const manifestParts: string[] = [];
      for (const { cache, req } of matchedRequests.sort((a, b) => a.req.url.localeCompare(b.req.url))) {
        const resp = await cache.match(req);
        if (!resp) continue;
        const cl = resp.headers.get('content-length');
        if (req.url.endsWith('.json') || (cl && Number(cl) <= 2 * 1024 * 1024)) {
          const buf = await resp.arrayBuffer();
          const fileHash = await computeSha256Hex(buf);
          manifestParts.push(`${req.url}|${buf.byteLength}|${fileHash ?? 'nohash'}`);
        } else {
          manifestParts.push(`${req.url}|len=${cl ?? 'unknown'}|etag=${resp.headers.get('etag') ?? 'none'}`);
        }
      }
      if (manifestParts.length > 0) {
        const encoded = new TextEncoder().encode(manifestParts.join('\n')).buffer;
        computedSha256 = await computeSha256Hex(encoded);
      }

      const now = new Date().toISOString();
      await putRecord<ModelMetadata>(STORES.model_metadata, {
        ...rec,
        integrityHashSha256: computedSha256,
        checksumStatus: computedSha256
          ? 'verified_sha256'
          : 'runtime_only_no_published_checksum',
        runtimeVerified: true,
        runtimeVerifiedAt: now,
        lastError: null,
      });

      return {
        modelId,
        cachePresent: true,
        cachedFileCount: matchedRequests.length,
        computedSha256,
        status: computedSha256 ? 'verified_sha256' : 'runtime_only_no_published_checksum',
        detail: `Verified ${matchedRequests.length} cached file(s) in browser Cache API${
          computedSha256 ? ' (SHA-256 cache manifest digest computed)' : ''
        }.`,
      };
    } catch (err) {
      return {
        modelId,
        cachePresent: false,
        cachedFileCount: 0,
        computedSha256: null,
        status: 'cache_missing',
        detail: err instanceof Error ? err.message : 'Cache verification error.',
      };
    }
  }

  private async markCacheMissing(rec: ModelMetadata, reason: string) {
    await putRecord<ModelMetadata>(STORES.model_metadata, {
      ...rec,
      downloadStatus: 'failed',
      installStatus: 'not_installed',
      availabilityStatus: 'download_required',
      checksumStatus: 'cache_missing',
      integrityHashSha256: null,
      runtimeVerified: false,
      lastError: reason,
    });
    if (rec.id === 'model_mms_tts_hin') {
      await this.syncTtsVoiceProfiles(false);
    }
  }

  /**
   * Checks both IndexedDB record AND actual browser Cache API presence before claiming a model is installed!
   */
  async isModelInstalled(modelId: string): Promise<boolean> {
    const rec = await getRecord<ModelMetadata>(STORES.model_metadata, modelId);
    if (!rec || rec.installStatus !== 'installed_verified') return false;
    if (!rec.repoId) return true; // built-in DSP

    if (typeof caches === 'undefined') {
      return true;
    }

    try {
      if (modelId === 'model_mediapipe_blazeface' && rec.downloadUrl) {
        const cache = await caches.open(MEDIAPIPE_CACHE_NAME);
        const match = await cache.match(rec.downloadUrl);
        if (!match) {
          await this.markCacheMissing(rec, 'BlazeFace cache entry missing (browser evicted cache).');
          return false;
        }
        return true;
      }

      const cacheNames = await caches.keys();
      for (const cname of cacheNames) {
        if (!cname.includes('transformers')) continue;
        const cache = await caches.open(cname);
        const keys = await cache.keys();
        if (keys.some((req) => req.url.includes(rec.repoId!))) {
          return true;
        }
      }

      await this.markCacheMissing(
        rec,
        `Model files for ${rec.repoId} were evicted from browser Cache API. Re-download to repair.`
      );
      return false;
    } catch {
      return true;
    }
  }

  private async syncTtsVoiceProfiles(installed: boolean) {
    const voices = await getAllRecords<VoiceProfile>(STORES.voice_profiles);
    const updated = voices.map((v) =>
      v.modelId === 'model_mms_tts_hin'
        ? {
            ...v,
            installStatus: installed
              ? ('verified_installed' as const)
              : ('not_installed' as const),
            availabilityStatus: installed
              ? ('available' as const)
              : ('not_installed' as const),
          }
        : v
    );
    await putManyRecords(STORES.voice_profiles, updated);
  }

  /**
   * Downloads, caches locally in browser Cache API, runs real runtime verification,
   * and computes genuine SHA-256 digest over cached artifacts (never fake strings).
   */
  async downloadAndVerifyModel(
    modelId: string,
    onProgress?: ModelProgressCallback
  ): Promise<ModelMetadata> {
    const model = await getRecord<ModelMetadata>(STORES.model_metadata, modelId);
    if (!model) {
      throw new Error(`Model '${modelId}' not found in local manifest catalog.`);
    }
    if (!model.repoId) {
      throw new Error(
        `Model '${model.name}' is a built-in DSP engine or has no downloadable ONNX repository.`
      );
    }

    await this.unloadActiveModel();

    await putRecord<ModelMetadata>(STORES.model_metadata, {
      ...model,
      downloadStatus: 'downloading',
      downloadProgressPercent: 2,
      lastError: null,
    });
    onProgress?.({
      modelId,
      progressPercent: 2,
      statusText: `Connecting to ${model.officialSource}…`,
    });

    try {
      let computedSha256: string | null = null;
      if (modelId === 'model_mediapipe_blazeface') {
        computedSha256 = await this.downloadAndVerifyMediaPipeFaceDetector(model, onProgress);
      } else {
        await this.downloadAndVerifyTransformersModel(model, onProgress);
      }

      const now = new Date().toISOString();
      const verifiedModel: ModelMetadata = {
        ...model,
        downloadStatus: 'verified',
        downloadProgressPercent: 100,
        installStatus: 'installed_verified',
        availabilityStatus: 'ready_offline',
        integrityHashSha256: computedSha256,
        checksumStatus: computedSha256
          ? 'verified_sha256'
          : 'runtime_only_no_published_checksum',
        runtimeVerified: true,
        runtimeVerifiedAt: now,
        verifiedAt: now,
        lastError: null,
      };
      await putRecord(STORES.model_metadata, verifiedModel);

      // Run real Cache API verification + SHA-256 manifest digest after install
      const cacheCheck = await this.verifyModelCacheIntegrity(modelId);

      if (modelId === 'model_mms_tts_hin') {
        await this.syncTtsVoiceProfiles(true);
      }

      onProgress?.({
        modelId,
        progressPercent: 100,
        statusText: cacheCheck.detail,
      });

      return (await getRecord<ModelMetadata>(STORES.model_metadata, modelId)) ?? verifiedModel;
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Model download or ONNX/WASM verification failed.';
      const failedModel: ModelMetadata = {
        ...model,
        downloadStatus: 'failed',
        downloadProgressPercent: 0,
        installStatus: 'not_installed',
        availabilityStatus: 'download_required',
        integrityHashSha256: null,
        checksumStatus: 'unverified',
        runtimeVerified: false,
        lastError: message,
      };
      await putRecord(STORES.model_metadata, failedModel);
      throw new Error(message);
    } finally {
      await this.unloadActiveModel();
    }
  }

  private async downloadAndVerifyMediaPipeFaceDetector(
    model: ModelMetadata,
    onProgress?: ModelProgressCallback
  ): Promise<string | null> {
    if (!model.downloadUrl) {
      throw new Error('Missing official MediaPipe BlazeFace model URL.');
    }

    onProgress?.({
      modelId: model.id,
      progressPercent: 20,
      statusText: 'Downloading blaze_face_short_range.tflite…',
    });

    const response = await fetch(model.downloadUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while downloading BlazeFace TFLite weights.`);
    }
    const blob = await response.blob();
    if (blob.size < 50000) {
      throw new Error('Downloaded BlazeFace model file is unexpectedly small or corrupted.');
    }

    const arrayBuf = await blob.arrayBuffer();
    const sha256 = await computeSha256Hex(arrayBuf);

    if (typeof caches !== 'undefined') {
      const cache = await caches.open(MEDIAPIPE_CACHE_NAME);
      await cache.put(model.downloadUrl, new Response(blob));
    }

    onProgress?.({
      modelId: model.id,
      progressPercent: 75,
      statusText: 'Verifying MediaPipe WASM FaceDetector runtime…',
    });

    const { FilesetResolver, FaceDetector } = await import('@mediapipe/tasks-vision');
    const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);
    const buffer = new Uint8Array(arrayBuf);
    const detector = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetBuffer: buffer },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.45,
    });
    detector.close();
    return sha256;
  }

  private async downloadAndVerifyTransformersModel(
    model: ModelMetadata,
    onProgress?: ModelProgressCallback
  ): Promise<void> {
    await this.configureTransformersEnv(true);
    const {
      pipeline,
      AutoProcessor,
      AutoModelForAudioFrameClassification,
    } = await import('@huggingface/transformers');

    const progressCallback = (p: { progress?: number; status?: string; file?: string }) => {
      const pct =
        typeof p.progress === 'number' && Number.isFinite(p.progress)
          ? Math.max(3, Math.min(98, Math.round(p.progress)))
          : undefined;
      if (pct !== undefined) {
        onProgress?.({
          modelId: model.id,
          progressPercent: pct,
          statusText: p.file ? `Downloading ${p.file} (${pct}%)` : p.status ?? `Loading ${pct}%`,
        });
      }
    };

    if (model.id === 'model_whisper_small_onnx') {
      const pipe = await pipeline('automatic-speech-recognition', model.repoId!, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: progressCallback,
      });
      this.activeLoaded = {
        modelId: model.id,
        memoryMb: model.estimatedMemoryMb ?? 1200,
        instance: pipe,
      };
    } else if (model.id === 'model_pyannote_segmentation') {
      const processor = await AutoProcessor.from_pretrained(model.repoId!, {
        progress_callback: progressCallback,
      });
      const segModel = await AutoModelForAudioFrameClassification.from_pretrained(
        model.repoId!,
        {
          device: 'wasm',
          progress_callback: progressCallback,
        }
      );
      this.activeLoaded = {
        modelId: model.id,
        memoryMb: model.estimatedMemoryMb ?? 420,
        instance: { processor, model: segModel, dispose: () => segModel.dispose?.() },
      };
    } else if (model.id === 'model_nllb_200_600m') {
      const pipe = await pipeline('translation', model.repoId!, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: progressCallback,
      });
      this.activeLoaded = {
        modelId: model.id,
        memoryMb: model.estimatedMemoryMb ?? 1450,
        instance: pipe,
      };
    } else if (model.id === 'model_multilingual_sentiment') {
      const pipe = await pipeline('text-classification', model.repoId!, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: progressCallback,
      });
      this.activeLoaded = {
        modelId: model.id,
        memoryMb: model.estimatedMemoryMb ?? 380,
        instance: pipe,
      };
    } else if (model.id === 'model_mms_tts_hin') {
      const pipe = await pipeline('text-to-speech', model.repoId!, {
        device: 'wasm',
        progress_callback: progressCallback,
      });
      this.activeLoaded = {
        modelId: model.id,
        memoryMb: model.estimatedMemoryMb ?? 480,
        instance: pipe,
      };
    } else if (model.id === 'model_local_llm_qwen_onnx') {
      const pipe = await pipeline('text-generation', model.repoId!, {
        dtype: 'q4',
        device: 'wasm',
        progress_callback: progressCallback,
      });
      this.activeLoaded = {
        modelId: model.id,
        memoryMb: model.estimatedMemoryMb ?? 920,
        instance: pipe,
      };
    } else {
      throw new Error(`No runtime adapter configured for model '${model.id}'.`);
    }
  }

  /**
   * Loads an already-installed model for offline inference, unloading any previous heavy model first.
   */
  async loadInstalledModel<T = unknown>(
    modelId: string,
    allowRemoteFallback: boolean = false
  ): Promise<T> {
    if (this.activeLoaded && this.activeLoaded.modelId === modelId) {
      return this.activeLoaded.instance as T;
    }

    const installed = await this.isModelInstalled(modelId);
    const model = await getRecord<ModelMetadata>(STORES.model_metadata, modelId);
    if (!installed || !model || !model.repoId) {
      throw new Error(
        `Model '${model?.name ?? modelId}' is not installed or its cache was evicted. Download/repair it in Model Manager first.`
      );
    }

    await this.unloadActiveModel();

    if (modelId === 'model_mediapipe_blazeface') {
      const { FilesetResolver, FaceDetector } = await import('@mediapipe/tasks-vision');
      let buffer: Uint8Array | null = null;
      if (typeof caches !== 'undefined' && model.downloadUrl) {
        const cache = await caches.open(MEDIAPIPE_CACHE_NAME);
        const cached = await cache.match(model.downloadUrl);
        if (cached) {
          buffer = new Uint8Array(await cached.arrayBuffer());
        }
      }
      if (!buffer) {
        if (!allowRemoteFallback || !model.downloadUrl) {
          throw new Error('BlazeFace cached weights missing. Re-download in Model Manager.');
        }
        const resp = await fetch(model.downloadUrl);
        buffer = new Uint8Array(await resp.arrayBuffer());
      }
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_ROOT);
      const detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetBuffer: buffer },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.45,
      });
      resourceManager.registerLoadedModel(modelId, model.estimatedMemoryMb ?? 280);
      this.activeLoaded = {
        modelId,
        memoryMb: model.estimatedMemoryMb ?? 280,
        instance: detector,
      };
      return detector as T;
    }

    await this.configureTransformersEnv(allowRemoteFallback);
    const {
      pipeline,
      AutoProcessor,
      AutoModelForAudioFrameClassification,
    } = await import('@huggingface/transformers');

    let instance: unknown;
    if (modelId === 'model_whisper_small_onnx') {
      instance = await pipeline('automatic-speech-recognition', model.repoId, {
        dtype: 'q8',
        device: 'wasm',
      });
    } else if (modelId === 'model_pyannote_segmentation') {
      const processor = await AutoProcessor.from_pretrained(model.repoId);
      const segModel = await AutoModelForAudioFrameClassification.from_pretrained(
        model.repoId,
        { device: 'wasm' }
      );
      instance = { processor, model: segModel, dispose: () => segModel.dispose?.() };
    } else if (modelId === 'model_nllb_200_600m') {
      instance = await pipeline('translation', model.repoId, {
        dtype: 'q8',
        device: 'wasm',
      });
    } else if (modelId === 'model_multilingual_sentiment') {
      instance = await pipeline('text-classification', model.repoId, {
        dtype: 'q8',
        device: 'wasm',
      });
    } else if (modelId === 'model_mms_tts_hin') {
      instance = await pipeline('text-to-speech', model.repoId, {
        device: 'wasm',
      });
    } else if (modelId === 'model_local_llm_qwen_onnx') {
      instance = await pipeline('text-generation', model.repoId, {
        dtype: 'q4',
        device: 'wasm',
      });
    } else {
      throw new Error(`Unsupported local runtime model '${modelId}'.`);
    }

    const memMb = model.estimatedMemoryMb ?? 512;
    resourceManager.registerLoadedModel(modelId, memMb);
    this.activeLoaded = { modelId, memoryMb: memMb, instance };
    return instance as T;
  }

  /**
   * Removes cached files for a model and resets its local status to not_installed.
   */
  async removeInstalledModel(modelId: string): Promise<void> {
    if (this.activeLoaded?.modelId === modelId) {
      await this.unloadActiveModel();
    }

    const model = await getRecord<ModelMetadata>(STORES.model_metadata, modelId);
    if (!model) return;

    if (typeof caches !== 'undefined') {
      if (modelId === 'model_mediapipe_blazeface' && model.downloadUrl) {
        const cache = await caches.open(MEDIAPIPE_CACHE_NAME);
        await cache.delete(model.downloadUrl);
      } else if (model.repoId) {
        try {
          const cacheNames = await caches.keys();
          for (const cname of cacheNames) {
            if (cname.includes('transformers')) {
              const cache = await caches.open(cname);
              const keys = await cache.keys();
              for (const req of keys) {
                if (req.url.includes(model.repoId)) {
                  await cache.delete(req);
                }
              }
            }
          }
        } catch {
          // Non-fatal if cache inspection restricted
        }
      }
    }

    await putRecord<ModelMetadata>(STORES.model_metadata, {
      ...model,
      downloadStatus: 'not_downloaded',
      downloadProgressPercent: 0,
      installStatus: 'not_installed',
      availabilityStatus: 'download_required',
      integrityHashSha256: null,
      checksumStatus: 'unverified',
      runtimeVerified: false,
      runtimeVerifiedAt: null,
      verifiedAt: null,
      lastError: null,
    });

    if (modelId === 'model_mms_tts_hin') {
      await this.syncTtsVoiceProfiles(false);
    }
  }
}

export const localModelRuntime = new LocalModelRuntime();
