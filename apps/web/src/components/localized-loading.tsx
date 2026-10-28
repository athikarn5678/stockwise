"use client";

import type { TranslationKey } from "@/i18n/en";
import { useLanguage } from "@/providers/language-provider";

export function LocalizedLoading({
  messageKey,
}: {
  messageKey: TranslationKey;
}) {
  const { t } = useLanguage();
  return <p aria-live="polite">{t(messageKey)}</p>;
}
