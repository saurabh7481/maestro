import { useEffect, useRef, useState } from "react";
import { cameraAvailable } from "../design/camera";

/** `BarcodeDetector` is a real platform API on Chrome/Android but has no
 * TypeScript lib definition and no support on iOS Safari, so it's
 * feature-detected at runtime against this minimal shape rather than
 * declared globally. `jsqr` is the fallback everywhere it's missing —
 * which, for a mobile web client, is every iPhone. */
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function barcodeDetector(): BarcodeDetectorLike | null {
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!ctor) return null;
  try {
    return new ctor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

/** `jsqr` is ~40 kB of pure-JS decoder that most sessions never need — a
 * paired device goes straight past this screen, and a `BarcodeDetector`
 * phone never calls into it. Loaded on the first camera open instead of
 * in the entry chunk, which this app pays for over cellular. */
async function loadJsQr() {
  return (await import("jsqr")).default;
}

/** Decoding runs on a downscaled copy of the frame: a QR filling a
 * viewfinder is perfectly legible at this size, and `jsQR` is pure JS
 * scanning every pixel — at a modern phone's full 1080p+ capture
 * resolution it would miss frames on the main thread. */
const DECODE_MAX_EDGE = 640;
/** Cheap enough to feel instant, far below the frame rate — decoding every
 * frame would just burn battery for no extra hit rate. */
const DECODE_INTERVAL_MS = 180;

function describeCameraError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera access was blocked. Allow camera access for this site in your browser settings, then try again — or enter the code manually.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No camera was found on this device. Enter the code manually instead.";
  }
  if (name === "NotReadableError") {
    return "The camera is already in use by another app. Close it and try again.";
  }
  return `Couldn't start the camera: ${error instanceof Error ? error.message : String(error)}`;
}

interface QrScannerProps {
  /** Called once per *distinct* decoded value. Repeats of the same QR are
   * swallowed so holding an unrecognized code in frame doesn't re-fire the
   * parent's error handling 5× a second. */
  onScan: (text: string) => void;
}

/** Live camera viewfinder that reports QR payloads as it sees them.
 *
 * Mounting starts the camera and unmounting stops it — there is no
 * imperative start/stop API, so the parent controls the camera (and the
 * permission prompt) purely by deciding whether to render this. */
export function QrScanner({ onScan }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  // Kept in a ref, not state: the decode loop reads it every frame and it
  // must never trigger a re-render (which would restart nothing but would
  // churn the component 5× a second).
  const lastValueRef = useRef<string | null>(null);
  // Held in a ref and refreshed in its own effect so a parent re-render
  // handing down a new closure doesn't retrigger the camera effect below —
  // that would stop and restart the stream, and re-prompt for permission,
  // mid-scan.
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let frameHandle = 0;
    let lastDecodeAt = 0;
    const canvas = document.createElement("canvas");
    const detector = barcodeDetector();
    let jsQR: Awaited<ReturnType<typeof loadJsQr>> | null = null;

    async function decodeFrame(): Promise<string | null> {
      if (!video || video.readyState < video.HAVE_CURRENT_DATA) return null;

      if (detector) {
        try {
          const [first] = await detector.detect(video);
          return first?.rawValue ?? null;
        } catch {
          // A detector that throws mid-stream (some Android builds do on
          // the first frames) shouldn't kill scanning — fall through to
          // the jsQR path for this frame and every one after.
        }
      }

      const { videoWidth, videoHeight } = video;
      if (!videoWidth || !videoHeight) return null;
      const scale = Math.min(1, DECODE_MAX_EDGE / Math.max(videoWidth, videoHeight));
      canvas.width = Math.round(videoWidth * scale);
      canvas.height = Math.round(videoHeight * scale);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return (
        jsQR?.(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })?.data ??
        null
      );
    }

    function tick(now: number) {
      if (cancelled) return;
      frameHandle = requestAnimationFrame(tick);
      if (now - lastDecodeAt < DECODE_INTERVAL_MS) return;
      lastDecodeAt = now;
      void decodeFrame().then((value) => {
        if (cancelled || !value || value === lastValueRef.current) return;
        lastValueRef.current = value;
        onScanRef.current(value);
      });
    }

    async function start() {
      if (!cameraAvailable()) {
        setError(
          window.isSecureContext
            ? "This browser can't open the camera. Enter the code manually instead."
            : "The camera needs a secure (https) connection. Enter the code manually instead.",
        );
        return;
      }
      try {
        // `ideal` rather than `exact`: a laptop or tablet with only a
        // front camera should still scan, just not preferentially.
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
        });
      } catch (e) {
        if (!cancelled) setError(describeCameraError(e));
        return;
      }
      if (cancelled || !video) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // Autoplay rejection on a muted inline stream is rare; the frames
        // still arrive, so keep scanning rather than failing the whole UI.
      }
      if (cancelled) return;
      // Only the platforms without a native detector pay for the decoder.
      if (!detector) {
        try {
          jsQR = await loadJsQr();
        } catch {
          if (!cancelled)
            setError("Couldn't load the QR decoder. Enter the code manually instead.");
          return;
        }
        if (cancelled) return;
      }
      setLive(true);
      frameHandle = requestAnimationFrame(tick);
    }

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameHandle);
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
    };
  }, []);

  if (error) return <p className="error-banner qr-error">{error}</p>;

  return (
    <div className="qr-viewfinder">
      {/* `playsInline` is what stops iOS Safari hijacking the stream into
          its fullscreen native player, which would hide the whole UI. */}
      <video ref={videoRef} playsInline muted autoPlay />
      <div className="qr-frame" />
      {!live && <span className="qr-status">Starting camera…</span>}
    </div>
  );
}
