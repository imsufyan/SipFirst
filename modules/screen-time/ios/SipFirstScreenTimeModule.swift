import DeviceActivity
import ExpoModulesCore
import FamilyControls
import ManagedSettings
import SwiftUI
import UIKit

public class SipFirstScreenTimeModule: Module {
  private let managedSettingsStore = ManagedSettingsStore()
  private let userDefaults = UserDefaults(suiteName: "group.com.plentycompany.sipfirst") ?? .standard
  private let selectionKey = "sipfirst.family.selection"
  private let unlockedIdsKey = "sipfirst.unlocked.ids"

  public func definition() -> ModuleDefinition {
    Name("SipFirstScreenTime")

    AsyncFunction("requestAuthorizationAsync") { () async throws -> Bool in
      try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
      return true
    }

    AsyncFunction("selectManagedAppsAsync") { () -> [[String: Any]] in
      return self.fetchManagedApps()
    }

    AsyncFunction("presentFamilyActivityPickerAsync") { () async throws -> [[String: Any]] in
      let selected = try await self.presentPicker()
      try self.persistSelection(selected)
      self.applyShieldsFromStoredSelection()
      return self.fetchManagedApps()
    }

    AsyncFunction("setShieldStateAsync") { (token: String, shielded: Bool) -> Void in
      var unlockedIds = self.readUnlockedIds()
      if shielded {
        unlockedIds.remove(token)
      } else {
        unlockedIds.insert(token)
      }

      self.userDefaults.set(Array(unlockedIds), forKey: self.unlockedIdsKey)
      self.applyShieldsFromStoredSelection()
    }

    AsyncFunction("getScreenTimeSummaryAsync") { (token: String) -> Double in
      // Placeholder while DeviceActivityReport extension is being wired.
      let minutes = Double((token.count % 7) * 5 + 10)
      return minutes
    }
  }
}

private extension SipFirstScreenTimeModule {
  func presentPicker() async throws -> FamilyActivitySelection {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.main.async {
        guard let root = Self.topViewController() else {
          continuation.resume(throwing: NSError(domain: "SipFirstScreenTime", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unable to find active iOS view controller."]))
          return
        }

        let picker = FamilyPickerContainer { selection in
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
    let raw = userDefaults.stringArray(forKey: unlockedIdsKey) ?? []
    return Set(raw)
  }

  func tokenId(_ token: ApplicationToken) -> String {
    return String(token.hashValue)
  }

  func fetchManagedApps() -> [[String: Any]] {
    guard let selection = loadSelection() else {
      return []
    }

    let unlocked = readUnlockedIds()
    let tokens = Array(selection.applicationTokens)
    return tokens.enumerated().map { index, token in
      let id = tokenId(token)
      return [
        "token": id,
        "displayName": "Managed App \(index + 1)",
        "isShielded": !unlocked.contains(id),
      ]
    }
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
    managedSettingsStore.shield.applicationCategories = ShieldSettings.ActivityCategoryPolicy.specific(selection.categoryTokens)
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
  @State private var selection = FamilyActivitySelection()
  let onDone: (FamilyActivitySelection) -> Void

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
