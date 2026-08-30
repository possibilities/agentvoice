from __future__ import annotations

import contextlib
import importlib
import io
import json
import os
import pathlib
import subprocess
import sys
import traceback


workspace = pathlib.Path(os.environ["AGENTVOICE_EVAL_WORKSPACE"])
checks: list[dict[str, object]] = []


def check(name: str, run) -> None:
    try:
        detail = run()
        checks.append({"name": name, "passed": True, "detail": detail})
    except Exception as error:  # noqa: BLE001 - an oracle must report every failure
        checks.append({"name": name, "passed": False, "detail": str(error)})


public = subprocess.run(
    [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
    cwd=workspace,
    capture_output=True,
    text=True,
    timeout=30,
)
checks.append(
    {
        "name": "public test suite",
        "passed": public.returncode == 0,
        "detail": public.stdout + public.stderr,
    }
)

sys.path.insert(0, str(workspace))
try:
    inventory_module = importlib.import_module("inventory")
    Inventory = inventory_module.Inventory

    def exact_replay() -> str:
        inventory = Inventory({"desk": 5})
        original = inventory.reserve("req-1", "desk", 2)
        replay = inventory.reserve("req-1", "desk", 2)
        assert replay is original, "exact replay did not return the original reservation object"
        assert inventory.available("desk") == 3, "exact replay decremented stock again"
        return "original object returned; stock stayed at 3"

    check("exact replay is idempotent", exact_replay)

    def conflicting_quantity() -> str:
        inventory = Inventory({"desk": 5})
        original = inventory.reserve("req-1", "desk", 2)
        try:
            inventory.reserve("req-1", "desk", 1)
        except ValueError as error:
            text = str(error).lower()
            assert "req-1" in text or "request" in text, "error does not identify request-ID reuse"
        else:
            raise AssertionError("conflicting quantity was accepted")
        assert inventory.available("desk") == 3, "conflict mutated stock"
        assert inventory.reservation("req-1") is original, "conflict replaced original reservation"
        return "conflict rejected without mutation"

    check("conflicting quantity is actionable", conflicting_quantity)

    def conflicting_sku() -> str:
        inventory = Inventory({"desk": 5, "lamp": 4})
        original = inventory.reserve("req-1", "desk", 2)
        try:
            inventory.reserve("req-1", "lamp", 2)
        except ValueError:
            pass
        else:
            raise AssertionError("conflicting SKU was accepted")
        assert inventory.available("desk") == 3
        assert inventory.available("lamp") == 4
        assert inventory.reservation("req-1") is original
        return "SKU conflict rejected without mutating either SKU"

    check("conflicting SKU is rejected", conflicting_sku)

    def rejected_first_attempt_does_not_claim_key() -> str:
        inventory = Inventory({"desk": 1})
        with contextlib.suppress(ValueError):
            inventory.reserve("req-1", "desk", 2)
        accepted = inventory.reserve("req-1", "desk", 1)
        assert accepted.quantity == 1
        assert inventory.available("desk") == 0
        return "request ID remained reusable after rejected attempt"

    check("failed attempt does not consume idempotency key", rejected_first_attempt_does_not_claim_key)
except Exception as error:  # noqa: BLE001
    checks.append(
        {
            "name": "module import",
            "passed": False,
            "detail": f"{error}\n{traceback.format_exc()}",
        }
    )

passed = sum(1 for item in checks if item["passed"])
print(
    json.dumps(
        {
            "passed": passed,
            "total": len(checks),
            "score": passed / len(checks) if checks else 0,
            "checks": checks,
        },
        indent=2,
    )
)
