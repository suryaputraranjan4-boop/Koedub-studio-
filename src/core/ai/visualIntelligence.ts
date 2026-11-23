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
  mouthMotionScore: number; // 0..1 estimated from consecutive frames
  appearanceHistogram: number[]; // normalized 12-bin RGB descriptor
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
 * Scene Detection Agent (#3): Detects visual scene boundaries in a local video Blob
 * using sampled frame histogram differences (never loading the full video into RAM).
 */
export async function detectVideoScenesFromBlob(
  projectId: string,
  videoBlob: Blob,
  durationMs: number,
  samplingIntervalMs: number = 4000
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

    const maxSamples = 40;
    const stepMs = Math.max(samplingIntervalMs, Math.ceil(durationMs / maxSamples));
    let prevHist: number[] | null = null;
    let sceneStartMs = 0;
    let sceneIdx = 0;

    for (let t = 0; t < durationMs; t += stepMs) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        video.onseeked = done;
        video.currentTime = Math.min(durationMs / 1000 - 0.05, t / 1000);
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
 * Frame Extraction Agent (#4): Extracts deduplicated JPEG keyframes per scene
 * into temp_processing storage with global timestamps.
 */
export async function extractKeyframesForScenes(
  projectId: string,
  videoBlob: Blob,
  scenes: Scene[],
  storeFrameBlob: (vaultKey: string, blob: Blob) => Promise<void>
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

    for (const scene of scenes.slice(0, 16)) {
      const midTs = Math.round((scene.startMs + scene.endMs) / 2);
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        video.onseeked = done;
        video.currentTime = Math.max(0, midTs / 1000);
        window.setTimeout(done, 450);
      });

      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) continue;

      ctx.drawImage(video, 0, 0, targetW, targetH);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.72)
      );

      const frameId = `frm_${projectId}_${scene.index}_${midTs}`;
      const vaultKey = `temp_processing/${projectId}/${frameId}.jpg`;

      if (blob) {
        await storeFrameBlob(vaultKey, blob);
      }

      imageElements.set(frameId, canvas);
      frames.push({
        id: frameId,
        projectId,
        sceneId: scene.id,
        timestampMs: midTs,
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
 * Face Detection Agent (#5): Runs verified MediaPipe BlazeFace detector over extracted keyframes.
 */
export function runMediaPipeFaceDetectionOnFrames(
  detector: MediaPipeFaceDetectorLike,
  frames: ExtractedFrame[],
  imageElements: Map<string, HTMLCanvasElement>
): { detections: FaceDetectionBox[]; updatedFrames: ExtractedFrame[] } {
  const detections: FaceDetectionBox[] = [];
  const updatedFrames: ExtractedFrame[] = [];
  let prevLowerFaceHist: number[] | null = null;

  for (const frame of frames) {
    const canvas = imageElements.get(frame.id);
    if (!canvas) {
      updatedFrames.push(frame);
      continue;
    }

    const result = detector.detect(canvas);
    const rawDetections = result.detections ?? [];
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    for (const det of rawDetections) {
      const box = det.boundingBox;
      if (!box || box.width <= 4 || box.height <= 4) continue;
      const x = Math.max(0, Math.floor(box.originX));
      const y = Math.max(0, Math.floor(box.originY));
      const w = Math.min(canvas.width - x, Math.floor(box.width));
      const h = Math.min(canvas.height - y, Math.floor(box.height));
      if (w <= 4 || h <= 4) continue;

      let hist = new Array(12).fill(1 / Math.sqrt(12));
      let mouthMotionScore = 0.2;

      if (ctx) {
        const crop = ctx.getImageData(x, y, w, h).data;
        hist = computeColorHistogram(crop);

        // Estimate lower-face / mouth-region change relative to previous detected face
        const mouthY = Math.min(canvas.height - 2, y + Math.floor(h * 0.62));
        const mouthH = Math.max(2, Math.min(canvas.height - mouthY, Math.floor(h * 0.35)));
        const mouthCrop = ctx.getImageData(x, mouthY, w, mouthH).data;
        const mouthHist = computeColorHistogram(mouthCrop);
        if (prevLowerFaceHist) {
          mouthMotionScore = Math.min(
            1,
            Math.max(0, 1 - cosineSimilarity(prevLowerFaceHist, mouthHist))
          );
        }
        prevLowerFaceHist = mouthHist;
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
        appearanceHistogram: hist,
      });
    }

    updatedFrames.push({
      ...frame,
      detectedFaceCount: rawDetections.length,
    });
  }

  return { detections, updatedFrames };
}

/**
 * Character Tracking Agent (#6): Clusters detected face regions across keyframes using
 * appearance histogram cosine similarity while flagging visually similar clusters as ambiguous.
 */
export function trackVisualCharacters(
  detections: FaceDetectionBox[],
  mergeThreshold: number = 0.91,
  ambiguityThreshold: number = 0.84
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
      target.averageScore =
        (target.averageScore * count + det.score) / (count + 1);
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
        visualSummary: `Detected face track ${id} (${Math.round(det.width)}×${Math.round(det.height)}px)`,
        ambiguousSimilarClusterIds: [],
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
 * 3. Mouth-region motion cues
 * 4. Scene context & character tracking history
 * Never forces an uncertain match — flags ambiguous / off-screen / narrator cases for review.
 */
export function computeMultimodalFaceVoiceMatches(params: {
  projectId: string;
  speakers: Speaker[];
  speakerTurnTimestamps: Record<string, Array<{ startMs: number; endMs: number }>>;
  visualTracks: VisualTrackCluster[];
  existingCharacters: CharacterProfile[];
}): MultimodalMatchResult {
  const { projectId, speakers, speakerTurnTimestamps, visualTracks, existingCharacters } =
    params;
  const now = new Date().toISOString();
  const associations: CharacterSpeakerAssociation[] = [];
  const reviewNotes: string[] = [];

  for (const speaker of speakers) {
    const turns = speakerTurnTimestamps[speaker.speakerLabel] ?? [];
    const existingMatchedChar = existingCharacters.find(
      (c) =>
        c.characterId === speaker.matchedCharacterId ||
        c.associatedSpeakerIds.includes(speaker.speakerLabel)
    );

    const audioEvidenceScore = Math.min(
      0.95,
      Math.max(0.35, speaker.matchConfidence || 0.65)
    );

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

    const visualEvidenceScore = bestTrack ? Math.min(0.95, bestOverlapRatio) : 0;
    const mouthSyncEvidenceScore = bestTrack ? bestTrack.mouthMotionAverage : 0;
    const sceneContextScore = existingMatchedChar ? 0.8 : bestTrack ? 0.5 : 0.25;

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
    } else if (combinedConfidence >= 0.78) {
      status = 'confirmed';
    } else {
      status = 'needs_review';
      reviewNotes.push(
        `${speaker.speakerLabel}: Moderate multimodal confidence (${Math.round(
          combinedConfidence * 100
        )}%) — queued for user confirmation.`
      );
    }

    const proposedCharacterId =
      existingMatchedChar?.characterId ?? `CHR-CAND-${speaker.speakerLabel}`;

    associations.push({
      id: `assoc_${projectId}_${speaker.id}`,
      projectId,
      characterId: proposedCharacterId,
      speakerId: speaker.speakerLabel,
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
