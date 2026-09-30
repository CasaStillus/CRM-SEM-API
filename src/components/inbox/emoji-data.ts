/**
 * The emoji the pickers offer, grouped the way WhatsApp groups them.
 *
 * A curated list rather than the full Unicode set: an emoji library is
 * hundreds of KB of JavaScript for a panel agents open a few times a
 * day, and the ones people actually use in a sales conversation fit in
 * a few hundred characters of data. Every entry is a plain, fully
 * qualified emoji that WhatsApp renders on every platform.
 */

export type EmojiCategoryId =
  | 'smileys'
  | 'gestures'
  | 'hearts'
  | 'animals'
  | 'food'
  | 'activities'
  | 'travel'
  | 'objects'
  | 'symbols';

export interface EmojiCategory {
  id: EmojiCategoryId;
  /** Shown on the category tab. */
  icon: string;
  emojis: string[];
}

function split(list: string): string[] {
  return list.trim().split(/\s+/);
}

export const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    id: 'smileys',
    icon: '😀',
    emojis: split(`
      😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙
      😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😌
      😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕
      😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩
      😫 🥱 😤 😡 😠 🤬 😈 👿 💀 🤡 👻 👽 🤖 💩 😺 😸 😹 😻 😼 😽
    `),
  },
  {
    id: 'gestures',
    icon: '👍',
    emojis: split(`
      👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋
      👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🦾 🫶 👀 👁️ 👄 🧠 🙋 🙋‍♀️ 🙋‍♂️ 🤷 🤷‍♀️ 🤷‍♂️
      🙆 🙆‍♀️ 🙆‍♂️ 🙅 🙅‍♀️ 🙅‍♂️ 💁 💁‍♀️ 💁‍♂️ 🤦 🤦‍♀️ 🤦‍♂️ 🙇 🙇‍♀️ 🙇‍♂️ 👶 👧 👦 👩 👨
    `),
  },
  {
    id: 'hearts',
    icon: '❤️',
    emojis: split(`
      ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ❤️‍🔥
      💋 💌 💐 🌹 🥀 🌷 🌸 💮 🌺 🌻 🌼 ✨ 🌟 ⭐ 💫 🔥 💥 💯 🎉 🎊
    `),
  },
  {
    id: 'animals',
    icon: '🐶',
    emojis: split(`
      🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧
      🐦 🐤 🦆 🦅 🦉 🐺 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🐠 🐬 🐳 🦈 🐘
      🌵 🎄 🌲 🌳 🌴 🌱 🌿 🍀 🍁 🍂 🌞 🌝 🌙 ⭐ ☀️ ⛅ 🌧️ ⛈️ ❄️ 🌈
    `),
  },
  {
    id: 'food',
    icon: '🍔',
    emojis: split(`
      🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🌽
      🥕 🥔 🍞 🥐 🧀 🥚 🍳 🥓 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜
      🍣 🍱 🍤 🍦 🍩 🍪 🎂 🍰 🧁 🍫 🍬 🍭 🍯 ☕ 🍵 🥤 🧃 🍺 🍷 🥂
    `),
  },
  {
    id: 'activities',
    icon: '⚽',
    emojis: split(`
      ⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥊 ⛳ 🏊 🚴 🏃 🧘 🏋️ 🤸 🏆 🥇
      🥈 🥉 🏅 🎖️ 🎗️ 🎫 🎟️ 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎸 🎮 🎲 🧩 🎯
    `),
  },
  {
    id: 'travel',
    icon: '🚗',
    emojis: split(`
      🚗 🚕 🚙 🚌 🏎️ 🚓 🚑 🚒 🚚 🚛 🏍️ 🛵 🚲 ✈️ 🚀 🛳️ ⛵ 🚆 🚇 🚦
      🏠 🏡 🏢 🏬 🏪 🏫 🏥 🏦 🏨 ⛪ 🏖️ 🏝️ 🏔️ 🗺️ 🌎 📍 🧭 🗼 🗽 🎡
    `),
  },
  {
    id: 'objects',
    icon: '💡',
    emojis: split(`
      📱 💻 ⌨️ 🖥️ 🖨️ 📷 📸 📹 🎥 📞 ☎️ 📺 📻 ⏰ ⌛ ⏳ 💡 🔦 🕯️ 🔋
      💸 💵 💰 💳 🧾 💎 ⚖️ 🔧 🔨 🛠️ 🔑 🗝️ 🔒 🔓 🚪 🛋️ 🛏️ 🪑 🚿 🛁
      🎁 🎈 🛍️ 🛒 📦 📫 📬 ✉️ 📧 📝 📄 📃 📑 📊 📈 📉 📅 📆 📌 📎
      ✂️ 🖊️ ✏️ 🔍 🔎 🏷️ 🧹 🧺 🧴 👕 👖 👗 👠 👟 👜 🎒 👓 🕶️ ⌚ 💍
    `),
  },
  {
    id: 'symbols',
    icon: '✅',
    emojis: split(`
      ✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ✖️ ➗ ❓ ❔ ❗ ❕ ‼️ ⁉️ ⚠️ 🚫 ⛔ 🔴 🟠
      🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔶 🔷 🔸 🔹 🔺 🔻 💠 🔘 ⬆️ ⬇️ ⬅️ ➡️ ↩️
      ↪️ 🔄 🔃 🔁 ▶️ ⏸️ ⏹️ ⏺️ ⏭️ ⏮️ 🔔 🔕 📣 📢 💬 💭 🗯️ 🆗 🆕 🆓
      🔝 🔜 ℹ️ ©️ ®️ ™️ #️⃣ 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟 💲 🇧🇷
    `),
  },
];

const RECENT_KEY = 'wacrm.recentEmojis';
const RECENT_MAX = 24;

/** Recently used emoji, newest first. Browser storage may be blocked. */
export function readRecentEmojis(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((e): e is string => typeof e === 'string').slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji: string): string[] {
  const next = [emoji, ...readRecentEmojis().filter((e) => e !== emoji)].slice(
    0,
    RECENT_MAX
  );
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private window or blocked storage: the picker simply has no history.
  }
  return next;
}

/**
 * Inserts `emoji` into `text` at the caret, replacing any selection.
 * Returns the new text and where the caret goes, so the textarea keeps
 * its place instead of jumping to the end.
 */
export function insertAtCaret(
  text: string,
  emoji: string,
  selectionStart: number | null,
  selectionEnd: number | null
): { text: string; caret: number } {
  const start =
    selectionStart === null ? text.length : Math.min(selectionStart, text.length);
  const end =
    selectionEnd === null ? start : Math.max(start, Math.min(selectionEnd, text.length));
  return {
    text: text.slice(0, start) + emoji + text.slice(end),
    caret: start + emoji.length,
  };
}
