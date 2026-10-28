"use client";
import { Button } from "@/components/ui/button";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TranslationKey } from "@/i18n/en";
import { useLanguage } from "@/providers/language-provider";

const FORMATS = ["code_128", "ean_13", "ean_8", "upc_a", "upc_e"];
interface NativeDetector {
  detect(video: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}
declare global {
  interface Window {
    BarcodeDetector?: {
      new (options: { formats: string[] }): NativeDetector;
      getSupportedFormats(): Promise<string[]>;
    };
  }
}

function cameraError(error: unknown): TranslationKey {
  const name =
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
      ? error.name
      : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "camErrDenied";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "camErrNotFound";
  if (name === "NotReadableError") return "camErrBusy";
  return "camErrGeneric";
}

export function PosCameraScanner({
  onClose,
  onDetected,
}: {
  onClose: () => void;
  onDetected: (barcode: string) => void;
}) {
  const { t } = useLanguage();
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const titleId = useId();
  const [status, setStatus] = useState<TranslationKey>("camStarting");
  const callbacks = useRef({ onClose, onDetected });
  callbacks.current = { onClose, onDetected };

  useEffect(() => {
    const element = dialog.current;
    const preview = video.current;
    element?.showModal();
    let active = true;
    let detected = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let controls: { stop(): void } | undefined;

    function stop() {
      active = false;
      window.clearTimeout(timer);
      controls?.stop();
      stream?.getTracks().forEach((track) => track.stop());
      if (preview) {
        preview.pause();
        preview.srcObject = null;
      }
    }
    function fail(message: TranslationKey) {
      if (!active) return;
      setStatus(message);
      stop();
    }
    function accept(value: string) {
      if (!active || detected || value.trim() === "") return;
      detected = true; // One accepted frame per opening; re-open to intentionally scan again.
      stop();
      callbacks.current.onDetected(value);
    }

    async function startFallback() {
      const { BrowserMultiFormatOneDReader } = await import("@zxing/browser");
      if (!active || !preview) return;
      const reader = new BrowserMultiFormatOneDReader(undefined, {
        delayBetweenScanAttempts: 200,
      });
      const started = await reader.decodeFromVideoElement(
        preview,
        (result, error) => {
          if (result) accept(result.getText());
          else if (
            error &&
            ![
              "NotFoundException",
              "ChecksumException",
              "FormatException",
            ].includes(error.name)
          )
            fail(cameraError(error));
        },
      );
      controls = started;
      if (!active) started.stop();
    }

    async function start() {
      if (!window.isSecureContext) {
        fail("camErrInsecure");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia || !preview) {
        fail("camErrUnsupported");
        return;
      }
      try {
        let detector: NativeDetector | undefined;
        try {
          const Native = window.BarcodeDetector;
          if (Native) {
            const supported = await Native.getSupportedFormats();
            if (FORMATS.every((format) => supported.includes(format)))
              detector = new Native({ formats: FORMATS });
          }
        } catch {
          // A missing or partially implemented native detector uses the local decoder.
        }
        if (!active) return;
        // Desktop browsers and some devices reject the rear-camera hint; retry
        // once with any available camera before reporting a failure.
        const acquired = await navigator.mediaDevices
          .getUserMedia({
            audio: false,
            video: { facingMode: { ideal: "environment" } },
          })
          .catch((error: unknown) => {
            const name = (error as { name?: string } | null)?.name;
            if (name !== "OverconstrainedError" && name !== "NotFoundError")
              throw error;
            return navigator.mediaDevices.getUserMedia({
              audio: false,
              video: true,
            });
          });
        if (!active) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = acquired;
        preview.srcObject = stream;
        await preview.play();
        if (!active) return;
        setStatus("camScanning");
        if (!detector) {
          await startFallback();
          return;
        }
        const native = detector;
        async function scanFrame() {
          if (!active) return;
          try {
            const values = await native.detect(preview!);
            if (!active) return;
            const value = values.find(
              (candidate) => candidate.rawValue.trim() !== "",
            );
            if (value) accept(value.rawValue);
            else timer = window.setTimeout(() => void scanFrame(), 200);
          } catch {
            // Some platforms expose the API but cannot decode live video.
            if (active)
              void startFallback().catch((error) => fail(cameraError(error)));
          }
        }
        void scanFrame();
      } catch (error) {
        fail(cameraError(error));
      }
    }
    function leave() {
      stop();
      callbacks.current.onClose();
    }
    function onVisibility() {
      if (document.visibilityState === "hidden") leave();
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", leave);
    void start();
    return () => {
      stop();
      element?.close();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", leave);
    };
  }, []);

  return createPortal(
    <dialog
      aria-labelledby={titleId}
      className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-lg border bg-background p-5 text-foreground backdrop:bg-black/50"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialog}
    >
      <div className="space-y-4">
        <h2 className="text-xl font-semibold" id={titleId}>
          {t("camTitle")}
        </h2>
        <video
          aria-label={t("camLive")}
          className="aspect-[4/3] w-full rounded-md bg-black object-contain"
          muted
          playsInline
          ref={video}
        />
        <p role="status" className="text-sm break-words">
          {t(status)}
        </p>
        <p className="text-sm text-muted-foreground">{t("camPrivacy")}</p>
        <Button variant="outline" className="" onClick={onClose} type="button">
          {t("camClose")}
        </Button>
      </div>
    </dialog>,
    document.body,
  );
}
