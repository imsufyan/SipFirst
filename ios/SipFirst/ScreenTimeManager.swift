import DeviceActivity
import FamilyControls
import Foundation
import ManagedSettings
import SwiftUI
import UIKit

@objc(ScreenTimeManager)
final class ScreenTimeManager: NSObject {
  private let managedSettingsStore = ManagedSettingsStore()
  private let userDefaults = UserDefaults(suiteName: "group.com.plentycompany.sipfirst") ?? .standard
  private let selectionKey = "sipfirst.family.selection"
  private let unlockedIdsKey = "sipfirst.unlocked.ids"
  private let unlockActivityPrefix = "sipfirst.unlock."
  private let monitorMapKey = "sipfirst.unlock.monitor.map"
  // DeviceActivity enforces a practical minimum for reliable one-shot schedules.
  // Keep 15m for killed-state relock guarantees.
  private let minimumMonitorDurationSeconds: TimeInterval = 15 * 60
  // Allow a small bridge delay so exact 15m picks don't drop slightly below threshold.
  private let monitorScheduleGraceSeconds: TimeInterval = 20

  @objc
  static func requiresMainQueueSetup() -> Bool {
    true
  }

  @objc
  func requestAuthorization(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
        resolve(true)
      } catch {
        reject("AUTHORIZATION_FAILED", "Unable to request Screen Time authorization.", error)
      }
    }
  }

  @objc
  func selectManagedApps(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      resolve(self.fetchManagedApps())
    }
  }

  @objc
  func presentFamilyActivityPicker(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    Task {
      do {
        let selection = try await presentPicker()
        try persistSelection(selection)
        applyShieldsFromStoredSelection()
        let apps = await MainActor.run { self.fetchManagedApps() }
        resolve(apps)
      } catch {
        reject("PICKER_FAILED", "Unable to present Family Activity Picker.", error)
      }
    }
  }

  @objc
  func setShieldState(_ token: String, shielded: Bool, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    var unlockedIds = readUnlockedIds()
    if shielded {
      unlockedIds.remove(token)
      stopRelockMonitor(for: token)
    } else {
      unlockedIds.insert(token)
    }

    userDefaults.set(Array(unlockedIds), forKey: unlockedIdsKey)
    applyShieldsFromStoredSelection()
    resolve(nil)
  }

  /// Unlocks the app until `expiresAtMs` (epoch ms) and schedules `DeviceActivityMonitor` to relock when that window ends.
  @objc
  func setTemporaryUnlock(_ token: String, expiresAtMs: Double, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      var unlockedIds = self.readUnlockedIds()
      unlockedIds.insert(token)
      self.userDefaults.set(Array(unlockedIds), forKey: self.unlockedIdsKey)
      self.applyShieldsFromStoredSelection()

      let end = Date(timeIntervalSince1970: expiresAtMs / 1000.0)
      do {
        try self.scheduleRelockMonitor(token: token, end: end)
        resolve(nil)
      } catch {
        // Never block unlock flow if DeviceActivity scheduling fails.
        // Foreground relock timer still runs via JS, and long-window background scheduling can be hardened separately.
        resolve(nil)
      }
    }
  }

  @objc
  func getScreenTimeSummary(_ token: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    let minutes = Double((token.count % 7) * 5 + 10)
    resolve(minutes)
  }

}

private extension ScreenTimeManager {
  func monitorMap() -> [String: String] {
    userDefaults.dictionary(forKey: monitorMapKey) as? [String: String] ?? [:]
  }

  func writeMonitorMap(_ map: [String: String]) {
    userDefaults.set(map, forKey: monitorMapKey)
  }

  func monitorId(for token: String) -> String {
    // DeviceActivityName values should be short and stable across launches.
    // Use a deterministic FNV-1a hash over the token string.
    var hash: UInt32 = 2_166_136_261
    for byte in token.utf8 {
      hash ^= UInt32(byte)
      hash = hash &* 16_777_619
    }
    return String(hash, radix: 16)
  }

  func stopRelockMonitor(for token: String) {
    let center = DeviceActivityCenter()
    let id = monitorId(for: token)
    let name = DeviceActivityName(rawValue: unlockActivityPrefix + id)
    center.stopMonitoring([name])

    var map = monitorMap()
    map.removeValue(forKey: id)
    writeMonitorMap(map)
  }

  func scheduleRelockMonitor(token: String, end: Date) throws {
    let center = DeviceActivityCenter()
    let id = monitorId(for: token)
    let name = DeviceActivityName(rawValue: unlockActivityPrefix + id)
    center.stopMonitoring([name])

    let start = Date()
    guard end > start else {
      throw NSError(domain: "ScreenTimeManager", code: 2, userInfo: [NSLocalizedDescriptionKey: "Relock end time must be in the future."])
    }
    let duration = end.timeIntervalSince(start)
    var effectiveEnd = end
    if duration < minimumMonitorDurationSeconds {
      let deficit = minimumMonitorDurationSeconds - duration
      if deficit <= monitorScheduleGraceSeconds {
        effectiveEnd = start.addingTimeInterval(minimumMonitorDurationSeconds + 1)
      } else {
        throw NSError(
          domain: "ScreenTimeManager",
          code: 1001,
          userInfo: [NSLocalizedDescriptionKey: "Requested unlock window is below iOS minimum for background relock."]
        )
      }
    }

    let calendar = Calendar.autoupdatingCurrent
    let components: Set<Calendar.Component> = [.year, .month, .day, .hour, .minute, .second]
    let startComponents = calendar.dateComponents(components, from: start.addingTimeInterval(1))
    let endComponents = calendar.dateComponents(components, from: effectiveEnd)

    // If component rounding collapses start/end to the same second, push end by 1 minute.
    if let startDate = calendar.date(from: startComponents),
       let endDate = calendar.date(from: endComponents),
       endDate <= startDate {
      effectiveEnd = startDate.addingTimeInterval(60)
    }

    let finalEndComponents = calendar.dateComponents(components, from: effectiveEnd)
    guard let finalEndDate = calendar.date(from: finalEndComponents),
          let finalStartDate = calendar.date(from: startComponents),
          finalEndDate > finalStartDate
    else {
      throw NSError(
        domain: "ScreenTimeManager",
        code: 1001,
        userInfo: [NSLocalizedDescriptionKey: "Relock schedule collapsed after rounding."]
      )
    }

    let schedule = DeviceActivitySchedule(intervalStart: startComponents, intervalEnd: finalEndComponents, repeats: false)
    try center.startMonitoring(name, during: schedule)

    var map = monitorMap()
    map[id] = token
    writeMonitorMap(map)
  }

  func presentPicker() async throws -> FamilyActivitySelection {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.main.async {
        guard let root = Self.topViewController() else {
          let error = NSError(domain: "ScreenTimeManager", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unable to find active iOS view controller."])
          continuation.resume(throwing: error)
          return
        }

        let picker = FamilyPickerContainer(initialSelection: self.loadSelection() ?? FamilyActivitySelection()) { selection in
          root.dismiss(animated: true)
          continuation.resume(returning: selection)
        }

        let host = UIHostingController(rootView: picker)
        host.modalPresentationStyle = .pageSheet
        root.present(host, animated: true)
      }
    }
  }

  func persistSelection(_ selection: FamilyActivitySelection) throws {
    let encoded = try JSONEncoder().encode(selection)
    userDefaults.set(encoded, forKey: selectionKey)
  }

  func loadSelection() -> FamilyActivitySelection? {
    guard let data = userDefaults.data(forKey: selectionKey) else {
      return nil
    }
    return try? JSONDecoder().decode(FamilyActivitySelection.self, from: data)
  }

  func readUnlockedIds() -> Set<String> {
    Set(userDefaults.stringArray(forKey: unlockedIdsKey) ?? [])
  }

  func tokenId(_ token: ApplicationToken) -> String {
    String(token.hashValue)
  }

  func fetchManagedApps() -> [[String: Any]] {
    guard let selection = loadSelection() else {
      return []
    }

    let unlocked = readUnlockedIds()
    return Array(selection.applicationTokens).enumerated().map { index, token in
      let id = tokenId(token)
      return [
        "token": id,
        "displayName": displayName(for: token, index: index),
        "isShielded": !unlocked.contains(id),
      ]
    }
  }

  func displayName(for token: ApplicationToken, index: Int) -> String {
    if #available(iOS 16.0, *) {
      let application = Application(token: token)
      if let localizedName = application.localizedDisplayName, !localizedName.isEmpty {
        return localizedName
      }
      if let bundleId = application.bundleIdentifier, !bundleId.isEmpty {
        // Extract last bundle component and split camelCase: "com.acme.myApp" → "My App"
        let lastComponent = bundleId.split(separator: ".").last.map(String.init) ?? bundleId
        let spaced = lastComponent.replacingOccurrences(of: "([A-Z])", with: " $1", options: .regularExpression)
          .trimmingCharacters(in: .whitespaces)
        if !spaced.isEmpty {
          return spaced.prefix(1).uppercased() + spaced.dropFirst()
        }
        return bundleId
      }
    }
    return "App \(index + 1)"
  }

  func applyShieldsFromStoredSelection() {
    guard let selection = loadSelection() else {
      managedSettingsStore.shield.applications = nil
      managedSettingsStore.shield.applicationCategories = nil
      return
    }

    let unlocked = readUnlockedIds()
    let filteredApps = Set(selection.applicationTokens.filter { !unlocked.contains(tokenId($0)) })

    managedSettingsStore.shield.applications = filteredApps
    managedSettingsStore.shield.applicationCategories = .specific(selection.categoryTokens)
  }

  static func topViewController(base: UIViewController? = UIApplication.shared.connectedScenes
    .compactMap { ($0 as? UIWindowScene)?.keyWindow }
    .first?.rootViewController) -> UIViewController? {
    if let navigationController = base as? UINavigationController {
      return topViewController(base: navigationController.visibleViewController)
    }
    if let tabBarController = base as? UITabBarController, let selected = tabBarController.selectedViewController {
      return topViewController(base: selected)
    }
    if let presented = base?.presentedViewController {
      return topViewController(base: presented)
    }
    return base
  }
}

private struct FamilyPickerContainer: View {
  @State private var selection: FamilyActivitySelection
  let onDone: (FamilyActivitySelection) -> Void

  init(initialSelection: FamilyActivitySelection, onDone: @escaping (FamilyActivitySelection) -> Void) {
    _selection = State(initialValue: initialSelection)
    self.onDone = onDone
  }

  var body: some View {
    NavigationView {
      FamilyActivityPicker(selection: $selection)
        .navigationTitle("Select Apps to Block")
        .toolbar {
          ToolbarItem(placement: .confirmationAction) {
            Button("Done") {
              onDone(selection)
            }
          }
        }
    }
  }
}
