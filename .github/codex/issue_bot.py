#!/usr/bin/env python3
"""Trusted orchestration. Uses only Python's standard library; never executes issue text."""
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_JSON = 150_000
MAX_PATCH = 1_000_000
MARKER = "<!-- codex-issue-bot -->"
EFFORTS = {"low", "medium", "high", "xhigh", "max"}


def comment_request(event):
    issue, comment = event.get("issue", {}), event.get("comment", {})
    if (issue.get("pull_request") or issue.get("state") != "open"
            or event.get("sender", {}).get("type") != "User"
            or comment.get("user", {}).get("type") != "User"):
        return None
    alias = os.environ.get("CODEX_BOT_MENTION", "@summer-shark").strip()
    if not re.fullmatch(r"@[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?", alias):
        raise ValueError("CODEX_BOT_MENTION must be an @bot-name")
    suffix = "" if alias.lower().endswith("[bot]") else r"(?:\[bot\])?"
    prefix = re.compile(r"^\s*" + re.escape(alias) + suffix + r"(?=\s|$)", re.IGNORECASE)
    body = comment.get("body") or ""
    match = prefix.match(body)
    if not match:
        return None
    text = body[match.end():].strip()
    effort = ""
    if text.lower().startswith("effort="):
        flag = re.match(r"effort=([^\s]+)(?:\s+|$)", text, re.IGNORECASE)
        effort = flag.group(1).lower() if flag else ""
        if effort not in EFFORTS:
            raise ValueError("effort must be low, medium, high, xhigh, or max")
        text = text[flag.end():].strip()
    return {"id": comment["id"], "author": comment["user"]["login"],
            "body": text, "effort": effort}


def configured_effort(override=""):
    effort = override.strip().lower()
    if effort in {"", "default"}:
        effort = os.environ.get("CODEX_REASONING_EFFORT", "max").strip().lower() or "max"
    if effort not in EFFORTS:
        raise ValueError("Reasoning effort must be low, medium, high, xhigh, or max")
    return effort


def read_json(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_JSON:
        raise ValueError("Invalid or oversized JSON artifact")
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def issue_number(value):
    if not re.fullmatch(r"[1-9][0-9]*", str(value)):
        raise ValueError("Issue number must be a positive integer")
    return int(value)


def git(*args):
    return subprocess.check_output([
        "git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", *args
    ])


def api(method, route, data=None):
    repo = os.environ["GITHUB_REPOSITORY"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("Invalid repository identifier")
    request = urllib.request.Request(
        "https://api.github.com/repos/" + repo + route,
        data=None if data is None else json.dumps(data).encode("utf-8"),
        method=method,
        headers={
            "Authorization": "Bearer " + os.environ["GITHUB_TOKEN"],
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "codex-issue-bot",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def event_context():
    event = read_json(os.environ["GITHUB_EVENT_PATH"])
    number = issue_number(event.get("issue", {}).get("number") or os.environ.get("REQUESTED_ISSUE", ""))
    branch = event["repository"]["default_branch"]
    sha = os.environ["GITHUB_SHA"]
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Invalid source revision")
    return event, {"issue_number": number, "base_branch": branch,
                   "base_sha": sha, "repository": os.environ["GITHUB_REPOSITORY"]}


def check_meta(meta):
    _, expected = event_context()
    if meta != expected or git("rev-parse", "HEAD").decode().strip() != expected["base_sha"]:
        raise ValueError("Artifact does not match this issue and source revision")


def set_output(name, value):
    rendered = ("true" if value else "false") if type(value) is bool else value
    if not isinstance(rendered, str) or any(char in rendered for char in "\r\n\0"):
        raise ValueError("Invalid workflow output")
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(name + "=" + rendered + "\n")


def provider_endpoint():
    base = os.environ.get("CODEX_BASE_URL", "").strip()
    if not base:
        return ""  # Keep the official Action's default endpoint.
    if any(char.isspace() or ord(char) < 32 for char in base):
        raise ValueError("CODEX_BASE_URL contains invalid whitespace")
    parsed = urllib.parse.urlsplit(base)
    if (parsed.scheme not in {"https", "http"} or not parsed.hostname
            or parsed.username is not None or parsed.password is not None or parsed.fragment):
        raise ValueError("CODEX_BASE_URL must be an HTTP(S) URL without embedded credentials or fragments")
    if not os.environ.get("CODEX_MODEL", "").strip():
        raise ValueError("Configure CODEX_MODEL when using a custom endpoint")
    path = parsed.path.rstrip("/")
    if not path.endswith("/responses"):
        path += "/responses"
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, ""))


def text_fields(result, fields):
    if not isinstance(result, dict):
        raise ValueError("Expected a JSON object")
    for field in fields:
        if not isinstance(result.get(field), str) or not result[field].strip() or len(result[field]) > 12_000:
            raise ValueError("Invalid result field: " + field)


def triage_result(path):
    result = read_json(path)
    text_fields(result, ["category", "summary", "reply"])
    if set(result) != {"category", "auto_fix", "summary", "evidence", "reply"}:
        raise ValueError("Unexpected triage fields")
    if result["category"] not in {"bug", "needs_info", "question", "feature", "not_reproduced"}:
        raise ValueError("Unknown issue category")
    if type(result["auto_fix"]) is not bool:
        raise ValueError("auto_fix must be boolean")
    if not isinstance(result["evidence"], list) or any(not isinstance(x, str) for x in result["evidence"]):
        raise ValueError("Invalid evidence")
    if result["auto_fix"] and (result["category"] != "bug" or not any(x.strip() for x in result["evidence"])):
        raise ValueError("Automatic repair requires an evidenced bug")
    return result


def fix_result(path):
    result = read_json(path)
    text_fields(result, ["summary", "validation", "reply"])
    if set(result) != {"resolved", "summary", "validation", "reply"} or type(result["resolved"]) is not bool:
        raise ValueError("Invalid fix result")
    return result


def prepare_triage(directory):
    event, meta = event_context()
    request = comment_request(event) if os.environ.get("GITHUB_EVENT_NAME") == "issue_comment" else None
    selected = os.environ.get("GITHUB_EVENT_NAME") != "issue_comment" or request is not None
    set_output("selected", selected)
    if not selected:
        print("No bot command at the beginning of this human issue comment; skipped.")
        return
    override = request["effort"] if request else os.environ.get("REQUESTED_EFFORT", "")
    effort = configured_effort(override)
    set_output("reasoning_effort", effort)
    set_output("responses_endpoint", provider_endpoint())
    check_meta(meta)
    issue = (api("GET", "/issues/" + str(meta["issue_number"]))
             if os.environ.get("GITHUB_EVENT_NAME") == "issue_comment"
             else event.get("issue") or api("GET", "/issues/" + str(meta["issue_number"])))
    if "pull_request" in issue:
        raise ValueError("Select an issue, not a pull request")
    if issue["state"] != "open":
        set_output("selected", False)
        print("Issue is closed; model run skipped.")
        return
    comments, truncated = [], False
    # Manual and mention-triggered runs include existing follow-ups.
    if os.environ.get("GITHUB_EVENT_NAME") in {"workflow_dispatch", "issue_comment"}:
        page = api("GET", "/issues/" + str(meta["issue_number"]) + "/comments?per_page=30")
        remaining = 20_000
        for comment in page:
            if comment["user"].get("type") == "Bot" and MARKER in (comment.get("body") or ""):
                continue
            body = comment.get("body") or ""
            excerpt = body[:min(8000, remaining)]
            comments.append({"author": comment["user"]["login"], "body": excerpt})
            remaining -= len(excerpt)
            truncated = truncated or len(excerpt) < len(body)
        truncated = truncated or len(page) == 30
    body = issue.get("body") or ""
    payload = {"title": issue.get("title", "")[:1000], "body": body[:20000], "comments": comments,
               "truncated": truncated or len(body) > 20000, "state": issue["state"]}
    if request:
        payload["request"] = {"id": request["id"], "author": request["author"], "body": request["body"][:12000]}
        payload["truncated"] = payload["truncated"] or len(request["body"]) > 12000
    directory.mkdir(parents=True, exist_ok=True)
    write_json(directory / "meta.json", meta)
    write_json(directory / "issue.json", payload)
    guidance = Path(".github/codex/triage.md").read_text(encoding="utf-8")
    command = os.environ.get("CODEX_TEST_COMMAND", "")
    prompt = guidance + "\nMaintainer-configured verification command:\n" + json.dumps(command) + "\n"
    prompt += "\nUntrusted issue data (JSON):\n" + json.dumps(payload, ensure_ascii=False) + "\n"
    (directory / "prompt.md").write_text(prompt, encoding="utf-8")


def validate_triage(directory):
    check_meta(read_json(directory / "meta.json"))
    result = triage_result(directory / "report.json")
    issue = read_json(directory / "issue.json")
    if issue["truncated"] or issue["state"] != "open" or not os.environ.get("CODEX_TEST_COMMAND", "").strip():
        result["auto_fix"] = False
        write_json(directory / "report.json", result)
    set_output("auto_fix", result["auto_fix"])


def prepare_fix(root):
    set_output("responses_endpoint", provider_endpoint())
    set_output("reasoning_effort", configured_effort(os.environ.get("REQUESTED_EFFORT", "")))
    triage, target = root / "triage", root / "fix"
    meta = read_json(triage / "meta.json")
    check_meta(meta)
    result = triage_result(triage / "report.json")
    if not result["auto_fix"]:
        raise ValueError("Issue was not selected for repair")
    target.mkdir(parents=True, exist_ok=True)
    write_json(target / "meta.json", meta)
    prompt = Path(".github/codex/fix.md").read_text(encoding="utf-8")
    prompt += "\nMaintainer-configured verification command:\n" + json.dumps(os.environ["CODEX_TEST_COMMAND"]) + "\n"
    prompt += "\nUntrusted issue data (JSON):\n" + json.dumps(read_json(triage / "issue.json"), ensure_ascii=False)
    prompt += "\nTriage evidence (JSON):\n" + json.dumps(result, ensure_ascii=False) + "\n"
    (target / "prompt.md").write_text(prompt, encoding="utf-8")


def validate_staged_paths():
    names = git("diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD").split(b"\0")
    paths = [x.decode("utf-8") for x in names if x]
    if not paths or len(paths) > 30:
        raise ValueError("Patch must change between 1 and 30 files")
    protected = {".git", ".github", ".codex", ".agents"}
    for name in paths:
        parts = PurePosixPath(name).parts
        if (not parts or name.startswith("/") or ".." in parts or any(x in protected for x in parts)
                or "AGENTS.md" in parts or parts[-1] == ".gitmodules" or parts[-1].startswith(".env")):
            raise ValueError("Patch touches a protected path: " + name)
    raw = git("diff", "--cached", "--raw", "--no-renames", "-z", "HEAD").split(b"\0")
    for item in raw[::2]:
        if item:
            modes = [item.split()[0].lstrip(b":"), item.split()[1]]
            if any(mode not in {b"000000", b"100644", b"100755"} for mode in modes):
                raise ValueError("Symlinks and submodules are outside automatic repair scope")
    return paths


def package_fix(root):
    target = root / "fix"
    check_meta(read_json(target / "meta.json"))
    result = fix_result(target / "report.json")
    if result["resolved"]:
        try:
            git("add", "--all")
            validate_staged_paths()
            patch = git("diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD")
            if not patch or len(patch) > MAX_PATCH:
                raise ValueError("Patch is empty or exceeds the 1 MB automatic repair limit")
            (target / "candidate.patch").write_bytes(patch)
        except ValueError as error:
            result["resolved"] = False
            result["reply"] = "自動修復結果需要維護者檢查：" + str(error)
            write_json(target / "report.json", result)
    set_output("resolved", result["resolved"])


def apply_fix(target):
    check_meta(read_json(target / "meta.json"))
    if not fix_result(target / "report.json")["resolved"]:
        raise ValueError("No completed repair")
    patch = target / "candidate.patch"
    if patch.is_symlink() or not patch.is_file() or not 0 < patch.stat().st_size <= MAX_PATCH:
        raise ValueError("Invalid patch artifact")
    git("apply", "--check", "--index", str(patch))
    git("apply", "--index", str(patch))
    validate_staged_paths()


def open_pr(target, meta, run_url):
    check_meta(read_json(target / "meta.json"))
    run_id = issue_number(os.environ["GITHUB_RUN_ID"])
    number = meta["issue_number"]
    branch = "codex/issue-" + str(number) + "-" + str(run_id)
    owner = os.environ["GITHUB_REPOSITORY"].split("/")[0]
    existing = api("GET", "/pulls?state=open&head=" + urllib.parse.quote(owner + ":" + branch, safe=""))
    if existing:
        return existing[0]["html_url"]
    apply_fix(target)
    remote = git("ls-remote", "--heads", "origin", "refs/heads/" + branch).strip()
    if remote:
        # A prior attempt may have pushed successfully but failed to create the PR.
        git("fetch", "--no-tags", "origin", "refs/heads/" + branch)
        tree = git("show", "-s", "--format=%T", "FETCH_HEAD").strip()
        parents = git("show", "-s", "--format=%P", "FETCH_HEAD").decode().strip()
        if tree != git("write-tree").strip() or parents != meta["base_sha"]:
            raise ValueError("Existing branch differs from this verified repair")
    else:
        git("switch", "-c", branch)
        login = os.environ.get("CODEX_BOT_LOGIN", "github-actions[bot]")
        git("config", "user.name", login)
        git("config", "user.email", login + "@users.noreply.github.com")
        git("commit", "-m", "Fix issue #" + str(number) + " via Codex")
        # Only the publishing job has Git credentials; candidate code is never executed here.
        git("push", "origin", "HEAD:refs/heads/" + branch)
    result = fix_result(target / "report.json")
    body = ("Addresses #" + str(number) + ".\n\n" + result["summary"] + "\n\n"
            + "Validation reported by Codex:\n" + result["validation"] + "\n\n"
            + "The separate verification job passed the maintainer-configured test command.\n"
            + "Workflow: " + run_url + "\n\nReview the patch and test coverage before merging.")
    pr = api("POST", "/pulls", {"title": "Codex: Fix issue #" + str(number),
             "head": branch, "base": meta["base_branch"], "body": body, "draft": True})
    return pr["html_url"]


def upsert_comment(number, body):
    run_marker = "<!-- codex-issue-bot-run:" + str(issue_number(os.environ["GITHUB_RUN_ID"])) + " -->"
    if os.environ.get("GITHUB_EVENT_NAME") == "issue_comment":
        event, _ = event_context()
        comment_id = issue_number(event["comment"]["id"])
        comment_url = (os.environ["GITHUB_SERVER_URL"] + "/" + os.environ["GITHUB_REPOSITORY"]
                       + "/issues/" + str(number) + "#issuecomment-" + str(comment_id))
        body = "回應[這則留言](" + comment_url + ")：\n\n" + body
    body = MARKER + "\n" + run_marker + "\n" + body
    login = os.environ.get("CODEX_BOT_LOGIN", "github-actions[bot]")
    page = 1
    while True:
        comments = api("GET", "/issues/" + str(number) + "/comments?per_page=100&page=" + str(page))
        for comment in comments:
            if comment["user"]["login"] == login and run_marker in (comment.get("body") or ""):
                api("PATCH", "/issues/comments/" + str(comment["id"]), {"body": body})
                return
        if len(comments) < 100:
            break
        page += 1
    api("POST", "/issues/" + str(number) + "/comments", {"body": body})


def publish(root):
    _, meta = event_context()
    number = meta["issue_number"]
    issue = api("GET", "/issues/" + str(number))
    if issue["state"] != "open":
        print("Issue is closed; publication skipped.")
        return
    run_url = os.environ["GITHUB_SERVER_URL"] + "/" + os.environ["GITHUB_REPOSITORY"] + "/actions/runs/" + os.environ["GITHUB_RUN_ID"]
    if os.environ["TRIAGE_STATUS"] != "success":
        body = "自動分析未完成，請維護者檢查執行紀錄與 API key 設定。"
    else:
        check_meta(read_json(root / "triage" / "meta.json"))
        triage = triage_result(root / "triage" / "report.json")
        body = triage["reply"]
        if triage["auto_fix"]:
            if os.environ["FIX_STATUS"] != "success":
                body += "\n\n修復工作未完成，詳見執行紀錄。"
            else:
                result = fix_result(root / "fix" / "report.json")
                if not result["resolved"]:
                    body = result["reply"]
                elif os.environ["VERIFY_STATUS"] != "success":
                    body = result["summary"] + "\n\n獨立測試未通過，尚未建立修復 PR；請維護者檢查執行紀錄。"
                else:
                    try:
                        url = open_pr(root / "fix", meta, run_url)
                        body = result["reply"] + "\n\n已通過獨立測試並建立草稿 PR：" + url
                    except (ValueError, subprocess.CalledProcessError, urllib.error.HTTPError) as error:
                        # Do not expose request headers, credentials, or arbitrary command output.
                        body = result["summary"] + "\n\n測試已通過，但 PR 發布未完成。請維護者檢查 GitHub Actions 的 PR 權限與執行紀錄。"
                        upsert_comment(number, body + "\n\n執行紀錄：" + run_url)
                        raise RuntimeError("PR publication failed: " + type(error).__name__) from None
    upsert_comment(number, body + "\n\n執行紀錄：" + run_url)
    print("Issue reply published.")


def main():
    commands = {"prepare-triage": prepare_triage, "validate-triage": validate_triage,
                "prepare-fix": prepare_fix, "package-fix": package_fix,
                "apply-fix": apply_fix, "publish": publish}
    if len(sys.argv) != 3 or sys.argv[1] not in commands:
        raise SystemExit("Usage: issue_bot.py COMMAND ARTIFACT_DIRECTORY")
    commands[sys.argv[1]](Path(sys.argv[2]).resolve())


if __name__ == "__main__":
    main()
