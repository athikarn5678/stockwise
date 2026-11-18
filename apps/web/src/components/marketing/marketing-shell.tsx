"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetDescription,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { BrandLogo } from "@/components/brand-logo";
import { PreferenceControls } from "@/components/preference-controls";
import { MarketingAccount } from "./marketing-account";
import { useLanguage } from "@/providers/language-provider";

export function MarketingShell({ children }: { children: ReactNode }) {
  const { t } = useLanguage();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const links = (inline: boolean) => (
    <>
      <Button
        variant="ghost"
        nativeButton={false}
        role="link"
        render={<Link href="/#features" onClick={() => setOpen(false)} />}
      >
        {t("features")}
      </Button>
      <Button
        variant="ghost"
        nativeButton={false}
        role="link"
        render={
          <Link
            href="/pricing"
            aria-current={pathname === "/pricing" ? "page" : undefined}
            onClick={() => setOpen(false)}
          />
        }
      >
        {t("pricing")}
      </Button>
      <PreferenceControls />
      <MarketingAccount inline={inline} onNavigate={() => setOpen(false)} />
    </>
  );
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        className="fixed left-4 top-2 z-[100] -translate-y-24 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:translate-y-0"
        href="#main-content"
      >
        {t("skip")}
      </a>
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-5 sm:px-8">
          <Link
            aria-label={t("brandHome")}
            className="flex items-center rounded-md focus-visible:outline-2 focus-visible:outline-ring"
            href="/"
          >
            <BrandLogo priority className="h-7" />
          </Link>
          <nav
            aria-label={t("publicNavigation")}
            className="hidden items-center gap-1 md:flex"
          >
            {links(false)}
          </nav>
          <div className="md:hidden">
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={t("menu")}
                  />
                }
              >
                <Menu />
              </SheetTrigger>
              <SheetContent className="max-w-80" showCloseButton={false}>
                <SheetHeader>
                  <SheetTitle>{t("menu")}</SheetTitle>
                  <SheetDescription className="sr-only">
                    {t("publicNavigation")}
                  </SheetDescription>
                </SheetHeader>
                <SheetClose
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-3 top-3"
                      aria-label={t("closeMenu")}
                    />
                  }
                >
                  <X />
                </SheetClose>
                <nav
                  aria-label={t("publicNavigation")}
                  className="flex flex-col items-stretch gap-3 px-4"
                >
                  {links(true)}
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>
      <main id="main-content">{children}</main>
      <footer className="border-t">
        <div className="mx-auto grid max-w-6xl gap-6 px-5 py-10 sm:px-8 md:grid-cols-2">
          <div>
            <Link
              className="inline-flex rounded-md focus-visible:outline-2 focus-visible:outline-ring"
              href="/"
            >
              <BrandLogo className="h-6" />
            </Link>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("footerDescription")}
            </p>
          </div>
          <nav
            aria-label={t("footerNavigation")}
            className="flex flex-wrap gap-5 text-sm md:justify-end"
          >
            <Link href="/#features">{t("features")}</Link>
            <Link href="/pricing">{t("pricing")}</Link>
            <Link href="/login">{t("signIn")}</Link>
          </nav>
          <p className="text-xs text-muted-foreground md:col-span-2">
            {t("footerNote")}
          </p>
        </div>
      </footer>
    </div>
  );
}
