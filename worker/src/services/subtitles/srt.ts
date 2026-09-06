export type SrtRow = {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
};

export function formatSrtTime(value: number): string {
  if (!Number.isFinite(value)) throw new Error('SRT timestamp must be finite.');
  if (value < 0) throw new Error('SRT timestamp must not be negative.');
  const totalMs = Math.round(value);
  const milliseconds = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

export function serializeSrt(rows: SrtRow[]): string {
  if (!Array.isArray(rows)) throw new Error('SRT rows must be an array.');
  const blocks = rows.map((row) => {
    if (!Number.isInteger(row.index) || row.index < 1) throw new Error('SRT row index must be a positive integer.');
    if (typeof row.text !== 'string') throw new Error('SRT row text must be a string.');
    if (!Number.isFinite(row.startMs) || !Number.isFinite(row.endMs) || row.startMs < 0 || row.endMs < row.startMs) {
      throw new Error('SRT row timestamps are invalid.');
    }
    const text = row.text.replace(/\r\n?/g, '\n');
    return `${row.index}\n${formatSrtTime(row.startMs)} --> ${formatSrtTime(row.endMs)}\n${text}`;
  });
  return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
}
