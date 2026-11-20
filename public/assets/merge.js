// Three-way merge for plain text.
//
// Each side's change against the common base is reduced to a single replace
// (position, removed length, inserted text). If the two replaces touch
// different parts of the text, both are kept. If they overlap, it is a real
// conflict and the caller asks the user.

/** The single replace that turns `a` into `b`, or null when they are equal. */
export function diff(a, b) {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { p, d: a.length - p - s, i: b.slice(p, b.length - s) };
}

export function apply(text, op) {
  return text.slice(0, op.p) + op.i + text.slice(op.p + op.d);
}

function overlaps(a, b) {
  const aEnd = a.p + a.d;
  const bEnd = b.p + b.d;
  if (a.d > 0 && b.d > 0) return a.p < bEnd && b.p < aEnd;
  // An insertion strictly inside the other side's removed range is ambiguous.
  if (a.d === 0 && b.d > 0) return a.p > b.p && a.p < bEnd;
  if (b.d === 0 && a.d > 0) return b.p > a.p && b.p < aEnd;
  return false; // two insertions never overlap
}

/**
 * Merges `local` and `remote`, both edited from `base`.
 * Returns { ok: true, text } or { ok: false } when the edits overlap.
 */
export function merge3(base, local, remote) {
  if (local === remote) return { ok: true, text: local };
  const l = diff(base, local);
  const r = diff(base, remote);
  if (!l) return { ok: true, text: remote };
  if (!r) return { ok: true, text: local };
  if (overlaps(l, r)) return { ok: false };

  // Leftmost edit first. At the same position an insertion goes first, and between
  // two insertions the remote one does (it reached the server first).
  let first = r;
  let second = l;
  if (l.p < r.p || (l.p === r.p && l.d === 0 && r.d > 0)) {
    first = l;
    second = r;
  }
  const text =
    base.slice(0, first.p) + first.i + base.slice(first.p + first.d, second.p) + second.i + base.slice(second.p + second.d);
  return { ok: true, text };
}
