import Cocoa
import ApplicationServices
import Foundation

struct ModerationDecision: Decodable {
  let id: String?
  let action: String
  let chatName: String
  let senderName: String
  let fromJid: String
  let messageTimeLocal: String?
  let messagePk: Int?
  let text: String
  let captureActionScreenshots: Bool?
  let screenshotDirectory: String?
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

func trace(_ message: String) {
  FileHandle.standardOutput.write(Data("TRACE: \(message)\n".utf8))
}

func traceSnippet(_ text: String, limit: Int = 120) -> String {
  let trimmed = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.count <= limit {
    return trimmed
  }
  return "\(trimmed.prefix(limit))..."
}

func sanitizedPathComponent(_ text: String) -> String {
  let normalizedText = normalized(text).replacingOccurrences(of: " ", with: "-")
  let trimmed = String(normalizedText.prefix(48))
  return trimmed.isEmpty ? "item" : trimmed
}

func screenshotBaseName(for decision: ModerationDecision) -> String {
  if let id = decision.id, !id.isEmpty {
    return id
  }

  let pk = decision.messagePk.map(String.init) ?? "unknown"
  return "\(decision.action)-\(pk)"
}

func captureActionScreenshot(
  stage: String,
  consequentialLabel: String,
  decision: ModerationDecision
) {
  guard decision.captureActionScreenshots == true,
        let screenshotDirectory = decision.screenshotDirectory,
        !screenshotDirectory.isEmpty else {
    return
  }

  do {
    try FileManager.default.createDirectory(
      atPath: screenshotDirectory,
      withIntermediateDirectories: true
    )
    let timestamp = ISO8601DateFormatter().string(from: Date())
      .replacingOccurrences(of: ":", with: "-")
    let fileName =
      "\(timestamp)-\(screenshotBaseName(for: decision))-\(sanitizedPathComponent(consequentialLabel))-\(sanitizedPathComponent(stage)).png"
    let screenshotPath = (screenshotDirectory as NSString).appendingPathComponent(fileName)

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", screenshotPath]
    try process.run()
    process.waitUntilExit()

    if process.terminationStatus == 0 {
      trace("Saved \(stage) screenshot for \(consequentialLabel): \(screenshotPath)")
    } else {
      trace("Failed to save \(stage) screenshot for \(consequentialLabel) (exit \(process.terminationStatus)).")
    }
  } catch {
    trace("Failed to save \(stage) screenshot for \(consequentialLabel): \(error)")
  }
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

func position(_ element: AXUIElement) -> CGPoint? {
  guard let rawValue = attr(element, kAXPositionAttribute as String) else {
    return nil
  }
  let value = unsafeBitCast(rawValue, to: AXValue.self)
  guard AXValueGetType(value) == .cgPoint else {
    return nil
  }

  var point = CGPoint.zero
  return AXValueGetValue(value, .cgPoint, &point) ? point : nil
}

func size(_ element: AXUIElement) -> CGSize? {
  guard let rawValue = attr(element, kAXSizeAttribute as String) else {
    return nil
  }
  let value = unsafeBitCast(rawValue, to: AXValue.self)
  guard AXValueGetType(value) == .cgSize else {
    return nil
  }

  var size = CGSize.zero
  return AXValueGetValue(value, .cgSize, &size) ? size : nil
}

func frame(_ element: AXUIElement) -> CGRect? {
  guard let origin = position(element), let size = size(element) else {
    return nil
  }
  return CGRect(origin: origin, size: size)
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

func clickPoint(_ point: CGPoint) {
  let source = CGEventSource(stateID: .hidSystemState)
  let mouseMoved = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
  let mouseDown = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
  let mouseUp = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
  mouseMoved?.post(tap: .cghidEventTap)
  mouseDown?.post(tap: .cghidEventTap)
  mouseUp?.post(tap: .cghidEventTap)
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
  trace("Found running WhatsApp app and activating it.")
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

func descendantText(_ element: AXUIElement, depth: Int = 2) -> String {
  let current = combinedText(element)
  guard depth > 0 else {
    return current
  }

  let childText = children(element)
    .map { descendantText($0, depth: depth - 1) }
    .filter { !$0.isEmpty }
    .joined(separator: " ")

  if current.isEmpty {
    return childText
  }
  if childText.isEmpty {
    return current
  }
  return "\(current) \(childText)"
}

func tokenCount(_ text: String) -> Int {
  let normalizedText = normalized(text)
  guard !normalizedText.isEmpty else {
    return 0
  }
  return normalizedText.split(separator: " ").count
}

func actionLabelMatchScore(haystack rawHaystack: String, labels: [String]) -> Int? {
  let haystack = normalized(rawHaystack)
  guard !haystack.isEmpty else {
    return nil
  }

  var bestScore: Int?

  for rawLabel in labels {
    let label = normalized(rawLabel)
    guard !label.isEmpty else {
      continue
    }

    let score: Int?
    let labelTokens = tokenCount(label)

    if haystack == label {
      score = 1_000
    } else if labelTokens >= 2 && (haystack.hasPrefix("\(label) ") || haystack.hasSuffix(" \(label)")) {
      score = 700
    } else if labelTokens >= 2 && haystack.contains(label) {
      let haystackTokens = tokenCount(haystack)
      score = haystackTokens <= labelTokens + 2 ? 350 : nil
    } else {
      score = nil
    }

    if let score {
      bestScore = max(bestScore ?? score, score)
    }
  }

  return bestScore
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

  trace("Opening chat '\(chatName)'.")
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

  trace("Scanned \(candidates.count) visible text candidate(s) for the target message.")
  guard let best = ranked.first?.element else {
    throw HookError.messageNotFound(String(decision.text.prefix(80)))
  }

  if let top = ranked.first {
    trace("Selected message candidate with score \(top.score): \(traceSnippet(descriptionText(top.element)))")
  }
  return best
}

func clickButton(
  containing labels: [String],
  in root: AXUIElement,
  decision: ModerationDecision? = nil,
  consequentialLabel: String? = nil
) throws {
  let normalizedLabels = labels.map(normalized)
  var buttons: [AXUIElement] = []
  findAll(root, where: { role($0) == "AXButton" }, into: &buttons)
  trace("Found \(buttons.count) button candidate(s) while looking for confirmation: \(labels.joined(separator: ", ")).")

  let rankedButtons = buttons
    .map { element in
      let haystack = descendantText(element, depth: 2)
      return (element: element, score: actionLabelMatchScore(haystack: haystack, labels: normalizedLabels) ?? -1, haystack: haystack)
    }
    .filter { $0.score >= 0 }
    .sorted { left, right in
      if left.score != right.score {
        return left.score > right.score
      }
      return left.haystack.count < right.haystack.count
    }

  guard let match = rankedButtons.first else {
    throw HookError.buttonNotFound(labels)
  }

  if let decision, let consequentialLabel {
    captureActionScreenshot(stage: "before", consequentialLabel: consequentialLabel, decision: decision)
  }
  trace("Clicking confirmation button: \(traceSnippet(descendantText(match.element, depth: 2))).")
  _ = perform(match.element, "AXPress")
  if let decision, let consequentialLabel {
    wait(seconds: 0.3)
    captureActionScreenshot(stage: "after", consequentialLabel: consequentialLabel, decision: decision)
  }
}

func findMenuItems(in root: AXUIElement) -> [AXUIElement] {
  var menuItems: [AXUIElement] = []
  findAll(root, where: {
    let itemRole = role($0)
    return itemRole == "AXMenuItem" || itemRole == "AXMenuBarItem"
  }, into: &menuItems)
  return menuItems
}

func clickMenuItem(
  containing labels: [String],
  in root: AXUIElement,
  decision: ModerationDecision? = nil,
  consequentialLabel: String? = nil
) throws {
  let normalizedLabels = labels.map(normalized)
  let menuItems = findMenuItems(in: root)
  trace("Found \(menuItems.count) menu item candidate(s) while looking for: \(labels.joined(separator: ", ")).")

  let rankedMenuItems = menuItems
    .map { element in
      let haystack = descendantText(element, depth: 2)
      return (element: element, score: actionLabelMatchScore(haystack: haystack, labels: normalizedLabels) ?? -1, haystack: haystack)
    }
    .filter { $0.score >= 0 }
    .sorted { left, right in
      if left.score != right.score {
        return left.score > right.score
      }
      return left.haystack.count < right.haystack.count
    }

  guard let match = rankedMenuItems.first else {
    throw HookError.menuItemNotFound(labels)
  }

  if let decision, let consequentialLabel {
    captureActionScreenshot(stage: "before", consequentialLabel: consequentialLabel, decision: decision)
  }
  trace("Clicking menu item: \(traceSnippet(descendantText(match.element, depth: 2))).")
  _ = perform(match.element, "AXPress")
  if let decision, let consequentialLabel {
    wait(seconds: 0.3)
    captureActionScreenshot(stage: "after", consequentialLabel: consequentialLabel, decision: decision)
  }
}

func clickSelectedMessageToolbarDelete(in root: AXUIElement, decision: ModerationDecision) throws {
  var elements: [AXUIElement] = []
  findAll(root, where: {
    let itemRole = role($0)
    return itemRole == "AXButton" || itemRole == "AXStaticText" || itemRole == "AXGroup"
  }, into: &elements)
  trace("Found \(elements.count) candidate(s) while looking for the selected-message delete toolbar action.")

  let rootFrame = frame(root)
  let rankedButtons = elements
    .map { element in
      let haystack = descendantText(element, depth: 2)
      let labelScore = actionLabelMatchScore(haystack: haystack, labels: ["Delete"]) ?? -1
      let elementFrame = frame(element)
      let isFooterCandidate: Bool
      if let rootFrame, let elementFrame {
        let center = CGPoint(x: elementFrame.midX, y: elementFrame.midY)
        isFooterCandidate = center.y > rootFrame.minY + (rootFrame.height * 0.75) &&
          center.x > rootFrame.minX + (rootFrame.width * 0.25) &&
          center.x < rootFrame.minX + (rootFrame.width * 0.75)
      } else {
        isFooterCandidate = false
      }
      let score = labelScore >= 1_000 && isFooterCandidate ? 1_000 : -1
      return (element: element, score: score, haystack: haystack)
    }
    .filter { $0.score >= 0 }
    .sorted { left, right in
      if left.score != right.score {
        return left.score > right.score
      }
      return left.haystack.count < right.haystack.count
    }

  guard let match = rankedButtons.first else {
    throw HookError.buttonNotFound(["Delete"])
  }

  captureActionScreenshot(stage: "before", consequentialLabel: "delete-toolbar", decision: decision)
  trace("Clicking selected-message delete toolbar button: \(traceSnippet(descendantText(match.element, depth: 2))).")
  let pressResult = perform(match.element, "AXPress")
  if pressResult != .success, let matchFrame = frame(match.element) {
    trace("Toolbar delete element was not directly pressable; clicking its center point instead.")
    clickPoint(CGPoint(x: matchFrame.midX, y: matchFrame.midY))
  }
  wait(seconds: 0.3)
  captureActionScreenshot(stage: "after", consequentialLabel: "delete-toolbar", decision: decision)
}

func chooseMenuItem(
  searchText: String,
  menuLabels: [String],
  confirmLabels: [String] = [],
  appElement: AXUIElement,
  decision: ModerationDecision,
  consequentialLabel: String,
  requireConfirmation: Bool = false
) throws {
  wait(seconds: 0.15)

  do {
    try clickMenuItem(
      containing: menuLabels,
      in: appElement,
      decision: requireConfirmation ? nil : decision,
      consequentialLabel: requireConfirmation ? nil : consequentialLabel
    )
  } catch HookError.menuItemNotFound {
    let hasMenu = !findMenuItems(in: appElement).isEmpty
    guard hasMenu else {
      throw HookError.menuNotAvailable
    }

    if !requireConfirmation {
      captureActionScreenshot(stage: "before", consequentialLabel: consequentialLabel, decision: decision)
    }
    trace("Menu item not directly discoverable; typing '\(searchText)' into the open menu.")
    sendText(searchText)
    wait(seconds: 0.15)
    trace("Pressing Return to choose the highlighted menu action.")
    sendKeyCode(36)
    if !requireConfirmation {
      wait(seconds: 0.3)
      captureActionScreenshot(stage: "after", consequentialLabel: consequentialLabel, decision: decision)
    }
  }

  wait(seconds: 0.8)

  if confirmLabels.isEmpty {
    return
  }

  do {
    let window = try appWindow(appElement)
    try clickButton(
      containing: confirmLabels,
      in: window,
      decision: decision,
      consequentialLabel: consequentialLabel
    )
    wait(seconds: 0.5)
  } catch HookError.buttonNotFound {
    if requireConfirmation {
      throw HookError.buttonNotFound(confirmLabels)
    }
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
  trace("Opened context menu for the matched message.")
  wait(seconds: 0.3)
  try chooseMenuItem(
    searchText: "delete",
    menuLabels: ["Delete", "Delete Message"],
    appElement: appElement,
    decision: decision,
    consequentialLabel: "delete-from-context-menu"
  )
  let refreshedWindow = try appWindow(appElement)
  try clickSelectedMessageToolbarDelete(in: refreshedWindow, decision: decision)
  let confirmationWindow = try appWindow(appElement)
  try clickButton(
    containing: ["Delete for everyone", "Delete for Everyone"],
    in: confirmationWindow,
    decision: decision,
    consequentialLabel: "delete-for-everyone"
  )
  let finalConfirmationWindow = try appWindow(appElement)
  try clickButton(
    containing: ["Delete"],
    in: finalConfirmationWindow,
    decision: decision,
    consequentialLabel: "delete-admin-confirmation"
  )
  wait(seconds: 0.5)
}

func handleRemoveSender(_ decision: ModerationDecision, appElement: AXUIElement) throws {
  let window = try openChat(named: decision.chatName, appElement: appElement)
  let message = try findMessage(decision, in: window)
  guard perform(message, "AXShowMenu") == .success else {
    throw HookError.menuNotAvailable
  }
  trace("Opened context menu for the matched message.")
  wait(seconds: 0.3)
  try chooseMenuItem(
    searchText: "remove",
    menuLabels: ["Remove", "Remove participant", "Remove from group", "Remove from community"],
    confirmLabels: ["Remove", "Remove participant", "Remove from group", "Remove from community", "OK"],
    appElement: appElement,
    decision: decision,
    consequentialLabel: "remove-sender"
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
