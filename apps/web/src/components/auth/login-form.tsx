"use client";
import type { TranslationKey } from "@/i18n/en";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { AuthApiError, login } from "@/api-client";

import {
  clearContinuation,
  saveContinuation,
} from "@/verification-continuation-browser";
import { getContinuationRevision } from "@/verification-continuation-browser";
import {
  acquireInvitationFlowLock,
  clearInvitationContinuationForFlow,
  isInvitationRecoveryRequired,
  loadInvitationContinuation,
  type InvitationFlowLock,
} from "@/invitation-continuation";
import {
  discardPrivateSession,
  notifySessionChange,
} from "@/session-lifecycle";
import { useLanguage } from "@/providers/language-provider";
import { hasEmailShape, passwordValidationMessage } from "./auth-form-support";
import { verificationErrorMessage } from "./auth-copy";

export function LoginForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  const pending = useRef(false);
  const mounted = useRef(false);
  const requestId = useRef(0);
  const invitationLock = useRef<InvitationFlowLock | null>(null);
  const errorMessage = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<
    { key: TranslationKey } | { cause: unknown } | null
  >(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  useEffect(() => {
    const restore = () => {
      mounted.current = true;
      pending.current = false;
      setIsSubmitting(false);
      setPassword("");
    };
    const invalidate = () => {
      mounted.current = false;
      requestId.current += 1;
      invitationLock.current = null;
    };
    restore();
    window.addEventListener("pagehide", invalidate);
    window.addEventListener("pageshow", restore);
    return () => {
      invalidate();
      window.removeEventListener("pagehide", invalidate);
      window.removeEventListener("pageshow", restore);
    };
  }, []);
  useEffect(() => {
    if (error !== null) errorMessage.current?.focus();
  }, [error]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) {
      return;
    }

    if (!hasEmailShape(email)) {
      setError({ key: "authInvalidEmail" });
      return;
    }

    const passwordError = passwordValidationMessage(password);
    if (passwordError !== null) {
      setError({ key: "authPasswordLength" });
      return;
    }

    setError(null);
    setIsSubmitting(true);
    pending.current = true;
    clearContinuation();
    const id = ++requestId.current;
    const revision = getContinuationRevision();
    const isCurrent = () =>
      mounted.current &&
      id === requestId.current &&
      revision === getContinuationRevision();

    let invitationFlowId: string | undefined;
    const savedInvitation = loadInvitationContinuation();
    if (savedInvitation.status === "ready") {
      const held =
        invitationLock.current?.flowId === savedInvitation.continuation.flowId
          ? invitationLock.current
          : await acquireInvitationFlowLock(
              savedInvitation.continuation.flowId,
            );
      if (!held) {
        if (isCurrent()) {
          clearInvitationContinuationForFlow(
            savedInvitation.continuation.flowId,
          );
          setError({ key: "invitationRecovery" });
        }
        setIsSubmitting(false);
        pending.current = false;
        return;
      }
      invitationLock.current = held;
      invitationFlowId = held.flowId;
    }
    try {
      const result = await login({
        email,
        password,
        ...(invitationFlowId === undefined ? {} : { invitationFlowId }),
      });
      const current = isCurrent();
      if (result.outcome === "authenticated") {
        notifySessionChange(
          queryClient,
          current && invitationFlowId !== undefined
            ? { preserveInvitationFlowId: invitationFlowId }
            : undefined,
        );
        if (current) {
          invitationLock.current = null;
          router.replace(
            invitationFlowId !== undefined || isInvitationRecoveryRequired()
              ? "/accept-invitation"
              : "/app",
          );
        }
        return;
      }
      if (!current) return;
      setPassword("");
      discardPrivateSession(queryClient);
      saveContinuation({
        version: 1,
        canonicalEmail: email.trim().toLowerCase(),
        challengeId: result.verification.challengeId,
        savedAt: Date.now(),
      });
      router.replace("/verify-email");
    } catch (requestError: unknown) {
      if (isCurrent()) setError({ cause: requestError });
      if (
        requestError instanceof AuthApiError &&
        requestError.kind === "unavailable"
      )
        notifySessionChange(queryClient);
    } finally {
      if (mounted.current && id === requestId.current) {
        setIsSubmitting(false);
        pending.current = false;
      }
    }
  }

  return (
    <form className="space-y-5" noValidate onSubmit={handleSubmit}>
      <div>
        <Label className="form-field" htmlFor="login-email">
          {t("authEmail")}
        </Label>
        <Input
          aria-describedby={error !== null ? "login-error" : undefined}
          autoComplete="email"
          className="mt-1"
          disabled={isSubmitting}
          id="login-email"
          name="email"
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
        />
      </div>
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <Label className="form-field" htmlFor="login-password">
            {t("authPassword")}
          </Label>
          <Link className="text-sm underline" href="/forgot-password" replace>
            {t("authForgotPassword")}
          </Link>
        </div>
        <Input
          aria-describedby={error !== null ? "login-error" : undefined}
          autoComplete="current-password"
          className="mt-1"
          disabled={isSubmitting}
          id="login-password"
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
      </div>
      {error === null ? null : (
        <Alert
          variant="destructive"
          aria-live="assertive"
          id="login-error"
          ref={errorMessage}
          tabIndex={-1}
        >
          <AlertDescription>
            {error === null
              ? null
              : "key" in error
                ? t(error.key)
                : verificationErrorMessage(error.cause, t)}
          </AlertDescription>
        </Alert>
      )}
      <Button className="w-full" disabled={isSubmitting} type="submit">
        {isSubmitting ? t("authSigningIn") : t("authSignIn")}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {t("authNeedAccount")}{" "}
        <Link
          className="font-medium text-foreground underline"
          href="/register"
          replace
        >
          {t("authCreateOne")}
        </Link>
      </p>
    </form>
  );
}
