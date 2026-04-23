import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import { Camera, useCameraDevice, useCameraPermission } from "react-native-vision-camera";

import { ThemedText } from "@/components/themed-text";
import { useChallengeDetection } from "@/hooks/use-challenge-detection";

type ChallengeParams = {
  token?: string;
  label?: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getMissingMessage(faceDetected: boolean, glassDetected: boolean): string | null {
  if (!faceDetected && !glassDetected) return "Face and glass both missing";
  if (!faceDetected) return "Face missing";
  if (!glassDetected) return "Transparent glass missing";
  return null;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ChallengeScreen() {
  const { label } = useLocalSearchParams<ChallengeParams>();
  const router = useRouter();
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice("front");
  const cameraRef = useRef<Camera>(null);

  // "detecting" → running Step 1   "detected" → both confirmed, ready for Step 2
  const [step1Done, setStep1Done] = useState(false);

  const appLabel = label ?? "Selected App";

  const handleStable = useCallback(() => {
    // Step 1 complete: face + glass confirmed stably.
    // Step 2 (water level check) will be wired here next.
    setStep1Done(true);
  }, []);

  const { state, reset } = useChallengeDetection(cameraRef, handleStable);

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

  // ── Status overlay content ───────────────────────────────────────────────────
  const { faceDetected, glassDetected, stage } = state;
  const missingMessage = !step1Done ? getMissingMessage(faceDetected, glassDetected) : null;

  return (
    <View style={styles.container}>
      {/* Live camera preview – active only while detecting */}
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={!step1Done}
        photo
      />

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <ThemedText type="title" style={styles.headerTitle}>
          Hydration Challenge
        </ThemedText>
        <ThemedText style={styles.headerSub}>
          {step1Done
            ? `Step 1 complete for ${appLabel}`
            : `Hold your face and a glass of water in view to unlock ${appLabel}`}
        </ThemedText>
      </View>

      {/* ── Detection feedback (only during searching / stabilizing) ─────────── */}
      {!step1Done && (
        <View style={styles.feedbackRow}>
          {stage === "stabilizing" && (
            <View style={[styles.badge, styles.badgeStabilizing]}>
              <ThemedText style={styles.badgeText}>Hold still…</ThemedText>
            </View>
          )}

          {stage === "searching" && missingMessage && (
            <View style={[styles.badge, styles.badgeMissing]}>
              <ThemedText style={styles.badgeText}>{missingMessage}</ThemedText>
            </View>
          )}
        </View>
      )}

      {/* ── Step 1 success state ─────────────────────────────────────────────── */}
      {step1Done && (
        <View style={styles.successContainer}>
          <ThemedText style={styles.successText}>
            Face and glass detected
          </ThemedText>
          <ThemedText style={styles.successSub}>
            Step 2 – water level check – coming next.
          </ThemedText>
          <TouchableOpacity
            onPress={() => {
              setStep1Done(false);
              reset();
            }}
            style={styles.secondaryButton}
          >
            <ThemedText>Try again</ThemedText>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.back()} style={styles.ghostButton}>
            <ThemedText>Cancel</ThemedText>
          </TouchableOpacity>
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
    backgroundColor: "rgba(220, 38, 38, 0.85)", // red-600 with alpha
  },
  badgeStabilizing: {
    backgroundColor: "rgba(234, 179, 8, 0.85)", // yellow-500 with alpha
  },
  badgeText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 15,
  },
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
    color: "#16a34a", // green-600
  },
  successSub: {
    color: "#52525b",
    textAlign: "center",
  },
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
