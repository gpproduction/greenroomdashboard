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

test('splits bullet lines and strips markers', () => {
  assert.deepEqual(toLines('- One\n• Two\n\n3) Three\n * Four '), ['One', 'Two', 'Three', 'Four']);
});

test('collects announcement items (not headers) and matching plan notes', () => {
  assert.equal(isAnnouncementItem(detail.items[0]), false);
  const all = buildAnnouncements(detail, { source: 'both', noteCategory: 'announcements' });
  assert.deepEqual(all.map((g) => [g.title, g.lines]), [
    ['Announcements', ['Christmas Decorating', 'Christmas Parade']],
    ['Announcements', ['Baptism sign-ups', 'Men’s breakfast']],
  ]);
  assert.equal(buildAnnouncements(detail, { source: 'items' }).length, 1);
  assert.equal(buildAnnouncements(detail, { source: 'notes' })[0].from, 'note');
  assert.deepEqual(buildAnnouncements(null, {}), []);
});
