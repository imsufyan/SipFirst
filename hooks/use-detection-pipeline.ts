import { useCallback, useEffect, useRef, useState } from "react";
import { NativeModules } from "react-native";
import type { Camera } from "react-native-vision-camera";

const { SipFirstVisionModule } = NativeModules;

// ─── Constants ────────────────────────────────────────────────────────────────

const STABLE_REQUIRED = 3;     // 3 × 500 ms = 1.5 s of sustained gate-pass (was 4)
const MISS_TOLERANCE = 3;      // absorb up to 3 consecutive gate-fails before decrementing (was 1)
const CAPTURE_INTERVAL_MS = 500;   // ms between capture + analysis rounds

// ── Step 2 EMA parameters ────────────────────────────────────────────────────
//
// High-pass input filter: EMA only climbs on frames where rawNorm > LEVEL_EMA_MIN.
// Low/false frames trigger passive decay instead of dragging the mean down.
//
// Key behaviours:
//   • Jump-start: if EMA has decayed below 0.50 and a strong signal arrives
//     (rawNorm ≥ 0.70), we seed EMA directly to rawNorm instead of blending.
//     Prevents the slow crawl from ~0.36 → 0.68 taking 10+ frames.
//   • Slower decay (0.997 vs 0.993): EMA holds above coast gate for ~4 no-signal
//     frames instead of ~2, absorbing the typical 2–3 frame detection gap.
//   • Lower coast gate (0.72 vs 0.78): once EMA reaches ~0.80 on a strong signal,
//     it can coast through 3-4 missed frames and still pass.

const LEVEL_EMA_ALPHA  = 0.50;   // response speed on each high-value update
const LEVEL_EMA_MIN    = 0.40;   // raw norm must exceed this to update EMA
const LEVEL_EMA_DECAY  = 0.997;  // passive decay per frame when no update (was 0.993)
const EMA_GATE         = 0.68;   // EMA threshold when current frame has active signal
const EMA_COAST_GATE   = 0.72;   // EMA threshold when coasting on zero-signal frames (was 0.78)
const EMA_JUMP_START_THRESH = 0.50;  // if EMA drops below this, seed directly on strong signal
const EMA_JUMP_START_RAW    = 0.70;  // minimum raw to trigger jump-start

// ── Step 3 parameters ────────────────────────────────────────────────────────
//
// Two-phase design:
//   "drinking"  → run sip state machine; advance to "showEmpty" after MIN_SIPS real sips
//   "showEmpty" → child lowers glass; wait for smoothLevel < EMPTY_THRESH for EMPTY_FRAMES
//                 consecutive frames before declaring hydrationComplete
//
// Sip validation — duration only (levelDrop removed):
//   The Step 3 EMA decays constantly (raw=0 most frames), so by the time a sip
//   is attempted smoothLevel is already near 0, making a ≥0.15 drop impossible.
//   Duration alone (SIP_MIN_FRAMES × 500ms) is the reliable discriminator.
//
// Display level vs smoothLevel:
//   smoothLevel (decaying EMA) → ONLY for empty detection in showEmpty phase
//   displayLevel (last rawNorm ≥ 0.15) → shown in UI as "% remaining"
//   This prevents the UI from showing 0% while the glass is still full.
//
// Sipping geometry miss tolerance:
//   When the glass is near the face during drinking, detection is noisy.
//   During "sipping" state, geometry misses DON'T reset to idle — they just
//   continue counting sipping frames until SIPPING_MAX_MISS is exceeded.

const STEP3_EMA_ALPHA      = 0.20;   // temporal smoothing for empty detection
const STEP3_EMA_SEED       = 0.70;   // initial smooth level on Step 3 entry
const STEP3_SIP_MIN_FRAMES = 5;      // min frames near mouth (5 × 500ms = 2.5 s)
const STEP3_EMPTY_THRESH     = 0.30;  // rawNorm below this → glass is empty
const STEP3_EMPTY_FRAMES     = 4;    // non-consecutive empty frames needed (with spike tolerance)
const STEP3_EMPTY_SPIKE_TOL  = 2;    // consecutive non-empty frames allowed before resetting count
const STEP3_MIN_SIPS         = 3;    // min real sips before moving to showEmpty phase
const STEP3_MISS_TOLERANCE         = 3;   // frames without geometry before resetting (non-sipping)
const STEP3_SIP_MAX_MISS           = 10;  // max geometry-miss frames allowed DURING sipping
const STEP3_SIP_NOT_NEAR_MOUTH_MAX = 3;   // consecutive !glassNearMouth detected-frames before ending sip
const STEP3_SIP_MAX_FRAMES         = 16;  // 8 s hard cap; auto-counts sip if nnm oscillation stalls exit

// ─── Types ────────────────────────────────────────────────────────────────────

export type PipelineStep = 1 | 2 | 3;
export type StepStatus = "detecting" | "stabilizing" | "stable";
export type LiquidLevel = "empty" | "low" | "medium" | "high" | "full" | "unknown";
export type DrinkState = "idle" | "approaching" | "nearMouth" | "sipping" | "cooldown";
export type Step3Phase = "drinking" | "showEmpty";

export interface PipelineState {
  activeStep: PipelineStep;
  stepStatus: StepStatus;
  faceDetected: boolean;
  glassDetected: boolean;
  hasLiquid: boolean;
  liquidLevel: LiquidLevel;
  liquidLevelNorm: number;
  liquidAboveThreshold: boolean;
  drinkDetected: boolean;
  drinkState: DrinkState;
  step3Phase: Step3Phase;
  hydrationComplete: boolean;
  sipCount: number;
}

interface NativeRect {
  x: number; y: number; width: number; height: number;
}

interface NativeResult {
  faceDetected: boolean;
  glassDetected: boolean;
  hasLiquid: boolean;
  liquidLevel: string;
  liquidLevelNorm: number;
  topLabels: string[];
  faceRect?: NativeRect;
  glassRect?: NativeRect;
}

// ─── Step 2 helpers ───────────────────────────────────────────────────────────

function updateLevelEma(ema: number, rawHasLiquid: boolean, rawNorm: number): number {
  if (rawHasLiquid && rawNorm >= LEVEL_EMA_MIN) {
    if (ema < 0) return rawNorm;
    // Jump-start: if EMA has decayed far below the gate and a strong signal arrives,
    // seed directly rather than blending — prevents a 10+ frame crawl back up.
    if (ema < EMA_JUMP_START_THRESH && rawNorm >= EMA_JUMP_START_RAW) return rawNorm;
    return LEVEL_EMA_ALPHA * rawNorm + (1 - LEVEL_EMA_ALPHA) * ema;
  }
  return ema < 0 ? -1 : ema * LEVEL_EMA_DECAY;
}

function step2Gate(ema: number, rawHasLiquid: boolean, rawNorm: number): boolean {
  // When the current frame carries an active signal, use the standard gate.
  if (rawHasLiquid && rawNorm >= LEVEL_EMA_MIN) return ema >= EMA_GATE;
  // When the current frame has no signal (raw=0 / hasLiquid=false), require a
  // higher EMA to prevent coasting. A full glass seeds EMA ~0.80 and its decay
  // stays above 0.78 for several frames. A low-fill glass that spikes to 0.73
  // decays to 0.725 on the next silent frame — below EMA_COAST_GATE.
  return ema >= EMA_COAST_GATE;
}

function updateStable(
  pass: boolean,
  count: number,
  missStreak: { current: number },
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
  return count;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDetectionPipeline(
  cameraRef: React.RefObject<Camera | null>,
  onComplete: () => void,
): { state: PipelineState; reset: () => void } {

  const [state, setState] = useState<PipelineState>({
    activeStep: 1,
    stepStatus: "detecting",
    faceDetected: false,
    glassDetected: false,
    hasLiquid: false,
    liquidLevel: "unknown",
    liquidLevelNorm: 0,
    liquidAboveThreshold: false,
    drinkDetected: false,
    drinkState: "idle",
    step3Phase: "drinking",
    hydrationComplete: false,
    sipCount: 0,
  });

  const activeStep = useRef<PipelineStep>(1);
  const stableCount = useRef(0);
  const missStreak = useRef(0);
  const stepTriggered = useRef(false);
  const isCapturing = useRef(false);
  const isMounted = useRef(true);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const levelEma = useRef<number>(-1);   // Step 2 EMA; -1 = uninitialised

  // Step 3 refs
  const drinkStateMachine = useRef<DrinkState>("idle");
  const drinkStateFrames = useRef(0);
  const sipCount = useRef(0);
  const hadLiquidRef = useRef(false);
  const emptyFrameCount = useRef(0);
  const prevGlassY = useRef<number | null>(null);
  const step3LevelEma = useRef<number>(-1);
  const levelAtSipStart = useRef<number>(0);
  const sippingFrames        = useRef(0);
  const sipNotNearMouthCount = useRef(0);
  const emptySpike           = useRef(0);   // consecutive non-empty raw frames during showEmpty
  const step3Phase    = useRef<Step3Phase>("drinking");
  const geometryMiss  = useRef(0);
  const displayLevel  = useRef<number>(STEP3_EMA_SEED);  // last known rawNorm ≥ 0.15 for UI

  const advanceToStep = useCallback((next: PipelineStep) => {
    activeStep.current = next;
    stableCount.current = 0;
    missStreak.current = 0;
    stepTriggered.current = false;
    levelEma.current = -1;
    if (next === 3) {
      hadLiquidRef.current = true;
      emptyFrameCount.current = 0;
      drinkStateMachine.current = "idle";
      drinkStateFrames.current = 0;
      sipCount.current = 0;
      prevGlassY.current = null;
      step3LevelEma.current = STEP3_EMA_SEED;
      levelAtSipStart.current = STEP3_EMA_SEED;
      sippingFrames.current        = 0;
      sipNotNearMouthCount.current = 0;
      emptySpike.current           = 0;
      step3Phase.current           = "drinking";
      geometryMiss.current         = 0;
      displayLevel.current         = STEP3_EMA_SEED;
    }
  }, []);

  const runPipeline = useCallback(async () => {
    if (isCapturing.current || !isMounted.current) return;

    const step = activeStep.current;
    const camera = cameraRef.current;
    if (!camera) return;

    isCapturing.current = true;
    try {
      const photo = await camera.takePhoto({ flash: "off", enableShutterSound: false });
      if (!isMounted.current) return;

      const result: NativeResult = await SipFirstVisionModule.analyzeImage(photo.path);
      if (!isMounted.current) return;

      const rawNorm = result.liquidLevelNorm ?? 0;

      // ── Step 3: drink + hydration detection ─────────────────────────────────
      if (step === 3) {

        // smoothLevel: decaying EMA — ONLY used for empty detection in showEmpty phase.
        // It decays naturally when raw=0 (typical while glass is being held/tilted),
        // eventually dropping below STEP3_EMPTY_THRESH after sustained absence.
        const prevSmooth = step3LevelEma.current < 0 ? STEP3_EMA_SEED : step3LevelEma.current;
        step3LevelEma.current = STEP3_EMA_ALPHA * rawNorm + (1 - STEP3_EMA_ALPHA) * prevSmooth;
        const smoothLevel = step3LevelEma.current;

        // displayLevel: last known real reading — shown in UI as "% remaining".
        // Only updates when native returns a plausible level reading (rawNorm ≥ 0.15).
        // Never decays; holds the last real value when glass is not detected.
        if (rawNorm >= 0.15) displayLevel.current = rawNorm;

        // ── Phase-separated: sip detection (drinking) vs empty check (showEmpty) ─
        let drinkDetected = false;

        if (step3Phase.current === "drinking") {
          // ── Sip state machine ───────────────────────────────────────────────
          const faceRect  = result.faceRect  ?? null;
          const glassRect = result.glassRect ?? null;

          if (faceRect && glassRect) {
            geometryMiss.current = 0;

            const glassTopY      = glassRect.y + glassRect.height;
            const prevY          = prevGlassY.current;
            const glassMovingUp  = prevY !== null && (glassTopY - prevY) > 0.025;
            prevGlassY.current   = glassTopY;
            const glassNearMouth = glassTopY >= faceRect.y - 0.07;

            const prev = drinkStateMachine.current;
            let   next = prev;
            drinkStateFrames.current++;

            switch (prev) {
              case "idle":
                if (glassNearMouth || glassMovingUp) {
                  next = "approaching";
                  drinkStateFrames.current = 0;
                }
                break;
              case "approaching":
                if (glassNearMouth) {
                  next = "nearMouth";
                  drinkStateFrames.current = 0;
                } else if (drinkStateFrames.current > 10) {
                  next = "idle";
                }
                break;
              case "nearMouth":
                if (glassNearMouth) {
                  next = "sipping";
                  sippingFrames.current = 1;
                  sipNotNearMouthCount.current = 0;
                  // Capture displayLevel at sip start so we can detect a drop
                  levelAtSipStart.current = displayLevel.current;
                } else {
                  sipNotNearMouthCount.current++;
                  if (sipNotNearMouthCount.current >= 2) {
                    next = "idle";
                    sipNotNearMouthCount.current = 0;
                  }
                }
                break;
              case "sipping":
                sippingFrames.current++;
                if (glassNearMouth) {
                  sipNotNearMouthCount.current = 0;
                } else {
                  sipNotNearMouthCount.current++;
                  if (sipNotNearMouthCount.current >= STEP3_SIP_NOT_NEAR_MOUTH_MAX) {
                    const realSip = sippingFrames.current >= STEP3_SIP_MIN_FRAMES;
                    if (realSip) {
                      sipCount.current++;
                      drinkDetected = true;
                      next = "cooldown";
                      drinkStateFrames.current = 0;
                    } else {
                      next = "idle";
                    }
                    sippingFrames.current = 0;
                    sipNotNearMouthCount.current = 0;
                  }
                }
                // Fast-path: if displayLevel has dropped meaningfully since the sip
                // started (≥ 0.20) and we've been sipping for at least 3 frames
                // (1.5 s of evidence), count the sip immediately. This handles the
                // common case where the child lowers the glass after a successful
                // sip but glassNearMouth keeps firing true (preventing nnm exit).
                if (
                  next === "sipping" &&
                  sippingFrames.current >= 3 &&
                  levelAtSipStart.current - displayLevel.current >= 0.20
                ) {
                  sipCount.current++;
                  drinkDetected = true;
                  next = "cooldown";
                  drinkStateFrames.current = 0;
                  sippingFrames.current = 0;
                  sipNotNearMouthCount.current = 0;
                }
                // Hard cap: if nnm oscillation stalls a clean exit, auto-count after 8 s
                if (next === "sipping" && sippingFrames.current >= STEP3_SIP_MAX_FRAMES) {
                  sipCount.current++;
                  drinkDetected = true;
                  next = "cooldown";
                  drinkStateFrames.current = 0;
                  sippingFrames.current = 0;
                  sipNotNearMouthCount.current = 0;
                }
                break;
              case "cooldown":
                if (drinkStateFrames.current >= 4) {
                  next = "idle";
                }
                break;
            }
            drinkStateMachine.current = next;

          } else {
            geometryMiss.current++;

            if (drinkStateMachine.current === "sipping") {
              sippingFrames.current++;
              if (geometryMiss.current > STEP3_SIP_MAX_MISS) {
                const realSip = sippingFrames.current >= STEP3_SIP_MIN_FRAMES;
                if (realSip) {
                  sipCount.current++;
                  drinkDetected = true;
                  drinkStateMachine.current = "cooldown";
                  drinkStateFrames.current  = 0;
                } else {
                  drinkStateMachine.current = "idle";
                }
                sippingFrames.current = 0;
                geometryMiss.current  = 0;
              }
            } else if (geometryMiss.current > STEP3_MISS_TOLERANCE) {
              prevGlassY.current = null;
              if (drinkStateMachine.current !== "cooldown") {
                drinkStateMachine.current = "idle";
              }
            }
          }

          // Transition to showEmpty after enough sips
          if (sipCount.current >= STEP3_MIN_SIPS) {
            step3Phase.current      = "showEmpty";
            emptyFrameCount.current = 0;
            emptySpike.current      = 0;
            drinkStateMachine.current = "idle";
            console.log(`[SipFirst] STEP 3 → showEmpty (sips:${sipCount.current})`);
          }

        } else {
          // ── showEmpty: look for empty glass — sip machine is NOT running ────
          // Use rawNorm directly; smoothLevel EMA is too easily bumped by noise.
          // Spike tolerance allows isolated false positives without full counter reset.
          if (rawNorm < STEP3_EMPTY_THRESH) {
            emptyFrameCount.current++;
            emptySpike.current = 0;
          } else {
            emptySpike.current++;
            if (emptySpike.current > STEP3_EMPTY_SPIKE_TOL) {
              emptyFrameCount.current = 0;
              emptySpike.current      = 0;
            }
          }
        }

        const hydrationComplete = step3Phase.current === "showEmpty"
          && hadLiquidRef.current
          && emptyFrameCount.current >= STEP3_EMPTY_FRAMES;

        console.log(
          `[SipFirst] STEP3 state:${drinkStateMachine.current}` +
          ` phase:${step3Phase.current}` +
          ` sips:${sipCount.current}/${STEP3_MIN_SIPS}` +
          ` smooth:${smoothLevel.toFixed(2)}` +
          ` display:${displayLevel.current.toFixed(2)}` +
          ` raw:${rawNorm.toFixed(2)}` +
          ` sipFrm:${sippingFrames.current}` +
          ` nnm:${sipNotNearMouthCount.current}` +
          ` miss:${geometryMiss.current}` +
          ` empty:${emptyFrameCount.current}/${STEP3_EMPTY_FRAMES}` +
          ` done:${hydrationComplete}`,
        );

        setState(prev => ({
          ...prev,
          activeStep:        3,
          stepStatus:        hydrationComplete ? "stable" : "detecting",
          faceDetected:      result.faceDetected,
          glassDetected:     result.glassDetected,
          hasLiquid:         result.hasLiquid,
          liquidLevelNorm:   displayLevel.current,   // actual level, not decaying EMA
          drinkDetected,
          drinkState:        drinkStateMachine.current,
          step3Phase:        step3Phase.current,
          hydrationComplete,
          sipCount:          sipCount.current,
        }));

        if (hydrationComplete && !stepTriggered.current) {
          stepTriggered.current = true;
          onCompleteRef.current();
        }
        return;
      }

      // ── Step 2: high-pass EMA ───────────────────────────────────────────────
      let effectiveHasLiquid = result.hasLiquid;
      let effectiveLiquidNorm = rawNorm;
      let liquidAboveThreshold = false;

      if (step === 2) {
        levelEma.current = updateLevelEma(levelEma.current, result.hasLiquid, rawNorm);
        const ema = levelEma.current < 0 ? 0 : levelEma.current;
        effectiveLiquidNorm = ema;
        effectiveHasLiquid = ema > 0;
        liquidAboveThreshold = step2Gate(ema, result.hasLiquid, rawNorm);
      }

      // ── Step 1 signal ───────────────────────────────────────────────────────
      const signalPass = step === 1 ? result.glassDetected : liquidAboveThreshold;

      stableCount.current = updateStable(signalPass, stableCount.current, missStreak);

      const stepStatus: StepStatus =
        stableCount.current >= STABLE_REQUIRED ? "stable"
          : stableCount.current > 0 ? "stabilizing"
            : "detecting";

      // ── Logging ─────────────────────────────────────────────────────────────
      if (step === 1) {
        console.log(
          `[SipFirst] STEP1 face=${result.faceDetected}` +
          ` glass=${result.glassDetected}` +
          ` stable=${stableCount.current}/${STABLE_REQUIRED} status=${stepStatus}`,
        );
      } else {
        const emaDisplay = (levelEma.current < 0 ? 0 : levelEma.current).toFixed(2);
        console.log(
          `[SipFirst] STEP2 hasLiquid=${result.hasLiquid}` +
          ` raw:${rawNorm.toFixed(2)} ema:${emaDisplay}` +
          ` gate=${liquidAboveThreshold}` +
          ` stable=${stableCount.current}/${STABLE_REQUIRED}` +
          ` miss=${missStreak.current}/${MISS_TOLERANCE}` +
          ` status=${stepStatus}`,
        );
      }

      setState(prev => ({
        ...prev,
        activeStep: step,
        stepStatus,
        faceDetected: result.faceDetected,
        glassDetected: result.glassDetected,
        hasLiquid: effectiveHasLiquid,
        liquidLevel: (result.liquidLevel as LiquidLevel) ?? "unknown",
        liquidLevelNorm: effectiveLiquidNorm,
        liquidAboveThreshold,
        drinkDetected: false,
        drinkState: "idle",
        step3Phase: "drinking",
        hydrationComplete: false,
        sipCount: 0,
      }));

      // ── Step transitions ─────────────────────────────────────────────────────
      if (stepStatus === "stable" && !stepTriggered.current) {
        stepTriggered.current = true;
        if (step === 1) {
          console.log("[SipFirst] ✓ Step 1 complete → Step 2");
          advanceToStep(2);
        } else {
          console.log("[SipFirst] ✓ Step 2 complete → Step 3");
          advanceToStep(3);
          setState(prev => ({ ...prev, activeStep: 3, stepStatus: "detecting" }));
        }
      }

    } catch {
      // Skip frame on capture or analysis error
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
    activeStep.current = 1;
    stableCount.current = 0;
    missStreak.current = 0;
    stepTriggered.current = false;

    levelEma.current = -1;
    drinkStateMachine.current = "idle";
    drinkStateFrames.current = 0;
    sipCount.current = 0;
    hadLiquidRef.current = false;
    emptyFrameCount.current = 0;
    prevGlassY.current = null;
    step3LevelEma.current = -1;
    levelAtSipStart.current = 0;
    sippingFrames.current        = 0;
    sipNotNearMouthCount.current = 0;
    emptySpike.current           = 0;
    step3Phase.current           = "drinking";
    geometryMiss.current         = 0;
    displayLevel.current         = 0;

    setState({
      activeStep: 1,
      stepStatus: "detecting",
      faceDetected: false,
      glassDetected: false,
      hasLiquid: false,
      liquidLevel: "unknown",
      liquidLevelNorm: 0,
      liquidAboveThreshold: false,
      drinkDetected: false,
      drinkState: "idle",
      step3Phase: "drinking",
      hydrationComplete: false,
      sipCount: 0,
    });
  }, []);

  return { state, reset };
}
