import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { Camera, useCameraDevice, useCameraPermission } from "react-native-vision-camera";

import { ThemedText } from "@/components/themed-text";
import { useSipFirst } from "@/context/sipfirst-context";
import {
  useDetectionPipeline,
  type DrinkState,
  type LiquidLevel,
  type PipelineStep,
  type Step3Phase,
} from "@/hooks/use-detection-pipeline";

type ChallengeParams = { token?: string; label?: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getStep1Message(faceDetected: boolean, glassDetected: boolean): string | null {
  if (!faceDetected && !glassDetected) return "Face and glass both missing";
  if (!faceDetected) return "Face missing";
  if (!glassDetected) return "Transparent glass missing";
  return null;
}

function getStep2Message(hasLiquid: boolean, level: LiquidLevel, norm: number): string {
  if (!hasLiquid) return "No liquid detected in glass";
  if (level === "empty" || norm < 0.70) return `Fill to 70%+ — currently ${Math.round(norm * 100)}%`;
  return `Water level OK: ${level} (${Math.round(norm * 100)}%)`;
}

function getHeaderSub(step: PipelineStep, appLabel: string, phase?: Step3Phase): string {
  if (step === 1) return `Hold your face and a glass of water in view to unlock ${appLabel}`;
  if (step === 2) return "Glass confirmed — show the water level in your glass";
  if (phase === "showEmpty") return "Great job! Now show the camera your empty glass";
  return "Almost done — drink your water!";
}

function getDrinkMessage(ds: DrinkState, sips: number): string {
  switch (ds) {
    case "approaching":  return "Keep raising the glass…";
    case "nearMouth":    return "Tip the glass and drink!";
    case "sipping":      return "Hold it there — keep drinking…";
    case "cooldown":     return "Good sip! Keep going…";
    default:             return sips > 0
      ? "Raise the glass again for another sip"
      : "Raise the glass to your mouth and drink";
  }
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ChallengeScreen() {
  const { label, token } = useLocalSearchParams<ChallengeParams>();
  const router           = useRouter();
  const { unlockForChallengeSuccess } = useSipFirst();
  const { hasPermission, requestPermission } = useCameraPermission();
  const device    = useCameraDevice("front");
  const cameraRef = useRef<Camera>(null);

  const appLabel = label ?? "Selected App";

  const handleComplete = useCallback(async () => {
    if (token) {
      await unlockForChallengeSuccess(token);
    }
    router.back();
  }, [router, token, unlockForChallengeSuccess]);

  const { state, reset } = useDetectionPipeline(cameraRef, handleComplete);
  const {
    activeStep, stepStatus,
    faceDetected, glassDetected, hasLiquid, liquidLevel, liquidLevelNorm, liquidAboveThreshold,
    drinkState, sipCount, step3Phase, hydrationComplete,
  } = state;

  // ── Permission gate ──────────────────────────────────────────────────────────

  if (!hasPermission) {
    return (
      <View style={styles.gateContainer}>
        <ThemedText type="title">Camera permission needed</ThemedText>
        <ThemedText>Grant camera access so SipFirst can verify your challenge.</ThemedText>
        <TouchableOpacity onPress={requestPermission} style={styles.primaryButton}>
          <ThemedText style={styles.buttonText}>Enable Camera</ThemedText>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.gateContainer}>
        <ThemedText type="title">No front camera found</ThemedText>
      </View>
    );
  }

  // ── Derived UI values ────────────────────────────────────────────────────────

  const step1Message = activeStep === 1 && stepStatus === "detecting"
    ? getStep1Message(faceDetected, glassDetected)
    : null;

  const step2Message = activeStep === 2 && stepStatus === "detecting"
    ? getStep2Message(hasLiquid, liquidLevel, liquidLevelNorm)
    : null;

  return (
    <View style={styles.container}>

      {/* Live camera — active only while steps 1 and 2 are running */}
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        photo
      />

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <ThemedText type="title" style={styles.headerTitle}>
          Hydration Challenge
        </ThemedText>
        <ThemedText style={styles.headerSub}>
          {getHeaderSub(activeStep, appLabel, step3Phase)}
        </ThemedText>
      </View>

      {/* ── Step indicator ────────────────────────────────────────────────────── */}
      <View style={styles.stepRow}>
        {([1, 2, 3] as const).map(s => (
          <View
            key={s}
            style={[
              styles.stepPill,
              activeStep === s && styles.stepPillActive,
              activeStep > s  && styles.stepPillDone,
            ]}
          >
            <ThemedText style={[
              styles.stepPillText,
              (activeStep === s || activeStep > s) && styles.stepPillTextLight,
            ]}>
              {s}
            </ThemedText>
          </View>
        ))}
      </View>

      {/* ── Step 1 feedback ───────────────────────────────────────────────────── */}
      {activeStep === 1 && (
        <View style={styles.feedbackRow}>
          {stepStatus === "stabilizing" && (
            <View style={[styles.badge, styles.badgeStabilizing]}>
              <ThemedText style={styles.badgeText}>Hold still…</ThemedText>
            </View>
          )}
          {step1Message && (
            <View style={[styles.badge, styles.badgeMissing]}>
              <ThemedText style={styles.badgeText}>{step1Message}</ThemedText>
            </View>
          )}
        </View>
      )}

      {/* ── Step 2 feedback ───────────────────────────────────────────────────── */}
      {activeStep === 2 && (
        <View style={styles.feedbackRow}>
          {stepStatus === "stabilizing" && (
            <View style={[styles.badge, styles.badgeStabilizing]}>
              <ThemedText style={styles.badgeText}>Hold still…</ThemedText>
            </View>
          )}
          {step2Message && (
            <View style={[
              styles.badge,
              liquidAboveThreshold ? styles.badgeOk : styles.badgeMissing,
            ]}>
              <ThemedText style={styles.badgeText}>{step2Message}</ThemedText>
            </View>
          )}
        </View>
      )}

      {/* ── Step 3: drink detection ───────────────────────────────────────────── */}
      {activeStep === 3 && !hydrationComplete && (
        <View style={styles.drinkOverlay}>
          {step3Phase === "drinking" ? (
            <>
              <ThemedText style={styles.drinkTitle}>Now Drink!</ThemedText>
              <ThemedText style={styles.drinkSub}>
                {getDrinkMessage(drinkState, sipCount)}
              </ThemedText>
              {sipCount > 0 && (
                <View style={styles.sipBadge}>
                  <ThemedText style={styles.sipBadgeText}>
                    {sipCount} / 3 sips
                  </ThemedText>
                </View>
              )}
            </>
          ) : (
            <>
              <ThemedText style={styles.drinkTitle}>Almost done!</ThemedText>
              <ThemedText style={styles.drinkSub}>
                Lower the glass and show it to the camera
              </ThemedText>
              <View style={[styles.sipBadge, styles.sipBadgeDone]}>
                <ThemedText style={styles.sipBadgeText}>
                  {sipCount} sip{sipCount !== 1 ? "s" : ""} done
                </ThemedText>
              </View>
            </>
          )}
          <TouchableOpacity onPress={reset} style={styles.ghostButton}>
            <ThemedText style={{ color: "rgba(255,255,255,0.6)" }}>Reset</ThemedText>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Step 3: hydration complete ────────────────────────────────────────── */}
      {activeStep === 3 && hydrationComplete && (
        <View style={styles.successContainer}>
          <ThemedText style={styles.successText}>Challenge Complete!</ThemedText>
          <ThemedText style={styles.successSub}>
            You drank your water — well done!
          </ThemedText>
        </View>
      )}

    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  gateContainer: {
    flex: 1,
    padding: 24,
    gap: 16,
    justifyContent: "center",
  },

  // Header
  header: {
    position: "absolute",
    top: 60,
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: 24,
    gap: 6,
  },
  headerTitle: {
    color: "#fff",
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  headerSub: {
    color: "rgba(255,255,255,0.85)",
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // Step indicators
  stepRow: {
    position: "absolute",
    top: 160,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    gap: 12,
  },
  stepPill: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.5)",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.3)",
  },
  stepPillActive: {
    borderColor: "#fff",
    backgroundColor: "rgba(10,132,255,0.85)",
  },
  stepPillDone: {
    borderColor: "#16a34a",
    backgroundColor: "#16a34a",
  },
  stepPillText: {
    color: "rgba(255,255,255,0.6)",
    fontWeight: "700",
    fontSize: 15,
  },
  stepPillTextLight: {
    color: "#fff",
  },

  // Detection feedback
  feedbackRow: {
    position: "absolute",
    bottom: 80,
    left: 24,
    right: 24,
    alignItems: "center",
  },
  badge: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 20,
  },
  badgeMissing: {
    backgroundColor: "rgba(220,38,38,0.85)",
  },
  badgeStabilizing: {
    backgroundColor: "rgba(234,179,8,0.85)",
  },
  badgeOk: {
    backgroundColor: "rgba(22,163,74,0.85)",
  },
  badgeText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15,
  },

  // Step 3: drink detection overlay
  drinkOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.70)",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    gap: 12,
    alignItems: "center",
  },
  drinkTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: "#fff",
  },
  drinkSub: {
    color: "rgba(255,255,255,0.85)",
    textAlign: "center",
    fontSize: 15,
  },
  sipBadge: {
    backgroundColor: "rgba(234,179,8,0.85)",
    paddingVertical: 6,
    paddingHorizontal: 16,
    borderRadius: 14,
  },
  sipBadgeDone: {
    backgroundColor: "rgba(22,163,74,0.85)",
  },
  sipBadgeText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 14,
  },
  levelBar: {
    width: "100%",
    height: 10,
    borderRadius: 5,
    backgroundColor: "rgba(255,255,255,0.20)",
    overflow: "hidden",
  },
  levelFill: {
    height: "100%",
    backgroundColor: "#0a84ff",
    borderRadius: 5,
  },
  levelLabel: {
    color: "rgba(255,255,255,0.60)",
    fontSize: 13,
  },

  // Step 3 success panel
  successContainer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 28,
    gap: 12,
    alignItems: "center",
  },
  successText: {
    fontSize: 18,
    fontWeight: "700",
    color: "#16a34a",
  },
  successSub: {
    color: "#52525b",
    textAlign: "center",
  },

  // Buttons
  primaryButton: {
    borderRadius: 10,
    backgroundColor: "#0a84ff",
    paddingVertical: 14,
    paddingHorizontal: 32,
    alignItems: "center",
  },
  secondaryButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#d4d4d8",
    paddingVertical: 12,
    paddingHorizontal: 32,
    alignItems: "center",
    width: "100%",
  },
  ghostButton: {
    paddingVertical: 10,
    alignItems: "center",
  },
  buttonText: {
    color: "#fff",
    fontWeight: "700",
  },
});
