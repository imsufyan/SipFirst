import { useCallback, useEffect, useRef, useState } from "react";
import { NativeModules } from "react-native";
import type { Camera } from "react-native-vision-camera";

const { SipFirstVisionModule } = NativeModules;

// ─── Constants ────────────────────────────────────────────────────────────────

const STABLE_REQUIRED     = 3;     // consecutive gate-passes before step advances
const MISS_TOLERANCE      = 1;     // consecutive gate-fails allowed before stable drops
const CAPTURE_INTERVAL_MS = 500;   // ms between capture + analysis rounds

// ── Step 2 EMA parameters ────────────────────────────────────────────────────
//
// Core insight from log analysis:
//   The native meniscus detector reports raw values of 0.80–0.88 on only
//   ~1 in 8 frames. The other 7 frames are low (0.15–0.35) or zero.
//   Including those low frames in any mean or EMA drags the estimate down.
//
// Fix: high-pass input filter — only update the EMA when raw > MIN_INPUT.
//   Low/false frames do NOT reset the EMA. Instead the EMA decays slowly
//   (PASSIVE_DECAY) which handles the "glass put down" case without letting
//   a single miss frames undo accumulated evidence.
//
// Result: EMA stabilises at the TRUE level for high frames (~0.65–0.85)
//   and decays to zero only after many consecutive low/false frames (~20s).
//
// Why no seed dampening: EMA_GATE=0.68 + MISS_TOLERANCE=1 already prevents
//   half-filled false positives. A dampened seed (×0.70) caused fully-filled
//   glasses with sparse high readings (1 in 25 frames) to never reach the gate —
//   the single seed frame set EMA at 0.58 and slow decay did the rest.

const LEVEL_EMA_ALPHA    = 0.50;   // response speed on each high-value update
const LEVEL_EMA_MIN      = 0.40;   // raw norm must exceed this to update EMA
const LEVEL_EMA_DECAY    = 0.993;  // passive decay per frame when no update
const EMA_GATE           = 0.68;   // EMA must reach this to signal "full enough"
const RAW_FAST_GATE      = 0.85;   // single very-high raw can bypass EMA climb…
const RAW_FAST_EMA_MIN   = 0.62;   // …but EMA must already show real substance

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
  liquidLevelNorm:      number;    // EMA value, 0.0 → 1.0
  liquidAboveThreshold: boolean;
}

interface NativeResult {
  faceDetected:    boolean;
  glassDetected:   boolean;
  hasLiquid:       boolean;
  liquidLevel:     string;
  liquidLevelNorm: number;
  topLabels:       string[];
}

// ─── Step 2 helpers ───────────────────────────────────────────────────────────

/**
 * EMA with high-pass input filter + passive decay.
 *
 * Why this design:
 *   Old mean/EMA: frame [0.88, 0.00, 0.00, 0.00, 0.00] → mean = 0.18 (fails)
 *   This EMA:     same frames → EMA stays at 0.88 * decay^4 ≈ 0.85 (passes)
 *
 * The EMA only CLIMBS on frames where raw > LEVEL_EMA_MIN (genuine signal).
 * It DECAYS slowly on all other frames. It never takes a sudden negative hit.
 */
function updateLevelEma(ema: number, rawHasLiquid: boolean, rawNorm: number): number {
  if (rawHasLiquid && rawNorm >= LEVEL_EMA_MIN) {
    // Active update — incorporate a genuine high-level reading.
    if (ema < 0) return rawNorm;                                         // first seed
    return LEVEL_EMA_ALPHA * rawNorm + (1 - LEVEL_EMA_ALPHA) * ema;
  }
  // Passive decay — no high reading this frame.
  // Decays to zero over ~20 seconds of silence, handling "glass put down".
  return ema < 0 ? -1 : ema * LEVEL_EMA_DECAY;
}

/**
 * Step 2 gate — EMA-only, no vote.
 *
 * Why no vote:
 *   The vote tracks raw hasLiquid which is false on ~65% of frames.
 *   Requiring majority vote means the gate almost never opens even when
 *   EMA has correctly climbed to 0.70–0.79 (as seen repeatedly in logs).
 *   The EMA itself IS the multi-frame evidence — a separate vote is redundant.
 *
 * Primary:     EMA ≥ 0.62  (sustained evidence of high fill)
 * Supplemental: raw ≥ 0.82 AND EMA ≥ 0.45  (very high single frame + climbing EMA)
 */
function step2Gate(ema: number, rawHasLiquid: boolean, rawNorm: number): boolean {
  if (ema >= EMA_GATE) return true;
  if (rawHasLiquid && rawNorm >= RAW_FAST_GATE && ema >= RAW_FAST_EMA_MIN) return true;
  return false;
}

/**
 * Stable counter with miss hysteresis.
 * MISS_TOLERANCE consecutive fails are absorbed before stable count drops by 1.
 * Count never zeroes from a single fail — momentum is preserved.
 */
function updateStable(
  pass:        boolean,
  count:       number,
  missStreak:  { current: number },
): number {
  if (pass) {
    missStreak.current = 0;
    return count + 1;
  }
  missStreak.current += 1;
  if (missStreak.current > MISS_TOLERANCE) {
    missStreak.current = 0;
    return Math.max(0, count - 1);
  }
  return count;   // within tolerance — hold position
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

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

  const activeStep      = useRef<PipelineStep>(1);
  const stableCount     = useRef(0);
  const missStreak      = useRef(0);
  const stepTriggered   = useRef(false);
  const step3Logged     = useRef(false);
  const isCapturing     = useRef(false);
  const isMounted       = useRef(true);
  const onCompleteRef   = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Step 2 EMA state — -1 means uninitialised (no readings yet)
  const levelEma = useRef<number>(-1);

  const advanceToStep = useCallback((next: PipelineStep) => {
    activeStep.current    = next;
    stableCount.current   = 0;
    missStreak.current    = 0;
    stepTriggered.current = false;
    levelEma.current      = -1;
  }, []);

  const runPipeline = useCallback(async () => {
    if (isCapturing.current || !isMounted.current) return;

    const step = activeStep.current;

    // ── Step 3 stub ──────────────────────────────────────────────────────────
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

      const rawNorm = result.liquidLevelNorm ?? 0;

      // ── Step 2: high-pass EMA ───────────────────────────────────────────────
      let effectiveHasLiquid  = result.hasLiquid;
      let effectiveLiquidNorm = rawNorm;
      let liquidAboveThreshold = false;

      if (step === 2) {
        levelEma.current    = updateLevelEma(levelEma.current, result.hasLiquid, rawNorm);
        const ema           = levelEma.current < 0 ? 0 : levelEma.current;
        effectiveLiquidNorm = ema;
        effectiveHasLiquid  = ema > 0;
        liquidAboveThreshold = step2Gate(ema, result.hasLiquid, rawNorm);
      }

      // ── Step 1 signal ───────────────────────────────────────────────────────
      const signalPass = step === 1 ? result.glassDetected : liquidAboveThreshold;

      // ── Stability counter ───────────────────────────────────────────────────
      stableCount.current = updateStable(signalPass, stableCount.current, missStreak);

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
        const emaDisplay = (levelEma.current < 0 ? 0 : levelEma.current).toFixed(2);
        console.log("[SipFirst] STEP 2 START");
        console.log(
          `[SipFirst] Liquid detected: ${result.hasLiquid}` +
          ` raw:${rawNorm.toFixed(2)} ema:${emaDisplay}`,
        );
        console.log(
          `[SipFirst] gate=${liquidAboveThreshold}` +
          ` stable=${stableCount.current}/${STABLE_REQUIRED}` +
          ` miss=${missStreak.current}/${MISS_TOLERANCE}` +
          ` status=${stepStatus}`,
        );
        if (!signalPass) {
          console.log(
            `[SipFirst] STEP 2 FAILED → raw:${rawNorm.toFixed(2)} ema:${emaDisplay}`,
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
          console.log("[SipFirst] STEP 2 PASSED → liquid OK → moving to Step 3");
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
    activeStep.current    = 1;
    stableCount.current   = 0;
    missStreak.current    = 0;
    stepTriggered.current = false;
    step3Logged.current   = false;
    levelEma.current      = -1;
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
