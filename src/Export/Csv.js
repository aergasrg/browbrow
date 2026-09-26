// CSV building and download.

/**
 * @param {string[]} Header
 * @param {(string | number | null | undefined)[][]} Rows
 */
export function toCsv(Header, Rows) {
  /** @param {string | number | null | undefined} Value */
  const cell = (Value) => {
    if (Value === null || Value === undefined || (typeof Value === 'number' && !Number.isFinite(Value))) return '';
    if (typeof Value === 'number') return String(Math.round(Value * 10000) / 10000);
    return /[",\n]/.test(Value) ? `"${Value.replace(/"/g, '""')}"` : Value;
  };
  return [Header.map(cell).join(','), ...Rows.map((Row) => Row.map(cell).join(','))].join('\n') + '\n';
}

/**
 * @param {string} FileName
 * @param {string} Text
 */
export function downloadText(FileName, Text) {
  const Url = URL.createObjectURL(new Blob([Text], { type: 'text/csv;charset=utf-8' }));
  const Link = document.createElement('a');
  Link.href = Url;
  Link.download = FileName;
  document.body.append(Link);
  Link.click();
  Link.remove();
  setTimeout(() => URL.revokeObjectURL(Url), 2000);
}

/** File-name friendly timestamp. */
export function stamp() {
  const Now = new Date();
  /** @param {number} Value */
  const pad = (Value) => String(Value).padStart(2, '0');
  return `${Now.getFullYear()}${pad(Now.getMonth() + 1)}${pad(Now.getDate())}-${pad(Now.getHours())}${pad(Now.getMinutes())}`;
}
