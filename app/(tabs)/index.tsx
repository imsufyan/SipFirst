import { Alert, StyleSheet, TouchableOpacity, View, ScrollView } from "react-native";
import { useState } from "react";

import { useSipFirst } from "@/context/sipfirst-context";
import { ThemedText } from "@/components/themed-text";
import { ThemedView } from "@/components/themed-view";

const UNLOCK_DURATION_OPTIONS = [
  { value: 15, label: "15m" },
  { value: 30, label: "30m" },
  { value: 60, label: "60m" },
] as const;

export default function HomeScreen() {
  const {
    authorizationGranted,
    requestAccess,
    loading,
    openPickerAndSync,
    unlockDurationMinutes,
    setUnlockDurationMinutes,
  } = useSipFirst();
  const [syncing, setSyncing] = useState(false);

  const handleSyncManagedApps = async () => {
    try {
      setSyncing(true);
      const apps = await openPickerAndSync();
      Alert.alert(
        "Managed apps synced",
        apps.length > 0
          ? `Selected and loaded ${apps.length} managed apps. Open the Blocked Apps tab to view them.`
          : "No apps were selected. Please choose apps in the Screen Time picker."
      );
    } catch {
      Alert.alert("Sync failed", "Unable to sync managed apps right now.");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <ScrollView style={styles.container}>
      <ThemedView style={styles.titleContainer}>
        <ThemedText type="title">SipFirst Parent Setup</ThemedText>
      </ThemedView>

      <ThemedView style={styles.card}>
        <ThemedText type="subtitle">1) Request Screen Time access</ThemedText>
        <ThemedText>
          This asks FamilyControls authorization so SipFirst can manage selected app shielding.
        </ThemedText>
        <TouchableOpacity style={styles.button} onPress={requestAccess} disabled={loading}>
          <ThemedText style={styles.buttonText}>
            {authorizationGranted ? "Access Granted" : "Request Authorization"}
          </ThemedText>
        </TouchableOpacity>
      </ThemedView>

      <ThemedView style={styles.card}>
        <ThemedText type="subtitle">2) Sync blocked apps list</ThemedText>
        <ThemedText>
          iOS does not allow listing all installed apps directly. Parent must pick apps through Screen Time
          picker, then SipFirst syncs only managed apps.
        </ThemedText>
        <TouchableOpacity
          style={styles.button}
          onPress={handleSyncManagedApps}
          disabled={!authorizationGranted || syncing}>
          <ThemedText style={styles.buttonText}>
            {syncing ? "Syncing..." : "Open Picker + Sync Managed Apps"}
          </ThemedText>
        </TouchableOpacity>
      </ThemedView>

      <ThemedView style={styles.card}>
        <ThemedText type="subtitle">3) Set temporary unlock duration</ThemedText>
        <ThemedText>Parent sets unlock time after successful hydration challenge.</ThemedText>
        <View style={styles.durationRow}>
          {UNLOCK_DURATION_OPTIONS.map((option) => {
            const selected = unlockDurationMinutes === option.value;
            return (
              <TouchableOpacity
                key={option.label}
                style={[styles.durationButton, selected ? styles.durationButtonSelected : null]}
                onPress={() => setUnlockDurationMinutes(option.value)}>
                <ThemedText style={selected ? styles.durationButtonTextSelected : undefined}>{option.label}</ThemedText>
              </TouchableOpacity>
            );
          })}
        </View>
      </ThemedView>

      <ThemedView style={styles.card}>
        <ThemedText type="subtitle">4) Have the child open blocked apps</ThemedText>
        <ThemedText>
          When a blocked app is tapped, SipFirst challenge flow opens and can grant a temporary unlock.
        </ThemedText>
      </ThemedView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    gap: 16,
  },
  titleContainer: {
    marginTop: 24,
  },
  card: {
    borderRadius: 12,
    padding: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: "#d4d4d8",
  },
  button: {
    marginTop: 6,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "#0a84ff",
  },
  buttonText: {
    color: "#ffffff",
    fontWeight: "600",
  },
  durationRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  durationButton: {
    borderWidth: 1,
    borderColor: "#d4d4d8",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  durationButtonSelected: {
    borderColor: "#0a84ff",
    backgroundColor: "#e6f0ff",
  },
  durationButtonTextSelected: {
    color: "#0a84ff",
    fontWeight: "700",
  },
});
