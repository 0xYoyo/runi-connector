# macOS course widget

Add **Reichman Courses** from the Mac's **Edit Widgets** gallery. The small size shows the next Moodle assignment. The medium size shows up to two and can include a short excerpt from a related Piazza post. Each deadline shows the Israel-local date, time and days remaining. Clicking an assignment opens Moodle. A question on Piazza is never displayed as an instruction. The connector currently reads post bodies, so a clarification posted only in a reply can be missed.

## Install from a checkout

On macOS 14 or later, install the Xcode Command Line Tools with a macOS 14+ SDK. The build uses Swift, Python 3.9+ and the Node executable on your PATH. Install the desktop connector using the Codex installation instructions in the main README and sign in to Reichman once. Piazza is optional.

From the repository root, run:

```sh
python3 macos-widget/build.py --install
```

The installer builds and signs the app locally for your Mac, copies it to `~/Applications/Reichman Courses.app`, opens it once and registers a per-user refresh task. Right-click the desktop, select **Edit Widgets**, search for **Reichman Courses** and choose a size. Rerun the same command to update the widget or point it at a new Node installation. To compile and verify the app without installing it, omit `--install`.

## Data and refresh

The companion app calls the installed local connector over standard input/output. The widget extension reads a snapshot in `~/Library/Caches/il.runi.studentdesk/`. The snapshot contains assignment titles, course names, dates, links and optional Piazza excerpts. Credentials stay with the connector. macOS refreshes on its own schedule. The per-user job checks every 30 minutes and fetches data only while a widget is placed. Open the app for a manual refresh. The last successful fetch time is shown on the widget; during an outage it can display older data.

## Remove

Remove the widget using its macOS context menu. To uninstall the companion app and delete its local data, run:

```sh
launchctl bootout "gui/$(id -u)/local.reichman.widget-refresh"
rm -f "$HOME/Library/LaunchAgents/local.reichman.widget-refresh.plist"
rm -rf "$HOME/Applications/Reichman Courses.app" "$HOME/Library/Caches/il.runi.studentdesk"
```

The Windows and Linux connector installs use the existing instructions in the main README. All widget build and installation steps are opt-in.
