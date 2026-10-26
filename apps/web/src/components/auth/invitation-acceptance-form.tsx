"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/providers/language-provider";
import type { CredentialLinkWindow } from "@/credential-link-entry";
import { notifySessionChange } from "@/session-lifecycle";
import {
  acquireInvitationFlowLock,
  clearInvitationContinuation,
  clearInvitationContinuationForFlow,
  clearInvitationRecoveryRequired,
  createInvitationFlowId,
  loadInvitationContinuation,
  markInvitationRecoveryRequired,
  releaseInvitationFlowLock,
  saveInvitationContinuation,
  type InvitationFlowLock,
} from "@/invitation-continuation";
import {
  acceptInvitationContinuation,
  cancelInvitationContinuation,
  captureInvitationContinuation,
  InvitationContinuationApiError,
  resumeInvitationContinuation,
} from "@/invitation-continuation-api-client";

export function InvitationAcceptanceForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  const mounted = useRef(false);
  const generation = useRef(0);
  const initialized = useRef(false);
  const flow = useRef<string | null>(null);
  const lock = useRef<InvitationFlowLock | null>(null);
  const pendingCapture = useRef<{
    flowId: string;
    settled: Promise<boolean>;
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [guest, setGuest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;

    const storeMatches = (flowId: string) => {
      const selected = loadInvitationContinuation();
      return (
        selected.status === "ready" && selected.continuation.flowId === flowId
      );
    };
    const currentRequest = (
      flowId: string,
      revision: number,
      requireStore = true,
    ) =>
      mounted.current &&
      generation.current === revision &&
      flow.current === flowId &&
      (!requireStore || storeMatches(flowId));
    const resume = async (flowId: string, revision: number) => {
      try {
        const result = await resumeInvitationContinuation(flowId);
        if (!currentRequest(flowId, revision)) return;
        saveInvitationContinuation({
          version: 1,
          flowId,
          expiresAt: result.data.expiresAt,
        });
        setGuest(false);
        setReady(true);
        setError(null);
      } catch (cause) {
        if (!currentRequest(flowId, revision)) return;
        if (
          cause instanceof InvitationContinuationApiError &&
          cause.kind === "authentication_required"
        ) {
          setGuest(true);
          setReady(false);
          setError(t("invitationGuestGuidance"));
        } else if (
          cause instanceof InvitationContinuationApiError &&
          cause.kind === "unavailable"
        ) {
          setError(t("invitationRetry"));
        } else {
          markInvitationRecoveryRequired();
          clearInvitationContinuation();
          flow.current = null;
          lock.current = null;
          setReady(false);
          setError(t("invitationInvalid"));
        }
      }
    };

    const initialize = async () => {
      const revision = generation.current;
      let token = (() => {
        const captured = (
          window as CredentialLinkWindow
        ).__stockwiseTakeCredentialLink?.();
        return captured?.route === "/accept-invitation" ? captured.token : null;
      })();
      const saved = loadInvitationContinuation();
      const flowId = token
        ? createInvitationFlowId()
        : saved.status === "ready"
          ? saved.continuation.flowId
          : null;
      if (!flowId) {
        setError(token ? t("invitationRecovery") : t("invitationInvalid"));
        return;
      }
      if (token) clearInvitationContinuation();
      flow.current = flowId;
      const held = await acquireInvitationFlowLock(flowId);
      if (!currentRequest(flowId, revision, false)) return;
      if (!held) {
        if (token) markInvitationRecoveryRequired();
        else clearInvitationContinuationForFlow(flowId);
        flow.current = null;
        setError(t("invitationRecovery"));
        return;
      }
      lock.current = held;

      if (token) {
        try {
          const capture = captureInvitationContinuation(flowId, token);
          const pending = {
            flowId,
            settled: capture.then(
              () => true,
              () => false,
            ),
          };
          pendingCapture.current = pending;
          token = null;
          const captured = await capture;
          if (pendingCapture.current === pending) pendingCapture.current = null;
          if (!currentRequest(flowId, revision, false)) return;
          const stored = loadInvitationContinuation();
          if (
            stored.status !== "missing" &&
            (stored.status !== "ready" || stored.continuation.flowId !== flowId)
          ) {
            markInvitationRecoveryRequired();
            clearInvitationContinuation();
            flow.current = null;
            lock.current = null;
            setError(t("invitationRecovery"));
            return;
          }
          if (
            !saveInvitationContinuation({
              version: 1,
              flowId,
              expiresAt: captured.data.expiresAt,
            })
          ) {
            throw new InvitationContinuationApiError(
              "invalid_invitation_continuation",
            );
          }
        } catch (cause) {
          if (pendingCapture.current?.flowId === flowId)
            pendingCapture.current = null;
          if (!currentRequest(flowId, revision, false)) return;
          markInvitationRecoveryRequired();
          clearInvitationContinuation();
          flow.current = null;
          lock.current = null;
          setError(
            cause instanceof InvitationContinuationApiError &&
              cause.kind === "invalid_invitation"
              ? t("invitationInvalid")
              : t("invitationRecovery"),
          );
          return;
        }
      } else if (!storeMatches(flowId)) {
        flow.current = null;
        setError(t("invitationInvalid"));
        return;
      }
      await resume(flowId, revision);
    };

    if (!initialized.current) {
      initialized.current = true;
      void initialize();
    }

    let hiddenForPageTransition = false;
    const onPageHide = () => {
      hiddenForPageTransition = true;
      generation.current++;
      releaseInvitationFlowLock();
      lock.current = null;
      setReady(false);
      setBusy(false);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted && !hiddenForPageTransition) return;
      hiddenForPageTransition = false;
      mounted.current = true;
      const selected = loadInvitationContinuation();
      const flowId =
        selected.status === "ready" ? selected.continuation.flowId : null;
      if (!flowId) {
        if (flow.current || pendingCapture.current)
          markInvitationRecoveryRequired();
        generation.current++;
        flow.current = null;
        setReady(false);
        setBusy(false);
        setError(t("invitationRecovery"));
        return;
      }
      flow.current = flowId;
      setReady(false);
      setBusy(false);
      const revision = ++generation.current;
      void acquireInvitationFlowLock(flowId).then((held) => {
        if (!currentRequest(flowId, revision)) return;
        if (!held) {
          clearInvitationContinuationForFlow(flowId);
          flow.current = null;
          setError(t("invitationRecovery"));
          return;
        }
        lock.current = held;
        void resume(flowId, revision);
      });
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      queueMicrotask(() => {
        if (!mounted.current) generation.current++;
      });
    };
  }, [t]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const flowId = flow.current;
    const selected = loadInvitationContinuation();
    if (busy || !ready) return;
    if (
      !flowId ||
      selected.status !== "ready" ||
      selected.continuation.flowId !== flowId
    ) {
      if (selected.status !== "ready") markInvitationRecoveryRequired();
      flow.current = null;
      lock.current?.release();
      lock.current = null;
      setReady(false);
      setError(t("invitationRecovery"));
      return;
    }
    const revision = generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await acceptInvitationContinuation(flowId);
      if (
        !mounted.current ||
        generation.current !== revision ||
        flow.current !== flowId
      )
        return;
      const stored = loadInvitationContinuation();
      if (stored.status !== "ready" || stored.continuation.flowId !== flowId)
        return;
      clearInvitationContinuation();
      clearInvitationRecoveryRequired();
      flow.current = null;
      lock.current = null;
      notifySessionChange(queryClient);
      router.replace(
        `/app?organizationId=${encodeURIComponent(result.data.membership.organization.id)}`,
      );
    } catch (cause) {
      if (
        !mounted.current ||
        generation.current !== revision ||
        flow.current !== flowId
      )
        return;
      const stored = loadInvitationContinuation();
      if (stored.status !== "ready" || stored.continuation.flowId !== flowId)
        return;
      if (
        cause instanceof InvitationContinuationApiError &&
        cause.kind === "authentication_required"
      ) {
        setReady(false);
        setGuest(true);
        setError(t("invitationGuestGuidance"));
      } else if (
        cause instanceof InvitationContinuationApiError &&
        cause.kind === "unavailable"
      ) {
        setError(t("invitationRetry"));
      } else if (
        cause instanceof InvitationContinuationApiError &&
        cause.kind === "invitation_scope_invalid"
      ) {
        setError(t("invitationScopeInvalid"));
      } else {
        markInvitationRecoveryRequired();
        clearInvitationContinuation();
        flow.current = null;
        lock.current = null;
        setReady(false);
        setError(t("invitationInvalid"));
      }
    } finally {
      if (mounted.current && generation.current === revision) setBusy(false);
    }
  }

  function cancel() {
    const flowId = flow.current;
    ++generation.current;
    const selected = loadInvitationContinuation();
    const pending = pendingCapture.current;
    if (flowId && pending?.flowId === flowId) {
      void pending.settled.then((captured) => {
        if (captured)
          void cancelInvitationContinuation(flowId).catch(() => undefined);
      });
    } else if (
      flowId &&
      selected.status === "ready" &&
      selected.continuation.flowId === flowId
    ) {
      void cancelInvitationContinuation(flowId).catch(() => undefined);
    }
    clearInvitationContinuation();
    clearInvitationRecoveryRequired();
    flow.current = null;
    lock.current = null;
    setReady(false);
    setBusy(false);
    router.replace("/");
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <p className="text-sm leading-6 text-muted-foreground">
        {t("invitationDescription")}
      </p>
      {error === null ? null : (
        <p
          aria-live="assertive"
          className="text-sm text-destructive form-message"
          role="alert"
        >
          {error}
        </p>
      )}
      {guest ? (
        <div className="flex justify-center gap-4 text-sm">
          <Link className="font-medium underline" href="/login">
            {t("invitationLogin")}
          </Link>
          <Link className="font-medium underline" href="/register">
            {t("invitationCreateAccount")}
          </Link>
        </div>
      ) : null}
      {ready ? (
        <Button className="w-full" disabled={busy} type="submit">
          {busy ? t("invitationAccepting") : t("invitationAccept")}
        </Button>
      ) : null}
      <Button
        className="w-full"
        disabled={busy}
        onClick={cancel}
        type="button"
        variant="outline"
      >
        {t("invitationCancel")}
      </Button>
    </form>
  );
}
