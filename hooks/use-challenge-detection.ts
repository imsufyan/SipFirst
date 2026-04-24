import { useCallback, useEffect, useRef, useState } from "react";
import { NativeModules } from "react-native";
import type { Camera } from "react-native-vision-camera";

const { SipFirstVisionModule } = NativeModules;

// ─── Constants ───────────────────────────────────────────────────────────────

// How many consecutive successful detections before we call it "stable".
// At CAPTURE_INTERVAL_MS = 500 ms this means ~1.5 seconds.
const STABLE_REQUIRED = 3;

// How many consecutive missed detections are tolerated before the stable
// counter resets (hysteresis).  Bumped to 4 because the two-gate glass check
// (hand + rectangle) is inherently noisier than face detection alone.
const MISS_HYSTERESIS = 4;

// Gap between each photo capture + analysis round.
const CAPTURE_INTERVAL_MS = 500;

// ─── Types ────────────────────────────────────────────────────────────────────

export type DetectionStage = "searching" | "stabilizing" | "stable";

export interface DetectionState {
  faceDetected: boolean;
  glassDetected: boolean;
  stage: DetectionStage;
}

interface NativeAnalysisResult {
  faceDetected: boolean;
  glassDetected: boolean;
  topLabels: string[]; // calibration only
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Drives Step-1 of the hydration challenge:
 * periodically captures a photo and runs native Vision-framework analysis
 * to confirm that BOTH a face AND a transparent glass are visible.
 *
 * onStable fires once when the stable window is satisfied.
 * Call reset() to restart the machine (e.g. after a failed step).
 */
export function useChallengeDetection(
  cameraRef: React.RefObject<Camera | null>,
  onStable: () => void
): { state: DetectionState; reset: () => void } {
  const [state, setState] = useState<DetectionState>({
    faceDetected: false,
    glassDetected: false,
    stage: "searching",
  });

  // Mutable counters live in refs so they don't cause re-renders and
  // are always up-to-date inside the interval callback closure.
  const stableCount = useRef(0);
  const missCount = useRef(0);
  const triggered = useRef(false);
  const isCapturing = useRef(false);
  const isMounted = useRef(true);

  // Keep the callback stable so the interval doesn't restart on every render.
  const onStableRef = useRef(onStable);
  onStableRef.current = onStable;

  const runDetection = useCallback(async () => {
    if (isCapturing.current || !isMounted.current) return;
    const camera = cameraRef.current;
    if (!camera) return;

    isCapturing.current = true;
    try {
      const photo = await camera.takePhoto({
        flash: "off",
        enableShutterSound: false,
      });

      // Guard against state updates after unmount (prevents the
      // "tried to reject a promise more than once" VisionCamera warning).
      if (!isMounted.current) return;

      const result: NativeAnalysisResult = await SipFirstVisionModule.analyzeImage(photo.path);
      const { faceDetected, glassDetected, topLabels } = result;
      const both = faceDetected && glassDetected;

      // ── State machine ──────────────────────────────────────────────────────

      if (both) {
        stableCount.current += 1;
        missCount.current = 0;
      } else {
        missCount.current += 1;
        if (missCount.current >= MISS_HYSTERESIS) {
          stableCount.current = 0;
          missCount.current = 0;
          triggered.current = false;
        }
      }

      const stage: DetectionStage =
        stableCount.current >= STABLE_REQUIRED
          ? "stable"
          : stableCount.current > 0
          ? "stabilizing"
          : "searching";

      // ── Calibration log ───────────────────────────────────────────────────
      console.log(
        `[SipFirst] stage=${stage} face=${faceDetected} glass=${glassDetected}` +
          ` stable=${stableCount.current}/${STABLE_REQUIRED}` +
          ` top=[${topLabels?.join(", ") ?? ""}]`
      );

      // ── React state update ────────────────────────────────────────────────
      setState({ faceDetected, glassDetected, stage });

      // ── Stable callback (fires once per detection window) ─────────────────
      if (stage === "stable" && !triggered.current) {
        triggered.current = true;
        onStableRef.current();
      }
    } catch {
      // Skip frame on any capture/analysis error.
    } finally {
      isCapturing.current = false;
    }
  }, [cameraRef]);

  useEffect(() => {
    isMounted.current = true;
    const id = setInterval(runDetection, CAPTURE_INTERVAL_MS);
    return () => {
      isMounted.current = false;
      clearInterval(id);
    };
  }, [runDetection]);

  const reset = useCallback(() => {
    stableCount.current = 0;
    missCount.current = 0;
    triggered.current = false;
    setState({ faceDetected: false, glassDetected: false, stage: "searching" });
  }, []);

  return { state, reset };
}
