// Announcements box: collects announcement text from Planning Center so it doesn't
// have to crowd the order of service.
//   • items: the description of any plan item with "announcement" in its title
//   • notes: plan notes (outside the order) in the chosen category, e.g. "Announcements"

export const isAnnouncementItem = (item) => item.type !== 'header' && /announce/i.test(item.title || '');

/** "- Christmas Decorating\n- Christmas Parade" → ["Christmas Decorating", "Christmas Parade"] */
export function toLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-–—•*·]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
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
