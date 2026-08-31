"""Stable multi-LoRA loader that keeps ComfyUI widget serialization fixed."""

import folder_paths
import comfy.sd
import comfy.utils


BYPASS_LORA = "(绕过)"
LORA_CONFIG_SYNC = "STABLE_MULTI_LORA_CONFIG"


class StableMultiLoRALoader:
    """Apply a chosen number of LoRAs without dynamically changing input order."""

    MAX_LORAS = 16

    def __init__(self):
        self._cache = {}

    @classmethod
    def INPUT_TYPES(cls):
        choices = [BYPASS_LORA] + folder_paths.get_filename_list("loras")
        required = {
            "model": ("MODEL", {"tooltip": "Base diffusion model."}),
            "lora_count": (
                "INT",
                {
                    "default": 1,
                    "min": 1,
                    "max": cls.MAX_LORAS,
                    "step": 1,
                    "tooltip": "Use the +/- controls to add or remove visible LoRA rows.",
                },
            ),
        }
        # These inputs deliberately remain in one fixed, per-row order. The
        # frontend only hides inactive rows; it never adds or reorders widgets.
        for index in range(1, cls.MAX_LORAS + 1):
            required[f"lora_{index}"] = (
                choices,
                {"default": BYPASS_LORA, "tooltip": "Select a LoRA, or choose bypass."},
            )
            required[f"model_strength_{index}"] = (
                "FLOAT",
                {
                    "default": 1.0,
                    "min": -100.0,
                    "max": 100.0,
                    "step": 0.01,
                    "tooltip": "Strength applied to the diffusion model.",
                },
            )
            required[f"clip_strength_{index}"] = (
                "FLOAT",
                {
                    "default": 1.0,
                    "min": -100.0,
                    "max": 100.0,
                    "step": 0.01,
                    "tooltip": "Strength applied to CLIP when a CLIP input is connected.",
                },
            )
            required[f"bypass_{index}"] = (
                "BOOLEAN",
                {
                    "default": False,
                    "tooltip": "Skip this LoRA without clearing its selected file or strengths.",
                },
            )
        return {
            "required": required,
            "optional": {
                "clip": (
                    "CLIP",
                    {"tooltip": "Optional. When connected, each row uses its CLIP strength."},
                ),
                "lora_sync": (
                    LORA_CONFIG_SYNC,
                    {"label": "LoRA 配置同步", "tooltip": "接上游稳定版多 LoRA 加载器的同步输出后，忽略本节点自己的 LoRA 配置。"},
                ),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", LORA_CONFIG_SYNC)
    RETURN_NAMES = ("模型", "CLIP", "LoRA 配置同步")
    FUNCTION = "load_loras"
    CATEGORY = "loaders"
    DESCRIPTION = "Stable multi-LoRA loader. Use LoRA count +/- to show rows; each row can be bypassed independently."

    def _load_file(self, lora_name):
        path = folder_paths.get_full_path_or_raise("loras", lora_name)
        cached = self._cache.get(path)
        if cached is None:
            cached = comfy.utils.load_torch_file(path, safe_load=True, return_metadata=True)
            self._cache = {path: cached}
        return cached

    @classmethod
    def _local_config(cls, lora_count, values):
        count = max(1, min(cls.MAX_LORAS, int(lora_count)))
        return {
            "version": 1,
            "lora_count": count,
            "rows": [
                {
                    "lora": values.get(f"lora_{index}", BYPASS_LORA),
                    "model_strength": float(values.get(f"model_strength_{index}", 1.0)),
                    "clip_strength": float(values.get(f"clip_strength_{index}", 1.0)),
                    "bypass": bool(values.get(f"bypass_{index}", False)),
                }
                for index in range(1, count + 1)
            ],
        }

    @classmethod
    def _normalize_sync_config(cls, value):
        if not isinstance(value, dict) or not isinstance(value.get("rows"), list):
            return None
        try:
            count = max(1, min(cls.MAX_LORAS, int(value.get("lora_count", 1))))
            rows = []
            for index in range(count):
                row = value["rows"][index] if index < len(value["rows"]) else {}
                if not isinstance(row, dict):
                    row = {}
                rows.append(
                    {
                        "lora": row.get("lora", BYPASS_LORA),
                        "model_strength": float(row.get("model_strength", 1.0)),
                        "clip_strength": float(row.get("clip_strength", 1.0)),
                        "bypass": bool(row.get("bypass", False)),
                    }
                )
            return {"version": 1, "lora_count": count, "rows": rows}
        except (TypeError, ValueError):
            return None

    def load_loras(self, model, lora_count=1, clip=None, lora_sync=None, **kwargs):
        config = self._normalize_sync_config(lora_sync) or self._local_config(lora_count, kwargs)
        count = config["lora_count"]
        if lora_sync is not None and self._normalize_sync_config(lora_sync) is not None:
            print("[稳定多 LoRA] 使用上游 LoRA 配置同步。")
        applied = []
        for index in range(1, count + 1):
            row = config["rows"][index - 1]
            lora_name = row["lora"]
            if lora_name in (None, "", BYPASS_LORA, "None"):
                continue
            if row["bypass"]:
                print(f"[稳定多 LoRA] 跳过第 {index} 条：{lora_name}")
                continue

            model_strength = row["model_strength"]
            clip_strength = row["clip_strength"] if clip is not None else 0.0
            if model_strength == 0 and clip_strength == 0:
                continue

            lora, metadata = self._load_file(lora_name)
            model, clip = comfy.sd.load_lora_for_models(
                model,
                clip,
                lora,
                model_strength,
                clip_strength,
                lora_metadata=metadata,
            )
            applied.append(lora_name)
            print(
                f"[稳定多 LoRA] 已加载第 {index} 条：{lora_name} "
                f"（模型 {model_strength:g}，CLIP {clip_strength:g}）"
            )

        if not applied:
            print("[稳定多 LoRA] 未加载任何 LoRA。")
        return (model, clip, config)


NODE_CLASS_MAPPINGS = {"StableMultiLoRALoader": StableMultiLoRALoader}
NODE_DISPLAY_NAME_MAPPINGS = {"StableMultiLoRALoader": "稳定版多 LoRA 加载器"}
