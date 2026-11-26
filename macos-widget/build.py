"""Build a local WidgetKit app. Pass --install to enable it for this macOS user."""

import argparse
import os
import platform
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

SOURCE = Path(__file__).resolve().parent
BUILD = SOURCE.parent / "dist" / "macos-widget"
APP_NAME = "Reichman Courses.app"
HOST_ID = "local.reichman.studentdesk"
AGENT = "local.reichman.widget-refresh"
# Independent of the npm/MCPB release version.
VERSION = "2.3"
BUILD_NUMBER = "5"


def run(*args):
    subprocess.run(list(map(str, args)), check=True)


def plist(path, values):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as file:
        plistlib.dump(values, file)


def compile_target(bundle, executable, identifier, extension=False):
    contents = bundle / "Contents"
    binaries = contents / "MacOS"
    binaries.mkdir(parents=True, exist_ok=True)
    info = dict(
        CFBundleIdentifier=identifier,
        CFBundleExecutable=executable,
        CFBundleName="Reichman Courses",
        CFBundleDisplayName="Reichman Courses",
        CFBundleVersion=BUILD_NUMBER,
        CFBundleShortVersionString=VERSION,
        CFBundleDevelopmentRegion="en",
        CFBundleSupportedPlatforms=["MacOSX"],
        LSMinimumSystemVersion="14.0",
    )
    compiler = [
        "xcrun",
        "swiftc",
        "-target",
        platform.machine() + "-apple-macos14.0",
        "-parse-as-library",
        "-module-cache-path",
        BUILD / "module-cache",
    ]
    if extension:
        info.update(
            CFBundlePackageType="XPC!",
            NSExtension={"NSExtensionPointIdentifier": "com.apple.widgetkit-extension"},
        )
        # WidgetKit launches through Foundation's extension entry point on macOS.
        compiler.extend(
            ["-application-extension", "-Xlinker", "-e", "-Xlinker", "_NSExtensionMain"]
        )
    else:
        info.update(CFBundlePackageType="APPL", LSUIElement=True)
    plist(contents / "Info.plist", info)
    run(
        *compiler,
        SOURCE / "Shared.swift",
        SOURCE / ("Widget.swift" if extension else "Host.swift"),
        "-o",
        binaries / executable,
    )


def build(node):
    app = BUILD / APP_NAME
    widget = app / "Contents/PlugIns/CoursesWidget.appex"
    compile_target(app, "Courses", HOST_ID)
    compile_target(widget, "CoursesWidget", HOST_ID + ".widget", extension=True)
    resources = app / "Contents/Resources"
    resources.mkdir(exist_ok=True)
    shutil.copyfile(SOURCE / "refresh.py", resources / "refresh.py")
    # GUI processes have a limited PATH, particularly with nvm or Homebrew.
    (resources / "node-path").write_text(node, encoding="utf8")
    entitlements = BUILD / "widget.entitlements"
    plist(
        entitlements,
        {
            "com.apple.security.app-sandbox": True,
            "com.apple.security.temporary-exception.files.home-relative-path.read-only": [
                "/Library/Caches/il.runi.studentdesk/"
            ],
        },
    )
    run("codesign", "--force", "--sign", "-", "--entitlements", entitlements, widget)
    run("codesign", "--force", "--sign", "-", app)
    run("codesign", "--verify", "--deep", "--strict", app)
    return app


def install(app):
    target = Path.home() / "Applications" / APP_NAME
    if target.exists():
        with (target / "Contents/Info.plist").open("rb") as f:
            if plistlib.load(f).get("CFBundleIdentifier") != HOST_ID:
                raise SystemExit(f"Another application already exists at {target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    run("ditto", app, target)
    agent_file = Path.home() / "Library/LaunchAgents" / (AGENT + ".plist")
    plist(
        agent_file,
        dict(
            Label=AGENT,
            RunAtLoad=True,
            StartInterval=1800,
            LimitLoadToSessionType="Aqua",
            ProgramArguments=[str(target / "Contents/MacOS/Courses"), "--if-added"],
        ),
    )
    domain = f"gui/{os.getuid()}"
    loaded = subprocess.run(
        ["launchctl", "print", domain + "/" + AGENT],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if loaded.returncode != 0:
        run("launchctl", "bootstrap", domain, agent_file)
    run("open", "-g", target)
    print("In Edit Widgets, search for Reichman Courses and choose a size.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.exit(0, "This optional widget is available on macOS only.\n")
    if int(platform.mac_ver()[0].split(".")[0]) < 14:
        parser.error("The widget requires macOS 14 or later.")
    node = shutil.which("node")
    if not node:
        parser.error("Node.js must be on PATH when building the widget.")
    if args.install:
        connector = (
            Path.home()
            / "Library/Application Support/runi-connector/app/runi-connector.js"
        )
        if not connector.is_file():
            parser.error(
                "First install and connect the desktop connector using the Codex installation instructions."
            )
    app = build(node)
    if args.install:
        install(app)
    else:
        print(app)


if __name__ == "__main__":
    main()
