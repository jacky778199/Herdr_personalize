"""Unit tests for mods/issue-panel/parser.py."""

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import parser  # noqa: E402


BOARD_SAMPLE = """# Issue 01 - Herdr App 個人化 Issue Panel 優化與實作

- **任務編號**: `01`
- **目前階段**: 階段二：計畫審核與實作
- **狀態**: `IN_PROGRESS`
- **重試計數**:
  - 偵察 (`inv`): `1`
  - 實作/測試 (`dev`/`qa`): `0`
  - Code Review: `0`

## 階段紀錄
- **[階段一]** 初始化任務看板，完成偵察。
- **[階段二]** 審核點 1 通過，進行實作。
"""


class TestIssueParser(unittest.TestCase):
    def test_normal_issue_parsing(self):
        with tempfile.TemporaryDirectory() as tmp:
            issue_dir = pathlib.Path(tmp) / ".ai_team" / "issue_01"
            issue_dir.mkdir(parents=True)
            (issue_dir / "00_board.md").write_text(BOARD_SAMPLE, encoding="utf-8")
            (issue_dir / "01_analysis.md").write_text("# Analysis\n\nRoot cause found.\n", encoding="utf-8")
            (issue_dir / "02_plan.md").write_text("# Plan\n\nStep 1.\n", encoding="utf-8")
            (issue_dir / "extra_notes.md").write_text("# Extra\n\nSome notes.\n", encoding="utf-8")

            res = parser.scan_workspace(tmp)
            self.assertTrue(res["ok"])
            self.assertTrue(res["has_ai_team"])
            self.assertEqual(res["selected_issue_id"], "01")
            self.assertEqual(len(res["issues"]), 1)

            cur = res["current"]
            self.assertEqual(cur["title"], "Issue 01 - Herdr App 個人化 Issue Panel 優化與實作")
            self.assertEqual(cur["stage"], 2)
            self.assertEqual(cur["stage_label"], "計畫與實作")
            self.assertEqual(cur["status"], "IN_PROGRESS")
            self.assertEqual(cur["retries"], {"inv": 1, "dev_qa": 0, "review": 0})
            self.assertEqual(cur["retry_max"], 1)
            self.assertFalse(cur["circuit_breaker"])
            self.assertEqual(len(cur["logs"]), 2)
            self.assertEqual(cur["logs"][0]["stage"], "階段一")

            docs_by_name = {d["name"]: d for d in cur["docs"]}
            self.assertTrue(docs_by_name["00_board.md"]["exists"])
            self.assertTrue(docs_by_name["01_analysis.md"]["exists"])
            self.assertTrue(docs_by_name["02_plan.md"]["exists"])
            self.assertFalse(docs_by_name["03_test_report.md"]["exists"])
            self.assertFalse(docs_by_name["04_final_report.md"]["exists"])
            self.assertIn("extra_notes.md", docs_by_name)
            self.assertTrue(docs_by_name["extra_notes.md"]["exists"])

    def test_multiple_issues_and_switching(self):
        with tempfile.TemporaryDirectory() as tmp:
            for idx, stage in [("01", "階段五：交付"), ("02", "階段三：測試")]:
                d = pathlib.Path(tmp) / ".ai_team" / f"issue_{idx}"
                d.mkdir(parents=True)
                (d / "00_board.md").write_text(
                    f"# Issue {idx}\n- **任務編號**: `{idx}`\n- **目前階段**: {stage}\n- **狀態**: `DONE`\n",
                    encoding="utf-8",
                )
            # Ensure issue_02 has a newer mtime than issue_01
            os.utime(pathlib.Path(tmp) / ".ai_team" / "issue_01" / "00_board.md", (1700000000, 1700000000))
            os.utime(pathlib.Path(tmp) / ".ai_team" / "issue_02" / "00_board.md", (1700001000, 1700001000))

            res = parser.scan_workspace(tmp)
            self.assertEqual([i["id"] for i in res["issues"]], ["02", "01"])
            self.assertEqual(res["selected_issue_id"], "02")
            self.assertEqual(res["current"]["stage"], 3)

            res_01 = parser.scan_workspace(tmp, selected_issue="01")
            self.assertEqual(res_01["selected_issue_id"], "01")
            self.assertEqual(res_01["current"]["stage"], 5)

    def test_circuit_breaker_conditions(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = pathlib.Path(tmp) / ".ai_team" / "issue_01"
            d1.mkdir(parents=True)
            (d1 / "00_board.md").write_text(
                "# Issue 01\n- **狀態**: `IN_PROGRESS`\n- 偵察 (`inv`): `0`\n- 實作/測試 (`dev`/`qa`): `3`\n- Code Review: `0`\n",
                encoding="utf-8",
            )
            res1 = parser.scan_workspace(tmp, selected_issue="01")
            self.assertEqual(res1["current"]["retry_max"], 3)
            self.assertTrue(res1["current"]["circuit_breaker"])

            d2 = pathlib.Path(tmp) / ".ai_team" / "issue_02"
            d2.mkdir(parents=True)
            (d2 / "00_board.md").write_text(
                "# Issue 02\n- **狀態**: `NEED_HUMAN`\n- 偵察 (`inv`): `0`\n- 實作/測試 (`dev`/`qa`): `1`\n- Code Review: `0`\n",
                encoding="utf-8",
            )
            res2 = parser.scan_workspace(tmp, selected_issue="02")
            self.assertEqual(res2["current"]["status"], "NEED_HUMAN")
            self.assertTrue(res2["current"]["circuit_breaker"])

    def test_fault_tolerance_missing_or_malformed(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Missing .ai_team
            res_empty = parser.scan_workspace(tmp)
            self.assertTrue(res_empty["ok"])
            self.assertFalse(res_empty["has_ai_team"])
            self.assertEqual(res_empty["issues"], [])
            self.assertIsNone(res_empty["current"])

            # Empty .ai_team
            ai_team = pathlib.Path(tmp) / ".ai_team"
            ai_team.mkdir()
            res_no_issues = parser.scan_workspace(tmp)
            self.assertTrue(res_no_issues["ok"])
            self.assertTrue(res_no_issues["has_ai_team"])
            self.assertEqual(res_no_issues["issues"], [])

            # Issue dir without 00_board.md
            d_missing = ai_team / "issue_03"
            d_missing.mkdir()
            res_missing_board = parser.scan_workspace(tmp, selected_issue="03")
            self.assertTrue(res_missing_board["ok"])
            self.assertFalse(res_missing_board["current"]["board_exists"])
            self.assertEqual(res_missing_board["current"]["status"], "UNKNOWN")
            self.assertEqual(res_missing_board["current"]["stage"], 0)

            # Malformed 00_board.md
            (d_missing / "00_board.md").write_text("random garbage without headers\nno fields here\n", encoding="utf-8")
            res_malformed = parser.scan_workspace(tmp, selected_issue="03")
            self.assertTrue(res_malformed["ok"])
            self.assertTrue(res_malformed["current"]["board_exists"])
            self.assertEqual(res_malformed["current"]["title"], "Issue 03")
            self.assertEqual(res_malformed["current"]["retry_max"], 0)

    def test_read_doc_and_path_traversal_protection(self):
        with tempfile.TemporaryDirectory() as tmp:
            issue_dir = pathlib.Path(tmp) / ".ai_team" / "issue_01"
            issue_dir.mkdir(parents=True)
            (issue_dir / "00_board.md").write_text("# Board\nContent\n", encoding="utf-8")
            (pathlib.Path(tmp) / "secret.md").write_text("SECRET", encoding="utf-8")

            ok_res = parser.read_doc(tmp, "01", "00_board.md")
            self.assertTrue(ok_res["ok"])
            self.assertIn("# Board", ok_res["content"])

            for bad_doc in ["../../etc/passwd", "..\\..\\secret.md", "../secret.md", "notes.txt", ""]:
                bad_res = parser.read_doc(tmp, "01", bad_doc)
                self.assertFalse(bad_res["ok"], f"Expected rejection for {bad_doc!r}")

            # CLI smoke test for path traversal
            script = str(pathlib.Path(__file__).resolve().parent / "parser.py")
            proc = subprocess.run(
                [sys.executable, script, "--cwd", tmp, "--issue", "01", "--doc", "..\\..\\secret.md"],
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
            self.assertNotEqual(proc.returncode, 0)
            out = json.loads(proc.stdout)
            self.assertFalse(out["ok"])


if __name__ == "__main__":
    unittest.main()
