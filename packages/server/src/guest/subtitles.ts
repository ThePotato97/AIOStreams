/** WebVTT is delivered beside a seek generation whose media time starts at zero. */
export function offsetWebVtt(text: string, offsetMs: number): string {
  if (!offsetMs) return text;
  const milliseconds = (stamp: string) => {
    const parts = stamp.split(':').map(Number);
    return (
      ((parts.length === 3 ? parts[0] * 3600 : 0) +
        parts.at(-2)! * 60 +
        parts.at(-1)!) *
      1000
    );
  };
  const stamp = (value: number) => {
    const ms = Math.max(0, Math.round(value));
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const timing =
    /((?:\d+:)?\d{2}:\d{2}\.\d{3}) --> ((?:\d+:)?\d{2}:\d{2}\.\d{3})/;
  return text
    .replace(/\r\n/g, '\n')
    .split('\n\n')
    .flatMap((block) => {
      const match = timing.exec(block);
      if (!match) return [block];
      const end = milliseconds(match[2]) - offsetMs;
      if (end <= 0) return [];
      return [
        block.replace(
          timing,
          `${stamp(milliseconds(match[1]) - offsetMs)} --> ${stamp(end)}`
        ),
      ];
    })
    .join('\n\n');
}
