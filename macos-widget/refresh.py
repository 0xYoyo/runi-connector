"""Read the installed connector over stdio. Emit only desktop display data."""

import datetime as dt
import html
import json
import os
import re
import signal
import subprocess
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Jerusalem")
ROOT = Path.home() / "Library/Application Support/runi-connector/app/runi-connector.js"
DATE_FORMAT = "%a, %d %b %Y, %H:%M"
ASSIGNMENT_NUM = re.compile(
    r"(?:hw|home\s*work|(?:home\s+)?assignment|תרגיל|מטלה)[\s_#-]*(\d+)\b", re.I
)
IMPORTANT = re.compile(
    r"corrected|correction|clarif|typo|errat|extension (?:granted|approved|for everyone)|extended|postpon|updated|should (?:be|read)|instead of|mistake|תיקון|תוקן|הבהר|הארכ|נדחה|טעות|עודכנ",
    re.I,
)
UNITS = {"first": "1", "second": "2", "third": "3", "fourth": "4"}


def key(value):
    return re.sub(r"[\W_]+", " ", value.casefold()).strip()


def timestamp(value):
    return int(
        dt.datetime.strptime(value.replace("Sept", "Sep"), DATE_FORMAT)
        .replace(tzinfo=TZ)
        .timestamp()
    )


class Connector:
    def __init__(self):
        node = Path(__file__).with_name("node-path").read_text(encoding="utf8").strip()
        self.proc = subprocess.Popen(
            [node, str(ROOT)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            env={**os.environ, "RUNI_NO_BROWSER": "1"},
        )
        self.serial = 0

    def send(self, message):
        self.proc.stdin.write(json.dumps(dict(jsonrpc="2.0", **message)) + "\n")
        self.proc.stdin.flush()

    def request(self, method, params):
        self.serial += 1
        self.send(dict(id=self.serial, method=method, params=params))
        for line in self.proc.stdout:
            reply = json.loads(line)
            if reply.get("id") == self.serial:
                return reply["result"]
        raise RuntimeError("connector stopped")

    def tool(self, name, **args):
        reply = self.request("tools/call", dict(name=name, arguments=args))
        if reply.get("isError"):
            raise RuntimeError(name)
        return "\n".join(x["text"] for x in reply["content"] if x.get("type") == "text")


def get_tasks(client):
    roster = client.tool("list_courses")
    if "'s courses (" not in roster:
        raise ValueError("course list")
    courses = re.findall(
        r"^- (.+) \| course no\. (.*?) \| moodle id (\d+)$", roster, re.M
    )
    events = client.tool("get_upcoming_deadlines", days=120)
    if not events.startswith(("Due in the next", "Nothing due in the next")):
        raise ValueError("calendar")
    calendar = {}
    for date, course, title, url in re.findall(
        r"^- (.+?) — (.*?): (.*?) \((https://[^ )]+)\)$", events, re.M
    ):
        if url.startswith("https://moodle.runi.ac.il/"):
            calendar.setdefault(
                (timestamp(date), key(re.sub(r" is due$", "", title))), []
            ).append((course, url))
    tasks = []
    now = dt.datetime.now(TZ).timestamp()
    for fullname, number, course_id in courses:
        report = client.tool("get_assignment_feedback", course=course_id)
        if report.startswith("No matching assignments"):
            continue
        blocks = re.split(r"(?m)^## ", report)[1:]
        if not blocks:
            raise ValueError("submission status")
        for block in blocks:
            match = re.match(r"(.+) \(due (.+)\)\nSubmission: ([^,·\n]+)", block)
            if not match:
                raise ValueError("assignment format")
            title, date, status = match.groups()
            if status.strip() == "submitted" or re.search(
                r"^Grade: (?!not graded yet)[^\n]+", block, re.M
            ):
                continue
            due = None if date == "no date" else timestamp(date)
            if due is not None and due <= now:
                continue
            entries = calendar.get((due, key(title)), [])
            course, url = entries[0] if len(entries) == 1 else (fullname, "")
            if not url:
                year = int(dt.datetime.now(TZ).year) + int(
                    dt.datetime.now(TZ).month >= 8
                )
                url = f"https://moodle.runi.ac.il/{year}/course/view.php?id={course_id}"
            tasks.append(
                dict(
                    title=title,
                    course=course,
                    name=fullname,
                    number=number,
                    due=due,
                    url=url,
                    draft=status.strip() == "draft",
                )
            )
    return sorted(
        tasks, key=lambda x: x["due"] if x["due"] is not None else float("inf")
    )


def class_for(task, classes):
    scores = []
    for name, number in classes:
        same_number = task["number"] in re.findall(r"\d+", number)
        words = set(key(task["name"]).split()) & set(key(name).split())
        words -= {"and", "of", "in", "the", "1", "2"}
        scores.append((100 if same_number else len(words), name))
    scores.sort(reverse=True)
    if (
        scores
        and scores[0][0] >= 2
        and (len(scores) == 1 or scores[0][0] > scores[1][0])
    ):
        return scores[0][1]


def get_posts(client, tasks, status):
    if not {"Piazza: signed in", "Piazza: login saved"}.intersection(status):
        return None
    raw = client.tool("piazza_list_classes")
    if not raw.startswith(("Your Piazza classes:", "No Piazza classes found")):
        raise ValueError("Piazza classes")
    classes = []
    for line in raw.splitlines():
        if line.startswith("- "):
            desc = line[2:].rsplit(" — ", 1)[0]
            match = re.fullmatch(r"(.+) \(([^()]+)\)", desc)
            classes.append(match.groups() if match else (desc, ""))
    results, seen = [], set()
    for task in tasks:
        course = class_for(task, classes)
        if not course:
            continue
        title = task["title"]
        number = ASSIGNMENT_NUM.search(title)
        digits = number.group(1) if number else None
        terms = (
            [
                title,
                "HW" + digits,
                "Assignment " + digits,
                "תרגיל " + digits,
                "correction",
                "clarification",
                "הבהרה",
                "תיקון",
            ]
            if digits
            else [title]
        )
        candidates = {}
        for term in dict.fromkeys(terms):
            found = client.tool("piazza_search", course=course, query=term)
            if not found.startswith(("Posts in ", "Nothing in ")):
                raise ValueError("Piazza search")
            for pid, kind, subject in re.findall(
                r"^- @(\d+) \[(\w+)\] (.+)$", found, re.M
            ):
                candidates[int(pid)] = kind, subject
        for pid in sorted(candidates, reverse=True)[:12]:
            if (course, pid) in seen:
                continue
            kind, subject = candidates[pid]
            content = client.tool("piazza_read_post", course=course, post_number=pid)
            if not content.startswith("@"):
                raise ValueError("Piazza post")
            body = " ".join(html.unescape(content.partition("\n\n")[2]).split())
            sample = subject + " " + body
            numbers = ASSIGNMENT_NUM.findall(sample)
            for word, n in UNITS.items():
                if re.search(r"\b" + word + r" assignment\b", sample, re.I):
                    numbers.append(n)
            if digits and digits not in numbers:
                continue
            if not digits and key(title) not in key(sample):
                continue
            sentences = re.split(r"(?<=[.!?])\s+|\s+(?=- )", body)

            def priority(sentence):
                if IMPORTANT.search(sentence):
                    return 3
                if re.search(
                    r"individually|submission deadline|must submit|יש להגיש",
                    sentence,
                    re.I,
                ):
                    return 2
                return 1

            question = kind == "question"
            snippet = (
                next((s for s in sentences if "?" in s), body)
                if question
                else max(sentences, key=priority, default=body)
            )
            if not snippet:
                continue
            results.append(
                dict(
                    course=task["course"],
                    task=title,
                    pid=pid,
                    subject=subject,
                    text=snippet.strip(),
                    question=question,
                    important=bool(IMPORTANT.search(subject + " " + snippet))
                    and not question,
                )
            )
            seen.add((course, pid))
    return sorted(results, key=lambda p: (not p["important"], p["question"], -p["pid"]))


def timeout(*_):
    raise TimeoutError()


if __name__ == "__main__":
    client = Connector()
    try:
        signal.signal(signal.SIGALRM, timeout)
        signal.alarm(150)
        client.request(
            "initialize",
            dict(
                protocolVersion="2025-03-26",
                capabilities={},
                clientInfo=dict(name="reichman-desk", version="1"),
            ),
        )
        client.send(dict(method="notifications/initialized"))
        status = client.tool("connector_status").splitlines()
        if not any(line.startswith("Reichman: login saved") for line in status):
            # Replace the last personal snapshot when credentials are removed or rejected.
            print(
                json.dumps(
                    dict(
                        tasks=[], posts=None, updated=int(dt.datetime.now().timestamp())
                    )
                )
            )
            raise SystemExit(0)
        tasks = get_tasks(client)
        try:
            posts = get_posts(client, tasks, status)
        except Exception:
            posts = None
        print(
            json.dumps(
                dict(
                    tasks=tasks, posts=posts, updated=int(dt.datetime.now().timestamp())
                ),
                ensure_ascii=False,
            )
        )
    finally:
        client.proc.terminate()
