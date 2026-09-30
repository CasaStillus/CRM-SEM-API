import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EMOJI_CATEGORIES,
  insertAtCaret,
  readRecentEmojis,
  rememberEmoji,
} from './emoji-data';

describe('EMOJI_CATEGORIES', () => {
  it('has no empty category and no duplicate within a category', () => {
    for (const category of EMOJI_CATEGORIES) {
      expect(category.emojis.length).toBeGreaterThan(0);
      expect(new Set(category.emojis).size).toBe(category.emojis.length);
    }
  });

  it('contains only emoji, never stray ASCII from the source list', () => {
    for (const category of EMOJI_CATEGORIES) {
      for (const emoji of category.emojis) {
        expect(emoji).not.toMatch(/^[\x20-\x7e]+$/);
      }
    }
  });
});

describe('insertAtCaret', () => {
  it('inserts at the caret and moves the caret past the emoji', () => {
    expect(insertAtCaret('Olá mundo', '👋', 3, 3)).toEqual({
      text: 'Olá👋 mundo',
      caret: 3 + '👋'.length,
    });
  });

  it('replaces a selection', () => {
    expect(insertAtCaret('Olá mundo', '🌎', 4, 9)).toEqual({
      text: 'Olá 🌎',
      caret: 4 + '🌎'.length,
    });
  });

  it('appends when there is no caret', () => {
    expect(insertAtCaret('Oi', '😊', null, null)).toEqual({
      text: 'Oi😊',
      caret: 2 + '😊'.length,
    });
  });

  it('clamps a caret past the end', () => {
    expect(insertAtCaret('Oi', '😊', 50, 60).text).toBe('Oi😊');
  });
});

describe('recent emoji', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
  }

  it('keeps the newest first without duplicates', () => {
    stubStorage();
    rememberEmoji('👍');
    rememberEmoji('❤️');
    rememberEmoji('👍');
    expect(readRecentEmojis()).toEqual(['👍', '❤️']);
  });

  it('survives blocked storage', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(readRecentEmojis()).toEqual([]);
    expect(rememberEmoji('👍')).toEqual(['👍']);
  });
});
