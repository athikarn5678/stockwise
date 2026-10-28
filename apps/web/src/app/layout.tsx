import type { Metadata } from "next";
import { type ReactNode, Suspense } from "react";

import { AppShell } from "@/components/app-shell";
import { LocalizedLoading } from "@/components/localized-loading";
import { QueryProvider } from "@/providers/query-provider";
import { ThemeProvider } from "@/providers/theme-provider";
import { LanguageProvider } from "@/providers/language-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

export const metadata: Metadata = {
  description: "StockWise retail operations platform",
  title: "StockWise",
};

interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <LanguageProvider>
            <TooltipProvider>
              <QueryProvider>
                <Suspense fallback={<LocalizedLoading messageKey="loading" />}>
                  <AppShell>{children}</AppShell>
                </Suspense>
              </QueryProvider>
            </TooltipProvider>
          </LanguageProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
