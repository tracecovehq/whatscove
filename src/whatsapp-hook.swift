import Cocoa
import ApplicationServices
import Foundation

struct ModerationDecision: Decodable {
  let action: String
  let chatName: String
  let senderName: String
  let fromJid: String
  let messageTimeLocal: String?
  let text: String
}

enum HookError: Error, CustomStringConvertible {
  case appNotRunning
  case noWindow
  case guiSessionUnavailable
  case chatNotFound(String)
  case messageNotFound(String)
  case menuNotAvailable
  case menuItemNotFound([String])
  case buttonNotFound([String])
  case unsupportedAction(String)
  case accessibilityDenied

  var description: String {
    switch self {
    case .appNotRunning:
      return "WhatsApp is not running."
    case .noWindow:
      return "WhatsApp does not have an accessible window."
    case .guiSessionUnavailable:
      return "Moderation actions require an active macOS GUI session. They will not run while the Mac is locked, at the login window, or asleep."
    case let .chatNotFound(chatName):
      return "Could not find chat '\(chatName)' in WhatsApp."
    case let .messageNotFound(snippet):
      return "Could not find a visible message matching '\(snippet)'."
    case .menuNotAvailable:
      return "Could not open the WhatsApp moderation menu for the matched message."
    case let .menuItemNotFound(labels):
      return "Could not find any moderation menu item matching: \(labels.joined(separator: ", "))."
    case let .buttonNotFound(labels):
      return "Could not find any confirmation button matching: \(labels.joined(separator: ", "))."
    case let .unsupportedAction(action):
      return "Unsupported moderation action '\(action)'."
    case .accessibilityDenied:
      return "Accessibility permission is required for WhatsCove moderation actions."
    }
  }
}

func normalized(_ text: String) -> String {
  return text
    .folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
    .replacingOccurrences(
      of: "[^a-z0-9]+",
      with: " ",
      options: .regularExpression
    )
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .replacingOccurrences(
      of: "\\s+",
      with: " ",
      options: .regularExpression
    )
}

func attr(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: CFTypeRef?
  let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
  if error == .success {
    return value as AnyObject?
  }
  return nil
}

func role(_ element: AXUIElement) -> String {
  (attr(element, kAXRoleAttribute as String) as? String) ?? ""
}

func title(_ element: AXUIElement) -> String {
  (attr(element, kAXTitleAttribute as String) as? String) ?? ""
}

func descriptionText(_ element: AXUIElement) -> String {
  (attr(element, kAXDescriptionAttribute as String) as? String) ?? ""
}

func valueText(_ element: AXUIElement) -> String {
  (attr(element, kAXValueAttribute as String) as? String) ?? ""
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  (attr(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

@discardableResult
func perform(_ element: AXUIElement, _ action: String) -> AXError {
  AXUIElementPerformAction(element, action as CFString)
}

func wait(seconds: Double) {
  usleep(useconds_t(seconds * 1_000_000))
}

func sendKeyCode(_ keyCode: CGKeyCode) {
  let source = CGEventSource(stateID: .hidSystemState)
  let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true)
  let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
  keyDown?.post(tap: .cghidEventTap)
  keyUp?.post(tap: .cghidEventTap)
}

func sendText(_ text: String) {
  let source = CGEventSource(stateID: .hidSystemState)
  for scalar in text.unicodeScalars {
    var utf16 = Array(String(scalar).utf16)
    let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
    keyDown?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
    let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
    keyUp?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
    keyDown?.post(tap: .cghidEventTap)
    keyUp?.post(tap: .cghidEventTap)
  }
}

func appElement() throws -> AXUIElement {
  try ensureAccessibilityPermission()
  try ensureInteractiveGuiSession()

  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "net.whatsapp.WhatsApp").first else {
    throw HookError.appNotRunning
  }
  app.activate()
  return AXUIElementCreateApplication(app.processIdentifier)
}

func ensureAccessibilityPermission() throws {
  guard AXIsProcessTrusted() else {
    throw HookError.accessibilityDenied
  }
}

func ensureInteractiveGuiSession() throws {
  guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else {
    throw HookError.guiSessionUnavailable
  }

  let onConsole = (session[kCGSessionOnConsoleKey as String] as? Bool) ?? false
  let loginDone = (session[kCGSessionLoginDoneKey as String] as? Bool) ?? false
  let screenLocked = (session["CGSSessionScreenIsLocked"] as? Bool) ?? false

  if !onConsole || !loginDone || screenLocked {
    throw HookError.guiSessionUnavailable
  }
}

func appWindow(_ appElement: AXUIElement) throws -> AXUIElement {
  guard let window = ((attr(appElement, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []).first else {
    throw HookError.noWindow
  }
  return window
}

func findFirst(_ element: AXUIElement, where predicate: (AXUIElement) -> Bool) -> AXUIElement? {
  if predicate(element) {
    return element
  }

  for child in children(element) {
    if let found = findFirst(child, where: predicate) {
      return found
    }
  }

  return nil
}

func findAll(_ element: AXUIElement, where predicate: (AXUIElement) -> Bool, into results: inout [AXUIElement]) {
  if predicate(element) {
    results.append(element)
  }

  for child in children(element) {
    findAll(child, where: predicate, into: &results)
  }
}

func combinedText(_ element: AXUIElement) -> String {
  [title(element), descriptionText(element), valueText(element)]
    .filter { !$0.isEmpty }
    .joined(separator: " ")
}

func openChat(named chatName: String, appElement: AXUIElement) throws -> AXUIElement {
  let window = try appWindow(appElement)
  let target = normalized(chatName)

  guard let chat = findFirst(window, where: {
    let combined = combinedText($0)
    return (role($0) == "AXButton" || role($0) == "AXStaticText") &&
      normalized(combined).contains(target)
  }) else {
    throw HookError.chatNotFound(chatName)
  }

  _ = perform(chat, "AXPress")
  wait(seconds: 0.8)
  return try appWindow(appElement)
}

func messageMatchScore(description: String, decision: ModerationDecision) -> Int {
  let normalizedDescription = normalized(description)
  let normalizedText = normalized(decision.text)
  let snippet = String(normalizedText.prefix(80))
  var score = 0

  if normalizedDescription.contains(snippet) {
    score += 8
  }
  if normalizedDescription.contains(String(normalizedText.prefix(40))) {
    score += 4
  }
  if let messageTimeLocal = decision.messageTimeLocal,
     !messageTimeLocal.isEmpty,
     normalizedDescription.contains(normalized(messageTimeLocal)) {
    score += 2
  }
  if !decision.senderName.isEmpty, normalizedDescription.contains(normalized(decision.senderName)) {
    score += 2
  }
  if !decision.fromJid.isEmpty {
    let digits = decision.fromJid.replacingOccurrences(of: "[^0-9]+", with: "", options: .regularExpression)
    if !digits.isEmpty, normalizedDescription.contains(digits) {
      score += 1
    }
  }

  return score
}

func findMessage(_ decision: ModerationDecision, in window: AXUIElement) throws -> AXUIElement {
  var candidates: [AXUIElement] = []
  findAll(window, where: { role($0) == "AXStaticText" && descriptionText($0).contains(decision.chatName) }, into: &candidates)

  if candidates.isEmpty {
    findAll(window, where: { role($0) == "AXStaticText" }, into: &candidates)
  }

  let ranked = candidates
    .map { (element: $0, score: messageMatchScore(description: descriptionText($0), decision: decision)) }
    .filter { $0.score > 0 }
    .sorted { left, right in
      if left.score != right.score {
        return left.score > right.score
      }
      return descriptionText(left.element).count < descriptionText(right.element).count
    }

  guard let best = ranked.first?.element else {
    throw HookError.messageNotFound(String(decision.text.prefix(80)))
  }

  return best
}

func clickButton(containing labels: [String], in root: AXUIElement) throws {
  let normalizedLabels = labels.map(normalized)
  var buttons: [AXUIElement] = []
  findAll(root, where: { role($0) == "AXButton" }, into: &buttons)

  guard let button = buttons.first(where: { element in
    let haystack = normalized(combinedText(element))
    return normalizedLabels.contains(where: { haystack.contains($0) })
  }) else {
    throw HookError.buttonNotFound(labels)
  }

  _ = perform(button, "AXPress")
}

func findMenuItems(in root: AXUIElement) -> [AXUIElement] {
  var menuItems: [AXUIElement] = []
  findAll(root, where: {
    let itemRole = role($0)
    return itemRole == "AXMenuItem" || itemRole == "AXMenuBarItem"
  }, into: &menuItems)
  return menuItems
}

func clickMenuItem(containing labels: [String], in root: AXUIElement) throws {
  let normalizedLabels = labels.map(normalized)
  let menuItems = findMenuItems(in: root)

  guard let menuItem = menuItems.first(where: { element in
    let haystack = normalized(combinedText(element))
    return normalizedLabels.contains(where: { haystack.contains($0) })
  }) else {
    throw HookError.menuItemNotFound(labels)
  }

  _ = perform(menuItem, "AXPress")
}

func chooseMenuItem(searchText: String, menuLabels: [String], confirmLabels: [String], appElement: AXUIElement) throws {
  wait(seconds: 0.15)

  do {
    try clickMenuItem(containing: menuLabels, in: appElement)
  } catch HookError.menuItemNotFound {
    let hasMenu = !findMenuItems(in: appElement).isEmpty
    guard hasMenu else {
      throw HookError.menuNotAvailable
    }

    sendText(searchText)
    wait(seconds: 0.15)
    sendKeyCode(36)
  }

  wait(seconds: 0.8)

  do {
    let window = try appWindow(appElement)
    try clickButton(containing: confirmLabels, in: window)
    wait(seconds: 0.5)
  } catch HookError.buttonNotFound {
    // Some actions complete immediately with no confirmation sheet.
  }
}

func notify(_ decision: ModerationDecision) throws {
  let body = decision.text.prefix(140)
  let script = """
  display notification \"\(String(body).replacingOccurrences(of: "\"", with: "\\\""))\" with title \"WhatsCove\" subtitle \"\(decision.action.replacingOccurrences(of: "\"", with: "\\\""))\"
  """
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
  process.arguments = ["-e", script]
  try process.run()
  process.waitUntilExit()
}

func handleDeleteMessage(_ decision: ModerationDecision, appElement: AXUIElement) throws {
  let window = try openChat(named: decision.chatName, appElement: appElement)
  let message = try findMessage(decision, in: window)
  guard perform(message, "AXShowMenu") == .success else {
    throw HookError.menuNotAvailable
  }
  wait(seconds: 0.3)
  try chooseMenuItem(
    searchText: "delete",
    menuLabels: ["Delete", "Delete Message", "Delete for everyone", "Delete for Everyone"],
    confirmLabels: ["Delete", "Delete Message", "Delete for everyone", "Delete for Everyone"],
    appElement: appElement
  )
}

func handleRemoveSender(_ decision: ModerationDecision, appElement: AXUIElement) throws {
  let window = try openChat(named: decision.chatName, appElement: appElement)
  let message = try findMessage(decision, in: window)
  guard perform(message, "AXShowMenu") == .success else {
    throw HookError.menuNotAvailable
  }
  wait(seconds: 0.3)
  try chooseMenuItem(
    searchText: "remove",
    menuLabels: ["Remove", "Remove participant", "Remove from group", "Remove from community"],
    confirmLabels: ["Remove", "Remove participant", "Remove from group", "Remove from community", "OK"],
    appElement: appElement
  )
}

let input = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
let decoder = JSONDecoder()

do {
  let decision = try decoder.decode(ModerationDecision.self, from: Data(input.utf8))
  switch decision.action {
  case "preflight_accessibility":
    try ensureAccessibilityPermission()
    try ensureInteractiveGuiSession()
  case "notify":
    try notify(decision)
  case "delete_message":
    let appEl = try appElement()
    try handleDeleteMessage(decision, appElement: appEl)
  case "remove_sender":
    let appEl = try appElement()
    try handleRemoveSender(decision, appElement: appEl)
  default:
    throw HookError.unsupportedAction(decision.action)
  }
} catch {
  FileHandle.standardError.write(Data("\(error)\n".utf8))
  exit(1)
}
