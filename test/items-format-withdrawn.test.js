import { describe, it, expect } from 'vitest';
import { formatItemDetail } from '../lib/items-format.js';

describe('item_get: a reply the user cancelled before it was sent', () => {
  it('says so instead of printing an empty reply', () => {
    const text = formatItemDetail({
      item: { id: 'it_1', num: 3, title: 'T', state: 'open' },
      comments: [
        { id: 'ic_1', author: 'user', kind: 'comment', body: '', attachments: [], withdrawn: true, created_at: 0 },
        { id: 'ic_2', author: 'user', kind: 'comment', body: 'use the other one', attachments: [], created_at: 1000 },
      ],
    });
    expect(text).toContain('- [user, 1970-01-01T00:00:00.000Z] (a reply the user cancelled before it was sent: not for you)');
    expect(text).toContain('use the other one');
    expect(text).not.toContain('(no text)');
  });
});
