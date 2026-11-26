import Foundation

func local(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ minute: Int = 0) -> Date {
  deadlineCalendar.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: minute))!
}
func check(_ from: Date, _ until: Date, _ expected: String) {
  precondition(remainingDays(until: until.timeIntervalSince1970, at: from) == expected)
}
check(local(2026, 11, 26, 12), local(2026, 12, 3, 23, 59), "בעוד 7 ימים")
check(local(2026, 11, 26, 12), local(2026, 12, 7, 18, 30), "בעוד 11 ימים")
check(local(2026, 12, 2, 23, 59), local(2026, 12, 3, 0, 1), "מחר")
check(local(2026, 12, 3, 0), local(2026, 12, 3, 23, 59), "היום")
check(local(2026, 3, 26, 23, 59), local(2026, 3, 28, 0), "בעוד יומיים")
check(local(2026, 10, 24, 0), local(2026, 10, 26, 23, 59), "בעוד יומיים")
print("6 calendar checks passed")
