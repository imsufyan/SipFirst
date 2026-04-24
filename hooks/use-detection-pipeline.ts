import { useCallback, useEffect, useRef, useState } from "react";
import { NativeModules } from "react-native";
import type { Camera } from "react-native-vision-camera";

const { SipFirstVisionModule } = NativeModules;

// ─── Constants ────────────────────────────────────────────────────────────────

const STABLE_REQUIRED       = 3;    // consecutive hits before a step is "stable"
const MISS_HYSTERESIS       = 4;    // consecutive misses before stable count resets
const CAPTURE_INTERVAL_MS   = 500;  // ms between each photo + analysis round
const LIQUID_BUFFER_SIZE    = 3;    // rolling window depth for Step 2 temporal smoothing
const LIQUID_LEVEL_MIN_NORM = 0.70; // minimum fill ratio required to pass Step 2 gate

// ─── Types ────────────────────────────────────────────────────────────────────

export type PipelineStep = 1 | 2 | 3;
export type StepStatus   = "detecting" | "stabilizing" | "stable";
export type LiquidLevel  = "empty" | "low" | "medium" | "high" | "full" | "unknown";

export interface PipelineState {
  activeStep:           PipelineStep;
  stepStatus:           StepStatus;
  faceDetected:         boolean;
  glassDetected:        boolean;
  hasLiquid:            boolean;
  liquidLevel:          LiquidLevel;
  liquidLevelNorm:      number;   // smoothed 0.0 → 1.0
  liquidAboveThreshold: boolean;  // smoothed norm >= LIQUID_LEVEL_MIN_NORM
}

interface NativeResult {
  faceDetected:    boolean;
  glassDetected:   boolean;
  hasLiquid:       boolean;
  liquidLevel:     string;
  liquidLevelNorm: number;
  topLabels:       string[];
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Three-step sequential detection pipeline:
 *
 *   Step 1 — Glass detection   (face + transparent glass stably confirmed)
 *   Step 2 — Liquid gate       (liquid present AND liquidLevelNorm >= 70%)
 *   Step 3 — Drinking stub     (no logic yet; logs intent and parks)
 *
 * Step 2 applies temporal smoothing over a rolling buffer of LIQUID_BUFFER_SIZE
 * frames before evaluating the gate, preventing single-frame flicker from
 * causing premature pass or fail.
 *
 * Each step requires STABLE_REQUIRED consecutive positive frames before
 * advancing. Up to MISS_HYSTERESIS misses are tolerated before the stable
 * counter resets.
 */
export function useDetectionPipeline(
  cameraRef: React.RefObject<Camera | null>,
  onComplete: () => void,
): { state: PipelineState; reset: () => void } {

  const [state, setState] = useState<PipelineState>({
    activeStep:           1,
    stepStatus:           "detecting",
    faceDetected:         false,
    glassDetected:        false,
    hasLiquid:            false,
    liquidLevel:          "unknown",
    liquidLevelNorm:      0,
    liquidAboveThreshold: false,
  });

  // All mutable counters live in refs: always current inside the interval
  // closure, zero re-renders, no stale closure bugs.
  const activeStep      = useRef<PipelineStep>(1);
  const stableCount     = useRef(0);
  const missCount       = useRef(0);
  const stepTriggered   = useRef(false);  // prevents double-fire per step
  const step3Logged     = useRef(false);  // Step 3 stub logs only once
  const isCapturing     = useRef(false);
  const isMounted       = useRef(true);
  const onCompleteRef   = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Step 2 temporal smoothing — rolling buffers for liquid presence and level
  const liquidNormBuffer = useRef<number[]>([]);
  const liquidHitBuffer  = useRef<boolean[]>([]);

  // Reset all per-step counters when advancing. Clears liquid buffers so
  // Step 2 starts fresh without stale readings from a prior attempt.
  const advanceToStep = useCallback((next: PipelineStep) => {
    activeStep.current       = next;
    stableCount.current      = 0;
    missCount.current        = 0;
    stepTriggered.current    = false;
    liquidNormBuffer.current = [];
    liquidHitBuffer.current  = [];
  }, []);

  const runPipeline = useCallback(async () => {
    if (isCapturing.current || !isMounted.current) return;

    const step = activeStep.current;

    // ── Step 3 stub — no camera capture needed ──────────────────────────────
    if (step === 3) {
      if (!step3Logged.current) {
        step3Logged.current = true;
        console.log("[SipFirst] STEP 3 START");
        console.log("[SipFirst] Detecting user drinking water...");
        console.log("[SipFirst] Coming next...");
      }
      return;
    }

    const camera = cameraRef.current;
    if (!camera) return;

    isCapturing.current = true;
    try {
      const photo = await camera.takePhoto({ flash: "off", enableShutterSound: false });
      if (!isMounted.current) return;

      const result: NativeResult = await SipFirstVisionModule.analyzeImage(photo.path);
      if (!isMounted.current) return;

      // ── Step 2 temporal smoothing ───────────────────────────────────────────
      // Raw values used for step 1; smoothed values used for step 2 signal and UI.
      let effectiveHasLiquid  = result.hasLiquid;
      let effectiveLiquidNorm = result.liquidLevelNorm ?? 0;

      if (step === 2) {
        liquidNormBuffer.current.push(result.liquidLevelNorm ?? 0);
        liquidHitBuffer.current.push(result.hasLiquid);
        if (liquidNormBuffer.current.length > LIQUID_BUFFER_SIZE) {
          liquidNormBuffer.current.shift();
          liquidHitBuffer.current.shift();
        }
        const bufLen        = liquidHitBuffer.current.length;
        effectiveHasLiquid  = liquidHitBuffer.current.filter(Boolean).length > bufLen / 2;
        effectiveLiquidNorm = liquidNormBuffer.current.reduce((a, b) => a + b, 0) / Math.max(1, bufLen);
      }

      const liquidAboveThreshold = effectiveHasLiquid && effectiveLiquidNorm >= LIQUID_LEVEL_MIN_NORM;

      // ── Signal for this step ────────────────────────────────────────────────
      // Step 2 gate: liquid must be present AND fill level >= 70%.
      const signalHit = step === 1 ? result.glassDetected : liquidAboveThreshold;

      // ── Hysteresis counter ──────────────────────────────────────────────────
      if (signalHit) {
        stableCount.current += 1;
        missCount.current    = 0;
      } else {
        missCount.current += 1;
        if (missCount.current >= MISS_HYSTERESIS) {
          stableCount.current = 0;
          missCount.current   = 0;
        }
      }

      const stepStatus: StepStatus =
        stableCount.current >= STABLE_REQUIRED ? "stable"
        : stableCount.current > 0              ? "stabilizing"
        : "detecting";

      // ── Logging ─────────────────────────────────────────────────────────────
      if (step === 1) {
        console.log("[SipFirst] STEP 1 START");
        console.log(`[SipFirst] Glass detected: ${result.glassDetected}`);
        console.log(
          `[SipFirst] step=1 face=${result.faceDetected}` +
          ` stable=${stableCount.current}/${STABLE_REQUIRED} status=${stepStatus}`,
        );
      } else {
        console.log("[SipFirst] STEP 2 START");
        console.log(
          `[SipFirst] Liquid detected: ${result.hasLiquid} → smoothed: ${effectiveHasLiquid}`,
        );
        console.log(
          `[SipFirst] Liquid level: ${result.liquidLevel}` +
          ` (raw: ${(result.liquidLevelNorm ?? 0).toFixed(2)}, smoothed: ${effectiveLiquidNorm.toFixed(2)})`,
        );
        console.log(
          `[SipFirst] step=2 stable=${stableCount.current}/${STABLE_REQUIRED} status=${stepStatus}`,
        );
        if (!signalHit) {
          console.log(
            `[SipFirst] STEP 2 FAILED → liquidDetected: ${effectiveHasLiquid}, ` +
            `level: ${result.liquidLevel ?? "unknown"}, norm: ${effectiveLiquidNorm.toFixed(2)}`,
          );
        }
      }

      setState({
        activeStep:           step,
        stepStatus,
        faceDetected:         result.faceDetected,
        glassDetected:        result.glassDetected,
        hasLiquid:            effectiveHasLiquid,
        liquidLevel:          (result.liquidLevel as LiquidLevel) ?? "unknown",
        liquidLevelNorm:      effectiveLiquidNorm,
        liquidAboveThreshold,
      });

      // ── Step transitions ─────────────────────────────────────────────────────
      if (stepStatus === "stable" && !stepTriggered.current) {
        stepTriggered.current = true;

        if (step === 1) {
          console.log("[SipFirst] ✓ Step 1 complete — advancing to Step 2");
          advanceToStep(2);
        } else {
          console.log(
            `[SipFirst] STEP 2 PASSED → liquid OK (>=${Math.round(LIQUID_LEVEL_MIN_NORM * 100)}%) → moving to Step 3`,
          );
          console.log("[SipFirst] Step 3 – checking user drinking water – coming next");
          advanceToStep(3);
          setState(prev => ({ ...prev, activeStep: 3, stepStatus: "detecting" }));
        }
      }

    } catch {
      // Skip frame on any capture or analysis error.
    } finally {
      isCapturing.current = false;
    }
  }, [cameraRef, advanceToStep]);

  useEffect(() => {
    isMounted.current = true;
    const id = setInterval(runPipeline, CAPTURE_INTERVAL_MS);
    return () => {
      isMounted.current = false;
      clearInterval(id);
    };
  }, [runPipeline]);

  const reset = useCallback(() => {
    activeStep.current       = 1;
    stableCount.current      = 0;
    missCount.current        = 0;
    stepTriggered.current    = false;
    step3Logged.current      = false;
    liquidNormBuffer.current = [];
    liquidHitBuffer.current  = [];
    setState({
      activeStep:           1,
      stepStatus:           "detecting",
      faceDetected:         false,
      glassDetected:        false,
      hasLiquid:            false,
      liquidLevel:          "unknown",
      liquidLevelNorm:      0,
      liquidAboveThreshold: false,
    });
  }, []);

  return { state, reset };
}
