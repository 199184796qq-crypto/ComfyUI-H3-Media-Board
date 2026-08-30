"""Stable multi-LoRA loader that keeps ComfyUI widget serialization fixed."""

import folder_paths
import comfy.sd
import comfy.utils


BYPASS_LORA = "(绕过)"


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
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("模型", "CLIP")
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

    def load_loras(self, model, lora_count=1, clip=None, **kwargs):
        count = max(1, min(self.MAX_LORAS, int(lora_count)))
        applied = []
        for index in range(1, count + 1):
            lora_name = kwargs.get(f"lora_{index}", BYPASS_LORA)
            if lora_name in (None, "", BYPASS_LORA, "None"):
                continue
            if bool(kwargs.get(f"bypass_{index}", False)):
                print(f"[稳定多 LoRA] 跳过第 {index} 条：{lora_name}")
                continue

            model_strength = float(kwargs.get(f"model_strength_{index}", 1.0))
            clip_strength = float(kwargs.get(f"clip_strength_{index}", 1.0)) if clip is not None else 0.0
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
        return (model, clip)


NODE_CLASS_MAPPINGS = {"StableMultiLoRALoader": StableMultiLoRALoader}
NODE_DISPLAY_NAME_MAPPINGS = {"StableMultiLoRALoader": "稳定版多 LoRA 加载器"}
