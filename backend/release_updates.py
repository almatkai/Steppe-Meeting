"""Read-only, unauthenticated GitHub release metadata. Never downloads installers.

One checker is shared by all windows served by this backend process. Responses
are cached independently of channel, caller version and platform.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
import json
import math
import re
import time
from typing import Literal
from urllib.parse import parse_qs, unquote, urlsplit

import httpx
from semver import Version

Channel = Literal["stable", "beta"]
REPOSITORY = "almatkai/Steppe-Meeting"
RELEASES_URL = f"https://github.com/{REPOSITORY}/releases"
API_URL = f"https://api.github.com/repos/{REPOSITORY}/releases"
CACHE_TTL = 15 * 60
NETWORK_DEADLINE = 11.0
MAX_PAGES = 5
MAX_PAGE_BYTES = 2_000_000


class UpdateError(Exception):
    def __init__(self, message: str, retry_after: int = 60, *, rate_limited: bool = False):
        super().__init__(message)
        self.retry_after = retry_after
        self.rate_limited = rate_limited


def parse_version(value: str) -> Version:
    if not isinstance(value, str) or not value or len(value) > 200:
        raise ValueError("Некорректная версия приложения: ожидается SemVer, например 1.2.3.")
    try:
        return Version.parse(value[1:] if value.startswith("v") else value)
    except ValueError:
        raise ValueError("Некорректная версия приложения: ожидается SemVer, например 1.2.3.") from None


class _PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.hidden += 1
        elif tag in ("br", "p", "div", "li"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def plain_text(value: object, limit: int) -> str:
    """Untrusted release prose is text, never executable HTML."""
    if not isinstance(value, str):
        return ""
    parser = _PlainText()
    parser.feed(value[:limit * 4])
    text = "".join(parser.parts).replace("<", "‹").replace(">", "›")
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", text)[:limit].strip()


def safe_github_url(value: object, kind: str) -> str | None:
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\x00-\x20\\]", value):
        return None
    try:
        url = urlsplit(value)
        if url.scheme != "https" or url.netloc != "github.com" or url.query or url.fragment:
            return None
        path = unquote(url.path)
        prefix = f"/{REPOSITORY}/releases/{kind}/"
        suffix = path[len(prefix):] if path.lower().startswith(prefix.lower()) else ""
        parts = suffix.split("/")
        if not suffix or any(part in ("", ".", "..") for part in parts):
            return None
        if re.search(r"[\x00-\x20\\]", path):
            return None
        if kind == "download" and len(parts) < 2:
            return None
        return value
    except ValueError:
        return None


def compatible_asset(assets: list, platform: str, arch: str) -> dict:
    platform = {"macos": "darwin", "mac": "darwin", "win32": "windows"}.get(platform.lower(), platform.lower())
    arch = {"arm64": "aarch64", "amd64": "x86_64", "x64": "x86_64"}.get(arch.lower(), arch.lower())
    extensions = {"darwin": (".dmg", ".pkg"), "windows": (".exe", ".msi"), "linux": (".appimage", ".deb", ".rpm")}
    if platform not in extensions or arch not in ("aarch64", "x86_64"):
        return {}
    for asset in assets:
        if not isinstance(asset, dict) or asset.get("state") != "uploaded":
            continue
        name = asset.get("name")
        if not isinstance(name, str) or len(name) > 255 or plain_text(name, 255) != name or "/" in name or "\\" in name:
            continue
        lower = name.lower()
        if not lower.endswith(extensions[platform]) or re.search(r"(^|[^a-z0-9])(source|sources|checksum)([^a-z0-9]|$)", lower):
            continue
        tokens = set(re.findall(r"(?<![a-z0-9])(?:x86_64|amd64|x64|aarch64|arm64|i686|i386|ia32|x86|armv7l?|armhf)(?![a-z0-9])", lower))
        detected = {"aarch64" if token in ("aarch64", "arm64") else "x86_64" if token in ("x86_64", "amd64", "x64") else "unsupported" for token in tokens}
        universal = platform == "darwin" and re.search(r"(^|[^a-z0-9])universal([^a-z0-9]|$)", lower)
        if detected != {arch} and not (universal and not detected):
            continue
        # DEB/RPM names can explicitly declare another OS; reject contradictions.
        os_tokens = set(re.findall(r"(?<![a-z0-9])(?:darwin|macos|windows|win32|linux)(?![a-z0-9])", lower))
        if any({"macos": "darwin", "win32": "windows"}.get(token, token) != platform for token in os_tokens):
            continue
        url = safe_github_url(asset.get("browser_download_url"), "download")
        if url:
            return {"download_url": url, "asset_name": name}
    return {}


def _api_page_url(value: str) -> bool:
    """Only follow bounded list-releases pagination on the exact public repo."""
    try:
        url = urlsplit(value)
        query = parse_qs(url.query, strict_parsing=True)
        return (url.scheme == "https" and url.netloc == "api.github.com"
                and url.path == f"/repos/{REPOSITORY}/releases" and not url.fragment
                and set(query) == {"page", "per_page"} and query["per_page"] == ["100"]
                and len(query["page"]) == 1 and query["page"][0].isdigit()
                and 1 <= int(query["page"][0]) <= MAX_PAGES)
    except ValueError:
        return False


def _retry_seconds(response: httpx.Response) -> int:
    now = time.time()
    delays = [60]
    retry = response.headers.get("retry-after", "")
    try:
        delays.append(float(retry))
    except ValueError:
        try:
            delays.append(parsedate_to_datetime(retry).timestamp() - now)
        except (ValueError, TypeError, OverflowError):
            pass
    if response.headers.get("x-ratelimit-remaining") == "0":
        try:
            delays.append(float(response.headers.get("x-ratelimit-reset", "")) - now)
        except ValueError:
            pass
    return math.ceil(max(delay for delay in delays if math.isfinite(delay)))


@dataclass
class _Page:
    releases: list
    etag: str | None
    next_url: str | None


class ReleaseChecker:
    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None):
        self.transport = transport
        self._pages: dict[str, _Page] = {}
        self._snapshot: dict | None = None
        self._expires = 0.0
        self._blocked_until = 0.0
        self._inflight: asyncio.Task | None = None

    async def _fetch(self) -> list:
        pages: dict[str, _Page] = {}
        releases: list = []
        url: str | None = f"{API_URL}?per_page=100&page=1"
        # No environment proxy credentials, .netrc, tokens, redirects or auth.
        async with httpx.AsyncClient(transport=self.transport, timeout=10.0, follow_redirects=False, trust_env=False,
                                     headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Steppe-Meeting-update-checker"}) as client:
            while url:
                if len(pages) >= MAX_PAGES or url in pages or not _api_page_url(url):
                    raise UpdateError("Не удалось полностью проверить список релизов GitHub: недопустимая или слишком длинная пагинация.")
                previous = self._pages.get(url)
                headers = {"If-None-Match": previous.etag} if previous and previous.etag else {}
                async with client.stream("GET", url, headers=headers) as response:
                    if response.status_code == 304:
                        if not previous:
                            raise UpdateError("GitHub вернул 304 без сохранённого списка релизов.")
                        page = previous
                    elif response.status_code != 200:
                        if response.status_code in (403, 429):
                            raise UpdateError("GitHub ограничил проверку обновлений. Повторите попытку позже.", _retry_seconds(response), rate_limited=True)
                        if response.status_code == 404:
                            raise UpdateError("Репозиторий или список релизов GitHub недоступен (404).", 900)
                        raise UpdateError(f"Не удалось проверить обновления: GitHub вернул HTTP {response.status_code}.")
                    else:
                        content = bytearray()
                        async for chunk in response.aiter_bytes():
                            content.extend(chunk)
                            if len(content) > MAX_PAGE_BYTES:
                                raise UpdateError("Ответ GitHub слишком большой для безопасной проверки обновлений.")
                        try:
                            data = json.loads(content)
                        except (ValueError, UnicodeError, RecursionError):
                            raise UpdateError("GitHub вернул некорректный JSON списка релизов.") from None
                        if not isinstance(data, list) or len(data) > 100 or any(not isinstance(item, dict) for item in data):
                            raise UpdateError("GitHub вернул неожиданный формат списка релизов.")
                        links = response.links
                        next_url = links.get("next", {}).get("url")
                        if response.headers.get("link") and not links:
                            raise UpdateError("GitHub вернул некорректные ссылки на страницы релизов.")
                        # A full page without pagination metadata is ambiguous.
                        if len(data) == 100 and not (next_url or links.get("prev")):
                            raise UpdateError("GitHub не предоставил сведения для полной проверки страниц релизов.")
                        page = _Page(data, response.headers.get("etag"), next_url)
                pages[url] = page
                releases.extend(page.releases)
                url = page.next_url
        self._pages = pages  # Commit validators only after a complete traversal.
        return releases

    async def _refresh(self) -> dict:
        try:
            releases = await asyncio.wait_for(self._fetch(), timeout=NETWORK_DEADLINE)
            snapshot = {"releases": releases}
            ttl = CACHE_TTL
        except (httpx.TimeoutException, asyncio.TimeoutError):
            snapshot = {"error": "Проверка обновлений превысила время ожидания. Проверьте подключение к интернету.", "retry_after": 60}
            ttl = 60
        except httpx.RequestError:
            snapshot = {"error": "Не удалось связаться с GitHub. Проверьте подключение к интернету и повторите попытку.", "retry_after": 60}
            ttl = 60
        except UpdateError as error:
            snapshot = {"error": str(error), "retry_after": error.retry_after}
            ttl = error.retry_after
            if error.rate_limited:
                self._blocked_until = time.monotonic() + ttl
        snapshot["checked_at"] = datetime.now(timezone.utc).isoformat()
        self._snapshot = snapshot
        self._expires = time.monotonic() + ttl
        return snapshot

    async def check(self, current_version: str, channel: Channel, platform: str = "", arch: str = "", force: bool = False) -> dict:
        base = {"repository": REPOSITORY, "channel": channel, "current_version": current_version}
        try:
            current = parse_version(current_version)
        except ValueError as error:
            return {**base, "status": "error", "checked_at": datetime.now(timezone.utc).isoformat(), "error": str(error)}
        if channel not in ("stable", "beta"):
            return {**base, "status": "error", "checked_at": datetime.now(timezone.utc).isoformat(), "error": "Неизвестный канал обновлений."}
        now = time.monotonic()
        if self._inflight and not self._inflight.done():
            snapshot = await asyncio.shield(self._inflight)
        elif self._snapshot is not None and (now < self._blocked_until or (not force and now < self._expires)):
            snapshot = self._snapshot
        else:
            self._inflight = asyncio.create_task(self._refresh())
            snapshot = await asyncio.shield(self._inflight)
        base["checked_at"] = snapshot["checked_at"]
        if "error" in snapshot:
            remaining = max(0, math.ceil(self._expires - time.monotonic()))
            return {**base, "status": "error", "error": snapshot["error"], "retry_after": remaining,
                    "retry_at": datetime.fromtimestamp(time.time() + remaining, timezone.utc).isoformat()}
        eligible: list[tuple[Version, dict]] = []
        invalid = False
        for release in snapshot["releases"]:
            if release.get("draft") is True:
                continue
            if release.get("draft") is not False or not isinstance(release.get("prerelease"), bool):
                invalid = True
                continue
            if "published_at" not in release:
                invalid = True
                continue
            if release["published_at"] is None:
                continue
            if channel == "stable" and release["prerelease"]:
                continue
            try:
                version = parse_version(release.get("tag_name"))
                published = datetime.fromisoformat(release["published_at"].replace("Z", "+00:00"))
                if published.tzinfo is None:
                    raise ValueError("Missing publication timezone")
            except (ValueError, AttributeError, TypeError):
                invalid = True
                continue
            if channel == "stable" and version.prerelease:
                continue
            eligible.append((version, release))
        if invalid:
            return {**base, "status": "error", "error": "Не удалось достоверно сравнить релизы: GitHub содержит некорректные версии или метаданные публикации."}
        if not eligible:
            return {**base, "status": "no_releases"}
        latest, release = max(eligible, key=lambda item: item[0])
        result = {**base, "status": "available" if latest > current else "up_to_date",
                  "latest_version": str(latest), "tag_name": release["tag_name"],
                  "release_name": plain_text(release.get("name"), 200) or release["tag_name"],
                  "published_at": release["published_at"],
                  "release_url": safe_github_url(release.get("html_url"), "tag") or RELEASES_URL,
                  "notes": plain_text(release.get("body"), 12000)}
        # Older releases remain informative, but never offer a downgrade asset.
        if latest > current:
            result.update(compatible_asset(release.get("assets", []) if isinstance(release.get("assets", []), list) else [], platform, arch))
        return result


checker = ReleaseChecker()
