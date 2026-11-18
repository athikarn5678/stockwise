"use client";

import { useQueryClient } from "@tanstack/react-query";
import { LogOut, UserRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { logout } from "@/api-client";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/providers/language-provider";
import { notifySessionChange } from "@/session-lifecycle";
import { useMarketingSession } from "./use-marketing-session";

/**
 * The account slot of the public header. Guests see one "Get started" button
 * (the login page links on to sign-up); signed-in visitors stay on the public
 * page and get a profile menu plus a "Go to dashboard" button.
 */
export function MarketingAccount({
  inline = false,
  onNavigate,
}: {
  /** Mobile sheet: list the profile details inline instead of a popup. */
  inline?: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const { t } = useLanguage();
  const session = useMarketingSession();
  if (session.status === "loading") return null;
  if (session.status === "guest")
    return (
      <Button
        nativeButton={false}
        role="link"
        render={<Link href="/login" onClick={() => onNavigate?.()} />}
      >
        {t("getStarted")}
      </Button>
    );
  const { user } = session.context;
  return (
    <>
      <ProfileMenu email={user.email} inline={inline} name={user.displayName} />
      <Button
        nativeButton={false}
        role="link"
        render={<Link href="/app" onClick={() => onNavigate?.()} />}
      >
        {t("goToDashboard")}
      </Button>
    </>
  );
}

function ProfileMenu({
  email,
  inline,
  name,
}: {
  email: string;
  inline: boolean;
  name: string | null;
}) {
  const { t } = useLanguage();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [failed, setFailed] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || inline) return;
    const close = (event: Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape")
        return;
      if (
        event.type === "pointerdown" &&
        root.current?.contains(event.target as Node)
      )
        return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open, inline]);

  async function signOut() {
    if (signingOut) return;
    setFailed(false);
    setSigningOut(true);
    try {
      await logout();
      notifySessionChange(queryClient);
      setOpen(false);
      router.replace("/");
    } catch {
      setFailed(true);
    } finally {
      setSigningOut(false);
    }
  }

  const details = (
    <div className="space-y-3 text-sm">
      <div className="min-w-0">
        {name ? <p className="truncate font-medium">{name}</p> : null}
        <p className="truncate text-muted-foreground">{email}</p>
      </div>
      {failed ? <p role="alert">{t("requestError")}</p> : null}
      <Button
        className="w-full justify-start"
        disabled={signingOut}
        onClick={() => void signOut()}
        type="button"
        variant="outline"
      >
        <LogOut aria-hidden="true" />
        {signingOut ? t("loggingOut") : t("logout")}
      </Button>
    </div>
  );

  if (inline)
    return (
      <section aria-label={t("profileMenu")} className="rounded-lg border p-3">
        {details}
      </section>
    );
  return (
    <div className="relative" ref={root}>
      <Button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={t("profileMenu")}
        onClick={() => setOpen((value) => !value)}
        type="button"
        variant="ghost"
      >
        <UserRound aria-hidden="true" />
        <span className="max-w-32 truncate">{name ?? email}</span>
      </Button>
      {open ? (
        <div
          className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md"
          id={panelId}
        >
          {details}
        </div>
      ) : null}
    </div>
  );
}
