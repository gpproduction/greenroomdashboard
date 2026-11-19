// Announcements box: collects announcement text from Planning Center so it doesn't
// have to crowd the order of service.
//   • items: the description of any plan item with "announcement" in its title
//   • notes: plan notes (outside the order) in the chosen category, e.g. "Announcements"

export const isAnnouncementItem = (item) => item.type !== 'header' && /announce/i.test(item.title || '');

/**
 * Announcement text, kept as written: every line in order, blank lines as spacing,
 * indentation kept. Lines starting with "-", "•", "*" etc. get a bullet in place of
 * that character; everything else (headings, details, "1." numbering) is untouched.
 * → [{ text, bullet, indent } | { blank: true }]
 */
export function toLines(text) {
  const out = [];
  for (const raw of String(text || '').replace(/\t/g, '    ').split(/\r?\n/)) {
    if (!raw.trim()) {
      if (out.length && !out.at(-1).blank) out.push({ blank: true }); // collapse repeats
      continue;
    }
    const indent = Math.min(4, Math.floor((raw.match(/^ */)[0].length) / 2));
    const m = /^\s*[-–—•*·]\s+(.*)$/.exec(raw);
    out.push(m ? { text: m[1].trimEnd(), bullet: true, indent } : { text: raw.trim(), bullet: false, indent });
  }
  while (out.length && out.at(-1).blank) out.pop(); // no trailing space
  return out;
}

/**
 * Groups of announcement lines for the current plan.
 * cfg: { enabled, source: 'items'|'notes'|'both', noteCategory }
 */
export function buildAnnouncements(detail, cfg = {}) {
  if (!detail) return [];
  const source = cfg.source || 'both';
  const groups = [];
  if (source === 'items' || source === 'both') {
    for (const item of detail.items || []) {
      if (!isAnnouncementItem(item)) continue;
      const lines = toLines(item.description);
      if (lines.length) groups.push({ title: item.title.trim(), lines, from: 'item' });
    }
  }
  if (source === 'notes' || source === 'both') {
    const want = String(cfg.noteCategory || 'Announcements').trim().toLowerCase();
    for (const n of detail.planNotes || []) {
      if (String(n.category || '').trim().toLowerCase() !== want) continue;
      const lines = toLines(n.content);
      if (lines.length) groups.push({ title: n.category, lines, from: 'note' });
    }
  }
  return groups;
}
