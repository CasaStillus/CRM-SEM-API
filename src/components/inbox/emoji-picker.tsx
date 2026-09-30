"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import {
  EMOJI_CATEGORIES,
  readRecentEmojis,
  rememberEmoji,
  type EmojiCategoryId,
} from "./emoji-data";

type TabId = EmojiCategoryId | "recent";

/**
 * A grid of emoji with a category bar, for the composer and for picking
 * a reaction beyond the six quick ones. Lives inside whatever popover
 * the caller opens; it has no trigger of its own.
 */
export function EmojiGrid({
  onPick,
  className,
}: {
  onPick: (emoji: string) => void;
  className?: string;
}) {
  const t = useTranslations("Inbox.emoji");
  // The grid only ever mounts inside a popover the agent opened, so it
  // never renders on the server and can read browser storage directly.
  const [recent, setRecent] = useState<string[]>(readRecentEmojis);
  const [tab, setTab] = useState<TabId>(() =>
    recent.length > 0 ? "recent" : "smileys",
  );

  const emojis =
    tab === "recent"
      ? recent
      : (EMOJI_CATEGORIES.find((c) => c.id === tab)?.emojis ?? []);

  const pick = (emoji: string) => {
    setRecent(rememberEmoji(emoji));
    onPick(emoji);
  };

  const tabs: { id: TabId; icon: string }[] = [
    ...(recent.length > 0 ? [{ id: "recent" as const, icon: "🕘" }] : []),
    ...EMOJI_CATEGORIES.map((c) => ({ id: c.id, icon: c.icon })),
  ];

  return (
    <div className={cn("flex w-[19rem] flex-col gap-1.5", className)}>
      <div
        role="tablist"
        aria-label={t("categories")}
        className="flex items-center gap-0.5 border-b border-border pb-1"
      >
        {tabs.map(({ id, icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            title={t(id)}
            onClick={() => setTab(id)}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md text-base leading-none transition-colors hover:bg-muted",
              tab === id && "bg-muted",
            )}
          >
            {icon}
          </button>
        ))}
      </div>
      <p className="px-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {t(tab)}
      </p>
      <div className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto pr-0.5">
        {emojis.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => pick(emoji)}
            aria-label={emoji}
            className="flex h-8 w-8 items-center justify-center rounded-md text-xl leading-none transition-transform hover:scale-110 hover:bg-muted"
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
