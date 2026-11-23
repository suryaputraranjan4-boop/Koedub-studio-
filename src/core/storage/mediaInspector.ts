import type { ChunkDefinition, MediaMetadata } from '../../types/domain';

export interface SupportedFormatSpec {
  extension: string;
  mimeTypes: string[];
  kind: 'video' | 'audio';
  containerLabel: string;
}

export const SUPPORTED_MEDIA_FORMATS: readonly SupportedFormatSpec[] = [
  { extension: 'mp4', mimeTypes: ['video/mp4'], kind: 'video', containerLabel: 'MP4 (MPEG-4)' },
  { extension: 'webm', mimeTypes: ['video/webm', 'audio/webm'], kind: 'video', containerLabel: 'WebM' },
  { extension: 'mkv', mimeTypes: ['video/x-matroska', 'application/x-matroska'], kind: 'video', containerLabel: 'Matroska (MKV)' },
  { extension: 'mov', mimeTypes: ['video/quicktime'], kind: 'video', containerLabel: 'QuickTime (MOV)' },
  { extension: 'wav', mimeTypes: ['audio/wav', 'audio/x-wav', 'audio/wave'], kind: 'audio', containerLabel: 'WAV (PCM)' },
  { extension: 'mp3', mimeTypes: ['audio/mpeg', 'audio/mp3'], kind: 'audio', containerLabel: 'MP3' },
  { extension: 'm4a', mimeTypes: ['audio/mp4', 'audio/x-m4a'], kind: 'audio', containerLabel: 'M4A (AAC)' },
  { extension: 'flac', mimeTypes: ['audio/flac', 'audio/x-flac'], kind: 'audio', containerLabel: 'FLAC' },
  { extension: 'ogg', mimeTypes: ['audio/ogg', 'video/ogg'], kind: 'audio', containerLabel: 'OGG' },
] as const;

export const FILE_PICKER_ACCEPT =
  '.mp4,.webm,.mkv,.mov,.wav,.mp3,.m4a,.flac,.ogg,video/mp4,video/webm,video/quicktime,video/x-matroska,audio/wav,audio/mpeg,audio/mp4,audio/flac,audio/ogg';

export interface MediaValidationResult {
  valid: boolean;
  extension: string;
  spec: SupportedFormatSpec | null;
  errorMessage: string | null;
}

export function validateMediaFile(fileName: string, mimeType: string, sizeBytes: number): MediaValidationResult {
  const cleanName = fileName.trim();
  const dotIndex = cleanName.lastIndexOf('.');
  const extension = dotIndex >= 0 ? cleanName.slice(dotIndex + 1).toLowerCase() : '';

  if (!cleanName || !extension) {
    return {
      valid: false,
      extension: '',
      spec: null,
      errorMessage: 'Selected file has no recognizable media extension. Supported formats: MP4, WebM, MKV, MOV, WAV, MP3, M4A, FLAC, OGG.',
    };
  }

  if (sizeBytes <= 0) {
    return {
      valid: false,
      extension,
      spec: null,
      errorMessage: `File "${cleanName}" is empty (0 bytes) and cannot be imported.`,
    };
  }

  const byExt = SUPPORTED_MEDIA_FORMATS.find((item) => item.extension === extension) ?? null;
  if (!byExt) {
    return {
      valid: false,
      extension,
      spec: null,
      errorMessage: `Unsupported file format ".${extension}". Supported media containers are MP4, WebM, MKV, MOV, WAV, MP3, M4A, FLAC, and OGG.`,
    };
  }

  // If MIME is present and clearly non-media (e.g. text/plain renamed to .mp4)
  if (
    mimeType &&
    !mimeType.startsWith('video/') &&
    !mimeType.startsWith('audio/') &&
    mimeType !== 'application/octet-stream' &&
    mimeType !== 'application/x-matroska'
  ) {
    return {
      valid: false,
      extension,
      spec: null,
      errorMessage: `MIME type "${mimeType}" does not match a supported audio or video container.`,
    };
  }

  return {
    valid: true,
    extension,
    spec: byExt,
    errorMessage: null,
  };
}

/**
 * Generates an overlapping chunk plan so long anime episodes (24+ min) or movies
 * are never loaded wholly into RAM during AI inference or DSP stages.
 */
export function buildChunkPlan(
  durationMs: number | null,
  chunkDurationMs: number = 30000,
  chunkOverlapMs: number = 2000
): ChunkDefinition[] {
  if (durationMs === null || durationMs <= 0) {
    return [];
  }

  const safeChunkMs = Math.max(5000, chunkDurationMs);
  const safeOverlapMs = Math.min(Math.floor(safeChunkMs / 3), Math.max(0, chunkOverlapMs));

  const chunks: ChunkDefinition[] = [];
  let index = 0;
  let cursor = 0;

  while (cursor < durationMs) {
    const startMs = cursor;
    const endMs = Math.min(durationMs, cursor + safeChunkMs);
    const overlapStartMs = Math.max(0, startMs - safeOverlapMs);
    const overlapEndMs = Math.min(durationMs, endMs + safeOverlapMs);

    chunks.push({
      index,
      startMs,
      endMs,
      overlapStartMs,
      overlapEndMs,
      status: 'planned',
    });

    if (endMs >= durationMs) break;
    cursor = endMs;
    index += 1;
  }

  return chunks;
}

export interface ProbedMediaResult {
  durationMs: number | null;
  widthPx: number | null;
  heightPx: number | null;
  sampleRateHz: number | null;
  channels: number | null;
  frameRateFps: number | null;
  bitrateKbps: number | null;
  decoderNotes: string;
}

/**
 * Probes real browser-accessible metadata from a local File/Blob using HTMLMediaElement
 * and (for reasonably sized audio buffers <= 25 MB) Web Audio API header decode.
 * Never fabricates values that the browser decoder cannot actually read.
 */
export async function probeMediaFile(
  file: Blob,
  kind: 'video' | 'audio',
  containerLabel: string
): Promise<ProbedMediaResult> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    return {
      durationMs: null,
      widthPx: null,
      heightPx: null,
      sampleRateHz: null,
      channels: null,
      frameRateFps: null,
      bitrateKbps: null,
      decoderNotes: 'Non-browser environment: media probing skipped.',
    };
  }

  const objectUrl = URL.createObjectURL(file);
  const notes: string[] = [];

  let durationMs: number | null = null;
  let widthPx: number | null = null;
  let heightPx: number | null = null;
  let sampleRateHz: number | null = null;
  let channels: number | null = null;
  const frameRateFps: number | null = null; // Browser HTMLVideoElement does not reliably expose exact FPS without MediaCapabilities/demuxer

  try {
    await new Promise<void>((resolve) => {
      const el = document.createElement(kind === 'video' ? 'video' : 'audio');
      el.preload = 'metadata';
      el.muted = true;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        el.removeAttribute('src');
        el.load();
        resolve();
      };

      const timeout = window.setTimeout(() => {
        notes.push('Metadata probe timed out; container may require native demuxer.');
        finish();
      }, 4500);

      el.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        if (Number.isFinite(el.duration) && el.duration > 0) {
          durationMs = Math.round(el.duration * 1000);
        }
        if (el instanceof HTMLVideoElement) {
          if (el.videoWidth > 0) widthPx = el.videoWidth;
          if (el.videoHeight > 0) heightPx = el.videoHeight;
        }
        finish();
      };

      el.onerror = () => {
        window.clearTimeout(timeout);
        notes.push(
          `Browser media element could not natively decode ${containerLabel} header; file preserved locally in original_media.`
        );
        finish();
      };

      el.src = objectUrl;
    });

    // 1. Memory-safe RIFF/WAV header parser (reads only first 64 KB, avoids AudioContext resampling)
    if (kind === 'audio' && file.size >= 44) {
      try {
        const headerSlice = await file.slice(0, 65536).arrayBuffer();
        const view = new DataView(headerSlice);
        const riff =
          String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
        const wave =
          String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
        if (riff === 'RIFF' && wave === 'WAVE') {
          let offset = 12;
          let byteRate = 0;
          let dataSize = 0;
          while (offset + 8 <= view.byteLength) {
            const chunkId = String.fromCharCode(
              view.getUint8(offset),
              view.getUint8(offset + 1),
              view.getUint8(offset + 2),
              view.getUint8(offset + 3)
            );
            const chunkSize = view.getUint32(offset + 4, true);
            if (chunkId === 'fmt ' && offset + 24 <= view.byteLength) {
              channels = view.getUint16(offset + 10, true);
              sampleRateHz = view.getUint32(offset + 12, true);
              byteRate = view.getUint32(offset + 16, true);
            } else if (chunkId === 'data') {
              dataSize = chunkSize;
              break;
            }
            offset += 8 + chunkSize + (chunkSize % 2);
          }
          if (durationMs === null && byteRate > 0 && dataSize > 0) {
            durationMs = Math.round((dataSize / byteRate) * 1000);
          }
        }
      } catch {
        // Fall through to Web Audio probe below
      }
    }

    // 2. Fallback Web Audio header probe for compressed audio files <= 25 MB when native sample rate not yet read
    const AudioCtx =
      typeof window !== 'undefined'
        ? window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;

    if (sampleRateHz === null && AudioCtx && file.size <= 25 * 1024 * 1024 && kind === 'audio') {
      const ctx = new AudioCtx();
      try {
        const buffer = await file.arrayBuffer();
        const decoded = await ctx.decodeAudioData(buffer.slice(0));
        sampleRateHz = decoded.sampleRate;
        channels = decoded.numberOfChannels;
        if (durationMs === null && Number.isFinite(decoded.duration)) {
          durationMs = Math.round(decoded.duration * 1000);
        }
      } catch {
        notes.push('Web Audio API could not decode audio stream header in this browser.');
      } finally {
        await ctx.close().catch(() => undefined);
      }
    } else if (kind === 'video') {
      notes.push(
        'Audio sample rate, channel layout, and exact frame rate require container demuxing (reserved for native/FFmpeg-WASM or Prompt 2 media pipeline).'
      );
    } else if (sampleRateHz === null && file.size > 25 * 1024 * 1024) {
      notes.push(
        'Skipped full in-memory Web Audio decode (>25 MB memory guard) to comply with 8 GB device budget.'
      );
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  const bitrateKbps =
    durationMs && durationMs > 0
      ? Math.round((file.size * 8) / durationMs)
      : null;

  return {
    durationMs,
    widthPx,
    heightPx,
    sampleRateHz,
    channels,
    frameRateFps,
    bitrateKbps,
    decoderNotes:
      notes.length > 0
        ? notes.join(' ')
        : 'Metadata probed directly from local browser media decoder.',
  };
}

export function createMediaMetadataRecord(
  projectId: string,
  mediaId: string,
  containerFormat: string,
  probe: ProbedMediaResult
): MediaMetadata {
  return {
    id: `meta_${mediaId}`,
    projectId,
    mediaId,
    durationMs: probe.durationMs,
    containerFormat,
    sampleRateHz: probe.sampleRateHz,
    channels: probe.channels,
    widthPx: probe.widthPx,
    heightPx: probe.heightPx,
    frameRateFps: probe.frameRateFps,
    bitrateKbps: probe.bitrateKbps,
    decoderNotes: probe.decoderNotes,
    analyzedAt: new Date().toISOString(),
  };
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return 'Unavailable';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, idx);
  return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[idx]}`;
}
