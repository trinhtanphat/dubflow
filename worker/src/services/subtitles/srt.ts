export type SrtRow = {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
};

export function formatSrtTime(value: number): string {
  if (!Number.isFinite(value)) throw new Error('SRT timestamp must be finite.');
  if (!Number.isInteger(value) || value < 0) throw new Error('SRT timestamp must be a non-negative integer.');

  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  const milliseconds = value % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export function serializeSrt(rows: SrtRow[]): string {
  return rows.map((row) => {
    if (!Number.isInteger(row.index) || row.index < 1) throw new Error('SRT index must be a positive integer.');
    if (row.endMs <= row.startMs) throw new Error('SRT end time must be after start time.');
    return [
      String(row.index),
      `${formatSrtTime(row.startMs)} --> ${formatSrtTime(row.endMs)}`,
      normalizeText(row.text),
      '',
    ].join('\n');
  }).join('\n');
}
