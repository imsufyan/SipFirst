//
//  DeviceActivityMonitorExtension.swift
//  SipFirstDeviceActivityMonitor
//

import DeviceActivity
import FamilyControls
import Foundation
import ManagedSettings

// Class name must match NSExtensionPrincipalClass in Info.plist.
class DeviceActivityMonitorExtension: DeviceActivityMonitor {
  private let managedSettingsStore = ManagedSettingsStore()
  private let appGroupId = "group.com.plentycompany.sipfirst"
  private let selectionKey = "sipfirst.family.selection"
  private let unlockedIdsKey = "sipfirst.unlocked.ids"
  private let activityPrefix = "sipfirst.unlock."
  private let monitorMapKey = "sipfirst.unlock.monitor.map"

  override func intervalDidEnd(for activity: DeviceActivityName) {
    super.intervalDidEnd(for: activity)
    guard let ud = UserDefaults(suiteName: appGroupId) else {
      return
    }

    let raw = activity.rawValue
    guard raw.hasPrefix(activityPrefix) else {
      return
    }

    let monitorId = String(raw.dropFirst(activityPrefix.count))
    let map = ud.dictionary(forKey: monitorMapKey) as? [String: String] ?? [:]
    let token = map[monitorId] ?? monitorId

    var unlocked = Set(ud.stringArray(forKey: unlockedIdsKey) ?? [])
    unlocked.remove(token)
    ud.set(Array(unlocked), forKey: unlockedIdsKey)

    var nextMap = map
    nextMap.removeValue(forKey: monitorId)
    ud.set(nextMap, forKey: monitorMapKey)

    applyShields(userDefaults: ud)
  }

  private func applyShields(userDefaults ud: UserDefaults) {
    guard let data = ud.data(forKey: selectionKey),
          let selection = try? JSONDecoder().decode(FamilyActivitySelection.self, from: data)
    else {
      managedSettingsStore.shield.applications = nil
      managedSettingsStore.shield.applicationCategories = nil
      return
    }

    let unlocked = Set(ud.stringArray(forKey: unlockedIdsKey) ?? [])
    func tokenId(_ t: ApplicationToken) -> String {
      String(t.hashValue)
    }

    let filteredApps = Set(selection.applicationTokens.filter { !unlocked.contains(tokenId($0)) })
    managedSettingsStore.shield.applications = filteredApps
    managedSettingsStore.shield.applicationCategories = .specific(selection.categoryTokens)
  }
}
