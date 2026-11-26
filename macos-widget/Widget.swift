import SwiftUI
import WidgetKit

struct Entry: TimelineEntry {
  let date: Date
  let summary: Summary?
}
struct Provider: TimelineProvider {
  func placeholder(in context: Context) -> Entry { Entry(date: Date(), summary: .example) }
  func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
    completion(Entry(date: Date(), summary: context.isPreview ? .example : Summary.read()))
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
    let now = Date()
    let summary = Summary.read()
    let next = now.addingTimeInterval(1800)
    // Schedule day changes ahead of the requested refresh in case WidgetKit defers it.
    let midnight = deadlineCalendar.dateInterval(of: .day, for: now)!.end
    let followingMidnight = deadlineCalendar.dateInterval(of: .day, for: midnight)!.end
    let deadlines = (summary?.tasks ?? []).compactMap(\.due)
      .map { Date(timeIntervalSince1970: $0) }
      .filter { $0 > now && $0 <= followingMidnight }
    let dates = Set([now, midnight, followingMidnight] + deadlines)
    let entries = dates.sorted().map { Entry(date: $0, summary: summary) }
    completion(Timeline(entries: entries, policy: .after(next)))
  }
}
struct Face: View {
  let entry: Entry
  @Environment(\.widgetFamily) var family
  var items: [TaskItem] {
    (entry.summary?.tasks ?? []).filter { ($0.due ?? .infinity) > entry.date.timeIntervalSince1970 }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Label("הגשות קרובות", systemImage: "calendar").font(.system(size: 15, weight: .semibold))
      if entry.summary == nil {
        Text("פתח את Reichman Courses כדי לעדכן את הנתונים.").font(.caption)
      } else if items.isEmpty {
        Text("אין הגשות קרובות").font(.subheadline)
      } else if family == .systemSmall, let first = items.first {
        Spacer(minLength: 1)
        Text(verbatim: first.title).font(.system(size: 16, weight: .semibold)).lineLimit(2)
        Text(verbatim: first.course).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(
          2)
        deadline(first.due, alignment: .leading)
      } else {
        ForEach(Array(items.prefix(2).enumerated()), id: \.offset) { _, item in
          if let link = item.destination {
            Link(destination: link) { row(item) }
          } else {
            row(item)
          }
        }
        let matches = entry.summary?.posts?.filter { update in
          !update.question
            && items.contains { $0.title == update.task && $0.course == update.course }
        }
        if let note = matches?.first(where: { $0.important }) ?? matches?.first {
          Divider()
          Text(verbatim: "Piazza · " + note.task + " · " + note.text).font(.system(size: 11))
            .lineLimit(2)
        }
      }
      Spacer(minLength: 0)
      if let summary = entry.summary {
        Text(verbatim: "עודכן " + formatted(summary.updated, "dd.MM · HH:mm")).font(
          .system(size: 10)
        ).foregroundStyle(.secondary)
      }
    }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .environment(\.layoutDirection, .rightToLeft)
      .widgetURL(family == .systemSmall ? items.first?.destination : nil)
      .containerBackground(.fill.tertiary, for: .widget)
  }
  @ViewBuilder
  func deadline(_ due: Double?, alignment: HorizontalAlignment) -> some View {
    if let due {
      VStack(alignment: alignment, spacing: 1) {
        Text(verbatim: remainingDays(until: due, at: entry.date))
          .font(.system(size: 14, weight: .bold)).lineLimit(1)
        Text(verbatim: formatted(due, "dd.MM · HH:mm"))
          .font(.system(size: 12, weight: .medium)).monospacedDigit().lineLimit(1)
      }.layoutPriority(1)
    } else {
      Text("ללא מועד").font(.system(size: 12))
    }
  }
  func row(_ item: TaskItem) -> some View {
    HStack {
      VStack(alignment: .leading, spacing: 0) {
        Text(verbatim: item.title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
        Text(verbatim: item.course).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(
          1)
      }
      Spacer(minLength: 3)
      deadline(item.due, alignment: .trailing).fixedSize(horizontal: true, vertical: false)
    }
  }
}
@main
struct CourseWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: widgetKind, provider: Provider()) { Face(entry: $0) }
      .configurationDisplayName("Reichman Courses")
      .description("מטלות ברייכמן, מועדי הגשה והימים שנותרו.")
      .supportedFamilies([.systemSmall, .systemMedium])
  }
}
