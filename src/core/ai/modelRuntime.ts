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

/**
 * Centralized Offline-First Local ML Model Runtime Adapter.
 * - Uses @huggingface/transformers (ONNX Runtime Web) and @mediapipe/tasks-vision (WASM).
 * - Enforces single-heavy-model loading on 8 GB RAM devices: loading a new heavy model
 *   automatically disposes and unloads any previously loaded model.
 * - Downloads strictly on explicit user request and caches in persistent browser Cache API
 *   so inference works offline after installation.
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

  async isModelInstalled(modelId: string): Promise<boolean> {
    const rec = await getRecord<ModelMetadata>(STORES.model_metadata, modelId);
    return rec?.installStatus === 'installed_verified';
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
   * Downloads, caches locally in browser Cache API, and verifies real instantiation of a model.
   * Immediately unloads weights after verification to keep device RAM free.
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
      if (modelId === 'model_mediapipe_blazeface') {
        await this.downloadAndVerifyMediaPipeFaceDetector(model, onProgress);
      } else {
        await this.downloadAndVerifyTransformersModel(model, onProgress);
      }

      const verifiedModel: ModelMetadata = {
        ...model,
        downloadStatus: 'verified',
        downloadProgressPercent: 100,
        installStatus: 'installed_verified',
        availabilityStatus: 'ready_offline',
        integrityHashSha256: `cache-verified:${model.repoId}@${new Date().toISOString().slice(0, 10)}`,
        verifiedAt: new Date().toISOString(),
        lastError: null,
      };
      await putRecord(STORES.model_metadata, verifiedModel);

      if (modelId === 'model_mms_tts_hin') {
        await this.syncTtsVoiceProfiles(true);
      }

      onProgress?.({
        modelId,
        progressPercent: 100,
        statusText: 'Downloaded, cached offline, and verified.',
      });

      return verifiedModel;
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
  ): Promise<void> {
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
    const buffer = new Uint8Array(await blob.arrayBuffer());
    const detector = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetBuffer: buffer },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.45,
    });
    detector.close();
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

    const model = await getRecord<ModelMetadata>(STORES.model_metadata, modelId);
    if (!model || model.installStatus !== 'installed_verified' || !model.repoId) {
      throw new Error(
        `Model '${model?.name ?? modelId}' is not installed locally. Download and verify it in Model Manager first.`
      );
    }

    // Strict 8 GB RAM single-heavy-model discipline
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
      verifiedAt: null,
      lastError: null,
    });

    if (modelId === 'model_mms_tts_hin') {
      await this.syncTtsVoiceProfiles(false);
    }
  }
}

export const localModelRuntime = new LocalModelRuntime();
