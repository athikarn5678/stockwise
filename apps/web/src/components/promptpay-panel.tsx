"use client";

import QRCode from "qrcode";
import { type ChangeEvent, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { TranslationKey } from "@/i18n/en";
import { formatMoney, formatThb } from "@/money-display";
import { useLanguage } from "@/providers/language-provider";

/** The server-computed total and its locally rendered QR image. */
export type PromptPayQr = { amount: string; svg: string };

/** Renders the payload locally as SVG. No canvas, no request, no storage. */
export async function renderPromptPayQrImage(payload: string): Promise<string> {
  return QRCode.toString(payload, {
    errorCorrectionLevel: "M",
    margin: 2,
    type: "svg",
  });
}

function qrImageSource(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * PromptPay presentation only. The parent owns the quote, the checkout
 * mutation, and every decision that must survive a re-render; this panel owns
 * just the locally previewed slip, which is never uploaded or persisted.
 */
export function PromptPayPanel({
  canConfirm,
  canGenerate,
  error,
  isConfirming,
  isGenerating,
  onConfirm,
  onGenerate,
  qr,
  resetToken,
}: {
  canConfirm: boolean;
  canGenerate: boolean;
  error: TranslationKey | null;
  isConfirming: boolean;
  isGenerating: boolean;
  onConfirm: () => void;
  onGenerate: () => void;
  qr: PromptPayQr | null;
  resetToken: number;
}) {
  const { t } = useLanguage();

  const [slip, setSlip] = useState<{ name: string; url: string } | null>(null);
  const [slipError, setSlipError] = useState<TranslationKey | null>(null);
  const [slipInputKey, setSlipInputKey] = useState(0);

  // An object URL is the only representation of the file the app ever holds.
  useEffect(() => {
    if (slip === null) return;
    const url = slip.url;
    return () => URL.revokeObjectURL(url);
  }, [slip]);

  // Any cart, discount, or method change invalidates the QR and its slip.
  useEffect(() => {
    setSlip(null);
    setSlipError(null);
    setSlipInputKey((value) => value + 1);
  }, [resetToken]);

  const clearSlip = () => {
    setSlip(null);
    setSlipError(null);
    setSlipInputKey((value) => value + 1);
  };

  const onSlipChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    if (file === null) {
      clearSlip();
      return;
    }
    if (!file.type.startsWith("image/")) {
      clearSlip();
      setSlipError("uiPromptPaySlipMustBeAnImage");
      return;
    }
    setSlipError(null);
    setSlip({ name: file.name, url: URL.createObjectURL(file) });
  };

  return (
    <fieldset className="space-y-4 border-t pt-4">
      <legend className="font-medium">{t("uiPromptPay")}</legend>
      <Button
        aria-busy={isGenerating}
        disabled={!canGenerate || isGenerating || isConfirming}
        onClick={onGenerate}
        type="button"
      >
        {isGenerating
          ? t("uiPromptPayGeneratingQr")
          : t("uiGeneratePromptPayQr")}
      </Button>
      {error === null ? null : (
        <p className="text-sm form-message" role="status">
          {t(error)}
        </p>
      )}
      {qr === null ? null : (
        <div className="grid items-start gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
          {/* A local data URL cannot be optimized by next/image. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt={t("uiPromptPayQrAlt").replace(
              "{amount}",
              formatMoney(qr.amount),
            )}
            className="h-56 w-56 rounded-md border bg-white"
            height={224}
            src={qrImageSource(qr.svg)}
            width={224}
          />
          <div className="space-y-2">
            <p className="text-lg font-semibold">
              {t("uiPromptPayAmountDue").replace(
                "{amount}",
                formatThb(qr.amount),
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("uiPromptPayQrServerTotalNote")}
            </p>
          </div>
        </div>
      )}
      <div className="space-y-2 border-t pt-4">
        <Label className="form-field">
          {t("uiPromptPaySlipOptional")}
          <Input
            accept="image/*"
            key={slipInputKey}
            onChange={onSlipChange}
            type="file"
          />
        </Label>
        {slipError === null ? null : (
          <p className="text-sm text-destructive form-message" role="status">
            {t(slipError)}
          </p>
        )}
        {slip === null ? null : (
          <div className="space-y-2">
            {/* The slip is a local blob preview and is never uploaded. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt={t("uiPromptPaySlipPreviewAlt")}
              className="max-h-56 w-auto max-w-full rounded-md border object-contain"
              src={slip.url}
            />
            <p className="text-xs text-muted-foreground">{slip.name}</p>
            <Button onClick={clearSlip} type="button" variant="outline">
              {t("uiPromptPayRemoveSlip")}
            </Button>
          </div>
        )}
      </div>
      <Button
        aria-busy={isConfirming}
        disabled={!canConfirm || isConfirming}
        onClick={onConfirm}
        type="button"
      >
        {isConfirming ? t("uiCompletingSale") : t("uiConfirmPaymentReceived")}
      </Button>
      {qr === null ? (
        <p className="text-sm text-muted-foreground">
          {t("uiPromptPayGenerateFirst")}
        </p>
      ) : null}
    </fieldset>
  );
}
