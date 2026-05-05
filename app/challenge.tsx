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
  if (!faceDetected && !glassDetected) return "Show your face & glass! 👀";
  if (!faceDetected) return "Can't see your face! 😊";
  if (!glassDetected) return "Hold up your glass! 🥛";
  return null;
}

function getStep2Message(hasLiquid: boolean, level: LiquidLevel, norm: number): string {
  if (!hasLiquid) return "No water yet — fill it up! 💧";
  if (level === "empty" || norm < 0.70) return `Fill to 70%+ — now at ${Math.round(norm * 100)}% 📏`;
  return `Looking great! ${Math.round(norm * 100)}% full 💧`;
}

function getHeaderSub(step: PipelineStep, appLabel: string, phase?: Step3Phase): string {
  if (step === 1) return `Show your face & a water glass to unlock ${appLabel}! 👋`;
  if (step === 2) return "Hold the glass steady so we can see the water level 💧";
  if (phase === "showEmpty") return "Awesome! Now show the camera your empty glass 🏆";
  return "Drink your water and we'll unlock the app! 🥤";
}

function getDrinkMessage(ds: DrinkState, sips: number): string {
  switch (ds) {
    case "approaching":  return "Keep raising the glass… almost there! 🙌";
    case "nearMouth":    return "Tip the glass and drink! 🥤";
    case "sipping":      return "Keep drinking! You've got this! 💦";
    case "cooldown":     return "Great sip! Go again! ⭐";
    default:             return sips > 0
      ? "Raise the glass again for another sip! 💪"
      : "Raise the glass to your mouth and drink! 🥤";
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
        <ThemedText style={styles.gateEmoji}>📷</ThemedText>
        <ThemedText type="title" style={styles.gateTitle}>Camera Access Needed!</ThemedText>
        <ThemedText style={styles.gateDesc}>
          SipFirst uses the camera to check that you drank your water before unlocking the app.
        </ThemedText>
        <TouchableOpacity onPress={requestPermission} style={styles.primaryButton}>
          <ThemedText style={styles.buttonText}>Allow Camera ✅</ThemedText>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.gateContainer}>
        <ThemedText style={styles.gateEmoji}>😬</ThemedText>
        <ThemedText type="title" style={styles.gateTitle}>No Front Camera Found</ThemedText>
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

      {/* Live camera feed */}
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive
        photo
      />

      {/* Top scrim for header readability */}
      <View style={styles.topScrim} />

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View style={styles.headerCard}>
          <ThemedText style={styles.headerTitle}>💧 Hydration Challenge</ThemedText>
          <ThemedText style={styles.headerSub}>
            {getHeaderSub(activeStep, appLabel, step3Phase)}
          </ThemedText>
        </View>
      </View>

      {/* ── Step indicator ────────────────────────────────────────────────────── */}
      <View style={styles.stepRow}>
        {([1, 2, 3] as PipelineStep[]).flatMap((s, i) => {
          const isDone   = activeStep > s;
          const isActive = activeStep === s;
          const pill = (
            <View
              key={`pill-${s}`}
              style={[
                styles.stepPill,
                isActive && styles.stepPillActive,
                isDone   && styles.stepPillDone,
              ]}
            >
              <ThemedText style={[
                styles.stepPillText,
                (isActive || isDone) && styles.stepPillTextBright,
              ]}>
                {isDone ? "✓" : s}
              </ThemedText>
            </View>
          );
          if (i < 2) {
            return [
              pill,
              <View
                key={`line-${s}`}
                style={[styles.stepLine, isDone && styles.stepLineDone]}
              />,
            ];
          }
          return [pill];
        })}
      </View>

      {/* ── Step 1 feedback ───────────────────────────────────────────────────── */}
      {activeStep === 1 && (
        <View style={styles.feedbackRow}>
          {stepStatus === "stabilizing" && (
            <View style={[styles.badge, styles.badgeStabilizing]}>
              <ThemedText style={styles.badgeText}>Hold still! ⏳</ThemedText>
            </View>
          )}
          {step1Message && (
            <View style={[styles.badge, styles.badgeMissing]}>
              <ThemedText style={styles.badgeText}>{step1Message}</ThemedText>
            </View>
          )}
          {!step1Message && stepStatus === "detecting" && faceDetected && glassDetected && (
            <View style={[styles.badge, styles.badgeOk]}>
              <ThemedText style={styles.badgeText}>Looking good! Hold still ✨</ThemedText>
            </View>
          )}
        </View>
      )}

      {/* ── Step 2 feedback ───────────────────────────────────────────────────── */}
      {activeStep === 2 && (
        <View style={styles.feedbackRow}>
          {stepStatus === "stabilizing" && (
            <View style={[styles.badge, styles.badgeStabilizing]}>
              <ThemedText style={styles.badgeText}>Hold still! ⏳</ThemedText>
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
              <ThemedText style={styles.drinkEmoji}>🥤</ThemedText>
              <ThemedText style={styles.drinkTitle}>Drink Your Water!</ThemedText>
              <ThemedText style={styles.drinkSub}>
                {getDrinkMessage(drinkState, sipCount)}
              </ThemedText>
              <View style={styles.sipDotsRow}>
                {[0, 1, 2].map(i => (
                  <View key={i} style={[styles.sipDot, i < sipCount && styles.sipDotFilled]} />
                ))}
              </View>
            </>
          ) : (
            <>
              <ThemedText style={styles.drinkEmoji}>🏆</ThemedText>
              <ThemedText style={styles.drinkTitle}>Almost Done!</ThemedText>
              <ThemedText style={styles.drinkSub}>
                Lower the glass and show it empty to the camera! 🎉
              </ThemedText>
              <View style={styles.sipDotsRow}>
                {[0, 1, 2].map(i => (
                  <View key={i} style={[styles.sipDot, styles.sipDotFilled]} />
                ))}
              </View>
            </>
          )}
          <TouchableOpacity onPress={reset} style={styles.ghostButton}>
            <ThemedText style={styles.ghostText}>Start Over</ThemedText>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Step 3: hydration complete ────────────────────────────────────────── */}
      {activeStep === 3 && hydrationComplete && (
        <View style={styles.successContainer}>
          <ThemedText style={styles.successEmoji}>🎉</ThemedText>
          <ThemedText style={styles.successTitle}>Amazing Job!</ThemedText>
          <ThemedText style={styles.successSub}>
            You drank your water — well done!{"\n"}{appLabel} is now unlocked! 🚀
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

  // Top scrim
  topScrim: {
    position: "absolute",
    top: 0, left: 0, right: 0,
    height: 240,
    backgroundColor: "rgba(0,0,0,0.40)",
  },

  // Gate screens (permission / no device)
  gateContainer: {
    flex: 1,
    padding: 32,
    gap: 18,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#EFF6FF",
  },
  gateEmoji: {
    fontSize: 72,
    textAlign: "center",
  },
  gateTitle: {
    textAlign: "center",
    color: "#1E3A5F",
  },
  gateDesc: {
    textAlign: "center",
    color: "#475569",
    fontSize: 16,
    lineHeight: 24,
  },

  // Header card
  header: {
    position: "absolute",
    top: 56,
    left: 16,
    right: 16,
  },
  headerCard: {
    backgroundColor: "rgba(14, 165, 233, 0.82)",
    borderRadius: 22,
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 5,
    alignItems: "center",
  },
  headerTitle: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "800",
    textShadowColor: "rgba(0,0,0,0.3)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  headerSub: {
    color: "rgba(255,255,255,0.93)",
    textAlign: "center",
    fontSize: 14,
    fontWeight: "500",
  },

  // Step indicators (pill + connecting line)
  stepRow: {
    position: "absolute",
    top: 188,
    left: 48,
    right: 48,
    flexDirection: "row",
    alignItems: "center",
  },
  stepPill: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.40)",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.30)",
  },
  stepPillActive: {
    borderColor: "#38BDF8",
    backgroundColor: "#0EA5E9",
    shadowColor: "#38BDF8",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 10,
    elevation: 8,
  },
  stepPillDone: {
    borderColor: "#22C55E",
    backgroundColor: "#22C55E",
  },
  stepLine: {
    flex: 1,
    height: 4,
    backgroundColor: "rgba(255,255,255,0.25)",
    borderRadius: 2,
    marginHorizontal: 6,
  },
  stepLineDone: {
    backgroundColor: "#22C55E",
  },
  stepPillText: {
    color: "rgba(255,255,255,0.55)",
    fontWeight: "800",
    fontSize: 17,
  },
  stepPillTextBright: {
    color: "#fff",
  },

  // Detection feedback badges
  feedbackRow: {
    position: "absolute",
    bottom: 88,
    left: 20,
    right: 20,
    alignItems: "center",
    gap: 8,
  },
  badge: {
    paddingVertical: 13,
    paddingHorizontal: 26,
    borderRadius: 26,
  },
  badgeMissing: {
    backgroundColor: "rgba(220,38,38,0.88)",
  },
  badgeStabilizing: {
    backgroundColor: "rgba(217,119,6,0.88)",
  },
  badgeOk: {
    backgroundColor: "rgba(22,163,74,0.88)",
  },
  badgeText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 16,
    textAlign: "center",
  },

  // Step 3: drink overlay
  drinkOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(7, 89, 133, 0.93)",
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingTop: 20,
    paddingBottom: 40,
    paddingHorizontal: 24,
    gap: 10,
    alignItems: "center",
  },
  drinkEmoji: {
    fontSize: 52,
  },
  drinkTitle: {
    fontSize: 26,
    fontWeight: "800",
    color: "#fff",
    textAlign: "center",
  },
  drinkSub: {
    color: "rgba(255,255,255,0.90)",
    textAlign: "center",
    fontSize: 17,
    lineHeight: 25,
  },
  sipDotsRow: {
    flexDirection: "row",
    gap: 14,
    marginTop: 2,
  },
  sipDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2.5,
    borderColor: "rgba(255,255,255,0.45)",
    backgroundColor: "transparent",
  },
  sipDotFilled: {
    backgroundColor: "#22C55E",
    borderColor: "#22C55E",
  },
  ghostButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    marginTop: 2,
  },
  ghostText: {
    color: "rgba(255,255,255,0.50)",
    fontSize: 14,
  },

  // Step 3: success
  successContainer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "#fff",
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingTop: 24,
    paddingBottom: 44,
    paddingHorizontal: 28,
    gap: 10,
    alignItems: "center",
  },
  successEmoji: {
    fontSize: 68,
    textAlign: "center",
  },
  successTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: "#16A34A",
    textAlign: "center",
  },
  successSub: {
    color: "#374151",
    textAlign: "center",
    fontSize: 16,
    lineHeight: 25,
  },

  // Buttons
  primaryButton: {
    borderRadius: 18,
    backgroundColor: "#0EA5E9",
    paddingVertical: 16,
    paddingHorizontal: 44,
    alignItems: "center",
    shadowColor: "#0EA5E9",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.45,
    shadowRadius: 10,
    elevation: 6,
  },
  buttonText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 17,
  },
});
