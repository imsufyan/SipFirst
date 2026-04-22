import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { Alert, StyleSheet, View, TouchableOpacity } from "react-native";
import { Camera, useCameraDevice, useCameraPermission } from "react-native-vision-camera";

import { ThemedText } from "@/components/themed-text";
import { useSipFirst } from "@/context/sipfirst-context";

type ChallengeParams = {
  token?: string;
  label?: string;
};

function formatDurationLabel(minutes: number) {
  if (minutes < 1) {
    return `${Math.round(minutes * 60)} seconds`;
  }
  if (minutes === 1) {
    return "1 minute";
  }
  return `${minutes} minutes`;
}

export default function ChallengeScreen() {
  const { token, label } = useLocalSearchParams<ChallengeParams>();
  const router = useRouter();
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice("front");
  const [mlConfidence, setMlConfidence] = useState(0.82);
  const { unlockForChallengeSuccess, unlockDurationMinutes } = useSipFirst();

  const appToken = useMemo(() => token ?? "", [token]);
  const appLabel = useMemo(() => label ?? "Selected App", [label]);

  const handleUnlock = async () => {
    if (!appToken) {
      Alert.alert("Missing app token", "Unable to identify which app to unlock.");
      return;
    }

    await unlockForChallengeSuccess(appToken);
    Alert.alert("Unlocked", `${appLabel} is now unlocked for ${formatDurationLabel(unlockDurationMinutes)}.`);
    router.back();
  };

  const runManualMlCheck = async () => {
    if (mlConfidence >= 0.75) {
      await handleUnlock();
      return;
    }

    Alert.alert("Challenge failed", "Hydration confidence too low. Try again.");
  };

  if (!hasPermission) {
    return (
      <View style={styles.container}>
        <ThemedText type="title">Camera permission needed</ThemedText>
        <ThemedText>Grant camera access so SipFirst can run the hydration challenge.</ThemedText>
        <TouchableOpacity onPress={requestPermission} style={styles.primaryButton}>
          <ThemedText style={styles.buttonText}>Enable Camera</ThemedText>
        </TouchableOpacity>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={styles.container}>
        <ThemedText type="title">No front camera found</ThemedText>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ThemedText type="title">Hydration Challenge</ThemedText>
      <ThemedText>
        Drink water on camera to unlock <ThemedText type="defaultSemiBold">{appLabel}</ThemedText>.
      </ThemedText>

      <Camera style={styles.camera} device={device} isActive photo />

      <TouchableOpacity onPress={runManualMlCheck} style={styles.primaryButton}>
        <ThemedText style={styles.buttonText}>Verify Challenge</ThemedText>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => setMlConfidence((old) => (old > 0.8 ? 0.6 : 0.84))} style={styles.secondaryButton}>
        <ThemedText>Simulate ML confidence: {mlConfidence.toFixed(2)}</ThemedText>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    gap: 12,
  },
  camera: {
    flex: 1,
    borderRadius: 12,
    overflow: "hidden",
  },
  primaryButton: {
    borderRadius: 10,
    backgroundColor: "#0a84ff",
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryButton: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#d4d4d8",
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonText: {
    color: "#ffffff",
    fontWeight: "700",
  },
});
