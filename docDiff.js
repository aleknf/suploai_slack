/**
 * docDiff.js
 *
 * Line-based comparison of two versions of a document, used by get_file_changes. The comparison is done in code so
 * that only the differences (not both full versions) reach the AI.
 */

const MAX_LCS_CELLS = 4_000_000; // ~2000 x 2000 lines; beyond this the middle part is compared as sets
const MAX_LINE_CHARS = 300;

const clip = line => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);

/** Splits text into trimmed, non-empty lines. */
const toLines = text =>
  String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

/**
 * Longest-common-subsequence edit script for two line arrays.
 * Returns ops: { op: 'keep'|'del'|'add', line }.
 */
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'keep', line: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ op: 'del', line: a[i++] });
    } else {
      ops.push({ op: 'add', line: b[j++] });
    }
  }
  while (i < n) ops.push({ op: 'del', line: a[i++] });
  while (j < m) ops.push({ op: 'add', line: b[j++] });
  return ops;
}

/** Fallback for very large inputs: lines present in only one version (order is lost). */
function setOps(a, b) {
  const counts = new Map();
  for (const line of a) counts.set(line, (counts.get(line) || 0) + 1);
  const ops = [];
  for (const line of b) {
    if (counts.get(line) > 0) counts.set(line, counts.get(line) - 1);
    else ops.push({ op: 'add', line });
  }
  for (const [line, left] of counts) for (let k = 0; k < left; k++) ops.push({ op: 'del', line });
  return ops;
}

/**
 * Compares two versions of a document.
 *
 * @param {string} before - Older text
 * @param {string} after - Newer text
 * @param {Object} [options]
 * @param {number} [options.maxChanges=60] - Maximum number of changes returned
 * @returns {{changes: Object[], stats: {added: number, removed: number, modified: number}, truncated: boolean}}
 *   changes: { type: 'added'|'removed'|'modified', before?: string, after?: string }
 */
function diffText(before, after, { maxChanges = 60 } = {}) {
  const a = toLines(before);
  const b = toLines(after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops = midA.length * midB.length <= MAX_LCS_CELLS ? lcsOps(midA, midB) : setOps(midA, midB);

  // Group consecutive del/add runs into hunks; a deleted line facing an added line reads as "modified"
  const changes = [];
  const stats = { added: 0, removed: 0, modified: 0 };
  let removed = [];
  let added = [];
  const flush = () => {
    const pairs = Math.min(removed.length, added.length);
    for (let k = 0; k < pairs; k++) {
      changes.push({ type: 'modified', before: clip(removed[k]), after: clip(added[k]) });
      stats.modified++;
    }
    for (const line of removed.slice(pairs)) {
      changes.push({ type: 'removed', before: clip(line) });
      stats.removed++;
    }
    for (const line of added.slice(pairs)) {
      changes.push({ type: 'added', after: clip(line) });
      stats.added++;
    }
    removed = [];
    added = [];
  };
  for (const { op, line } of ops) {
    if (op === 'keep') flush();
    else if (op === 'del') removed.push(line);
    else added.push(line);
  }
  flush();

  return { changes: changes.slice(0, maxChanges), stats, truncated: changes.length > maxChanges };
}

module.exports = { diffText };
