#!/usr/bin/env python3
"""The cJSON nesting cap must be identical on the target, in the simulator
and in the host tests: the parsers run on 5-6 KB task stacks, and cJSON's
default of 1000 recursion levels lets a hostile "[[[[..." body panic the
panel. One number, three build files, so the host proves the target's limit."""

from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent
LIMIT = "CJSON_NESTING_LIMIT=16"

target = (root / "third_party/cjson/CMakeLists.txt").read_text(encoding="utf-8")
sim = (root / "sim/CMakeLists.txt").read_text(encoding="utf-8")
run = (root / "test/run.sh").read_text(encoding="utf-8")

assert re.search(
    r"target_compile_definitions\(\$\{COMPONENT_LIB\}\s+PRIVATE\s+" + LIMIT,
    target), "target cjson component must cap nesting at 16"
assert re.search(
    r"set_source_files_properties\(\.\./third_party/cjson/cJSON\.c\s+PROPERTIES\s+"
    r"COMPILE_DEFINITIONS\s+" + LIMIT, sim), (
    "simulator must compile cJSON.c with the same nesting cap")
assert re.search(r"-D" + LIMIT + r"\s+-c\s+\.\./third_party/cjson/cJSON\.c", run), (
    "host tests must compile cJSON.c with the same nesting cap")

# The cap is a -D on the cJSON compilation unit, which only works because
# cJSON.h guards its default; a vendored upgrade must keep that guard.
header = (root / "third_party/cjson/cJSON.h").read_text(encoding="utf-8")
assert "#ifndef CJSON_NESTING_LIMIT" in header

print("OK: cJSON:s nästningstak är 16 på target, i simulatorn och i hosttesterna")
