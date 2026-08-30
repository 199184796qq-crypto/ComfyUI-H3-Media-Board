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
            required[f"enabled_{index}"] = (
                "BOOLEAN",
                {
                    "default": True,
                    "tooltip": "Keep the selected LoRA and its strength, but skip applying it when disabled.",
                },
            )
        return {
            "required": required,
            "optional": {
                "clip": (
                    "CLIP",
                    {
                        "tooltip": "Optional. Connect the text encoder to also apply compatible token-refiner / CLIP LoRA weights.",
                    },
                ),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
    FUNCTION = "load_loras"
    CATEGORY = "loaders"
    DESCRIPTION = (
        "Add LoRA rows with the + button. Rows are applied from top to bottom; "
        "an empty or disabled LoRA row is bypassed."
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

    def load_loras(self, model, lora_count=1, clip=None, **kwargs):
        active_count = max(1, min(self.MAX_LORAS, int(lora_count)))
        applied_loras = []
        for index in range(1, active_count + 1):
            lora_name = kwargs.get(f"lora_{index}", EMPTY_LORA)
            lora_enabled = kwargs.get(f"enabled_{index}", True)
            # Dynamic rows that have just been revealed can be serialized as
            # null by the frontend until the user touches their strength
            # widget. Treat that empty value as the documented default.
            raw_strength = kwargs.get(f"model_strength_{index}", 1.0)
            model_strength = 1.0 if raw_strength in (None, "") else float(raw_strength)
            if lora_name in (None, "", EMPTY_LORA, "None"):
                continue
            if not bool(lora_enabled):
                print(f"[多 LoRA 加载器] 跳过第 {index} 条（已关闭）：{lora_name}")
                continue
            if model_strength == 0:
                continue

            print(
                f"[多 LoRA 加载器] 正在加载第 {index} 条：{lora_name} "
                f"（模型强度 {model_strength:g}）"
            )
            lora, metadata = self._load_file(lora_name)
            model, clip = comfy.sd.load_lora_for_models(
                model,
                clip,
                lora,
                model_strength,
                model_strength if clip is not None else 0,
                lora_metadata=metadata,
            )
            applied_loras.append(f"第 {index} 条 {lora_name}")
        if applied_loras:
            print(
                f"[多 LoRA 加载器] 加载完成：共 {len(applied_loras)} 条，"
                f"活动行 {active_count} 条。"
            )
        else:
            print(
                f"[多 LoRA 加载器] 未加载 LoRA：{active_count} 条活动行均为空或模型强度为 0。"
            )
        return (model, clip)


NODE_CLASS_MAPPINGS = {"MultiLoRALoader": MultiLoRALoader}
NODE_DISPLAY_NAME_MAPPINGS = {"MultiLoRALoader": "多 LoRA 加载器"}
