const MAX_EXPORT_CLIPS = 4096;
const TARGET_LANGUAGES = new Set(['vi', 'en', 'zh', 'ja', 'ko']);
const AUDIO_MODES = new Set(['dubbed_only', 'duck_original', 'separated_background']);

export const DUCK_GAIN_DB = -18;
export const DUCK_ATTACK_MS = 80;
export const DUCK_RELEASE_MS = 120;
export const DUCK_GAIN_LINEAR = 10 ** (DUCK_GAIN_DB / 20);

function projectPrefix(projectId) {
  return `projects/${projectId}/`;
}

function validProjectId(projectId) {
  return typeof projectId === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(projectId);
}

function renderOptions(input) {
  const hasTarget = input?.targetLanguage !== undefined;
  const hasExport = input?.exportId !== undefined;
  if (hasTarget !== hasExport) throw new Error('targetLanguage and exportId must be provided together.');
  if (!hasTarget) {
    if (input?.audioMode !== undefined || input?.backgroundObjectKey !== undefined) {
      throw new Error('Audio render options require targetLanguage and exportId.');
    }
    return null;
  }
  if (!TARGET_LANGUAGES.has(input.targetLanguage)) throw new Error('Invalid targetLanguage.');
  if (typeof input.exportId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(input.exportId)) {
    throw new Error('Invalid exportId.');
  }

  const audioMode = input.audioMode === undefined ? 'dubbed_only' : input.audioMode;
  if (!AUDIO_MODES.has(audioMode)) throw new Error('Invalid audio mode.');

  const backgroundObjectKey = input.backgroundObjectKey;
  if (audioMode === 'separated_background') {
    if (typeof backgroundObjectKey !== 'string' || backgroundObjectKey.length === 0) {
      throw new Error('Separated backgroundObjectKey is required.');
    }
    if (!backgroundObjectKey.startsWith(`${projectPrefix(input.projectId)}stems/`)) {
      throw new Error('Separated background object is outside the project.');
    }
  } else if (backgroundObjectKey !== undefined) {
    throw new Error('backgroundObjectKey is only valid for separated_background.');
  }

  return {
    targetLanguage: input.targetLanguage,
    exportId: input.exportId,
    audioMode,
    ...(audioMode === 'separated_background' ? { backgroundObjectKey } : {}),
  };
}

export function validateRenderExportInput(input) {
  if (!input || !validProjectId(input.projectId)) throw new Error('Invalid projectId.');
  if (typeof input.objectKey !== 'string' || !input.objectKey.startsWith(`${projectPrefix(input.projectId)}source/`)) {
    throw new Error('Source object is outside the project.');
  }
  if (!Array.isArray(input.clips) || input.clips.length === 0 || input.clips.length > MAX_EXPORT_CLIPS) {
    throw new Error(`clips must contain between 1 and ${MAX_EXPORT_CLIPS} items.`);
  }

  const options = renderOptions(input);
  const clipPrefix = options
    ? `${projectPrefix(input.projectId)}voices/${options.targetLanguage}/`
    : `${projectPrefix(input.projectId)}dubbed/`;
  const seen = new Set();
  for (const clip of input.clips) {
    if (
      !clip ||
      typeof clip.segmentId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(clip.segmentId) ||
      !Number.isInteger(clip.startMs) || clip.startMs < 0 ||
      !Number.isInteger(clip.endMs) || clip.endMs <= clip.startMs ||
      typeof clip.objectKey !== 'string' || !clip.objectKey.startsWith(clipPrefix)
    ) {
      throw new Error('Invalid or cross-project dubbed clip.');
    }
    if (seen.has(clip.segmentId)) throw new Error(`Duplicate segmentId: ${clip.segmentId}`);
    seen.add(clip.segmentId);
  }
  return options ? { ...input, ...options } : input;
}

function seconds(ms) {
  return (ms / 1000).toFixed(3).replace(/\.?0+$/, '');
}

function tempoValue(value) {
  return String(Number(value.toFixed(6)));
}

export function buildAtempoChain(sourceDurationMs, targetDurationMs) {
  if (!Number.isFinite(sourceDurationMs) || sourceDurationMs <= 0 || !Number.isFinite(targetDurationMs) || targetDurationMs <= 0) {
    throw new Error('Voice and target durations must be positive finite values.');
  }

  let ratio = sourceDurationMs / targetDurationMs;
  if (Math.abs(ratio - 1) < 0.001) return '';

  const filters = [];
  while (ratio > 2.000001) {
    filters.push('atempo=2');
    ratio /= 2;
  }
  while (ratio < 0.499999) {
    filters.push('atempo=0.5');
    ratio /= 0.5;
  }
  if (Math.abs(ratio - 1) >= 0.001) filters.push(`atempo=${tempoValue(ratio)}`);
  return filters.join(',');
}

export function mergeDialogueWindows(clips, attackMs = DUCK_ATTACK_MS, releaseMs = DUCK_RELEASE_MS) {
  if (!Array.isArray(clips)) throw new Error('Dialogue clips are required.');
  if (!Number.isFinite(attackMs) || attackMs < 0 || !Number.isFinite(releaseMs) || releaseMs < 0) {
    throw new Error('Dialogue duck timing is invalid.');
  }
  const ranges = clips.map((clip) => {
    if (!clip || !Number.isFinite(clip.startMs) || !Number.isFinite(clip.endMs) || clip.startMs < 0 || clip.endMs <= clip.startMs) {
      throw new Error('Dialogue clip timing is invalid.');
    }
    return {
      startMs: Math.max(0, clip.startMs - attackMs),
      endMs: clip.endMs + releaseMs,
    };
  }).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (!last || range.startMs > last.endMs) merged.push({ ...range });
    else last.endMs = Math.max(last.endMs, range.endMs);
  }
  return merged;
}

function buildDuckBaseFilter(clips) {
  const windows = mergeDialogueWindows(clips);
  const gainFilters = windows.map((window) => (
    `volume=${DUCK_GAIN_DB}dB:enable='between(t,${seconds(window.startMs)},${seconds(window.endMs)})'`
  ));
  return `[0:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS,${gainFilters.join(',')}[base]`;
}

export function buildRenderExportArgs({
  sourcePath,
  outputPath,
  durationMs,
  clips,
  clipPaths,
  clipDurationsMs,
  audioMode = 'dubbed_only',
  backgroundPath,
}) {
  if (typeof sourcePath !== 'string' || !sourcePath || typeof outputPath !== 'string' || !outputPath) {
    throw new Error('Source and output paths are required.');
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Source duration is invalid.');
  if (!Array.isArray(clips) || !Array.isArray(clipPaths) || clips.length === 0 || clips.length !== clipPaths.length) {
    throw new Error('Clip manifest and local clip files must align.');
  }
  if (clipDurationsMs !== undefined && (
    !Array.isArray(clipDurationsMs) ||
    clipDurationsMs.length !== clips.length ||
    clipDurationsMs.some((value) => !Number.isFinite(value) || value <= 0)
  )) {
    throw new Error('Clip durations must align with local clip files.');
  }
  if (!AUDIO_MODES.has(audioMode)) throw new Error('Invalid audio mode.');
  if (audioMode === 'separated_background') {
    if (typeof backgroundPath !== 'string' || !backgroundPath) throw new Error('Separated background path is required.');
  } else if (backgroundPath !== undefined) {
    throw new Error('Background path is only valid for separated_background.');
  }

  const durationSeconds = seconds(durationMs);
  const args = ['-nostdin', '-y', '-v', 'error', '-i', sourcePath];
  let clipInputOffset;
  const filters = [];

  if (audioMode === 'dubbed_only') {
    args.push('-f', 'lavfi', '-t', durationSeconds, '-i', 'anullsrc=r=48000:cl=stereo');
    clipInputOffset = 2;
    filters.push('[1:a]aresample=48000,asetpts=PTS-STARTPTS[base]');
  } else if (audioMode === 'duck_original') {
    clipInputOffset = 1;
    filters.push(buildDuckBaseFilter(clips));
  } else {
    args.push('-i', backgroundPath);
    clipInputOffset = 2;
    filters.push('[1:a]aresample=48000,asetpts=PTS-STARTPTS[base]');
  }

  for (const path of clipPaths) args.push('-i', path);

  const labels = ['[base]'];
  clips.forEach((clip, index) => {
    const inputIndex = index + clipInputOffset;
    const label = `dub${index}`;
    const targetDurationMs = clip.endMs - clip.startMs;
    const clipDuration = seconds(targetDurationMs);
    const sourceDurationMs = clipDurationsMs?.[index] ?? targetDurationMs;
    const tempo = buildAtempoChain(sourceDurationMs, targetDurationMs);
    const tempoFilter = tempo ? `${tempo},` : '';
    filters.push(
      `[${inputIndex}:a]aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
      `${tempoFilter}atrim=duration=${clipDuration},apad=whole_dur=${clipDuration},asetpts=PTS-STARTPTS,` +
      `adelay=${clip.startMs}|${clip.startMs}[${label}]`,
    );
    labels.push(`[${label}]`);
  });
  filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0[dubbed]`);

  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '0:v:0?',
    '-map', '[dubbed]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    '-t', durationSeconds,
    outputPath,
  );
  return args;
}
