"use client";
import type { TranslationKey } from "@/i18n/en";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { register } from "@/api-client";
import {
  clearContinuation,
  saveContinuation,
  getContinuationRevision,
} from "@/verification-continuation-browser";
import { useLanguage } from "@/providers/language-provider";

import { hasEmailShape, passwordValidationMessage } from "./auth-form-support";
import { verificationErrorMessage } from "./auth-copy";

export function RegistrationForm() {
  const { t } = useLanguage();
  const router = useRouter();
  const pending = useRef(false);
  const mounted = useRef(false);
  const requestId = useRef(0);
  const errorMessage = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmationTouched, setConfirmationTouched] = useState(false);
  const confirmationInput = useRef<HTMLInputElement>(null);
  const confirmationError = !confirmationTouched
    ? null
    : confirmPassword === ""
      ? "authConfirmPasswordRequired"
      : confirmPassword !== password
        ? "authPasswordMismatch"
        : null;
  const [error, setError] = useState<
    { key: TranslationKey } | { cause: unknown } | null
  >(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  useEffect(() => {
    const restore = () => {
      mounted.current = true;
      pending.current = false;
      setIsSubmitting(false);
    };
    restore();
    const invalidate = () => {
      mounted.current = false;
      requestId.current += 1;
    };
    window.addEventListener("pagehide", invalidate);
    // A restored document may submit again, but cannot accept pre-pagehide work.
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

    if (confirmPassword === "" || confirmPassword !== password) {
      setConfirmationTouched(true);
      setError(null);
      confirmationInput.current?.focus();
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

    try {
      const result = await register({ email, password });
      if (!isCurrent()) return;
      const saved = saveContinuation({
        version: 1,
        canonicalEmail: email.trim().toLowerCase(),
        challengeId: result.data.verification.challengeId,
        savedAt: Date.now(),
      });
      setPassword("");
      setConfirmPassword("");
      setConfirmationTouched(false);
      if (!saved) {
        // Cannot safely recover the OTP challenge without the one-use
        // continuation. Preserve the generic enrollment response.
        setError({ key: "authRecovery" });
        return;
      }
      router.replace("/verify-email");
    } catch (requestError: unknown) {
      if (isCurrent()) setError({ cause: requestError });
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
        <Label className="form-field" htmlFor="registration-email">
          {t("authEmail")}
        </Label>
        <Input
          aria-describedby={error !== null ? "registration-error" : undefined}
          autoComplete="email"
          className="mt-1"
          disabled={isSubmitting}
          id="registration-email"
          name="email"
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
        />
      </div>
      <div>
        <Label className="form-field" htmlFor="registration-password">
          {t("authPassword")}
        </Label>
        <Input
          aria-describedby={error !== null ? "registration-error" : undefined}
          autoComplete="new-password"
          className="mt-1"
          disabled={isSubmitting}
          id="registration-password"
          name="password"
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          {t("authPasswordLength")}
        </p>
      </div>
      <div>
        <Label className="form-field" htmlFor="registration-confirm-password">
          {t("authConfirmPassword")}
        </Label>
        <Input
          aria-describedby={
            confirmationError !== null
              ? "registration-confirm-error"
              : error !== null
                ? "registration-error"
                : undefined
          }
          aria-invalid={confirmationError !== null}
          autoComplete="new-password"
          className="mt-1"
          disabled={isSubmitting}
          id="registration-confirm-password"
          name="confirmPassword"
          onBlur={() => setConfirmationTouched(true)}
          onChange={(event) => setConfirmPassword(event.target.value)}
          ref={confirmationInput}
          required
          type="password"
          value={confirmPassword}
        />
        {confirmationError !== null && (
          <p
            className="mt-2 text-sm text-destructive"
            id="registration-confirm-error"
            role="alert"
          >
            {t(confirmationError)}
          </p>
        )}
      </div>
      {error === null ? null : (
        <Alert
          variant="default"
          className="border-destructive/60"
          aria-live="assertive"
          id="registration-error"
          ref={errorMessage}
          tabIndex={-1}
        >
          <AlertDescription className="text-foreground">
            {error === null
              ? null
              : "key" in error
                ? t(error.key)
                : verificationErrorMessage(error.cause, t)}
          </AlertDescription>
        </Alert>
      )}
      <Button className="w-full" disabled={isSubmitting} type="submit">
        {isSubmitting ? t("authCreatingAccount") : t("authCreateAccount")}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {t("authAlreadyAccount")}{" "}
        <Link
          className="font-medium text-foreground underline"
          href="/login"
          replace
        >
          {t("authSignIn")}
        </Link>
      </p>
    </form>
  );
}
