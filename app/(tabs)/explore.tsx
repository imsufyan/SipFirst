import { Link } from "expo-router";
import { Pressable, ScrollView, StyleSheet } from "react-native";

import { ThemedText } from "@/components/themed-text";
import { useSipFirst } from "@/context/sipfirst-context";

function formatDurationLabel(minutes: number) {
  if (minutes < 1) {
    return `${Math.round(minutes * 60)} seconds`;
  }
  if (minutes === 1) {
    return "1 minute";
  }
  return `${minutes} minutes`;
}

function formatRemaining(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

export default function BlockedAppsScreen() {
  const { managedApps, getRemainingSeconds, unlockDurationMinutes } = useSipFirst();

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <ThemedText type="title">Managed Blocked Apps</ThemedText>
      <ThemedText>
        Tap a blocked app to open the camera challenge and request a temporary {formatDurationLabel(unlockDurationMinutes)} unlock.
      </ThemedText>

      {managedApps.length === 0 ? (
        <ThemedText style={styles.empty}>No managed apps yet. Run setup on the Home tab first.</ThemedText>
      ) : (
        managedApps.map((app) => {
          const remainingSeconds = getRemainingSeconds(app.token);
          const isUnlocked = remainingSeconds > 0;

          return (
            <Link
              key={app.token}
              href={{ pathname: "/challenge", params: { token: app.token, label: app.displayName } }}
              asChild>
              <Pressable style={styles.card}>
                <ThemedText type="subtitle">{app.displayName}</ThemedText>
                <ThemedText>{isUnlocked ? "Temporarily unlocked" : "Blocked by SipFirst"}</ThemedText>
                {isUnlocked ? (
                  <ThemedText style={styles.timer}>Relocks in {formatRemaining(remainingSeconds)}</ThemedText>
                ) : null}
              </Pressable>
            </Link>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 12,
    padding: 20,
  },
  empty: {
    marginTop: 12,
  },
  card: {
    borderWidth: 1,
    borderColor: "#d4d4d8",
    borderRadius: 12,
    padding: 14,
    gap: 4,
  },
  timer: {
    color: "#0a84ff",
    fontWeight: "600",
  },
});
