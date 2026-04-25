import Cocoa
import ApplicationServices
import Foundation

// Bundled moderation executor for WhatsApp Desktop on macOS.
//
// The TypeScript bot owns detection, policy, persistence, and retry. This Swift
// script only receives one ModerationDecision JSON object on stdin and performs
// the requested UI action through macOS Accessibility. Keep stdout trace lines
// descriptive: they are persisted into moderation-events.jsonl and are the main
// way to debug failures in WhatsApp's changing desktop UI.
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
  case menuItemDidNotActivate([String])
  case buttonNotFound([String])
  case unsafeTarget(String)
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
    case let .menuItemDidNotActivate(labels):
      return "Found a moderation menu item matching \(labels.joined(separator: ", ")), but selecting it did not change the WhatsApp UI."
    case let .buttonNotFound(labels):
      return "Could not find any confirmation button matching: \(labels.joined(separator: ", "))."
    case let .unsafeTarget(reason):
      return "Refusing to target an unsafe WhatsApp UI element: \(reason)."
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

func elementLabel(_ element: AXUIElement) -> String {
  let text = traceSnippet(descendantText(element, depth: 2), limit: 80)
  if text.isEmpty {
    return role(element)
  }
  return "\(role(element)) \(text)"
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

func sendKeyCodes(_ keyCodes: [CGKeyCode], pauseSeconds: Double = 0.06) {
  for keyCode in keyCodes {
    sendKeyCode(keyCode)
    wait(seconds: pauseSeconds)
  }
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
  // Prefer a modal sheet when one exists. WhatsApp exposes destructive
  // confirmations such as "Delete for everyone" and "Remove" as sheets; searching
  // the main window while a sheet is open misses the buttons we need.
  let windows = (attr(appElement, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
  let focusedWindow = attr(appElement, kAXFocusedWindowAttribute as String)
    .map { unsafeBitCast($0, to: AXUIElement.self) }
  let mainWindow = attr(appElement, kAXMainWindowAttribute as String)
    .map { unsafeBitCast($0, to: AXUIElement.self) }

  let orderedCandidates = [focusedWindow, mainWindow]
    .compactMap { $0 }
    .filter { candidate in
      !windows.contains(where: { CFEqual($0, candidate) })
    } + windows

  func directSheet(in element: AXUIElement) -> AXUIElement? {
    if let sheets = attr(element, "AXSheets") as? [AXUIElement],
       let firstSheet = sheets.first {
      return firstSheet
    }

    return children(element).first(where: { role($0) == "AXSheet" })
  }

  if !orderedCandidates.isEmpty {
    let windowPreview = orderedCandidates
      .prefix(5)
      .map(elementLabel)
      .joined(separator: " | ")
    trace("App window candidates: \(windowPreview)")
  }

  for candidate in orderedCandidates {
    if let sheet = directSheet(in: candidate) {
      trace("Using modal sheet as interactive root: \(elementLabel(sheet))")
      return sheet
    }
  }

  if let focusedWindow {
    trace("Using focused window as interactive root: \(elementLabel(focusedWindow))")
    return focusedWindow
  }

  guard let window = windows.first else {
    throw HookError.noWindow
  }
  trace("Using first app window as interactive root: \(elementLabel(window))")
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

func isReasonableFrame(_ frame: CGRect?) -> Bool {
  guard let frame else {
    return false
  }

  return frame.width >= 8 && frame.height >= 8
}

func isOnScreen(_ frame: CGRect?) -> Bool {
  guard let frame else {
    return false
  }

  let screenBounds = NSScreen.screens.reduce(CGRect.null) { partialResult, screen in
    partialResult.union(screen.frame)
  }

  if screenBounds.isNull {
    return true
  }

  return frame.intersects(screenBounds)
}

typealias ActiveMenu = (menu: AXUIElement, items: [AXUIElement])

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

func pressElementWithFallback(
  _ element: AXUIElement,
  label: String
) {
  let pressResult = perform(element, "AXPress")
  if pressResult == .success {
    return
  }

  if let elementFrame = frame(element), isReasonableFrame(elementFrame) {
    trace("\(label) was not directly pressable; clicking its center point instead.")
    clickPoint(CGPoint(x: elementFrame.midX, y: elementFrame.midY))
  }
}

func groupInfoSeemsOpen(
  chatName: String,
  in root: AXUIElement
) -> Bool {
  let normalizedChatName = normalized(chatName)
  let texts = normalizedTexts(in: root, roles: ["AXButton", "AXHeading", "AXStaticText", "AXGroup"], depth: 3)

  let hasChatName = texts.contains { $0.contains(normalizedChatName) }
  let stillInChatView = texts.contains {
    $0.contains("messages in chat with \(normalizedChatName)") ||
      $0.contains("compose message") ||
      $0.contains("voice message")
  }
  let hasGroupInfoSignals = texts.contains {
    $0 == "members" ||
      $0.hasPrefix("members ") ||
      $0.contains("group admins") ||
      $0.contains("group permissions") ||
      $0.contains("media links and docs") ||
      $0.contains("disappearing messages")
  }

  return hasChatName && hasGroupInfoSignals && !stillInChatView
}

func findGroupHeader(
  chatName: String,
  in window: AXUIElement
) -> AXUIElement? {
  let normalizedChatName = normalized(chatName)
  let windowFrame = frame(window)

  var candidates: [AXUIElement] = []
  findAll(window, where: {
    let itemRole = role($0)
    guard itemRole == "AXButton" || itemRole == "AXHeading" || itemRole == "AXStaticText" else {
      return false
    }
    let text = normalized(descendantText($0, depth: 2))
    guard text.contains(normalizedChatName) else {
      return false
    }
    if let elementFrame = frame($0), let windowFrame {
      let center = CGPoint(x: elementFrame.midX, y: elementFrame.midY)
      let inHeaderBand = center.y < windowFrame.minY + (windowFrame.height * 0.18)
      let inMainPane = center.x > windowFrame.minX + (windowFrame.width * 0.25)
      return inHeaderBand && inMainPane
    }
    return true
  }, into: &candidates)

  let rankedCandidates = candidates
    .map { element -> (element: AXUIElement, score: Int, text: String) in
      let text = normalized(descendantText(element, depth: 2))
      var score = 0
      if text == normalizedChatName {
        score += 25
      } else if text.hasPrefix("\(normalizedChatName) ") {
        score += 18
      } else if text.contains(normalizedChatName) {
        score += 5
      }
      if text.contains("online") {
        score += 8
      }
      if text.contains("members") || text.contains("you") {
        score += 2
      }
      if text.contains("message ") || text.contains("sent to ") || text.contains("received in ") ||
        text.contains("disappearing message") || text.contains("list of chats") {
        score -= 20
      }
      if let elementFrame = frame(element), let windowFrame {
        let center = CGPoint(x: elementFrame.midX, y: elementFrame.midY)
        if center.y < windowFrame.minY + (windowFrame.height * 0.18) {
          score += 2
        }
        if center.x > windowFrame.minX + (windowFrame.width * 0.25) {
          score += 2
        }
      }
      return (element: element, score: score, text: text)
    }
    .filter { $0.score > 0 }
    .sorted { left, right in
      if left.score != right.score {
        return left.score > right.score
      }
      return left.text.count < right.text.count
    }

  if !rankedCandidates.isEmpty {
    let preview = rankedCandidates.prefix(5).map { traceSnippet($0.text) }.joined(separator: " | ")
    trace("Group-header candidates: \(preview)")
  }

  return rankedCandidates.first?.element
}

func findChatListRow(
  chatName: String,
  in window: AXUIElement
) -> AXUIElement? {
  let normalizedChatName = normalized(chatName)
  let windowFrame = frame(window)

  var candidates: [AXUIElement] = []
  findAll(window, where: {
    let itemRole = role($0)
    guard itemRole == "AXButton" || itemRole == "AXStaticText" || itemRole == "AXGroup" else {
      return false
    }
    let text = normalized(descendantText($0, depth: 3))
    guard text.contains(normalizedChatName) else {
      return false
    }
    if let elementFrame = frame($0), let windowFrame {
      let center = CGPoint(x: elementFrame.midX, y: elementFrame.midY)
      let inChatList = center.x < windowFrame.minX + (windowFrame.width * 0.35)
      let belowSearchHeader = center.y > windowFrame.minY + (windowFrame.height * 0.12)
      return inChatList && belowSearchHeader
    }
    return true
  }, into: &candidates)

  let rankedCandidates = candidates
    .map { element -> (element: AXUIElement, score: Int, text: String) in
      let text = normalized(descendantText(element, depth: 3))
      var score = 0
      if text == normalizedChatName {
        score += 12
      } else if text.hasPrefix("\(normalizedChatName) ") {
        score += 9
      } else if text.contains(normalizedChatName) {
        score += 4
      }
      if text.contains("list of chats") {
        score -= 8
      }
      if text.contains("message from") || text.contains("your message") || text.contains("received in") {
        score += 1
      }
      if let elementFrame = frame(element), let windowFrame {
        let center = CGPoint(x: elementFrame.midX, y: elementFrame.midY)
        if center.x < windowFrame.minX + (windowFrame.width * 0.35) {
          score += 5
        }
      }
      return (element: element, score: score, text: text)
    }
    .filter { $0.score > 0 }
    .sorted { left, right in
      if left.score != right.score {
        return left.score > right.score
      }
      return left.text.count < right.text.count
    }

  if !rankedCandidates.isEmpty {
    let preview = rankedCandidates.prefix(5).map { traceSnippet($0.text) }.joined(separator: " | ")
    trace("Chat-list row candidates for group info fallback: \(preview)")
  }

  return rankedCandidates.first?.element
}

func openGroupInfoFromChatListContextMenu(
  chatName: String,
  in window: AXUIElement,
  appElement: AXUIElement
) throws -> Bool {
  guard let chatRow = findChatListRow(chatName: chatName, in: window) else {
    trace("Could not find chat-list row for group info fallback.")
    return false
  }

  trace("Opening chat-list context menu for '\(chatName)' to find Group info.")
  guard perform(chatRow, "AXShowMenu") == .success else {
    trace("Chat-list row did not expose a context menu for group info fallback.")
    return false
  }
  wait(seconds: 0.25)

  do {
    try clickMenuItem(containing: ["Group info", "Group Info"], in: appElement)
  } catch {
    trace("Chat-list context menu did not provide Group info: \(error)")
    return false
  }

  wait(seconds: 0.8)
  guard let refreshedRoot = try? appWindow(appElement) else {
    return false
  }
  let opened = groupInfoSeemsOpen(chatName: chatName, in: refreshedRoot)
  trace("Group info via chat-list context menu \(opened ? "opened successfully" : "did not open").")
  return opened
}

func openGroupInfo(
  chatName: String,
  in window: AXUIElement,
  appElement: AXUIElement
) throws {
  // Opening group info is the most version-sensitive part of remove_sender.
  // Try the chat header first, then a coordinate click on the same header, then
  // the chat-list context menu's "Group info" item. The fallback order mirrors
  // the flows that worked in manual WhatsApp Desktop testing.
  guard let header = findGroupHeader(chatName: chatName, in: window) else {
    throw HookError.buttonNotFound(["Group header"])
  }

  trace("Opening group info for '\(chatName)'.")
  _ = perform(header, "AXPress")
  wait(seconds: 0.5)

  if let refreshedRoot = try? appWindow(appElement),
     groupInfoSeemsOpen(chatName: chatName, in: refreshedRoot) {
    trace("Group info opened from header via AXPress.")
    return
  }

  if let headerFrame = frame(header), isReasonableFrame(headerFrame) {
    trace("Header AXPress did not open group info; clicking the header center point.")
    clickPoint(CGPoint(x: headerFrame.midX, y: headerFrame.midY))
    wait(seconds: 0.6)
    if let refreshedRoot = try? appWindow(appElement),
       groupInfoSeemsOpen(chatName: chatName, in: refreshedRoot) {
      trace("Group info opened from header center click.")
      return
    }
  }

  trace("Header route did not open group info; trying chat-list context menu route.")
  if try openGroupInfoFromChatListContextMenu(
    chatName: chatName,
    in: window,
    appElement: appElement
  ) {
    return
  }

  throw HookError.buttonNotFound(["Group info"])
}

func normalizedTexts(
  in root: AXUIElement,
  roles allowedRoles: Set<String>,
  depth: Int = 2
) -> [String] {
  var elements: [AXUIElement] = []
  findAll(root, where: { allowedRoles.contains(role($0)) }, into: &elements)
  let texts = elements
    .map { normalized(descendantText($0, depth: depth)) }
    .filter { !$0.isEmpty }
  return Array(NSOrderedSet(array: texts)) as? [String] ?? texts
}

func previewList(_ values: [String], limit: Int = 12) -> String {
  let preview = values.prefix(limit).joined(separator: " | ")
  return preview.isEmpty ? "<none>" : preview
}

func logRemoveFlowDiagnostics(
  step: String,
  root: AXUIElement?,
  senderName: String
) {
  trace("Remove-flow failure step: \(step)")

  guard let root else {
    trace("Remove-flow diagnostics: no accessible WhatsApp root available.")
    return
  }

  trace("Remove-flow root: \(elementLabel(root))")

  let buttonTexts = normalizedTexts(in: root, roles: ["AXButton"], depth: 2)
  trace("Visible buttons during remove flow: \(previewList(buttonTexts))")

  let textValues = normalizedTexts(in: root, roles: ["AXHeading", "AXStaticText", "AXGroup"], depth: 3)
  trace("Visible texts during remove flow: \(previewList(textValues))")

  let normalizedSenderName = normalized(senderName)
  let senderRelated = textValues.filter {
    $0.contains(normalizedSenderName) || $0.contains("members") || $0.contains("more options") || $0.contains("remove")
  }
  trace("Sender/member-related texts during remove flow: \(previewList(senderRelated))")
}

func memberListSeemsVisible(
  senderName: String,
  in root: AXUIElement
) -> Bool {
  let normalizedSenderName = normalized(senderName)
  let texts = normalizedTexts(in: root, roles: ["AXButton", "AXStaticText", "AXGroup"], depth: 3)

  let hasSenderMemberRow = texts.contains {
    $0.contains(normalizedSenderName) &&
      ($0.contains("more options") || $0.contains("group admin") || tokenCount($0) <= 8)
  }
  let hasYou = texts.contains { $0 == "you" || $0.contains(" you ") || $0.hasSuffix(" you") || $0.hasPrefix("you ") }
  let hasMemberContext = texts.contains {
    isMembersScreenText($0) || $0.contains("more options") || $0.contains("group admin")
  }

  return hasSenderMemberRow && hasYou && hasMemberContext
}

func isPermissionScreenText(_ text: String) -> Bool {
  text.contains("members can") ||
    text.contains("admins can") ||
    text.contains("edit group settings") ||
    text.contains("send new messages") ||
    text.contains("add other members") ||
    text.contains("invite via link") ||
    text.contains("approve new members") ||
    text.contains("group permissions") ||
    text.contains("anyone in this group can invite new members")
}

func isMembersNavigationText(_ text: String) -> Bool {
  if isPermissionScreenText(text) {
    return false
  }
  if text == "members" {
    return true
  }
  if text.hasPrefix("members ") && tokenCount(text) <= 6 {
    return true
  }
  if text.contains(" members ") && tokenCount(text) <= 6 {
    return true
  }
  return false
}

func isMembersScreenText(_ text: String) -> Bool {
  if isPermissionScreenText(text) {
    return false
  }
  return text == "members" || text.hasPrefix("members ") || text.contains("group admins")
}

func openMembersPane(
  senderName: String,
  in root: AXUIElement,
  appElement: AXUIElement
) throws -> AXUIElement {
  // The group-info sidebar contains both "Members" and "Group permissions".
  // Permission screens also mention "members", so navigation filters reject
  // permission-related text before choosing a Members control.
  let buttonPreview = normalizedTexts(in: root, roles: ["AXButton"], depth: 2)
  trace(
    "Visible group-info buttons before opening Members: \(buttonPreview.prefix(12).joined(separator: " | "))"
  )

  let textPreview = normalizedTexts(in: root, roles: ["AXHeading", "AXStaticText", "AXGroup"], depth: 3)
  trace(
    "Visible group-info texts before opening Members: \(textPreview.prefix(12).joined(separator: " | "))"
  )

  if memberListSeemsVisible(senderName: senderName, in: root) {
    trace("Group info already appears to show the member list for '\(senderName)'; skipping Members navigation.")
    return root
  }

  var candidates: [AXUIElement] = []
  findAll(root, where: {
    let itemRole = role($0)
    guard itemRole == "AXButton" || itemRole == "AXStaticText" || itemRole == "AXGroup" else {
      return false
    }
    let text = normalized(descendantText($0, depth: 2))
    return isMembersNavigationText(text)
  }, into: &candidates)

  let rankedCandidates = candidates
    .map { element -> (element: AXUIElement, score: Int, text: String) in
      let text = normalized(descendantText(element, depth: 2))
      var score = 0
      if text == "members" {
        score += 10
      } else if text.hasPrefix("members ") && tokenCount(text) <= 6 {
        score += 7
      } else if text.contains(" members ") && tokenCount(text) <= 6 {
        score += 4
      }
      if role(element) == "AXButton" {
        score += 2
      }
      return (element: element, score: score, text: text)
    }
    .sorted { left, right in
      if left.score != right.score {
        return left.score > right.score
      }
      return left.text.count < right.text.count
    }

  if !rankedCandidates.isEmpty {
    let preview = rankedCandidates.prefix(6).map(\.text).joined(separator: " | ")
    trace("Members navigation candidates: \(preview)")
  }

  guard let membersControl = rankedCandidates.first?.element else {
    throw HookError.buttonNotFound(["Members"])
  }

  trace("Opening Members pane.")
  pressElementWithFallback(membersControl, label: "Members button")
  wait(seconds: 0.8)

  let refreshedRoot = try appWindow(appElement)
  let refreshedTextPreview = normalizedTexts(in: refreshedRoot, roles: ["AXHeading", "AXStaticText", "AXGroup"], depth: 3)
  trace(
    "Visible texts after opening Members: \(refreshedTextPreview.prefix(12).joined(separator: " | "))"
  )
  return refreshedRoot
}

func logVisibleMemberEntries(in root: AXUIElement) {
  var elements: [AXUIElement] = []
  findAll(root, where: {
    let itemRole = role($0)
    return itemRole == "AXButton" || itemRole == "AXStaticText" || itemRole == "AXGroup"
  }, into: &elements)

  let normalizedEntries = elements
    .compactMap { element -> String? in
      let text = normalized(descendantText(element, depth: 3))
      guard !text.isEmpty else {
        return nil
      }
      if text.contains("add members") || text.contains("invite via link") || text.contains("search") {
        return nil
      }
      if text.contains("admin") || text.contains("more options") || tokenCount(text) <= 6 {
        return text
      }
      return nil
    }

  let entries = Array(NSOrderedSet(array: normalizedEntries)) as? [String] ?? normalizedEntries
  if !entries.isEmpty {
    trace("Visible group members: \(entries.prefix(10).joined(separator: " | "))")
  } else {
    trace("Visible group members: <none>")
  }
}

func moreOptionsButtonForMember(
  named senderName: String,
  in root: AXUIElement
) -> AXUIElement? {
  let normalizedSenderName = normalized(senderName)
  var groups: [AXUIElement] = []
  findAll(root, where: { role($0) == "AXGroup" }, into: &groups)

  let rankedGroups = groups
    .map { group -> (group: AXUIElement, text: String, score: Int) in
      let text = normalized(descendantText(group, depth: 3))
      var score = 0
      if text.contains(normalizedSenderName) {
        score += 5
      }
      if text.contains("more options") {
        score += 3
      }
      return (group: group, text: text, score: score)
    }
    .filter { $0.score > 0 }
    .sorted { left, right in
      if left.score != right.score {
        return left.score > right.score
      }
      return left.text.count < right.text.count
    }

  for match in rankedGroups {
    if let button = children(match.group).first(where: {
      role($0) == "AXButton" && normalized(descendantText($0, depth: 2)).contains("more options")
    }) {
      return button
    }
  }

  return nil
}

func openMemberOptionsMenu(
  senderName: String,
  in root: AXUIElement
) throws {
  let normalizedSenderName = normalized(senderName)
  var memberRows: [AXUIElement] = []
  findAll(root, where: { role($0) == "AXGroup" || role($0) == "AXButton" }, into: &memberRows)
  let memberPreview = memberRows
    .map { normalized(descendantText($0, depth: 3)) }
    .filter { $0.contains(normalizedSenderName) || $0.contains("more options") }
  if !memberPreview.isEmpty {
    trace("Candidate member rows for '\(senderName)': \(memberPreview.prefix(6).joined(separator: " | "))")
  }

  guard let moreOptionsButton = moreOptionsButtonForMember(named: senderName, in: root) else {
    throw HookError.buttonNotFound(["More options"])
  }

  trace("Opening member options for '\(senderName)'.")
  pressElementWithFallback(moreOptionsButton, label: "Member more-options button")
  wait(seconds: 0.4)
}

func messageMatchScore(description: String, decision: ModerationDecision) -> Int {
  let normalizedDescription = normalized(description)
  let normalizedText = normalized(decision.text)
  let snippet = String(normalizedText.prefix(80))
  var score = 0

  if !decision.senderName.isEmpty,
     normalized(decision.senderName) != "you",
     normalizedDescription.contains("your message") {
    return -1_000
  }

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
  if !decision.senderName.isEmpty,
     normalizedDescription.contains("message from"),
     normalizedDescription.contains(normalized(decision.senderName)) {
    score += 5
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
  logButtonOptions(in: root, context: "confirmation search")

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

func clickDoneIfVisible(appElement: AXUIElement, chatName: String) {
  guard let root = try? appWindow(appElement) else {
    trace("Could not read WhatsApp UI while trying to close group info.")
    return
  }

  var buttons: [AXUIElement] = []
  findAll(root, where: { role($0) == "AXButton" }, into: &buttons)

  let rankedButtons = buttons
    .map { element in
      let haystack = descendantText(element, depth: 2)
      return (
        element: element,
        score: actionLabelMatchScore(haystack: haystack, labels: ["Done"]) ?? -1,
        haystack: haystack
      )
    }
    .filter { $0.score >= 0 }
    .sorted { left, right in
      if left.score != right.score {
        return left.score > right.score
      }
      return left.haystack.count < right.haystack.count
    }

  guard let doneButton = rankedButtons.first?.element else {
    trace("No Done button was visible after remove_sender; leaving WhatsApp on the current screen.")
    return
  }

  trace("Clicking Done to return from group info to the main chat screen.")
  pressElementWithFallback(doneButton, label: "Done button")
  wait(seconds: 0.5)

  guard let refreshedRoot = try? appWindow(appElement) else {
    trace("Could not verify WhatsApp screen after clicking Done.")
    return
  }

  if groupInfoSeemsOpen(chatName: chatName, in: refreshedRoot) {
    trace("Done was clicked, but group info still appears to be open.")
  } else {
    trace("Returned to the main chat screen after remove_sender.")
  }
}

func containsButton(
  matching labels: [String],
  in root: AXUIElement
) -> Bool {
  let normalizedLabels = labels.map(normalized)
  var buttons: [AXUIElement] = []
  findAll(root, where: { role($0) == "AXButton" }, into: &buttons)
  return buttons.contains { element in
    let haystack = descendantText(element, depth: 2)
    return actionLabelMatchScore(haystack: haystack, labels: normalizedLabels) != nil
  }
}

func normalizedButtonOptions(in root: AXUIElement) -> [String] {
  var buttons: [AXUIElement] = []
  findAll(root, where: { role($0) == "AXButton" }, into: &buttons)
  let options = buttons
    .map { normalized(descendantText($0, depth: 2)) }
    .filter { !$0.isEmpty }
  return Array(NSOrderedSet(array: options)) as? [String] ?? options
}

func logButtonOptions(
  in root: AXUIElement,
  context: String
) {
  let options = normalizedButtonOptions(in: root)
  let preview = options.prefix(12).joined(separator: " | ")
  if preview.isEmpty {
    trace("Visible button options in \(context): <none>")
  } else {
    trace("Visible button options in \(context): \(preview)")
  }
}

func activeMenu(in root: AXUIElement) -> ActiveMenu? {
  // macOS can expose unrelated menus from other apps or Finder while WhatsApp is
  // focused. Rank menus by visible on-screen items, then callers verify the menu
  // looks like a WhatsApp message/member menu before choosing destructive items.
  var menus: [AXUIElement] = []
  findAll(root, where: { role($0) == "AXMenu" }, into: &menus)

  let rankedMenus = menus
    .map { menu -> (menu: AXUIElement, visibleItemCount: Int, itemCount: Int, area: CGFloat) in
      let menuChildren = children(menu).filter { role($0) == "AXMenuItem" }
      let itemCount = menuChildren.count
      let visibleItemCount = menuChildren.filter { isReasonableFrame(frame($0)) && isOnScreen(frame($0)) }.count
      let area: CGFloat
      if let menuFrame = frame(menu) {
        area = menuFrame.width * menuFrame.height
      } else {
        area = 0
      }
      return (menu: menu, visibleItemCount: visibleItemCount, itemCount: itemCount, area: area)
    }
    .filter { $0.itemCount > 0 }
    .sorted { left, right in
      if left.visibleItemCount != right.visibleItemCount {
        return left.visibleItemCount > right.visibleItemCount
      }
      if left.itemCount != right.itemCount {
        return left.itemCount > right.itemCount
      }
      return left.area > right.area
    }

  if let activeMenu = rankedMenus.first?.menu {
    let directItems = children(activeMenu).filter { role($0) == "AXMenuItem" }
    let visibleDirectItems = directItems.filter { isReasonableFrame(frame($0)) && isOnScreen(frame($0)) }
    return (menu: activeMenu, items: visibleDirectItems.isEmpty ? directItems : visibleDirectItems)
  }
  return nil
}

func findMenuItems(in root: AXUIElement) -> [AXUIElement] {
  activeMenu(in: root)?.items ?? []
}

func normalizedMenuOptions(_ menuItems: [AXUIElement]) -> [String] {
  let options = menuItems
    .map { normalized(descendantText($0, depth: 2)) }
    .filter { !$0.isEmpty }

  return Array(NSOrderedSet(array: options)) as? [String] ?? options
}

func logMenuOptions(_ menuItems: [AXUIElement], context: String = "context menu") {
  let uniqueOptions = normalizedMenuOptions(menuItems)
  let preview = uniqueOptions.prefix(12).joined(separator: " | ")
  if preview.isEmpty {
    trace("Visible \(context) options: <none>")
  } else {
    trace("Visible \(context) options: \(preview)")
  }
}

func looksLikeWhatsAppMessageMenu(_ options: [String]) -> Bool {
  let expected = Set([
    "reply",
    "react",
    "keep",
    "pin",
    "forward",
    "copy",
    "reply privately",
    "report",
    "delete",
    "select messages"
  ])

  let overlap = options.filter { option in
    expected.contains(option) || option.hasPrefix("message ")
  }.count
  return overlap >= 4
}

func estimatedMenuItemClickPoint(
  menu: AXUIElement,
  items: [AXUIElement],
  target: AXUIElement
) -> CGPoint? {
  guard let menuFrame = frame(menu), isReasonableFrame(menuFrame) else {
    return nil
  }

  guard let index = items.firstIndex(where: { CFEqual($0, target) }) else {
    return nil
  }

  let rowHeight = menuFrame.height / CGFloat(max(items.count, 1))
  guard rowHeight >= 8 else {
    return nil
  }

  return CGPoint(
    x: menuFrame.midX,
    y: menuFrame.minY + rowHeight * (CGFloat(index) + 0.5)
  )
}

func activateMenuItemByKeyboard(
  target: AXUIElement,
  menuItems: [AXUIElement]
) {
  guard let index = menuItems.firstIndex(where: { CFEqual($0, target) }) else {
    return
  }

  trace("Direct menu-item activation was unavailable; using keyboard navigation to choose menu item \(index + 1).")
  sendKeyCodes(Array(repeating: 125, count: index)) // Down arrow
  sendKeyCode(36) // Return
}

func clickMenuItem(
  containing labels: [String],
  in root: AXUIElement,
  decision: ModerationDecision? = nil,
  consequentialLabel: String? = nil
) throws {
  let normalizedLabels = labels.map(normalized)
  let activeMenuContext = activeMenu(in: root)
  let menuItems = activeMenuContext?.items ?? []
  trace("Found \(menuItems.count) menu item candidate(s) while looking for: \(labels.joined(separator: ", ")).")
  logMenuOptions(menuItems)

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

func isSelectedMessageMode(in root: AXUIElement) -> Bool {
  var elements: [AXUIElement] = []
  findAll(root, where: {
    let itemRole = role($0)
    return itemRole == "AXButton" || itemRole == "AXStaticText" || itemRole == "AXGroup"
  }, into: &elements)

  let normalizedTexts = elements
    .map { normalized(descendantText($0, depth: 2)) }
    .filter { !$0.isEmpty }

  let hasCancel = normalizedTexts.contains("cancel")
  let hasSelectedCounter = normalizedTexts.contains(where: { text in
    text.hasSuffix(" selected") && tokenCount(text) <= 3
  })

  return hasCancel && hasSelectedCounter
}

func selectedMessageFooterFrame(in root: AXUIElement) -> CGRect? {
  var groups: [AXUIElement] = []
  findAll(root, where: { role($0) == "AXGroup" }, into: &groups)

  let rankedGroups = groups
    .compactMap { element -> (frame: CGRect, text: String)? in
      guard let elementFrame = frame(element), isReasonableFrame(elementFrame) else {
        return nil
      }
      let text = normalized(descendantText(element, depth: 2))
      guard text.contains("selected"), text.contains("cancel") else {
        return nil
      }
      return (frame: elementFrame, text: text)
    }
    .sorted { left, right in
      if left.frame.maxY != right.frame.maxY {
        return left.frame.maxY > right.frame.maxY
      }
      return left.frame.width > right.frame.width
    }

  return rankedGroups.first?.frame
}

func footerTexts(in root: AXUIElement, footerFrame: CGRect) -> [String] {
  var elements: [AXUIElement] = []
  findAll(root, where: {
    let itemRole = role($0)
    return itemRole == "AXButton" || itemRole == "AXStaticText" || itemRole == "AXGroup"
  }, into: &elements)

  let candidateTexts = elements.compactMap { element -> (text: String, priority: Int)? in
    guard let elementFrame = frame(element), isReasonableFrame(elementFrame) else {
      return nil
    }

    let center = CGPoint(x: elementFrame.midX, y: elementFrame.midY)
    guard footerFrame.contains(center) else {
      return nil
    }

    let text = normalized(descendantText(element, depth: 2))
    guard !text.isEmpty else {
      return nil
    }

    let isActionBarText =
      text == "delete" ||
      text == "cancel" ||
      text == "1 selected" ||
      text == "selected" ||
      text.contains(" selected") ||
      text.contains("delete") ||
      text.contains("cancel")

    let priority: Int
    if text == "delete" || text == "cancel" || text == "1 selected" {
      priority = 3
    } else if tokenCount(text) <= 4 && isActionBarText {
      priority = 2
    } else if isActionBarText {
      priority = 1
    } else {
      priority = 0
    }

    return (text: text, priority: priority)
  }

  let filtered = candidateTexts.filter { $0.priority > 0 }
  let sorted = filtered.sorted { left, right in
    if left.priority != right.priority {
      return left.priority > right.priority
    }
    if tokenCount(left.text) != tokenCount(right.text) {
      return tokenCount(left.text) < tokenCount(right.text)
    }
    return left.text.count < right.text.count
  }

  let texts = sorted.map(\.text)
  return Array(NSOrderedSet(array: texts)) as? [String] ?? texts
}

func clickDeleteMenuItemAndEnsureSelectionMode(
  in appElement: AXUIElement,
  decision: ModerationDecision
) throws {
  // Selecting "Delete" from a message menu should enter WhatsApp's selected-
  // message mode, not delete anything yet. Verify that state transition before
  // moving to the action bar/trash step.
  let labels = ["Delete", "Delete Message"]
  let normalizedLabels = labels.map(normalized)
  let activeMenuContext = activeMenu(in: appElement)
  let menuItems = activeMenuContext?.items ?? []
  trace("Found \(menuItems.count) menu item candidate(s) while looking for: \(labels.joined(separator: ", ")).")
  logMenuOptions(menuItems)
  let menuOptions = normalizedMenuOptions(menuItems)
  guard looksLikeWhatsAppMessageMenu(menuOptions) else {
    throw HookError.menuNotAvailable
  }

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

  captureActionScreenshot(stage: "before", consequentialLabel: "delete-from-context-menu", decision: decision)
  trace("Attempting to activate context menu item: \(traceSnippet(descendantText(match.element, depth: 2))).")

  _ = perform(match.element, "AXPress")
  wait(seconds: 0.4)

  if let window = try? appWindow(appElement), isSelectedMessageMode(in: window) {
    trace("Delete context-menu action entered selected-message mode via AXPress.")
    captureActionScreenshot(stage: "after", consequentialLabel: "delete-from-context-menu", decision: decision)
    return
  }

  let directClickPoint =
    isReasonableFrame(frame(match.element))
      ? CGPoint(x: frame(match.element)!.midX, y: frame(match.element)!.midY)
      : activeMenuContext.flatMap { estimatedMenuItemClickPoint(menu: $0.menu, items: $0.items, target: match.element) }

  if let directClickPoint {
    trace("AXPress did not change the UI; clicking the matched menu item directly.")
    clickPoint(directClickPoint)
    wait(seconds: 0.4)

    if let window = try? appWindow(appElement), isSelectedMessageMode(in: window) {
      trace("Delete context-menu action entered selected-message mode after direct click.")
      captureActionScreenshot(stage: "after", consequentialLabel: "delete-from-context-menu", decision: decision)
      return
    }
  } else {
    trace("Matched menu item frame was not usable for a direct-click fallback.")
  }

  activateMenuItemByKeyboard(target: match.element, menuItems: menuItems)
  wait(seconds: 0.4)

  if let window = try? appWindow(appElement), isSelectedMessageMode(in: window) {
    trace("Delete context-menu action entered selected-message mode after keyboard fallback.")
    captureActionScreenshot(stage: "after", consequentialLabel: "delete-from-context-menu", decision: decision)
    return
  }

  captureActionScreenshot(stage: "after", consequentialLabel: "delete-from-context-menu", decision: decision)
  throw HookError.menuItemDidNotActivate(labels)
}

func clickSelectedMessageToolbarDelete(
  in root: AXUIElement,
  appElement: AXUIElement,
  decision: ModerationDecision
) throws {
  // WhatsApp sometimes exposes a labeled "Delete" accessibility element in the
  // action bar that does not actually press the visual trash icon. Try the label
  // first for semantics, then fall back to the visual bottom-center trash control
  // and prove success by detecting the delete confirmation sheet.
  var elements: [AXUIElement] = []
  findAll(root, where: {
    let itemRole = role($0)
    return itemRole == "AXButton" || itemRole == "AXStaticText" || itemRole == "AXGroup"
  }, into: &elements)
  trace("Found \(elements.count) candidate(s) while looking for the selected-message delete toolbar action.")

  let rootFrame = frame(root)
  let footerFrame = selectedMessageFooterFrame(in: root)
  if let footerFrame {
    trace(
      "Selected-message footer frame: x=\(Int(footerFrame.minX)) y=\(Int(footerFrame.minY)) w=\(Int(footerFrame.width)) h=\(Int(footerFrame.height))."
    )
    let visibleFooterTexts = footerTexts(in: root, footerFrame: footerFrame)
    if !visibleFooterTexts.isEmpty {
      trace("Visible selected-message action bar options: \(visibleFooterTexts.prefix(10).joined(separator: " | "))")
    }
  } else {
    trace("Selected-message footer frame was not discoverable.")
  }

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

  func confirmationOpened() -> Bool {
    guard let window = try? appWindow(appElement) else {
      return false
    }
    logButtonOptions(in: window, context: "post delete-toolbar click")
    return containsButton(
      matching: ["Delete for everyone", "Delete for Everyone", "Delete for me"],
      in: window
    )
  }

  func logPostDeleteToolbarState(prefix: String) {
    guard let window = try? appWindow(appElement) else {
      trace("\(prefix): could not read WhatsApp window state after click.")
      return
    }

    if confirmationOpened() {
      trace("\(prefix): confirmation dialog detected.")
      return
    }

    let selectedMode = isSelectedMessageMode(in: window)
    let footerVisible = selectedMessageFooterFrame(in: window) != nil
    trace(
      "\(prefix): no confirmation dialog detected; selected-message mode=\(selectedMode ? "yes" : "no"), footer toolbar visible=\(footerVisible ? "yes" : "no")."
    )
  }

  captureActionScreenshot(stage: "before", consequentialLabel: "delete-toolbar", decision: decision)
  var openedConfirmation = false
  if let match = rankedButtons.first {
    trace("Clicking selected-message delete toolbar button: \(traceSnippet(descendantText(match.element, depth: 2))).")
    let pressResult = perform(match.element, "AXPress")
    if pressResult != .success, let matchFrame = frame(match.element) {
      trace("Toolbar delete element was not directly pressable; clicking its center point instead.")
      clickPoint(CGPoint(x: matchFrame.midX, y: matchFrame.midY))
    }
    wait(seconds: 0.35)
    openedConfirmation = confirmationOpened()
    logPostDeleteToolbarState(prefix: "Post labeled footer-delete click state")
    if !openedConfirmation {
      trace("Labeled footer delete control did not open a confirmation dialog; falling back to the bottom-center trash control.")
    }
  } else if rootFrame != nil {
    trace("Footer delete button was not labeled accessibly; clicking the bottom-center delete control instead.")
  } else {
    throw HookError.buttonNotFound(["Delete"])
  }

  if !openedConfirmation, let footerFrame {
    let fallbackPoint = CGPoint(
      x: footerFrame.midX,
      y: footerFrame.midY
    )
    trace("Clicking the center of the selected-message footer toolbar as a trash-icon fallback.")
    clickPoint(fallbackPoint)
    wait(seconds: 0.4)
    openedConfirmation = confirmationOpened()
    logPostDeleteToolbarState(prefix: "Post footer-toolbar-center click state")
  } else if !openedConfirmation, let rootFrame {
    let fallbackPoint = CGPoint(
      x: rootFrame.midX,
      y: rootFrame.maxY - max(28, rootFrame.height * 0.035)
    )
    trace("Footer toolbar frame was not discoverable; clicking the bottom-center delete control instead.")
    clickPoint(fallbackPoint)
    wait(seconds: 0.4)
    openedConfirmation = confirmationOpened()
    logPostDeleteToolbarState(prefix: "Post bottom-center click state")
  }

  captureActionScreenshot(stage: "after", consequentialLabel: "delete-toolbar", decision: decision)
  if !openedConfirmation {
    throw HookError.buttonNotFound(["Delete for everyone", "Delete for Everyone"])
  }
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
  // End-to-end UI sequence:
  // message context menu -> Delete -> selected-message action bar trash ->
  // Delete for everyone -> final admin Delete confirmation.
  let window = try openChat(named: decision.chatName, appElement: appElement)
  let message = try findMessage(decision, in: window)
  guard perform(message, "AXShowMenu") == .success else {
    throw HookError.menuNotAvailable
  }
  trace("Opened context menu for the matched message.")
  wait(seconds: 0.3)
  do {
    try clickDeleteMenuItemAndEnsureSelectionMode(in: appElement, decision: decision)
  } catch HookError.menuItemDidNotActivate {
    trace("Delete menu selection may still have worked; attempting the footer delete step anyway.")
  }
  let refreshedWindow = try appWindow(appElement)
  try clickSelectedMessageToolbarDelete(in: refreshedWindow, appElement: appElement, decision: decision)
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
  // End-to-end UI sequence:
  // chat header/group info -> Members -> sender More options ->
  // Remove from group -> Remove confirmation -> Done.
  // Do not fall back to right-clicking the spam message here; delete_message may
  // have already removed that message, so member removal must target group info.
  var currentStep = "open chat"
  let window = try openChat(named: decision.chatName, appElement: appElement)
  do {
    currentStep = "open group info from header"
    try openGroupInfo(chatName: decision.chatName, in: window, appElement: appElement)

    currentStep = "read group info root"
    let groupInfoWindow = try appWindow(appElement)

    currentStep = "open members pane or detect visible member list"
    let membersWindow = try openMembersPane(
      senderName: decision.senderName,
      in: groupInfoWindow,
      appElement: appElement
    )

    currentStep = "inspect visible member entries"
    logVisibleMemberEntries(in: membersWindow)

    currentStep = "open member options menu"
    try openMemberOptionsMenu(senderName: decision.senderName, in: membersWindow)
    trace("Opened member options menu for '\(decision.senderName)'.")

    currentStep = "inspect member options menu"
    let memberMenuItems = findMenuItems(in: appElement)
    trace("Found \(memberMenuItems.count) member-options menu item candidate(s) while looking for remove action.")
    logMenuOptions(memberMenuItems, context: "member menu for '\(decision.senderName)'")

    currentStep = "choose remove-from-group action"
    try chooseMenuItem(
      searchText: "remove",
      menuLabels: ["Remove from group", "Remove participant", "Remove", "Remove from community"],
      confirmLabels: ["Remove"],
      appElement: appElement,
      decision: decision,
      consequentialLabel: "remove-sender",
      requireConfirmation: true
    )
    wait(seconds: 0.5)

    currentStep = "close group info"
    clickDoneIfVisible(appElement: appElement, chatName: decision.chatName)
  } catch {
    let diagnosticRoot = try? appWindow(appElement)
    logRemoveFlowDiagnostics(
      step: currentStep,
      root: diagnosticRoot,
      senderName: decision.senderName
    )
    throw error
  }
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
