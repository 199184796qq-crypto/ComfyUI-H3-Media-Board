"""Load the installed T8 sampling module without executing its node entrypoint."""
import importlib
import sys
import types
from pathlib import Path

import folder_paths


def load_t8_sampling():
    package_name = "_motion_con_installed_t8"
    module_name = package_name + ".sampling"
    if module_name in sys.modules:
        return sys.modules[module_name]
    for root in folder_paths.get_folder_paths("custom_nodes"):
        directory = Path(root) / "minimax-h3-audio-T8"
        if (directory / "sampling.py").is_file():
            package = types.ModuleType(package_name)
            package.__path__ = [str(directory)]
            package.__package__ = package_name
            sys.modules[package_name] = package
            return importlib.import_module(module_name)
    raise RuntimeError(
        "motion_con requires minimax-h3-audio-T8 with sampling.py installed "
        "in a ComfyUI custom_nodes directory."
    )
