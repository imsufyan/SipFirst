import { Alert, ScrollView, StyleSheet, TouchableOpacity, View } from "react-native";
import { useState } from "react";

import { useSipFirst } from "@/context/sipfirst-context";
import { ThemedText } from "@/components/themed-text";

const UNLOCK_OPTIONS = [
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
  { value: 60, label: "60 min" },
] as const;

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return <ThemedText style={styles.sectionHeader}>{title}</ThemedText>;
}

function StatusPill({ granted }: { granted: boolean }) {
  return (
    <View style={[styles.pill, granted ? styles.pillGranted : styles.pillPending]}>
      <ThemedText style={[styles.pillText, granted ? styles.pillTextGranted : styles.pillTextPending]}>
        {granted ? "✓ Active" : "Required"}
      </ThemedText>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function SetupScreen() {
  const {
    authorizationGranted,
    requestAccess,
    loading,
    openPickerAndSync,
    managedApps,
    unlockDurationMinutes,
    setUnlockDurationMinutes,
  } = useSipFirst();
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    try {
      setSyncing(true);
      const apps = await openPickerAndSync();
      Alert.alert(
        "Apps Updated",
        apps.length > 0
          ? `${apps.length} app${apps.length !== 1 ? "s" : ""} are now managed by SipFirst.`
          : "No apps selected. Tap Edit to choose apps to block."
      );
    } catch {
      Alert.alert("Sync Failed", "Unable to sync managed apps right now.");
    } finally {
      setSyncing(false);
    }
  };

  const appCount = managedApps?.length ?? 0;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>

      {/* ── Hero ──────────────────────────────────────────────────────────────── */}
      <View style={styles.hero}>
        <ThemedText style={styles.heroEmoji}>💧</ThemedText>
        <ThemedText style={styles.heroTitle}>SipFirst Setup</ThemedText>
        <ThemedText style={styles.heroDesc}>
          Complete the steps below once, then hand the device to your child.
        </ThemedText>
      </View>

      {/* ── Section 1: Permission ─────────────────────────────────────────────── */}
      <SectionHeader title="SCREEN TIME PERMISSION" />
      <View style={styles.card}>
        <View style={styles.cardRow}>
          <View style={styles.iconBox}>
            <ThemedText style={styles.iconEmoji}>🔒</ThemedText>
          </View>
          <View style={styles.rowBody}>
            <ThemedText style={styles.rowTitle}>Family Controls Access</ThemedText>
            <ThemedText style={styles.rowDesc}>
              Lets SipFirst shield and unshield selected apps via Screen Time.
            </ThemedText>
          </View>
          <StatusPill granted={authorizationGranted} />
        </View>
        {!authorizationGranted && (
          <>
            <View style={styles.divider} />
            <TouchableOpacity
              style={[styles.rowAction, loading && styles.rowActionDisabled]}
              onPress={requestAccess}
              disabled={loading}
            >
              <ThemedText style={styles.rowActionText}>
                {loading ? "Requesting…" : "Grant Permission →"}
              </ThemedText>
            </TouchableOpacity>
          </>
        )}
      </View>

      {/* ── Section 2: Apps ───────────────────────────────────────────────────── */}
      <SectionHeader title="BLOCKED APPS" />
      <View style={styles.card}>
        <View style={styles.cardRow}>
          <View style={styles.iconBox}>
            <ThemedText style={styles.iconEmoji}>📱</ThemedText>
          </View>
          <View style={styles.rowBody}>
            <ThemedText style={styles.rowTitle}>Managed Apps</ThemedText>
            <ThemedText style={styles.rowDesc}>
              {appCount > 0
                ? `${appCount} app${appCount !== 1 ? "s" : ""} blocked — child must drink water to open them`
                : "No apps selected yet — tap Add Apps to get started"}
            </ThemedText>
          </View>
          <TouchableOpacity
            style={[
              styles.outlineButton,
              (!authorizationGranted || syncing) && styles.outlineButtonDisabled,
            ]}
            onPress={handleSync}
            disabled={!authorizationGranted || syncing}
          >
            <ThemedText style={[
              styles.outlineButtonText,
              (!authorizationGranted || syncing) && styles.outlineButtonTextDisabled,
            ]}>
              {syncing ? "Syncing…" : appCount > 0 ? "Edit" : "Add"}
            </ThemedText>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Section 3: Duration ───────────────────────────────────────────────── */}
      <SectionHeader title="UNLOCK DURATION" />
      <View style={styles.card}>
        <View style={styles.cardRow}>
          <View style={styles.iconBox}>
            <ThemedText style={styles.iconEmoji}>⏱️</ThemedText>
          </View>
          <View style={styles.rowBody}>
            <ThemedText style={styles.rowTitle}>Time After Challenge</ThemedText>
            <ThemedText style={styles.rowDesc}>
              App stays unlocked for this long after a successful hydration check.
            </ThemedText>
          </View>
        </View>
        <View style={styles.divider} />
        <View style={styles.segmented}>
          {UNLOCK_OPTIONS.map((opt) => {
            const active = unlockDurationMinutes === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                style={[styles.segment, active && styles.segmentActive]}
                onPress={() => setUnlockDurationMinutes(opt.value)}
              >
                <ThemedText style={[styles.segmentText, active && styles.segmentTextActive]}>
                  {opt.label}
                </ThemedText>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {/* ── Section 4: How it works ───────────────────────────────────────────── */}
      <SectionHeader title="HOW IT WORKS" />
      <View style={styles.card}>
        {([
          { icon: "🚫", step: "1", title: "App Blocked", desc: "Child taps a blocked app on the device" },
          { icon: "💧", step: "2", title: "Hydration Challenge", desc: "Camera verifies they drink a full glass of water" },
          { icon: "🔓", step: "3", title: "App Unlocked", desc: `App opens for ${unlockDurationMinutes} minutes, then re-locks automatically` },
        ] as const).map((item, i, arr) => (
          <View key={item.step}>
            <View style={styles.howRow}>
              <View style={styles.stepBubble}>
                <ThemedText style={styles.stepBubbleText}>{item.step}</ThemedText>
              </View>
              <View style={styles.rowBody}>
                <ThemedText style={styles.rowTitle}>{item.icon} {item.title}</ThemedText>
                <ThemedText style={styles.rowDesc}>{item.desc}</ThemedText>
              </View>
            </View>
            {i < arr.length - 1 && <View style={styles.divider} />}
          </View>
        ))}
      </View>

      <View style={styles.footer} />
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: "#F2F2F7",
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 40,
  },

  // Hero
  hero: {
    alignItems: "center",
    paddingTop: 28,
    paddingBottom: 8,
    gap: 6,
  },
  heroEmoji: {
    fontSize: 48,
  },
  heroTitle: {
    fontSize: 24,
    fontWeight: "800",
    color: "#1C1C1E",
  },
  heroDesc: {
    fontSize: 14,
    color: "#6B6B6B",
    textAlign: "center",
    lineHeight: 20,
  },

  // Section header
  sectionHeader: {
    fontSize: 12,
    fontWeight: "600",
    color: "#6B6B6B",
    letterSpacing: 0.5,
    marginTop: 24,
    marginBottom: 8,
    marginLeft: 4,
  },

  // Card
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    overflow: "hidden",
  },
  cardRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    gap: 12,
  },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: "#EFF6FF",
    alignItems: "center",
    justifyContent: "center",
  },
  iconEmoji: {
    fontSize: 20,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: "#1C1C1E",
  },
  rowDesc: {
    fontSize: 13,
    color: "#6B6B6B",
    lineHeight: 18,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#E5E5EA",
    marginLeft: 14,
  },

  // Status pill
  pill: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 20,
  },
  pillGranted: {
    backgroundColor: "#DCFCE7",
  },
  pillPending: {
    backgroundColor: "#FEF3C7",
  },
  pillText: {
    fontSize: 12,
    fontWeight: "700",
  },
  pillTextGranted: {
    color: "#16A34A",
  },
  pillTextPending: {
    color: "#D97706",
  },

  // Row action (grant permission)
  rowAction: {
    padding: 14,
  },
  rowActionDisabled: {
    opacity: 0.4,
  },
  rowActionText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#0A84FF",
  },

  // Outline button (Add / Edit apps)
  outlineButton: {
    borderWidth: 1.5,
    borderColor: "#0A84FF",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 14,
  },
  outlineButtonDisabled: {
    borderColor: "#C7C7CC",
  },
  outlineButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#0A84FF",
  },
  outlineButtonTextDisabled: {
    color: "#C7C7CC",
  },

  // Segmented control
  segmented: {
    flexDirection: "row",
    margin: 14,
    backgroundColor: "#F2F2F7",
    borderRadius: 10,
    padding: 2,
    gap: 2,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
  },
  segmentActive: {
    backgroundColor: "#FFFFFF",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.10,
    shadowRadius: 2,
    elevation: 2,
  },
  segmentText: {
    fontSize: 14,
    fontWeight: "500",
    color: "#6B6B6B",
  },
  segmentTextActive: {
    color: "#0A84FF",
    fontWeight: "700",
  },

  // How it works rows
  howRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    gap: 12,
  },
  stepBubble: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#0A84FF",
    alignItems: "center",
    justifyContent: "center",
  },
  stepBubbleText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "800",
  },

  footer: {
    height: 20,
  },
});
