import Foundation

let widgetKind = "ReichmanCourseDeadlines"
struct TaskItem: Codable, Hashable {
  let title, course, url: String
  let due: Double?
  let draft: Bool
  var destination: URL? {
    guard let u = URL(string: url), u.scheme == "https", u.host == "moodle.runi.ac.il" else {
      return nil
    }
    return u
  }
}
struct Update: Codable {
  let course, task, text: String
  let question, important: Bool
}
struct Summary: Codable {
  let updated: Double
  let tasks: [TaskItem]
  let posts: [Update]?
  static var file: URL {
    let dir = getpwuid(getuid()).map { String(cString: $0.pointee.pw_dir) } ?? NSHomeDirectory()
    return URL(fileURLWithPath: dir).appendingPathComponent(
      "Library/Caches/il.runi.studentdesk/latest.json")
  }
  static func read() -> Summary? {
    guard let data = try? Data(contentsOf: file) else { return nil }
    return try? JSONDecoder().decode(Self.self, from: data)
  }
  static var example: Summary {
    let now = Date().timeIntervalSince1970
    return Summary(
      updated: now,
      tasks: [
        TaskItem(title: "תרגיל 2", course: "למידה עמוקה", url: "", due: now + 86400, draft: false),
        TaskItem(
          title: "עבודה 3", course: "ניתוח סטטיסטי", url: "", due: now + 259200, draft: false),
      ], posts: [])
  }
}
let deadlineCalendar: Calendar = {
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone(identifier: "Asia/Jerusalem")!
  return calendar
}()

func remainingDays(until deadline: Double, at reference: Date) -> String {
  let start = deadlineCalendar.startOfDay(for: reference)
  let end = deadlineCalendar.startOfDay(for: Date(timeIntervalSince1970: deadline))
  let days = deadlineCalendar.dateComponents([.day], from: start, to: end).day!
  switch days {
  case 0: return "היום"
  case 1: return "מחר"
  case 2: return "בעוד יומיים"
  default: return "בעוד \(days) ימים"
  }
}
func formatted(_ epoch: Double, _ pattern: String) -> String {
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "he_IL")
  formatter.timeZone = TimeZone(identifier: "Asia/Jerusalem")
  formatter.dateFormat = pattern
  return formatter.string(from: Date(timeIntervalSince1970: epoch))
}
