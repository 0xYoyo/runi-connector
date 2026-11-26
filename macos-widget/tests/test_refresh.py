"""Widget data checks use only synthetic MCP replies."""

import unittest
from unittest.mock import Mock

from refresh import get_posts, get_tasks


class WidgetFeedTests(unittest.TestCase):
    def test_piazza_is_optional(self):
        for state in ("not connected", "saved password rejected", "unknown"):
            with self.subTest(state=state):
                client = Mock()
                self.assertIsNone(get_posts(client, [], [f"Piazza: {state}"]))
                client.tool.assert_not_called()
        for state in ("signed in", "login saved"):
            client = Mock()
            client.tool.return_value = "No Piazza classes found on your account."
            self.assertEqual(get_posts(client, [], [f"Piazza: {state}"]), [])
            client.tool.assert_called_once_with("piazza_list_classes")

    def test_future_unsubmitted_assignment_keeps_calendar_link(self):
        client = Mock()
        link = "https://moodle.runi.ac.il/2099/mod/assign/view.php?id=7"
        date = "Wed, 1 Apr 2099, 18:30"
        client.tool.side_effect = [
            "Test's courses (1):\n- Example | course no. 101 | moodle id 20",
            f"Due in the next 120 days:\n- {date} — Example: HW1 is due ({link})",
            f"Example\n## HW1 (due {date})\nSubmission: draft · grading: notgraded\nGrade: not graded yet\n"
            f"## HW2 (due {date})\nSubmission: submitted, last changed {date}\nGrade: not graded yet\n"
            "## HW0 (due Mon, 1 Jan 2001, 12:00)\nSubmission: none\nGrade: not graded yet",
        ]
        tasks = get_tasks(client)
        self.assertEqual(
            [(task["title"], task["url"], task["draft"]) for task in tasks],
            [("HW1", link, True)],
        )
