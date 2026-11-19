import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnnouncements, toLines, isAnnouncementItem } from '../server/announcements.js';

const detail = {
  items: [
    { id: 'h', type: 'header', title: 'Welcome & Announcements' },
    { id: 'a', type: 'item', title: 'Announcements', description: '- Christmas Decorating\n- Christmas Parade\n\n' },
    { id: 'w', type: 'item', title: 'Welcome & New Here', description: 'Say good morning' },
    { id: 's', type: 'song', title: 'Battle Belongs', description: 'Tag bridge' },
  ],
  planNotes: [{ category: 'Announcements', content: '• Baptism sign-ups\n1. Men’s breakfast' }, { category: 'Sound', content: 'Spotify' }],
};

test('keeps text as written: plain lines, bullets, blank lines, indentation, numbering', () => {
  const text = 'Say good morning to someone next to you.\n\nNew Here\n- GrowCard \n  - Table in Lobby\n\n\n1. Men’s breakfast\n-NoSpaceStays';
  assert.deepEqual(toLines(text), [
    { text: 'Say good morning to someone next to you.', bullet: false, indent: 0 },
    { blank: true },
    { text: 'New Here', bullet: false, indent: 0 },
    { text: 'GrowCard', bullet: true, indent: 0 },
    { text: 'Table in Lobby', bullet: true, indent: 1 },
    { blank: true },
    { text: '1. Men’s breakfast', bullet: false, indent: 0 },
    { text: '-NoSpaceStays', bullet: false, indent: 0 },
  ]);
  assert.deepEqual(toLines('\n\n'), []);
});

test('collects announcement items (not headers) and matching plan notes', () => {
  assert.equal(isAnnouncementItem(detail.items[0]), false);
  const all = buildAnnouncements(detail, { source: 'both', noteCategory: 'announcements' });
  const texts = (g) => g.lines.map((l) => (l.blank ? '' : `${l.bullet ? '•' : ''}${l.text}`));
  assert.deepEqual(all.map((g) => [g.title, texts(g)]), [
    ['Announcements', ['•Christmas Decorating', '•Christmas Parade']],
    ['Announcements', ['•Baptism sign-ups', '1. Men’s breakfast']],
  ]);
  assert.equal(buildAnnouncements(detail, { source: 'items' }).length, 1);
  assert.equal(buildAnnouncements(detail, { source: 'notes' })[0].from, 'note');
  assert.deepEqual(buildAnnouncements(null, {}), []);
});
