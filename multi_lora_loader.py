"""A compact, sequential multi-LoRA loader for ComfyUI."""

import folder_paths
import comfy.sd
import comfy.utils


EMPTY_LORA = "(空 / 绕过)"


class MultiLoRALoader:
    """Apply any number of LoRAs, in the order shown in the node."""

    MAX_LORAS = 16

    def __init__(self):
        self._cache = {}

    @classmethod
    def INPUT_TYPES(cls):
        lora_choices = [EMPTY_LORA] + folder_paths.get_filename_list("loras")
        required = {
            "model": ("MODEL", {"tooltip": "Base diffusion model."}),
            "clip": ("CLIP", {"tooltip": "Base text encoder."}),
            "lora_count": (
                "INT",
                {"default": 1, "min": 1, "max": cls.MAX_LORAS, "step": 1},
            ),
        }
        for index in range(1, cls.MAX_LORAS + 1):
            required[f"lora_{index}"] = (
                lora_choices,
                {"default": EMPTY_LORA, "tooltip": "Choose empty to bypass this row."},
            )
            required[f"model_strength_{index}"] = (
                "FLOAT",
                {
                    "default": 1.0,
                    "min": -100.0,
                    "max": 100.0,
                    "step": 0.01,
                    "tooltip": "LoRA strength applied to the diffusion model.",
                },
            )
            required[f"clip_strength_{index}"] = (
                "FLOAT",
                {
                    "default": 1.0,
                    "min": -100.0,
                    "max": 100.0,
                    "step": 0.01,
                    "tooltip": "LoRA strength applied to CLIP / text encoder.",
                },
            )
        return {"required": required}

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
    FUNCTION = "load_loras"
    CATEGORY = "loaders"
    DESCRIPTION = (
        "Add LoRA rows with the + button. Rows are applied from top to bottom; "
        "an empty LoRA row is bypassed."
    )

    def _load_file(self, lora_name):
        path = folder_paths.get_full_path_or_raise("loras", lora_name)
        cached = self._cache.get(path)
        if cached is None:
            cached = comfy.utils.load_torch_file(
                path, safe_load=True, return_metadata=True
            )
            self._cache = {path: cached}
        return cached

    def load_loras(self, model, clip, lora_count=1, **kwargs):
        active_count = max(1, min(self.MAX_LORAS, int(lora_count)))
        for index in range(1, active_count + 1):
            lora_name = kwargs.get(f"lora_{index}", EMPTY_LORA)
            model_strength = float(kwargs.get(f"model_strength_{index}", 1.0))
            clip_strength = float(kwargs.get(f"clip_strength_{index}", 1.0))

            if lora_name in (None, "", EMPTY_LORA, "None"):
                continue
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
        return (model, clip)


NODE_CLASS_MAPPINGS = {"MultiLoRALoader": MultiLoRALoader}
NODE_DISPLAY_NAME_MAPPINGS = {"MultiLoRALoader": "多 LoRA 加载器"}
