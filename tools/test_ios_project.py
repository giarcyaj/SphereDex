"""Guards on the iOS project spec, because Xcode Cloud does not build the project we can see.

ci_scripts/ci_post_clone.sh runs `xcodegen generate` before every cloud archive, which OVERWRITES
SphereDex.xcodeproj from project.yml. So project.yml is the only file that reaches a real build, and the
committed .xcodeproj is decoration: it is hand maintained Xcode output (it still carries
LastUpgradeCheck and TargetAttributes, and the commit that introduced ci_post_clone never touched it).

That asymmetry cost 18 days of iOS push. CODE_SIGN_ENTITLEMENTS was set in the pbxproj and nowhere else,
so every cloud build archived with no aps-environment. registerForRemoteNotifications() then failed into
didFailToRegisterForRemoteNotificationsWithError, whose body was empty, so no iOS device registered a
push token and nothing anywhere said so. 32 iOS tokens froze on 2026-09-18 while 13 new installs landed.

test_settings_only_in_pbxproj_are_declared_in_project_yml is the one that matters: it fails for ANY
setting that exists only in the .xcodeproj, not just this one, so the next such divergence is caught at
push time instead of in the store.

Stdlib only, like every other test in this folder (CI installs no dependencies).
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IOS = ROOT / "ios" / "SphereDex"
SPEC = IOS / "project.yml"
PBXPROJ = IOS / "SphereDex.xcodeproj" / "project.pbxproj"
APP_SWIFT = IOS / "SphereDex" / "SphereDexApp.swift"

ENTITLEMENTS_RE = re.compile(r"^\s*CODE_SIGN_ENTITLEMENTS:\s*(\S+)\s*$", re.M)

# Settings that may appear in the .xcodeproj without being in project.yml, because XcodeGen supplies an
# equivalent itself or the setting is legacy. Anything NOT listed here must be declared in project.yml.
XCODEGEN_SUPPLIES = {
    "SDKROOT",                   # XcodeGen derives it from `platform: iOS`
    "LD_RUNPATH_SEARCH_PATHS",   # XcodeGen's default for an application target
    "CODE_SIGN_IDENTITY",        # legacy; Xcode Cloud manages the signing identity itself
}


def spec_text():
    return SPEC.read_text(encoding="utf-8")


def declared_entitlements():
    """The path project.yml points CODE_SIGN_ENTITLEMENTS at, or None."""
    m = ENTITLEMENTS_RE.search(spec_text())
    return m.group(1) if m else None


def handler_body(src, name):
    """The literal body of a Swift func, located by matching braces so that `{}` reads as empty.

    The first version of this test used a regex requiring a newline before the closing brace. The real
    handler was `) {}` on a single line, so it never matched that shape: the non-greedy wildcard ran on
    to a later `}` and captured a DIFFERENT function's body, and the test passed while the bug it exists
    to catch was live in production. Counting braces cannot make that mistake.
    """
    at = src.find(name)
    if at < 0:
        return None
    open_at = src.find("{", at)
    if open_at < 0:
        return None
    depth = 0
    for i in range(open_at, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[open_at + 1:i]
    return None


def app_target_settings():
    """Build-setting KEYS from the app target's build configurations in the committed .xcodeproj.

    The app target's configs are the ones carrying PRODUCT_BUNDLE_IDENTIFIER; the project-level configs
    (compiler defaults that Xcode writes and XcodeGen also writes) are deliberately ignored.
    """
    raw = PBXPROJ.read_text(encoding="utf-8")
    keys = set()
    for block in re.findall(r"buildSettings = \{(.*?)\n\t\t\t\};", raw, re.S):
        if "PRODUCT_BUNDLE_IDENTIFIER" not in block:
            continue
        for line in block.splitlines():
            m = re.match(r"\s*([A-Z][A-Z0-9_]*)\s*=", line)
            if m:
                keys.add(m.group(1))
    return keys


class ProjectFilesExist(unittest.TestCase):
    def test_the_files_this_suite_reasons_about_are_all_present(self):
        for p in (SPEC, PBXPROJ, APP_SWIFT):
            self.assertTrue(p.is_file(), f"missing {p}")

    def test_the_pbxproj_parser_actually_found_the_app_target(self):
        # If the pbxproj format ever changes under us, every other assertion here would pass vacuously.
        keys = app_target_settings()
        self.assertIn("PRODUCT_BUNDLE_IDENTIFIER", keys,
                      "could not parse the app target's build settings out of project.pbxproj; the "
                      "source-of-truth guard below would silently pass on an empty set.")


class ApnsEntitlement(unittest.TestCase):
    """The specific regression: push is dead unless all three of these facts hold together."""

    def test_project_yml_declares_the_entitlements_file(self):
        self.assertIsNotNone(
            declared_entitlements(),
            "project.yml does not set CODE_SIGN_ENTITLEMENTS. Xcode Cloud regenerates the project from "
            "project.yml, so setting it only in SphereDex.xcodeproj ships an app with NO aps-environment: "
            "registerForRemoteNotifications() fails and no iOS device can register for push.",
        )

    def test_the_declared_entitlements_file_exists(self):
        rel = declared_entitlements()
        self.assertIsNotNone(rel, "CODE_SIGN_ENTITLEMENTS is not declared in project.yml")
        self.assertTrue(
            (IOS / rel).resolve().is_file(),
            f"project.yml points CODE_SIGN_ENTITLEMENTS at {rel}, which does not exist.",
        )

    def test_the_entitlements_file_actually_grants_apns(self):
        rel = declared_entitlements()
        self.assertIsNotNone(rel, "CODE_SIGN_ENTITLEMENTS is not declared in project.yml")
        body = (IOS / rel).resolve().read_text(encoding="utf-8")
        self.assertIn(
            "aps-environment", body,
            "the entitlements file is wired up but does not contain aps-environment, so the app still "
            "cannot register for push notifications.",
        )


class SpecIsTheSourceOfTruth(unittest.TestCase):
    """The class-level guard. This is the test that would have caught the original bug."""

    def test_settings_only_in_pbxproj_are_declared_in_project_yml(self):
        spec = spec_text()
        missing = sorted(
            k for k in app_target_settings()
            if k not in XCODEGEN_SUPPLIES and not re.search(r"^\s*%s:" % re.escape(k), spec, re.M)
        )
        self.assertEqual(
            missing, [],
            "These build settings exist in SphereDex.xcodeproj but NOT in project.yml: "
            + ", ".join(missing)
            + ". Xcode Cloud runs `xcodegen generate` and overwrites the .xcodeproj from project.yml, so "
              "each one is silently dropped from every real build. Either declare it in project.yml or, "
              "if XcodeGen genuinely supplies an equivalent, add it to XCODEGEN_SUPPLIES in this file "
              "with a comment saying why.",
        )


class RegistrationFailureIsNotSilent(unittest.TestCase):
    """Why the bug survived 18 days: the failure path said nothing, to nobody."""

    def test_the_apns_failure_handler_has_a_body(self):
        src = APP_SWIFT.read_text(encoding="utf-8")
        raw = handler_body(src, "didFailToRegisterForRemoteNotificationsWithError")
        self.assertIsNotNone(
            raw, "could not find didFailToRegisterForRemoteNotificationsWithError in SphereDexApp.swift",
        )
        body = "\n".join(
            ln for ln in raw.splitlines() if ln.strip() and not ln.strip().startswith("//")
        ).strip()
        self.assertNotEqual(
            body, "",
            "didFailToRegisterForRemoteNotificationsWithError has an empty body. An APNs registration "
            "failure is then invisible: no log, no report, no user signal. That is exactly how the missing "
            "aps-environment entitlement went unnoticed while every iOS install silently failed to "
            "register. Log it at minimum.",
        )


class TheGuardCanActuallyFail(unittest.TestCase):
    """Meta-tests. The first cut of this suite passed on the broken tree, which made it worthless."""

    def test_handler_body_reads_an_inline_empty_body_as_empty(self):
        src = (
            "    func application(_ a: UIApplication,\n"
            "                     didFailToRegisterForRemoteNotificationsWithError error: Error) {}\n"
            "\n"
            "    func other() {\n        print(\"not this one\")\n    }\n"
        )
        self.assertEqual(handler_body(src, "didFailToRegisterForRemote"), "")

    def test_handler_body_reads_a_real_body_and_stops_at_its_own_brace(self):
        src = (
            "    func application(_ a: UIApplication,\n"
            "                     didFailToRegisterForRemoteNotificationsWithError error: Error) {\n"
            "        if true { print(\"nested\") }\n"
            "    }\n"
            "\n    func other() {\n        print(\"not this one\")\n    }\n"
        )
        body = handler_body(src, "didFailToRegisterForRemote")
        self.assertIn("nested", body)
        self.assertNotIn("not this one", body)

    def test_the_entitlements_check_fails_when_the_setting_is_absent(self):
        self.assertIsNone(ENTITLEMENTS_RE.search("settings:\n  base:\n    PRODUCT_NAME: SphereDex\n"))


if __name__ == "__main__":
    unittest.main()
