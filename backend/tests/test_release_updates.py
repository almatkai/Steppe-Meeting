"""Read-only release checks with synthetic metadata and mocked HTTP only."""
import asyncio
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import release_updates as updates


def release(tag="v1.0.0", **values):
    return {"tag_name": tag, "name": tag, "draft": False, "prerelease": False,
            "published_at": "2026-10-20T12:00:00Z", "body": "Изменения",
            "html_url": f"{updates.RELEASES_URL}/tag/{tag}", "assets": [], **values}


def asset(name, **values):
    return {"name": name, "state": "uploaded",
            "browser_download_url": f"{updates.RELEASES_URL}/download/v1.0.0/{name}", **values}


class ReleaseLogicTests(unittest.IsolatedAsyncioTestCase):
    def checker(self, data):
        return updates.ReleaseChecker(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=data)))

    async def test_semver_numeric_order_v_prefix_build_metadata_and_no_downgrade(self):
        checker = self.checker([release("v1.9.0"), release("v1.10.0+build.5")])
        result = await checker.check("1.9.0", "stable")
        self.assertEqual((result["status"], result["latest_version"]), ("available", "1.10.0+build.5"))
        self.assertEqual((await checker.check("1.10.0+other", "stable"))["status"], "up_to_date")
        newer = await checker.check("2.0.0", "stable", "darwin", "aarch64")
        self.assertEqual(newer["status"], "up_to_date")
        self.assertNotIn("download_url", newer)

    async def test_stable_excludes_flagged_and_misflagged_prereleases(self):
        checker = self.checker([release("1.2.0"), release("3.0.0", prerelease=True), release("4.0.0-beta.1")])
        stable = await checker.check("1.0.0", "stable")
        beta = await checker.check("1.0.0", "beta")
        self.assertEqual(stable["latest_version"], "1.2.0")
        self.assertEqual(beta["latest_version"], "4.0.0-beta.1")

    async def test_beta_semver_prerelease_numeric_order_then_stable(self):
        checker = self.checker([release("2.0.0-beta.2", prerelease=True), release("2.0.0-beta.10", prerelease=True), release("1.9.0")])
        self.assertEqual((await checker.check("2.0.0-beta.2", "beta"))["latest_version"], "2.0.0-beta.10")
        self.assertEqual((await self.checker([release("2.0.0-beta.99"), release("2.0.0")]).check("2.0.0-rc.1", "beta"))["latest_version"], "2.0.0")

    async def test_dates_do_not_choose_the_winner_and_drafts_unpublished_ignored(self):
        checker = self.checker([release("1.9.0", published_at="2026-10-27T00:00:00Z"),
                                release("1.10.0", published_at="2025-01-01T00:00:00Z"),
                                release("99.0.0", draft=True), release("98.0.0", published_at=None)])
        self.assertEqual((await checker.check("1.0.0", "stable"))["latest_version"], "1.10.0")

    async def test_no_published_or_channel_eligible_releases(self):
        for data in ([], [release(draft=True)], [release(published_at=None)], [release("1.0.0-beta.1")]):
            self.assertEqual((await self.checker(data).check("0.1.0", "stable"))["status"], "no_releases")

    async def test_invalid_tags_cannot_be_reported_as_up_to_date(self):
        for tag in ("latest", "1.2", "1.02.0", "1.0.0-01", "1.0.0rc1", ""):
            for data in ([release(tag)], [release("1.0.0"), release(tag)]):
                with self.subTest(tag=tag):
                    result = await self.checker(data).check("9.0.0", "stable")
                    self.assertEqual(result["status"], "error")

    async def test_invalid_current_version_never_fetches(self):
        async def fail(request):
            self.fail("Invalid caller version must not make a request")
        checker = updates.ReleaseChecker(transport=httpx.MockTransport(fail))
        for version in ("", "1.0", "nope", "1.0.0rc1", "01.0.0"):
            result = await checker.check(version, "stable")
            self.assertEqual(result["status"], "error")
            self.assertIn("SemVer", result["error"])

    async def test_bad_publication_metadata_is_an_error(self):
        for metadata in ({"published_at": "bad"}, {"published_at": "2026-10-20"}, {"draft": "false"}, {"prerelease": "false"}):
            self.assertEqual((await self.checker([release(**metadata)]).check("1.0.0", "stable"))["status"], "error")
        for data in ({}, {"draft": False, "prerelease": False}):
            self.assertEqual((await self.checker([data]).check("1.0.0", "stable"))["status"], "error")

    async def test_safe_metadata_only_and_plain_capped_notes(self):
        data = release("2.0.0", name="<b>Версия</b>", body="<script>danger()</script><p>Хорошо\x00</p>&lt;img src=x onerror=alert(1)&gt;" + "x" * 14000,
                       html_url="javascript:alert(1)", author={"token": "never return"})
        result = await self.checker([data]).check("1.0.0", "stable")
        self.assertEqual(result["release_url"], updates.RELEASES_URL)
        self.assertEqual(result["release_name"], "Версия")
        self.assertNotIn("danger", result["notes"])
        self.assertNotIn("\x00", result["notes"])
        self.assertNotIn("<", result["notes"])
        self.assertLessEqual(len(result["notes"]), 12000)
        self.assertNotIn("author", result)


class AssetTests(unittest.TestCase):
    def test_matching_os_arch_extensions(self):
        assets = [asset("Steppe_x64.dmg"), asset("Steppe_aarch64.dmg"), asset("Steppe_x64.exe"),
                  asset("Steppe_arm64.msi"), asset("Steppe_amd64.AppImage"), asset("Steppe_arm64.deb")]
        for platform, arch, expected in (("darwin", "aarch64", "Steppe_aarch64.dmg"), ("macos", "x86_64", "Steppe_x64.dmg"),
                                         ("windows", "x64", "Steppe_x64.exe"), ("win32", "arm64", "Steppe_arm64.msi"),
                                         ("linux", "amd64", "Steppe_amd64.AppImage"), ("linux", "aarch64", "Steppe_arm64.deb")):
            self.assertEqual(updates.compatible_asset(assets, platform, arch)["asset_name"], expected)

    def test_ambiguous_arch_source_updater_archives_and_wrong_os_rejected(self):
        for name in ("Steppe.dmg", "Steppe_x64.dmg", "Steppe_x86_arm64.dmg", "source_arm64.dmg",
                     "Steppe_arm64.app.tar.gz", "Steppe_arm64.zip", "Steppe_linux_arm64.dmg", "Steppe_arm64.dmg.sig"):
            self.assertEqual(updates.compatible_asset([asset(name)], "darwin", "aarch64"), {}, name)
        self.assertEqual(updates.compatible_asset([asset("Steppe_arm64.dmg")], "unknown", "arm64"), {})
        self.assertEqual(updates.compatible_asset([asset("Steppe_universal.dmg")], "darwin", "arm64")["asset_name"], "Steppe_universal.dmg")

    def test_links_are_https_exact_repo_no_external_or_traversal(self):
        for url in ("javascript:alert(1)", "https://evil.test/a", "https://github.com/other/repo/releases/download/v1/a.dmg",
                    "https://github.com@evil.test/a", f"{updates.RELEASES_URL}/download/v1/%2e%2e/a.dmg",
                    f"{updates.RELEASES_URL}/download/v1/a.dmg?next=evil", f"{updates.RELEASES_URL}/download/v1/a.dmg#fragment",
                    f"{updates.RELEASES_URL}/download/v1/a.dmg\n"):
            self.assertEqual(updates.compatible_asset([asset("Steppe_arm64.dmg", browser_download_url=url)], "darwin", "aarch64"), {}, url)
        self.assertEqual(updates.compatible_asset([asset("Steppe_arm64.dmg", state="new")], "darwin", "aarch64"), {})


class FetchCacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_cache_is_shared_across_channel_version_platform_force_revalidates_304(self):
        calls = []
        def handle(request):
            calls.append(request)
            if len(calls) == 1:
                return httpx.Response(200, json=[release("2.0.0")], headers={"ETag": '"one"'})
            self.assertEqual(request.headers["if-none-match"], '"one"')
            return httpx.Response(304)
        checker = updates.ReleaseChecker(transport=httpx.MockTransport(handle))
        self.assertEqual((await checker.check("1.0.0", "stable"))["status"], "available")
        self.assertEqual((await checker.check("3.0.0", "beta", "linux", "x64"))["status"], "up_to_date")
        self.assertEqual(len(calls), 1)
        self.assertGreater(checker._expires - time.monotonic(), 899)
        self.assertEqual((await checker.check("1.0.0", "beta", force=True))["status"], "available")
        self.assertEqual(len(calls), 2)
        self.assertNotIn("authorization", calls[0].headers)
        self.assertEqual(calls[0].url.host, "api.github.com")

    async def test_parallel_checks_including_force_are_coalesced(self):
        entered, finish = asyncio.Event(), asyncio.Event()
        count = 0
        async def handle(request):
            nonlocal count
            count += 1
            entered.set()
            await finish.wait()
            return httpx.Response(200, json=[])
        checker = updates.ReleaseChecker(transport=httpx.MockTransport(handle))
        first = asyncio.create_task(checker.check("1.0.0", "stable", force=True))
        await entered.wait()
        others = [asyncio.create_task(checker.check("1.0.0", "beta", force=True)) for _ in range(5)]
        # Schedule a barrier callback after every caller has entered check().
        barrier = asyncio.get_running_loop().create_future()
        asyncio.get_running_loop().call_soon(barrier.set_result, None)
        await barrier
        finish.set()
        results = await asyncio.gather(first, *others)
        self.assertEqual(count, 1)
        self.assertTrue(all(result["status"] == "no_releases" for result in results))

    async def test_expired_cache_refreshes_and_cancelled_caller_does_not_cancel_shared_fetch(self):
        count = 0
        entered, finish = asyncio.Event(), asyncio.Event()
        async def handle(request):
            nonlocal count
            count += 1
            entered.set()
            await finish.wait()
            return httpx.Response(200, json=[])
        checker = updates.ReleaseChecker(transport=httpx.MockTransport(handle))
        caller = asyncio.create_task(checker.check("1.0.0", "stable"))
        await entered.wait()
        caller.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await caller
        self.assertFalse(checker._inflight.cancelled())
        finish.set()
        self.assertEqual((await checker.check("1.0.0", "stable"))["status"], "no_releases")
        checker._expires = 0
        self.assertEqual((await checker.check("1.0.0", "stable"))["status"], "no_releases")
        self.assertEqual(count, 2)

    async def test_five_page_bound_is_not_a_partial_success(self):
        calls = []
        def handle(request):
            calls.append(request)
            next_page = int(request.url.params["page"]) + 1
            return httpx.Response(200, json=[release("2.0.0")], headers={"Link": f'<{updates.API_URL}?per_page=100&page={next_page}>; rel="next"'})
        checker = updates.ReleaseChecker(transport=httpx.MockTransport(handle))
        self.assertEqual((await checker.check("1.0.0", "stable"))["status"], "error")
        self.assertEqual(len(calls), 5)

    async def test_pagination_includes_higher_version_on_later_page_and_page_etags(self):
        calls = []
        second = f"{updates.API_URL}?per_page=100&page=2"
        def handle(request):
            calls.append(request)
            page = request.url.params["page"]
            headers = {"Link": f'<{second}>; rel="next"'} if page == "1" else {}
            if "if-none-match" in request.headers:
                return httpx.Response(304)
            return httpx.Response(200, json=[release("1.0.0" if page == "1" else "2.0.0")], headers={**headers, "ETag": f'"{page}"'})
        checker = updates.ReleaseChecker(transport=httpx.MockTransport(handle))
        self.assertEqual((await checker.check("1.0.0", "stable"))["latest_version"], "2.0.0")
        self.assertEqual((await checker.check("1.0.0", "stable", force=True))["latest_version"], "2.0.0")
        self.assertEqual(len(calls), 4)

    async def test_unsafe_looping_overlong_or_ambiguous_pagination_errors(self):
        first = f"{updates.API_URL}?per_page=100&page=1"
        for next_url in ("https://evil.test/data", f"{updates.API_URL}?per_page=100&page=6", first,
                         "https://api.github.com/repos/other/repo/releases?per_page=100&page=2"):
            calls = []
            def handle(request):
                calls.append(request)
                return httpx.Response(200, json=[release()], headers={"Link": f'<{next_url}>; rel="next"'})
            checker = updates.ReleaseChecker(transport=httpx.MockTransport(handle))
            self.assertEqual((await checker.check("1.0.0", "stable"))["status"], "error")
            self.assertEqual(len(calls), 1)
        checker = updates.ReleaseChecker(transport=httpx.MockTransport(lambda req: httpx.Response(200, json=[release()] * 100)))
        self.assertEqual((await checker.check("1.0.0", "stable"))["status"], "error")

    async def test_later_page_failure_does_not_expose_partial_success(self):
        def handle(request):
            if request.url.params["page"] == "1":
                return httpx.Response(200, json=[release("2.0.0")], headers={"Link": f'<{updates.API_URL}?per_page=100&page=2>; rel="next"'})
            return httpx.Response(500)
        checker = updates.ReleaseChecker(transport=httpx.MockTransport(handle))
        self.assertEqual((await checker.check("1.0.0", "stable"))["status"], "error")
        self.assertEqual(checker._pages, {})

    async def test_errors_not_fake_success_and_force_can_recover(self):
        responses = iter([httpx.Response(200, json=[release("2.0.0")]), httpx.Response(500), httpx.Response(200, json=[])])
        checker = updates.ReleaseChecker(transport=httpx.MockTransport(lambda req: next(responses)))
        self.assertEqual((await checker.check("1.0.0", "stable"))["status"], "available")
        self.assertEqual((await checker.check("1.0.0", "stable", force=True))["status"], "error")
        self.assertEqual((await checker.check("1.0.0", "stable"))["status"], "error")
        self.assertEqual((await checker.check("1.0.0", "stable", force=True))["status"], "no_releases")

    async def test_http_errors_non_json_schema_304_without_cache_redirect_and_size(self):
        for response in (httpx.Response(404), httpx.Response(500), httpx.Response(200, text="<html>offline</html>"),
                         httpx.Response(200, json={"message": "bad"}), httpx.Response(200, json=["bad"]),
                         httpx.Response(304), httpx.Response(302, headers={"Location": "https://evil.test"})):
            checker = updates.ReleaseChecker(transport=httpx.MockTransport(lambda req: response))
            result = await checker.check("1.0.0", "stable")
            self.assertEqual(result["status"], "error")
            self.assertTrue(result["error"])
            self.assertGreater(result["retry_after"], 0)
        with patch.object(updates, "MAX_PAGE_BYTES", 5):
            checker = updates.ReleaseChecker(transport=httpx.MockTransport(lambda req: httpx.Response(200, json=[release()])))
            self.assertEqual((await checker.check("1.0.0", "stable"))["status"], "error")

    async def test_rate_limit_backoff_even_force_and_reset_header(self):
        for status, headers in ((429, {"Retry-After": "120"}),
                                (403, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": str(int(time.time()) + 180)}),
                                (403, {"Retry-After": "invalid"})):
            count = 0
            def handle(request):
                nonlocal count
                count += 1
                return httpx.Response(status, headers=headers)
            checker = updates.ReleaseChecker(transport=httpx.MockTransport(handle))
            result = await checker.check("1.0.0", "stable")
            self.assertEqual(result["status"], "error")
            self.assertGreaterEqual(result["retry_after"], 60)
            self.assertIn("ограничил", result["error"])
            await checker.check("1.0.0", "beta", force=True)
            self.assertEqual(count, 1)

    async def test_timeout_offline_and_overall_deadline(self):
        for error in (httpx.ConnectError("offline"), httpx.ReadTimeout("timeout")):
            def handle(request):
                raise error
            checker = updates.ReleaseChecker(transport=httpx.MockTransport(handle))
            result = await checker.check("1.0.0", "stable")
            self.assertEqual(result["status"], "error")
            self.assertIn("интернет", result["error"])
        async def stalled(request):
            await asyncio.Event().wait()
        checker = updates.ReleaseChecker(transport=httpx.MockTransport(stalled))
        start = time.monotonic()
        with patch.object(updates, "NETWORK_DEADLINE", 0.02):
            result = await checker.check("1.0.0", "stable")
        self.assertEqual(result["status"], "error")
        self.assertLess(time.monotonic() - start, 1)
        self.assertLessEqual(updates.NETWORK_DEADLINE, 12)


if __name__ == "__main__":
    unittest.main()
