#!/usr/bin/env python3
"""T1–T4 scored from one chat completion.

No CodeForge tool contract, tool loop, oracle, spec check, or runtime verify.
The task text is the task.json prompt. One extra instruction tells the model
to return changed files as markdown fences so this script can write them.
There is no second turn.

Score matches benchmarks/bench.mjs:
  hidden 60 · visible 15 · protected untouched 10 · checks 10 · no junk 5.

  python benchmarks/raw_api_bench.py --selftest
  python benchmarks/raw_api_bench.py --tasks T1,T2,T3,T4 --reps 3 --model qwen3.6-35b
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
TASKS = HERE / "tasks"
RESULTS = HERE / "results" / "raw-api"
HIDDEN_DIR = ".bench-hidden"
COPY_SKIP = {"bin", "obj", "node_modules", ".git", "TestResults", HIDDEN_DIR}
JUNK = re.compile(r"(^|/)(_tmp|tmp_|_vip_|_check_)[^/]*$|\.py$", re.I)
FENCE = re.compile(r"```([^\n`]*)\n(.*?)```", re.S)
TEXT_SUFFIXES = {
    ".js",
    ".md",
    ".json",
    ".txt",
    ".cs",
    ".csproj",
    ".slnx",
}


def js_round(value: float) -> int:
    return int(math.floor(value + 0.5))


def die(msg: str) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(1)


def load_tasks() -> list[dict]:
    tasks = []
    for directory in sorted(p for p in TASKS.iterdir() if p.is_dir()):
        task_path = directory / "task.json"
        if not task_path.exists():
            continue
        task = json.loads(task_path.read_text(encoding="utf-8"))
        task["_dir"] = directory
        tasks.append(task)
    return tasks


def find_tasks(keys: list[str]) -> list[dict]:
    tasks = load_tasks()
    chosen = []
    for key in keys:
        needle = key.lower()
        match = next(
            (
                task
                for task in tasks
                if task["id"].lower() == needle
                or task["id"].lower().startswith(needle + "-")
                or task["id"].lower().startswith(needle)
            ),
            None,
        )
        if match is None:
            die(f'Unknown task "{key}".')
        if match["id"].split("-")[0] not in {"T1", "T2", "T3", "T4"}:
            die(f'{match["id"]} is outside T1–T4.')
        chosen.append(match)
    return chosen


def copy_tree(src: Path, dest: Path) -> None:
    for entry in src.iterdir():
        if entry.name in COPY_SKIP:
            continue
        target = dest / entry.name
        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            copy_tree(entry, target)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(entry, target)


def materialize(task: dict, dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    fixture_name = task.get("fixture") or "shop"
    fixture = FIXTURES / fixture_name
    if not fixture.is_dir():
        die(f'Missing fixture "{fixture_name}".')
    copy_tree(fixture, dest)
    overlay = task["_dir"] / "overlay"
    if overlay.is_dir():
        copy_tree(overlay, dest)


def rel_files(root: Path) -> list[str]:
    found = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in COPY_SKIP for part in path.relative_to(root).parts):
            continue
        found.append(path.relative_to(root).as_posix())
    return sorted(found)


def snapshot(root: Path) -> dict[str, bytes]:
    return {rel: (root / rel).read_bytes() for rel in rel_files(root)}


def changed_files(before: dict[str, bytes], root: Path) -> list[str]:
    after = snapshot(root)
    changed = []
    for rel, data in after.items():
        if before.get(rel) != data:
            changed.append(rel)
    for rel in before:
        if rel not in after:
            changed.append(rel)
    return sorted(set(changed))


def apply_solution(root: Path, task: dict) -> None:
    edits = json.loads((task["_dir"] / "solution.json").read_text(encoding="utf-8"))
    for edit in edits:
        if "shell" in edit or "delete" in edit:
            die(f'{task["id"]} solution uses shell/delete; this scorer only applies replace edits.')
        path = root / edit["file"]
        text = path.read_text(encoding="utf-8")
        old, new = edit["replace"], edit["with"]
        count = text.count(old)
        if count == 0:
            die(f'{task["id"]}: replace text missing in {edit["file"]}.')
        text = text.replace(old, new) if edit.get("all") else text.replace(old, new, 1)
        path.write_text(text, encoding="utf-8", newline="\n")


def safe_rel(raw: str) -> str | None:
    text = raw.strip().strip("`").replace("\\", "/")
    if not text or text.startswith("/") or re.match(r"^[A-Za-z]:", text):
        return None
    parts = [part for part in text.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        return None
    rel = "/".join(parts)
    if not rel or Path(rel).suffix.lower() not in TEXT_SUFFIXES:
        return None
    return rel


def parse_fences(reply: str) -> dict[str, str]:
    files: dict[str, str] = {}
    for info, body in FENCE.findall(reply):
        token = info.strip()
        if token.lower().startswith("path="):
            token = token.split("=", 1)[1].strip()
        elif ":" in token and "/" in token:
            token = token.split(":", 1)[1].strip()
        rel = safe_rel(token)
        if rel is None:
            continue
        files[rel] = body
    return files


def apply_fences(root: Path, files: dict[str, str]) -> list[str]:
    written = []
    for rel, body in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8", newline="\n")
        written.append(rel)
    return written


def run_node_tests(root: Path, files: list[str]) -> dict:
    if not files:
        return {"pass": 0, "fail": 0, "output": "(no test files)"}
    try:
        completed = subprocess.run(
            ["node", "--test", "--test-reporter=tap", *files],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except FileNotFoundError:
        die("node is not on PATH.")
    except subprocess.TimeoutExpired as exc:
        return {"pass": 0, "fail": 1, "output": f"timeout: {exc}"}
    output = f"{completed.stdout or ''}{completed.stderr or ''}"

    def tap_count(label: str) -> int:
        found = re.search(rf"^# {label} (\d+)", output, re.M)
        return int(found.group(1)) if found else 0

    passed = tap_count("pass")
    failed = tap_count("fail")
    if completed.returncode != 0 and failed == 0:
        failed = 1
    return {"pass": passed, "fail": failed, "output": output}


def run_checks(root: Path, checks: list[dict], changed: list[str]) -> list[dict]:
    results = []
    for check in checks or []:
        kind = check.get("type")
        if kind == "absent":
            pattern = re.compile(check["pattern"])
            base = root / check["dir"]
            hits = []
            if base.is_dir():
                for path in base.rglob("*"):
                    if path.is_file() and pattern.search(path.read_text(encoding="utf-8", errors="replace")):
                        hits.append(path.relative_to(root).as_posix())
            results.append({**check, "ok": not hits, "detail": ", ".join(hits)})
        elif kind == "unchanged":
            hit = check["file"].replace("\\", "/") in changed
            results.append({**check, "ok": not hit, "detail": "modified" if hit else ""})
        elif kind == "contains":
            path = root / check["file"]
            ok = path.is_file() and re.search(check["pattern"], path.read_text(encoding="utf-8"), re.I | re.M) is not None
            results.append({**check, "ok": ok, "detail": "" if ok else "pattern not found"})
        elif kind == "exists":
            ok = (root / check["file"]).exists()
            results.append({**check, "ok": ok, "detail": "" if ok else "missing"})
        else:
            results.append({**check, "ok": False, "detail": f"unknown check type {kind}"})
    return results


def score_tree(root: Path, task: dict, before: dict[str, bytes]) -> dict:
    changed = changed_files(before, root)
    protected = [
        rel
        for rel in changed
        if any(rel.startswith(prefix.replace("\\", "/")) for prefix in task.get("protected") or [])
    ]
    junk = [rel for rel in changed if JUNK.search(rel)]
    checks = run_checks(root, task.get("checks") or [], changed)
    visible_files = [rel for rel in rel_files(root) if rel.startswith("test/") and rel.endswith(".test.js")]
    visible = run_node_tests(root, visible_files)
    hidden_src = task["_dir"] / "hidden"
    hidden_target = root / HIDDEN_DIR
    if hidden_target.exists():
        shutil.rmtree(hidden_target)
    hidden = {"pass": 0, "fail": 0, "output": "(no hidden)", "skipped": True}
    if hidden_src.is_dir():
        hidden_target.mkdir()
        copy_tree(hidden_src, hidden_target)
        hidden_files = [path.relative_to(root).as_posix() for path in hidden_target.rglob("*") if path.is_file()]
        hidden = run_node_tests(root, hidden_files)
        hidden["skipped"] = False
        shutil.rmtree(hidden_target)
    hidden_total = hidden["pass"] + hidden["fail"]
    hidden_ratio = 1.0 if hidden.get("skipped") else (hidden["pass"] / hidden_total if hidden_total else 0.0)
    visible_ok = visible["fail"] == 0 and visible["pass"] > 0
    checks_ok = all(item["ok"] for item in checks)
    score = js_round(
        60 * hidden_ratio
        + 15 * (1 if visible_ok else 0)
        + 10 * (0 if protected else 1)
        + 10 * (1 if checks_ok else 0)
        + 5 * (0 if junk else 1)
    )
    passed = hidden_ratio == 1 and visible_ok and not protected and checks_ok
    return {
        "pass": passed,
        "score": score,
        "hidden": {"pass": hidden["pass"], "fail": hidden["fail"]},
        "visible": {"pass": visible["pass"], "fail": visible["fail"]},
        "changedFiles": changed,
        "protectedTouched": protected,
        "junkFiles": junk,
        "checks": [{"type": item.get("type"), "ok": item["ok"], "why": item.get("why", "")} for item in checks],
    }


def prompt_for(task: dict, root: Path) -> str:
    chunks = [
        "Return only the files you change.",
        "For each file, emit one markdown fence whose info string is the path relative to the project root and whose body is the complete new file.",
        "Do not add an explanation.",
        "",
        "Task:",
        task["prompt"],
        "",
        "Project files:",
    ]
    for rel in rel_files(root):
        path = root / rel
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        chunks.append(f"===== {rel} =====")
        chunks.append(path.read_text(encoding="utf-8"))
    return "\n".join(chunks)


def load_server(server_id: str | None, model: str | None) -> tuple[str, str, str]:
    settings_path = Path.home() / ".CodeForge" / "ai" / "settings.json"
    if not settings_path.is_file():
        die(f"No settings file at {settings_path}. Pass --base-url and --model.")
    settings = json.loads(settings_path.read_text(encoding="utf-8"))
    chosen_id = server_id or settings.get("activeServerId") or ""
    servers = settings.get("servers") or []
    server = next((item for item in servers if item.get("id") == chosen_id and item.get("enabled") is not False), None)
    if server is None or not str(server.get("baseUrl") or "").strip():
        die(f"No usable server (id={chosen_id or 'none'}).")
    chosen_model = (model or (settings.get("activeModel") if settings.get("activeServerId") == chosen_id else "") or "").strip()
    if not chosen_model:
        models = server.get("models") or []
        chosen_model = models[0] if models else ""
    if not chosen_model:
        die("No model. Pass --model.")
    return str(server["baseUrl"]).rstrip("/"), str(server.get("apiKey") or ""), chosen_model


def chat(base_url: str, api_key: str, model: str, prompt: str, temperature: float, max_tokens: int) -> tuple[str, str]:
    url = base_url + "/chat/completions"
    body = {
        "model": model,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=900) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        die(f"API HTTP {exc.code}: {detail}")
    except urllib.error.URLError as exc:
        die(f"API request failed: {exc.reason}")
    choice = (payload.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    content = message.get("content") or ""
    return str(content), str(choice.get("finish_reason") or "")


def run_once(task: dict, base_url: str, api_key: str, model: str, temperature: float, max_tokens: int) -> dict:
    with tempfile.TemporaryDirectory(prefix="raw-api-") as tmp:
        root = Path(tmp) / "work"
        materialize(task, root)
        before = snapshot(root)
        prompt = prompt_for(task, root)
        reply, finish = chat(base_url, api_key, model, prompt, temperature, max_tokens)
        files = parse_fences(reply)
        apply_fences(root, files)
        scored = score_tree(root, task, before)
    return {
        "task": task["id"],
        "model": model,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "finish_reason": finish,
        "filesReturned": sorted(files),
        "replyChars": len(reply),
        **scored,
    }


def selftest() -> None:
    tasks = find_tasks(["T1", "T2", "T3", "T4"])
    sample = parse_fences("```src/cart/totals.js\nmodule.exports = {};\n```\n```javascript\nno path\n```")
    if sample != {"src/cart/totals.js": "module.exports = {};\n"}:
        die(f"fence parser failed: {sample}")
    if safe_rel("../secrets.js") is not None or safe_rel("C:/x.js") is not None:
        die("fence parser accepted a path outside the project")
    for task in tasks:
        with tempfile.TemporaryDirectory(prefix="raw-api-self-") as tmp:
            root = Path(tmp) / "work"
            materialize(task, root)
            before = snapshot(root)
            bare = score_tree(root, task, before)
            if bare["score"] >= 100 or bare["pass"]:
                die(f'{task["id"]} bare tree scored {bare["score"]} (expected a failing baseline)')
            apply_solution(root, task)
            solved = score_tree(root, task, before)
            if solved["score"] != 100 or not solved["pass"]:
                die(f'{task["id"]} solution scored {solved["score"]} pass={solved["pass"]} hidden={solved["hidden"]} visible={solved["visible"]} checks={solved["checks"]}')
            print(f'{task["id"]}: bare {bare["score"]} → solution {solved["score"]}')
    print("raw_api_bench selftest: ok")


def main() -> None:
    parser = argparse.ArgumentParser(description="Score T1–T4 from one direct API completion.")
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--tasks", default="T1,T2,T3,T4")
    parser.add_argument("--reps", type=int, default=1)
    parser.add_argument("--model", default=os.environ.get("CODEFORGE_BENCH_MODEL") or None)
    parser.add_argument("--server", default=None)
    parser.add_argument("--base-url", default=os.environ.get("CODEFORGE_BENCH_BASE_URL") or None)
    parser.add_argument("--temperature", type=float, default=0.7)
    parser.add_argument("--max-tokens", type=int, default=4096)
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return
    if args.reps < 1:
        die("--reps must be >= 1")
    tasks = find_tasks([part.strip() for part in args.tasks.split(",") if part.strip()])
    if args.base_url:
        base_url = args.base_url.rstrip("/")
        api_key = os.environ.get("CODEFORGE_BENCH_API_KEY") or ""
        model = args.model or ""
        if not model:
            die("Pass --model with --base-url.")
    else:
        base_url, api_key, model = load_server(args.server, args.model)
    RESULTS.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    rows = []
    for task in tasks:
        for rep in range(1, args.reps + 1):
            print(f'running {task["id"]} rep {rep}/{args.reps} …', flush=True)
            row = run_once(task, base_url, api_key, model, args.temperature, args.max_tokens)
            row["rep"] = rep
            rows.append(row)
            print(f'  {task["id"]} r{rep}: score {row["score"]} pass {row["pass"]} files {len(row["filesReturned"])} finish {row["finish_reason"]}')
    by_task: dict[str, list[int]] = {}
    for row in rows:
        by_task.setdefault(row["task"], []).append(row["score"])
    print("")
    print(f"model {model}  temperature {args.temperature}  one completion, no tools")
    for task_id, scores in by_task.items():
        mean = sum(scores) / len(scores)
        print(f"  {task_id}: mean {mean:.1f}  scores {scores}")
    out = RESULTS / f"{stamp}.json"
    out.write_text(json.dumps({"model": model, "temperature": args.temperature, "rows": rows}, indent=2), encoding="utf-8")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
