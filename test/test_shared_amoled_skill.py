#!/usr/bin/env python3
"""Repository contract for the shared Torget AMOLED iteration workflow."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / ".claude/skills/iterating-esp32-amoled-ui"
INSTALLER = ROOT / "tools/install-local-skills.sh"
SKILL_NAME = "iterating-esp32-amoled-ui"
# The installer is POSIX sh. Windows cannot exec it directly; Git Bash can
# run it, and MSYS must be told to create real symlinks rather than copies.
BASH = shutil.which("bash") if os.name == "nt" else None


def run(command: list[str], *, cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        text=True,
        capture_output=True,
        check=check,
    )


def _symlinks_available() -> bool:
    with tempfile.TemporaryDirectory() as temp_dir:
        try:
            os.symlink(temp_dir, os.path.join(temp_dir, "probe"),
                       target_is_directory=True)
        except (OSError, NotImplementedError):
            return False
    return True


def requires_installer_runtime(test):
    """The installer needs a POSIX shell and symlink rights. Locally that
    may be missing (Windows without Git Bash or Developer Mode); on CI it
    must never be, so a missing runtime fails instead of skipping."""
    reasons = []
    if os.name == "nt" and BASH is None:
        reasons.append("Git Bash is not on PATH")
    if not _symlinks_available():
        reasons.append("symlink creation is not permitted")
    if not reasons:
        return test
    reason = "; ".join(reasons)
    if os.environ.get("CI"):
        def fail(self):
            self.fail(f"installer tests cannot run on CI: {reason}")
        fail.__name__ = test.__name__
        fail.__doc__ = test.__doc__
        return fail
    return unittest.skip(reason)(test)


def installer_command(installer: Path) -> list[str]:
    if os.name == "nt":
        return [BASH, installer.as_posix()]
    return [str(installer)]


def installer_env(codex_home: Path) -> dict[str, str]:
    env = {**os.environ, "CODEX_HOME": codex_home.as_posix()}
    if os.name == "nt":
        env["MSYS"] = "winsymlinks:nativestrict"
    return env


def path_as_printed(path: Path) -> str:
    """The installer echoes CODEX_HOME verbatim plus POSIX-joined parts."""
    return path.as_posix() if os.name == "nt" else str(path)


def commit_fixture_repo(primary: Path) -> None:
    run(["git", "init"], cwd=primary)
    run(["git", "add", "."], cwd=primary)
    run(
        [
            "git",
            "-c",
            "user.name=VibePulse Test",
            "-c",
            "user.email=vibepulse@example.invalid",
            "commit",
            "-m",
            "fixture",
        ],
        cwd=primary,
    )


class SharedAmoledSkillTests(unittest.TestCase):
    def test_canonical_skill_has_bounded_trigger_and_interface(self) -> None:
        skill_md = SKILL / "SKILL.md"
        self.assertTrue(skill_md.is_file(), "canonical shared skill is missing")

        text = skill_md.read_text(encoding="utf-8")
        self.assertLess(len(text.split()), 500)
        _, frontmatter, body = text.split("---", 2)
        metadata = yaml.safe_load(frontmatter)
        self.assertEqual(set(metadata), {"name", "description"})
        self.assertEqual(metadata["name"], "iterating-esp32-amoled-ui")
        self.assertEqual(
            metadata["description"],
            "Use when making any Torget AMOLED app visual change, exact-size "
            "mockup, simulator capture, or physical review.",
        )

        required_workflow = (
            "spec/hardware-capabilities.yaml",
            "spec/ui-spec.md",
            "design/vibepulse/studio-design.json",
            "latest physical review",
            "docs/superpowers/reviews/",
            "If no physical review exists",
            "1:1 480 x 480",
            "materially different states",
            "design.py --check",
            "tools/preview-ui.sh vibepulse",
            "one static shared LVGL batch",
            "./test/run.sh",
            "Build once",
            "explicit user authorization",
            "static physical AMOLED",
            "#D97757",
            "#6F78FF",
            "never fabricate data",
            "tiny",
            "time pressure",
            "cable",
            "prior approval",
            "concurrent Claude/Codex edits",
            "scope and diff",
            "memory budget",
            "interaction performance",
            "shared display pipeline",
            "flush count",
            "largest internal block",
            "network/TLS stress",
            "one variable at a time",
            "never increase display-buffer height",
            "Static approval does not imply motion approval",
            "shared LVGL raster is the visual authority",
            "widest realistic copy",
            "missing-data state",
            "one dominant metric",
            "round secondary values",
            "encode discovered spacing as validator tests",
            "source provenance",
            "live, cached/stale, and no-data",
            "same active fixture",
            "native final sizes",
            "byte-for-byte",
            "transparent corners",
            "Do not infer visual correctness from a green test",
            "two-stage review",
        )
        for phrase in required_workflow:
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, body)

        interface = yaml.safe_load(
            (SKILL / "agents/openai.yaml").read_text(encoding="utf-8")
        )
        self.assertEqual(
            interface,
            {
                "interface": {
                    "display_name": "ESP32 AMOLED UI",
                    "short_description": "Exact-size VibePulse AMOLED iteration",
                    "default_prompt": (
                        "Use $iterating-esp32-amoled-ui to make and verify this "
                        "Torget AMOLED visual change."
                    ),
                }
            },
        )

    @requires_installer_runtime
    def test_linked_worktree_installer_targets_primary_and_handles_existing_targets(
        self,
    ) -> None:
        self.assertTrue(INSTALLER.is_file(), "Codex skill installer is missing")
        self.assertTrue(os.access(INSTALLER, os.X_OK), "installer is not executable")

        with tempfile.TemporaryDirectory(prefix="amoled skill paths ") as temp_dir:
            base = Path(temp_dir)
            primary = base / "Primary Repo"
            linked = base / "Linked Worktree"
            codex_home = base / "Codex Home"
            primary.mkdir()
            primary_skill = primary / ".claude/skills" / SKILL_NAME
            primary_skill.mkdir(parents=True)
            (primary_skill / "SKILL.md").write_text("primary\n", encoding="utf-8")
            primary_installer = primary / "tools/install-local-skills.sh"
            primary_installer.parent.mkdir()
            shutil.copy2(INSTALLER, primary_installer)
            commit_fixture_repo(primary)
            run(["git", "worktree", "add", "-b", "linked-test", str(linked)], cwd=primary)

            linked_installer = linked / "tools/install-local-skills.sh"
            command = installer_command(linked_installer)
            env = installer_env(codex_home)
            result = subprocess.run(
                command,
                cwd=linked,
                env=env,
                text=True,
                capture_output=True,
                check=True,
            )
            link = codex_home / "skills" / SKILL_NAME
            self.assertTrue(link.is_symlink())
            self.assertEqual(link.resolve(), primary_skill.resolve())
            self.assertIn(path_as_printed(link), result.stdout)
            self.assertIn("new Codex session", result.stdout)

            subprocess.run(
                command,
                cwd=linked,
                env=env,
                text=True,
                capture_output=True,
                check=True,
            )
            self.assertEqual(link.resolve(), primary_skill.resolve())

            foreign = base / "Foreign Skill"
            foreign.mkdir()
            link.unlink()
            link.symlink_to(foreign, target_is_directory=True)
            subprocess.run(
                command,
                cwd=linked,
                env=env,
                text=True,
                capture_output=True,
                check=True,
            )
            self.assertEqual(link.resolve(), primary_skill.resolve())

            link.unlink()
            link.symlink_to(base / "Missing Skill", target_is_directory=True)
            subprocess.run(
                command,
                cwd=linked,
                env=env,
                text=True,
                capture_output=True,
                check=True,
            )
            self.assertEqual(link.resolve(), primary_skill.resolve())

            link.unlink()
            link.write_text("keep me", encoding="utf-8")
            refused = subprocess.run(
                command,
                cwd=linked,
                env=env,
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(refused.returncode, 0)
            self.assertEqual(link.read_text(encoding="utf-8"), "keep me")

            link.unlink()
            link.mkdir()
            (link / "keep-me").write_text("directory", encoding="utf-8")
            refused = subprocess.run(
                command,
                cwd=linked,
                env=env,
                text=True,
                capture_output=True,
            )
            self.assertNotEqual(refused.returncode, 0)
            self.assertEqual((link / "keep-me").read_text(encoding="utf-8"), "directory")

    @requires_installer_runtime
    def test_premerge_installer_refuses_when_primary_skill_is_absent(self) -> None:
        # A checkout from before the skill merged: installer present, skill
        # absent. Built in a temp directory so the case is exercised on every
        # run instead of being skipped whenever this checkout has the skill.
        with tempfile.TemporaryDirectory(prefix="amoled skill premerge ") as temp_dir:
            base = Path(temp_dir)
            primary = base / "Primary Repo"
            primary.mkdir()
            primary_installer = primary / "tools/install-local-skills.sh"
            primary_installer.parent.mkdir()
            shutil.copy2(INSTALLER, primary_installer)
            commit_fixture_repo(primary)
            linked = base / "Linked Worktree"
            run(["git", "worktree", "add", "-b", "premerge-linked", str(linked)], cwd=primary)
            codex_home = base / "Codex Home"

            for label, installer, cwd in (
                ("primary", primary_installer, primary),
                ("linked worktree", linked / "tools/install-local-skills.sh", linked),
            ):
                with self.subTest(checkout=label):
                    refused = subprocess.run(
                        installer_command(installer),
                        cwd=cwd,
                        env=installer_env(codex_home),
                        text=True,
                        capture_output=True,
                    )
                    self.assertNotEqual(refused.returncode, 0)
                    self.assertIn("primary checkout", refused.stderr)
                    self.assertIn("merge", refused.stderr.lower())
                    # Refusal comes before any write: not even CODEX_HOME.
                    self.assertFalse(codex_home.exists())

    def test_both_agents_route_visual_work_through_the_physical_gate(self) -> None:
        for filename in ("AGENTS.md", "CLAUDE.md"):
            text = (ROOT / filename).read_text(encoding="utf-8")
            with self.subTest(filename=filename):
                self.assertIn("iterating-esp32-amoled-ui", text)
                self.assertIn("480 x 480", text)
                self.assertIn("static physical AMOLED", text)
                self.assertIn("Studio approval never authorizes a flash", text)


if __name__ == "__main__":
    unittest.main()
