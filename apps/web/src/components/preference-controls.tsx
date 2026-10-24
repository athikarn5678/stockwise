"use client";

import { Globe, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useId } from "react";
import { useLanguage } from "@/providers/language-provider";
import { Button } from "@/components/ui/button";

export function PreferenceControls() {
  const { resolvedTheme, setTheme } = useTheme();
  const { language, setLanguage, t } = useLanguage();
  const themeDescriptionId = useId();
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("theme")}
        aria-describedby={themeDescriptionId}
        onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      >
        <Sun className="dark:hidden" aria-hidden="true" />
        <Moon className="hidden dark:block" aria-hidden="true" />
        <span id={themeDescriptionId} className="sr-only">
          <span className="dark:hidden">{t("light")}</span>
          <span className="hidden dark:block">{t("dark")}</span>
        </span>
      </Button>
      <Button
        variant="ghost"
        aria-label={t("language")}
        onClick={() => setLanguage(language === "th" ? "en" : "th")}
      >
        <Globe aria-hidden="true" />
        <span>{language === "th" ? "ไทย" : "EN"}</span>
      </Button>
    </div>
  );
}
