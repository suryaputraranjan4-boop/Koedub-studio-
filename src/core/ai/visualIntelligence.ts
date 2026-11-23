import type {
  CharacterProfile,
  CharacterSpeakerAssociation,
  ExtractedFrame,
  Scene,
  Speaker,
} from '../../types/domain';
import { cosineSimilarity } from './audioDsp';

export interface FaceDetectionBox {
  frameId: string;
  sceneId: string;
  timestampMs: number;
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  mouthMotionScore: number; // 0..1 computed per-track across consecutive same-scene frames
  appearanceHistogram: number[]; // 36-dim multi-region descriptor (hair/crown + face + torso/clothing)
  mouthHistogram?: number[];
}

export interface VisualTrackCluster {
  trackClusterId: string;
  sceneIds: string[];
  timestampsMs: number[];
  averageScore: number;
  mouthMotionAverage: number;
  appearanceDescriptor: number[];
  visualSummary: string;
  ambiguousSimilarClusterIds: string[];
  animeRecognitionCaveat: string;
}

export interface MultimodalMatchResult {
  associations: CharacterSpeakerAssociation[];
  reviewNotes: string[];
}

export function computeColorHistogram(rgba: Uint8ClampedArray): number[] {
  const bins = new Array(12).fill(0);
  const step = Math.max(4, Math.floor(rgba.length / 4 / 800) * 4);
  for (let i = 0; i < rgba.length; i += step) {
    const rBin = Math.min(3, Math.floor(rgba[i] / 64));
    const gBin = Math.min(3, Math.floor(rgba[i + 1] / 64));
    const bBin = Math.min(3, Math.floor(rgba[i + 2] / 64));
    bins[rBin] += 1;
    bins[4 + gBin] += 1;
    bins[8 + bBin] += 1;
  }
  const norm = Math.sqrt(bins.reduce((s, v) => s + v * v, 0)) || 1;
  return bins.map((v) => v / norm);
}

/**
 * Computes a 36-dimensional multi-region anime appearance descriptor combining:
 * - Upper-head / hair color distribution (12 dims, weighted 1.25× since anime hair is distinctive)
 * - Facial region color distribution (12 dims)
 * - Torso / clothing region directly below the face (12 dims)
 * Kept cleanly separated from face detection so visual clustering doesn't rely solely on a tiny face crop.
 */
export function extractMultiRegionAppearanceDescriptor(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  x: number,
  y: number,
  w: number,
  h: number
): number[] {
  const faceCrop = ctx.getImageData(x, y, w, h).data;
  const faceHist = computeColorHistogram(faceCrop);

  // Upper-head / hair region (above & top 30% of face box)
  const hairY = Math.max(0, y - Math.floor(h * 0.45));
  const hairH = Math.max(4, Math.min(canvasHeight - hairY, Math.floor(h * 0.75)));
  const hairX = Math.max(0, x - Math.floor(w * 0.15));
  const hairW = Math.max(4, Math.min(canvasWidth - hairX, Math.floor(w * 1.3)));
  const hairHist = computeColorHistogram(ctx.getImageData(hairX, hairY, hairW, hairH).data);

  // Clothing / torso region below chin
  const torsoY = Math.min(canvasHeight - 4, y + h);
  const torsoH = Math.max(4, Math.min(canvasHeight - torsoY, Math.floor(h * 1.1)));
  const torsoX = Math.max(0, x - Math.floor(w * 0.25));
  const torsoW = Math.max(4, Math.min(canvasWidth - torsoX, Math.floor(w * 1.5)));
  const torsoHist =
    torsoY < canvasHeight - 4
      ? computeColorHistogram(ctx.getImageData(torsoX, torsoY, torsoW, torsoH).data)
      : new Array(12).fill(0);

  const combined = [
    ...hairHist.map((v) => v * 1.25),
    ...faceHist,
    ...torsoHist.map((v) => v * 1.1),
  ];
  const norm = Math.sqrt(combined.reduce((acc, v) => acc + v * v, 0)) || 1;
  return combined.map((v) => v / norm);
}

/**
 * Reconstructs HTMLCanvasElements from persisted JPEG Blobs in file_vault so checkpoint
 * recovery can restore visual inspection state across full restarts without re-seeking video.
 */
export async function reconstructFrameCanvasesFromBlobs(
  frames: ExtractedFrame[],
  loadFrameBlob: (vaultKey: string) => Promise<Blob | null>
): Promise<Map<string, HTMLCanvasElement>> {
  const map = new Map<string, HTMLCanvasElement>();
  if (typeof document === 'undefined') return map;

  for (const frame of frames) {
    if (!frame.vaultKey) continue;
    const blob = await loadFrameBlob(frame.vaultKey);
    if (!blob) continue;
    try {
      const bitmap =
        typeof createImageBitmap === 'function' ? await createImageBitmap(blob) : null;
      const canvas = document.createElement('canvas');
      canvas.width = frame.widthPx || bitmap?.width || 320;
      canvas.height = frame.heightPx || bitmap?.height || 180;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        bitmap?.close?.();
        continue;
      }
      if (bitmap) {
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        map.set(frame.id, canvas);
      } else {
        const url = URL.createObjectURL(blob);
        try {
          await new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              resolve();
            };
            img.onerror = () => resolve();
            img.src = url;
          });
          map.set(frame.id, canvas);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
    } catch {
      // Skip corrupt JPEG cleanly
    }
  }

  return map;
}

/**
 * Scene Detection Agent (#3): Adaptive full-episode visual scene boundary detector.
 * Removes the old hardcoded 40-sample cap — scales sampling density adaptively across
 * full 24+ minute anime episodes while keeping temporary RAM flat (one 96×54 canvas reused).
 */
export async function detectVideoScenesFromBlob(
  projectId: string,
  videoBlob: Blob,
  durationMs: number,
  samplingIntervalMs: number = 2500
): Promise<Scene[]> {
  if (typeof document === 'undefined' || durationMs <= 0) return [];

  const url = URL.createObjectURL(videoBlob);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;

  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 54;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const scenes: Scene[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () =>
        reject(new Error('Browser video element could not decode video frames.'));
      window.setTimeout(() => resolve(), 3500);
    });

    if (!ctx || video.videoWidth === 0) {
      return [];
    }

    // Adaptive interval: fine 2.5s scans for short clips, up to ~240 evenly spaced samples across a full 24-min episode
    const adaptiveStepMs =
      durationMs <= 120_000
        ? Math.max(1500, samplingIntervalMs)
        : Math.max(samplingIntervalMs, Math.min(6000, Math.ceil(durationMs / 240)));

    let prevHist: number[] | null = null;
    let sceneStartMs = 0;
    let sceneIdx = 0;

    for (let t = 0; t < durationMs; t += adaptiveStepMs) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        video.onseeked = done;
        video.currentTime = Math.min(Math.max(0, durationMs / 1000 - 0.05), t / 1000);
        window.setTimeout(done, 450);
      });

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const hist = computeColorHistogram(pixels);

      if (prevHist) {
        const sim = cosineSimilarity(prevHist, hist);
        if (sim < 0.84 && t - sceneStartMs >= 2000) {
          scenes.push({
            id: `scn_${projectId}_${sceneIdx}`,
            projectId,
            index: sceneIdx,
            startMs: sceneStartMs,
            endMs: t,
            contextSummary: `Visual scene ${sceneIdx + 1} (histogram cut similarity ${sim.toFixed(2)})`,
            environmentTag: sim < 0.65 ? 'major_cut' : 'shot_change',
            detectionSource: 'prompt2_model',
          });
          sceneStartMs = t;
          sceneIdx += 1;
        }
      }
      prevHist = hist;
    }

    scenes.push({
      id: `scn_${projectId}_${sceneIdx}`,
      projectId,
      index: sceneIdx,
      startMs: sceneStartMs,
      endMs: durationMs,
      contextSummary: `Visual scene ${sceneIdx + 1}`,
      environmentTag: 'continuous_scene',
      detectionSource: 'prompt2_model',
    });

    return scenes;
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

/**
 * Frame Extraction Agent (#4): Removes the old 16-scene cap!
 * Extracts representative deduplicated JPEG keyframes across ALL detected scenes AND
 * prioritizes dialogue timestamps (with short consecutive-pair frames inside dialogue scenes
 * so per-track mouth motion can be evaluated reliably across consecutive frames).
 */
export async function extractKeyframesForScenes(
  projectId: string,
  videoBlob: Blob,
  scenes: Scene[],
  storeFrameBlob: (vaultKey: string, blob: Blob) => Promise<void>,
  dialogueTimestampsMs: number[] = []
): Promise<{ frames: ExtractedFrame[]; imageElements: Map<string, HTMLCanvasElement> }> {
  if (typeof document === 'undefined' || scenes.length === 0) {
    return { frames: [], imageElements: new Map() };
  }

  const url = URL.createObjectURL(videoBlob);
  const video = document.createElement('video');
  video.muted = true;
  video.src = url;

  const frames: ExtractedFrame[] = [];
  const imageElements = new Map<string, HTMLCanvasElement>();

  try {
    await new Promise<void>((resolve) => {
      video.onloadeddata = () => resolve();
      window.setTimeout(() => resolve(), 3000);
    });

    if (video.videoWidth === 0) {
      return { frames: [], imageElements };
    }

    const targetW = Math.min(480, video.videoWidth);
    const targetH = Math.round((targetW / video.videoWidth) * video.videoHeight);

    // Build adaptive extraction schedule covering ALL scenes + dialogue priority points
    const sampleTargets: Array<{ scene: Scene; tsMs: number }> = [];
    for (const scene of scenes) {
      const sceneDur = Math.max(200, scene.endMs - scene.startMs);
      const dialogueInScene = dialogueTimestampsMs.filter(
        (ts) => ts >= scene.startMs && ts <= scene.endMs
      );

      if (dialogueInScene.length > 0) {
        // Extract up to 3 representative dialogue-aligned timestamps per scene (including short 400ms pair for mouth motion)
        const picked = dialogueInScene.slice(0, 2);
        for (const dts of picked) {
          sampleTargets.push({ scene, tsMs: dts });
          if (dts + 400 < scene.endMs) {
            sampleTargets.push({ scene, tsMs: dts + 400 });
          }
        }
      } else {
        const midTs = Math.round((scene.startMs + scene.endMs) / 2);
        sampleTargets.push({ scene, tsMs: midTs });
        if (sceneDur >= 4000) {
          sampleTargets.push({ scene, tsMs: Math.min(scene.endMs - 200, midTs + 450) });
        }
      }
    }

    // Deduplicate timestamps within 250ms and keep RAM bounded (<= 96 stored canvases)
    const dedupTargets: Array<{ scene: Scene; tsMs: number }> = [];
    sampleTargets.sort((a, b) => a.tsMs - b.tsMs);
    for (const item of sampleTargets) {
      const prev = dedupTargets[dedupTargets.length - 1];
      if (!prev || Math.abs(item.tsMs - prev.tsMs) >= 250) {
        dedupTargets.push(item);
      }
      if (dedupTargets.length >= 96) break;
    }

    let lastFrameHist: number[] | null = null;
    for (const { scene, tsMs } of dedupTargets) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        video.onseeked = done;
        video.currentTime = Math.max(0, tsMs / 1000);
        window.setTimeout(done, 450);
      });

      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) continue;

      ctx.drawImage(video, 0, 0, targetW, targetH);

      // Deduplicate near-identical static frames except short mouth-motion pairs (<=600ms)
      const hist = computeColorHistogram(ctx.getImageData(0, 0, targetW, targetH).data);
      const prevFrame = frames[frames.length - 1];
      const isShortPair = prevFrame && prevFrame.sceneId === scene.id && tsMs - prevFrame.timestampMs <= 600;
      if (lastFrameHist && !isShortPair && cosineSimilarity(lastFrameHist, hist) > 0.992) {
        continue;
      }
      lastFrameHist = hist;

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.72)
      );

      const frameId = `frm_${projectId}_${scene.index}_${tsMs}`;
      const vaultKey = `temp_processing/${projectId}/${frameId}.jpg`;

      if (blob) {
        await storeFrameBlob(vaultKey, blob);
      }

      imageElements.set(frameId, canvas);
      frames.push({
        id: frameId,
        projectId,
        sceneId: scene.id,
        timestampMs: tsMs,
        storageNamespace: 'temp_processing',
        vaultKey: blob ? vaultKey : null,
        widthPx: targetW,
        heightPx: targetH,
        detectedFaceCount: 0,
      });
    }

    return { frames, imageElements };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

interface MediaPipeFaceDetectorLike {
  detect: (image: HTMLCanvasElement) => {
    detections?: Array<{
      boundingBox?: { originX: number; originY: number; width: number; height: number };
      categories?: Array<{ score?: number }>;
    }>;
  };
}

/**
 * Computes spatial IoU (Intersection-over-Union) between two face boxes for per-face tracking.
 */
function boxIoU(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Face Detection Agent (#5): Runs verified MediaPipe BlazeFace detector over extracted keyframes.
 * - Extracts 36-dim multi-region anime appearance descriptors (hair/crown + face + torso).
 * - Computes mouth-region motion STRICTLY per-face across consecutive frames within the SAME
 *   scene and bounded frame delta (<= 2500 ms), resetting across camera cuts and never sharing
 *   one global `prevLowerFaceHist` between unrelated faces!
 */
export function runMediaPipeFaceDetectionOnFrames(
  detector: MediaPipeFaceDetectorLike,
  frames: ExtractedFrame[],
  imageElements: Map<string, HTMLCanvasElement>
): { detections: FaceDetectionBox[]; updatedFrames: ExtractedFrame[] } {
  const detections: FaceDetectionBox[] = [];
  const updatedFrames: ExtractedFrame[] = [];

  // Per-frame tracked faces from immediately preceding frame in the same scene
  let prevSceneId: string | null = null;
  let prevTimestampMs = -1;
  let prevFrameFaces: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    appearance: number[];
    mouthHist: number[];
  }> = [];

  const sortedFrames = [...frames].sort((a, b) => a.timestampMs - b.timestampMs);

  for (const frame of sortedFrames) {
    const canvas = imageElements.get(frame.id);
    if (!canvas) {
      updatedFrames.push(frame);
      continue;
    }

    // Reset temporal mouth-motion tracking on scene boundary cuts or long time gaps (>2.5s)
    const sceneChanged = prevSceneId !== null && prevSceneId !== frame.sceneId;
    const gapTooLong = prevTimestampMs >= 0 && frame.timestampMs - prevTimestampMs > 2500;
    if (sceneChanged || gapTooLong) {
      prevFrameFaces = [];
    }

    const result = detector.detect(canvas);
    const rawDetections = result.detections ?? [];
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const currentFrameFaces: typeof prevFrameFaces = [];

    for (const det of rawDetections) {
      const box = det.boundingBox;
      if (!box || box.width <= 4 || box.height <= 4) continue;
      const x = Math.max(0, Math.floor(box.originX));
      const y = Math.max(0, Math.floor(box.originY));
      const w = Math.min(canvas.width - x, Math.floor(box.width));
      const h = Math.min(canvas.height - y, Math.floor(box.height));
      if (w <= 4 || h <= 4) continue;

      let appearance = new Array(36).fill(1 / Math.sqrt(36));
      let mouthHist = new Array(12).fill(1 / Math.sqrt(12));
      let mouthMotionScore = 0; // 0 when no valid temporal match in same scene

      if (ctx) {
        appearance = extractMultiRegionAppearanceDescriptor(
          ctx,
          canvas.width,
          canvas.height,
          x,
          y,
          w,
          h
        );

        const mouthY = Math.min(canvas.height - 2, y + Math.floor(h * 0.62));
        const mouthH = Math.max(2, Math.min(canvas.height - mouthY, Math.floor(h * 0.35)));
        mouthHist = computeColorHistogram(ctx.getImageData(x, mouthY, w, mouthH).data);

        // Match ONLY against the corresponding tracked face in the previous frame of the same scene
        let bestMatch: (typeof prevFrameFaces)[number] | null = null;
        let bestMatchScore = 0;
        for (const pf of prevFrameFaces) {
          const iou = boxIoU({ x, y, width: w, height: h }, pf);
          const appSim = cosineSimilarity(appearance, pf.appearance);
          const combined = iou * 0.55 + appSim * 0.45;
          if (combined > bestMatchScore && (iou >= 0.25 || appSim >= 0.88)) {
            bestMatchScore = combined;
            bestMatch = pf;
          }
        }

        if (bestMatch) {
          const dtSec = Math.max(0.2, (frame.timestampMs - prevTimestampMs) / 1000);
          const rawDiff = Math.min(1, Math.max(0, 1 - cosineSimilarity(bestMatch.mouthHist, mouthHist)));
          // Normalize slightly by frame delta so rapid short-interval mouth changes score higher than slow drift
          mouthMotionScore = Math.min(1, rawDiff * (dtSec <= 0.7 ? 1.2 : 0.85));
        }

        currentFrameFaces.push({ x, y, width: w, height: h, appearance, mouthHist });
      }

      detections.push({
        frameId: frame.id,
        sceneId: frame.sceneId,
        timestampMs: frame.timestampMs,
        x,
        y,
        width: w,
        height: h,
        score: Math.round((det.categories?.[0]?.score ?? 0.6) * 100) / 100,
        mouthMotionScore: Math.round(mouthMotionScore * 100) / 100,
        appearanceHistogram: appearance,
        mouthHistogram: mouthHist,
      });
    }

    prevSceneId = frame.sceneId;
    prevTimestampMs = frame.timestampMs;
    prevFrameFaces = currentFrameFaces;

    updatedFrames.push({
      ...frame,
      detectedFaceCount: rawDetections.length,
    });
  }

  return { detections, updatedFrames };
}

/**
 * Character Tracking Agent (#6): Clusters detected character regions using 36-dim multi-region
 * appearance descriptors (hair/crown + face + clothing) while explicitly flagging stylized
 * anime visual uncertainty so uncertain clusters always require manual review.
 */
export function trackVisualCharacters(
  detections: FaceDetectionBox[],
  mergeThreshold: number = 0.9,
  ambiguityThreshold: number = 0.82
): VisualTrackCluster[] {
  const clusters: VisualTrackCluster[] = [];

  for (const det of detections) {
    let bestIdx = -1;
    let bestSim = -1;

    for (let i = 0; i < clusters.length; i += 1) {
      const sim = cosineSimilarity(
        det.appearanceHistogram,
        clusters[i].appearanceDescriptor
      );
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestSim >= mergeThreshold) {
      const target = clusters[bestIdx];
      const count = target.timestampsMs.length;
      target.timestampsMs.push(det.timestampMs);
      if (!target.sceneIds.includes(det.sceneId)) {
        target.sceneIds.push(det.sceneId);
      }
      target.averageScore = (target.averageScore * count + det.score) / (count + 1);
      target.mouthMotionAverage =
        (target.mouthMotionAverage * count + det.mouthMotionScore) / (count + 1);
      target.appearanceDescriptor = target.appearanceDescriptor.map(
        (v, idx) => (v * count + (det.appearanceHistogram[idx] ?? 0)) / (count + 1)
      );
    } else {
      const id = `VTRK_${String(clusters.length + 1).padStart(2, '0')}`;
      const newCluster: VisualTrackCluster = {
        trackClusterId: id,
        sceneIds: [det.sceneId],
        timestampsMs: [det.timestampMs],
        averageScore: det.score,
        mouthMotionAverage: det.mouthMotionScore,
        appearanceDescriptor: [...det.appearanceHistogram],
        visualSummary: `Multi-region anime appearance track ${id} (${Math.round(det.width)}×${Math.round(det.height)}px, hair+face+clothing)`,
        ambiguousSimilarClusterIds: [],
        animeRecognitionCaveat:
          'BlazeFace + multi-region color descriptor provides visual grouping hints only (not a dedicated anime face identity neural network); confirm character identity in Character Studio.',
      };

      if (bestIdx >= 0 && bestSim >= ambiguityThreshold) {
        newCluster.ambiguousSimilarClusterIds.push(clusters[bestIdx].trackClusterId);
        clusters[bestIdx].ambiguousSimilarClusterIds.push(id);
      }
      clusters.push(newCluster);
    }
  }

  return clusters;
}

/**
 * Face-Voice Matching Agent (#9): Multimodal evidence fusion combining:
 * 1. Audio speaker evidence (primary)
 * 2. Face visibility during speaker turn timestamps
 * 3. Per-track mouth-region motion cues
 * 4. Strictly series-scoped & project-scoped character memory
 * Never forces an uncertain match — calibrates anime visual confidence conservatively and
 * flags ambiguous / off-screen / narrator / unconfirmed anime matches for user review.
 */
export function computeMultimodalFaceVoiceMatches(params: {
  projectId: string;
  seriesScope?: string;
  speakers: Speaker[];
  speakerTurnTimestamps: Record<string, Array<{ startMs: number; endMs: number }>>;
  visualTracks: VisualTrackCluster[];
  existingCharacters: CharacterProfile[];
}): MultimodalMatchResult {
  const {
    projectId,
    seriesScope = '',
    speakers,
    speakerTurnTimestamps,
    visualTracks,
    existingCharacters,
  } = params;
  const now = new Date().toISOString();
  const associations: CharacterSpeakerAssociation[] = [];
  const reviewNotes: string[] = [];

  // Strictly filter candidate characters to THIS project or the SAME seriesScope
  const normalizedSeries = seriesScope.trim().toLowerCase();
  const scopedCharacters = existingCharacters.filter(
    (c) =>
      c.projectId === projectId ||
      (normalizedSeries.length > 0 && (c.seriesScope ?? '').trim().toLowerCase() === normalizedSeries)
  );

  for (const speaker of speakers) {
    const internalId = speaker.internalSpeakerId || `spk_${projectId}_${speaker.speakerLabel}`;
    const turns = speakerTurnTimestamps[speaker.speakerLabel] ?? [];
    const existingMatchedChar = scopedCharacters.find(
      (c) =>
        c.characterId === speaker.matchedCharacterId ||
        c.associatedSpeakerIds.includes(internalId) ||
        (c.projectId === projectId && c.associatedSpeakerIds.includes(speaker.speakerLabel))
    );

    const audioEvidenceScore = Math.min(0.88, Math.max(0.35, speaker.matchConfidence || 0.6));

    let bestTrack: VisualTrackCluster | null = null;
    let bestOverlapRatio = 0;
    let secondBestOverlapRatio = 0;

    for (const track of visualTracks) {
      if (turns.length === 0) break;
      let matchingFrames = 0;
      for (const ts of track.timestampsMs) {
        const insideTurn = turns.some(
          (t) => ts >= t.startMs - 750 && ts <= t.endMs + 750
        );
        if (insideTurn) matchingFrames += 1;
      }
      const ratio = matchingFrames / Math.max(1, track.timestampsMs.length);
      if (ratio > bestOverlapRatio) {
        secondBestOverlapRatio = bestOverlapRatio;
        bestOverlapRatio = ratio;
        bestTrack = track;
      } else if (ratio > secondBestOverlapRatio) {
        secondBestOverlapRatio = ratio;
      }
    }

    // Cap automatic visual confidence conservatively because anime faces lack a dedicated neural anime ID model here
    const visualEvidenceScore = bestTrack ? Math.min(0.75, bestOverlapRatio * 0.85) : 0;
    const mouthSyncEvidenceScore = bestTrack ? Math.min(0.85, bestTrack.mouthMotionAverage) : 0;
    const sceneContextScore = existingMatchedChar ? 0.78 : bestTrack ? 0.45 : 0.2;

    const combinedConfidence =
      Math.round(
        (audioEvidenceScore * 0.5 +
          visualEvidenceScore * 0.22 +
          mouthSyncEvidenceScore * 0.13 +
          sceneContextScore * 0.15) *
          100
      ) / 100;

    const multipleVisibleCandidates =
      secondBestOverlapRatio > 0.25 && bestOverlapRatio - secondBestOverlapRatio < 0.2;
    const lookalikeAmbiguity = Boolean(
      bestTrack && bestTrack.ambiguousSimilarClusterIds.length > 0
    );
    const isOffScreenOrAudioOnly = visualEvidenceScore === 0;

    let status: CharacterSpeakerAssociation['status'] = 'needs_review';
    if (existingMatchedChar && existingMatchedChar.reviewStatus === 'approved') {
      status = 'confirmed';
    } else if (multipleVisibleCandidates || lookalikeAmbiguity) {
      status = 'ambiguous';
      reviewNotes.push(
        `${speaker.speakerLabel}: Multiple visible faces or visually similar tracks detected — flagged Ambiguous for user review.`
      );
    } else if (isOffScreenOrAudioOnly) {
      status = 'needs_review';
      reviewNotes.push(
        `${speaker.speakerLabel}: Audio-only / off-screen speaker (no visible face alignment) — preserved with audio evidence (${Math.round(
          audioEvidenceScore * 100
        )}%) for review.`
      );
    } else {
      // Unapproved automatic anime matches always stay needs_review until human confirmation
      status = 'needs_review';
      reviewNotes.push(
        `${speaker.speakerLabel}: Visual grouping score ${Math.round(
          combinedConfidence * 100
        )}% (multi-region descriptor; confirm anime character identity in Character Studio).`
      );
    }

    const proposedCharacterId =
      existingMatchedChar?.characterId ?? `CHR-CAND-${projectId.slice(-6)}-${speaker.speakerLabel}`;

    associations.push({
      id: `assoc_${projectId}_${speaker.id}`,
      projectId,
      characterId: proposedCharacterId,
      speakerId: speaker.speakerLabel,
      internalSpeakerId: internalId,
      audioEvidenceScore: Math.round(audioEvidenceScore * 100) / 100,
      visualEvidenceScore: Math.round(visualEvidenceScore * 100) / 100,
      mouthSyncEvidenceScore: Math.round(mouthSyncEvidenceScore * 100) / 100,
      sceneContextScore: Math.round(sceneContextScore * 100) / 100,
      combinedConfidence,
      status,
      updatedAt: now,
    });
  }

  return { associations, reviewNotes };
}
