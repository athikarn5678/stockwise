// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { LanguageProvider, useLanguage } from "@/providers/language-provider";
import { en } from "@/i18n/en";
import { th } from "@/i18n/th";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PosCameraScanner } from "./pos-camera-scanner";

const fallback = vi.hoisted(() => ({ decode: vi.fn(), stop: vi.fn() }));
vi.mock("@zxing/browser", () => ({
  BrowserMultiFormatOneDReader: class {
    decodeFromVideoElement = fallback.decode;
  },
}));
const onClose = vi.fn();
const onDetected = vi.fn();
const stopTrack = vi.fn();
const getUserMedia = vi.fn();
const detect = vi.fn();
const formats = ["code_128", "ean_13", "ean_8", "upc_a", "upc_e"];
const supported = vi.fn();
class Detector {
  static getSupportedFormats = supported;
  detect = detect;
}
function setup() {
  return render(<PosCameraScanner onClose={onClose} onDetected={onDetected} />);
}
beforeEach(() => {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("BarcodeDetector", Detector);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
  getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  supported.mockResolvedValue(formats);
  detect.mockResolvedValue([]);
  fallback.decode.mockResolvedValue({ stop: fallback.stop });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("POS single-scan camera", () => {
  it("requests only rear-facing video after opening and accepts just one frame", async () => {
    expect(getUserMedia).not.toHaveBeenCalled();
    detect.mockResolvedValue([{ rawValue: "00AbC" }, { rawValue: "00AbC" }]);
    setup();
    expect(
      screen.getByRole("dialog", { name: "Scan barcode with camera" }),
    ).toBeTruthy();
    await waitFor(() => expect(onDetected).toHaveBeenCalledWith("00AbC"));
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
    expect(onDetected).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalled();
    expect(fallback.decode).not.toHaveBeenCalled();
  });
  it.each([
    ["NotAllowedError", /permission was denied/],
    ["NotFoundError", /No usable camera/],
    ["NotReadableError", /camera is busy/],
  ])(
    "handles %s without disclosing browser error details",
    async (name, message) => {
      getUserMedia.mockRejectedValue(
        new DOMException("private camera detail", String(name)),
      );
      setup();
      expect(await screen.findByText(message)).toBeTruthy();
      expect(onDetected).not.toHaveBeenCalled();
      expect(screen.queryByText(/private camera detail/)).toBeNull();
    },
  );
  it("handles insecure contexts without requesting permission", async () => {
    vi.stubGlobal("isSecureContext", false);
    setup();
    expect(await screen.findByText(/requires HTTPS or localhost/)).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it("handles unsupported camera access", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });
    setup();
    expect(await screen.findByText(/unsupported in this browser/)).toBeTruthy();
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it.each(["missing", "partial", "broken"])(
    "uses the local decoder when the native API is %s",
    async (mode) => {
      if (mode === "missing") vi.stubGlobal("BarcodeDetector", undefined);
      if (mode === "partial") supported.mockResolvedValue(["ean_13"]);
      if (mode === "broken")
        detect.mockRejectedValue(new Error("native failed"));
      setup();
      await waitFor(() => expect(fallback.decode).toHaveBeenCalledOnce());
      const callback = fallback.decode.mock.calls[0]![1];
      act(() => {
        callback({ getText: () => "0012345678905" });
        callback({ getText: () => "0012345678905" });
      });
      expect(onDetected).toHaveBeenCalledOnce();
      expect(stopTrack).toHaveBeenCalled();
      expect(fallback.stop).toHaveBeenCalled();
    },
  );
  it("stops the stream when local decoding fails", async () => {
    vi.stubGlobal("BarcodeDetector", undefined);
    fallback.decode.mockRejectedValue(new Error("decode failed"));
    setup();
    expect(await screen.findByText(/could not start/)).toBeTruthy();
    expect(stopTrack).toHaveBeenCalled();
  });
  it("offers close and Escape and stops native detection on teardown", async () => {
    const view = setup();
    await waitFor(() => expect(detect).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Close camera" }));
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { cancelable: true }),
    );
    expect(onClose).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(stopTrack).toHaveBeenCalled();
  });
  it("stops a stream granted after the scanner has already closed", async () => {
    let grant!: (stream: {
      getTracks: () => { stop: typeof stopTrack }[];
    }) => void;
    getUserMedia.mockImplementation(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const view = setup();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    view.unmount();
    await act(async () => grant({ getTracks: () => [{ stop: stopTrack }] }));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(onDetected).not.toHaveBeenCalled();
  });
  it("stops late fallback controls after teardown", async () => {
    vi.stubGlobal("BarcodeDetector", undefined);
    let finish!: (controls: { stop: typeof fallback.stop }) => void;
    fallback.decode.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = setup();
    await waitFor(() => expect(fallback.decode).toHaveBeenCalled());
    view.unmount();
    await act(async () => finish({ stop: fallback.stop }));
    expect(fallback.stop).toHaveBeenCalledOnce();
    expect(stopTrack).toHaveBeenCalled();
  });
  it("closes and cleans resources when the page enters the background", async () => {
    setup();
    await waitFor(() => expect(detect).toHaveBeenCalled());
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    fireEvent(document, new Event("visibilitychange"));
    expect(stopTrack).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });
});

function TestLanguageToggle() {
  const { language, setLanguage } = useLanguage();
  return (
    <button onClick={() => setLanguage(language === "en" ? "th" : "en")}>
      Switch language
    </button>
  );
}

it("retranslates a camera error without reopening the camera", async () => {
  localStorage.clear();
  getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
  render(
    <LanguageProvider>
      <TestLanguageToggle />
      <PosCameraScanner onClose={onClose} onDetected={onDetected} />
    </LanguageProvider>,
  );
  await screen.findByText(en.camErrDenied);
  fireEvent.click(screen.getByRole("button", { name: "Switch language" }));
  expect(screen.getByText(th.camErrDenied)).toBeTruthy();
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  localStorage.clear();
});
