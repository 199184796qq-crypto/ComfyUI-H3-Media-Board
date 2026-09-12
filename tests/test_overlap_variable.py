"""Check getter output without loading ComfyUI or models."""
import ast
from pathlib import Path
from typing import Any

source = ast.parse((Path(__file__).parents[1] / "nodes.py").read_text(encoding="utf-8"))
parts = [node for node in source.body if
         isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "H3MB_VARIABLE_NAMES" for t in node.targets)
         or isinstance(node, ast.ClassDef) and node.name == "H3MediaBoardVariableGet"]
scope = {"Any": Any}
exec(compile(ast.Module(body=parts, type_ignores=[]), "getter", "exec"), scope)
getter = scope["H3MediaBoardVariableGet"]()
for frames in (5, 22, 39, 56):
    for name in ("H3mb_重叠帧数", "H3_ConLength"):
        value, = getter.get_value(name, frames)
        assert type(value) is str and value == str(frames)
        assert value in ["22", "5", "39", "56"]
for frames in (0, 5, 22, 39, 56):
    for name in ("H3mb_裁剪帧数", "H3_tremFames"):
        value, = getter.get_value(name, frames)
        assert type(value) is int and value == frames
print("PASS: overlap matches context dropdown values; trim remains INT")
