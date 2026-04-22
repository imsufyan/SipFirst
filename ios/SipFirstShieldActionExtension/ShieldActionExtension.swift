//
//  ShieldActionExtension.swift
//  SipFirstShieldActionExtension
//

import Foundation
import ManagedSettings

// Class name must match NSExtensionPrincipalClass in Info.plist.
class ShieldActionExtension: ShieldActionDelegate {
  /// `ShieldActionResponse` only supports `.close`, `.defer`, and `.none` — there is no URL / open-app case.
  override func handle(action: ShieldAction, for application: ApplicationToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
    switch action {
    case .primaryButtonPressed:
      completionHandler(.close)
    case .secondaryButtonPressed:
      completionHandler(.defer)
    @unknown default:
      completionHandler(.close)
    }
  }

  override func handle(action: ShieldAction, for webDomain: WebDomainToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
    switch action {
    case .primaryButtonPressed:
      completionHandler(.close)
    case .secondaryButtonPressed:
      completionHandler(.defer)
    @unknown default:
      completionHandler(.close)
    }
  }

  override func handle(action: ShieldAction, for category: ActivityCategoryToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
    switch action {
    case .primaryButtonPressed:
      completionHandler(.close)
    case .secondaryButtonPressed:
      completionHandler(.defer)
    @unknown default:
      completionHandler(.close)
    }
  }
}
