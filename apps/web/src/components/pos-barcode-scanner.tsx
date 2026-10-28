"use client";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

import { useEffect, useRef, useState } from "react";

import {
  searchPosProducts,
  SalesApiError,
  type PosProduct,
  type SalesRequestContext,
} from "@/sales-api-client";

import type { TranslationKey } from "@/i18n/en";
import { useLanguage } from "@/providers/language-provider";
import { PosCameraScanner } from "./pos-camera-scanner";

function lookupError(error: unknown): TranslationKey {
  if (error instanceof SalesApiError) {
    if (error.kind === "authentication_required") return "scanErrAuth";
    if (error.kind === "forbidden" || error.kind === "branch_inactive")
      return "scanErrUnavailable";
    if (error.kind === "validation") return "scanErrInvalid";
  }
  return "scanErrLookup";
}

export function PosBarcodeScanner({
  context,
  disabled,
  onAdd,
  onPendingChange,
}: {
  context: SalesRequestContext;
  disabled: boolean;
  onAdd: (product: PosProduct) => void;
  onPendingChange: (count: number) => void;
}) {
  const { t } = useLanguage();
  const input = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const cameraOpenRef = useRef(false);
  const [pending, setPending] = useState(0);
  const [results, setResults] = useState<
    Array<{ key: TranslationKey; barcode?: string; name?: string }>
  >([]);
  const queue = useRef<string[]>([]);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const callbacks = useRef({ onAdd, onPendingChange, disabled });
  callbacks.current = { onAdd, onPendingChange, disabled };

  useEffect(() => {
    return () => {
      generation.current += 1;
      queue.current = [];
      controller.current?.abort();
    };
  }, []);

  useEffect(() => {
    // Focus only after the native modal is removed and the input is no longer inert.
    if (!cameraOpen && !disabled) input.current?.focus();
  }, [cameraOpen, disabled]);

  function reportPending() {
    setPending(queue.current.length);
    callbacks.current.onPendingChange(
      queue.current.length + (cameraOpenRef.current ? 1 : 0),
    );
  }

  function showResult(message: {
    key: TranslationKey;
    barcode?: string;
    name?: string;
  }) {
    setResults((current) => [...current.slice(-4), message]);
  }

  async function drain() {
    const currentGeneration = generation.current;
    while (queue.current.length > 0) {
      const barcode = queue.current[0]!;
      const requestController = new AbortController();
      controller.current = requestController;
      // Bound a stalled request so later scans can proceed; never retry an add automatically.
      const timeout = window.setTimeout(
        () => requestController.abort(),
        15_000,
      );
      let message: TranslationKey;
      let name = "";
      try {
        const response = await searchPosProducts(context, {
          barcode,
          signal: requestController.signal,
        });
        if (currentGeneration !== generation.current) return;
        const product = response.data.products[0];
        if (response.data.products.length === 0) {
          message = "scanNotFound";
        } else if (response.data.products.length !== 1) {
          message = "scanAmbiguous";
        } else if (!product?.available) {
          message = "scanUnavailableProduct";
        } else if (callbacks.current.disabled) {
          message = "scanDuringCheckout";
        } else {
          callbacks.current.onAdd(product);
          message = "scanAdded";
          name = product.name;
        }
      } catch (error) {
        if (currentGeneration !== generation.current) return;
        message = lookupError(error);
      } finally {
        window.clearTimeout(timeout);
      }
      showResult({ key: message, barcode, name });
      queue.current.shift();
      reportPending();
    }
    controller.current = null;
  }

  function submit(value: string) {
    const barcode = value.trim();
    if (barcode === "") return; // Ignore extra Enter/CR/LF terminators after the field is cleared.
    if (callbacks.current.disabled) {
      showResult({ key: "scanWaitCheckout" });
      return;
    }
    if (input.current) input.current.value = "";
    const wasEmpty = queue.current.length === 0;
    queue.current.push(barcode);
    reportPending();
    if (wasEmpty) void drain();
  }

  function closeCamera() {
    cameraOpenRef.current = false;
    setCameraOpen(false);
    reportPending();
  }

  return (
    <section
      aria-label={t("scanRegion")}
      className="min-w-0 space-y-3 rounded-lg border p-4"
    >
      <form
        aria-label={t("scanForm")}
        className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          submit(input.current?.value ?? "");
          input.current?.focus();
        }}
      >
        <Label className="form-field">
          {t("scanLabel")}
          <Input
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            className=""
            disabled={disabled}
            name="barcode"
            ref={input}
          />
        </Label>
        <Button
          variant="outline"
          className="self-end"
          disabled={disabled}
          type="submit"
        >
          {t("scanAdd")}
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">{t("scanKeyboardHelp")}</p>
      <Button
        variant="outline"
        className=""
        disabled={disabled}
        type="button"
        onClick={() => {
          cameraOpenRef.current = true;
          setCameraOpen(true);
          reportPending();
        }}
      >
        {t("scanCamera")}
      </Button>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="false"
        className="space-y-1 text-sm break-words"
      >
        <p>
          {pending > 0
            ? t("scanPending").replace("{count}", String(pending))
            : t("scanReady")}
        </p>
        {results.length > 0 ? (
          <ul aria-label={t("scanRecent")}>
            {results.map((message, index) => (
              <li key={index}>
                {t(message.key)
                  .replace("{barcode}", message.barcode ?? "")
                  .replace("{name}", message.name ?? "")}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {cameraOpen ? (
        <PosCameraScanner
          onClose={closeCamera}
          onDetected={(barcode) => {
            submit(barcode);
            closeCamera();
          }}
        />
      ) : null}
    </section>
  );
}
