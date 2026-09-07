import ast
from pathlib import Path
import sys
import unittest
from typing import Any

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT.parents[1]))

from audio_control import control_audio
from comfy.nested_tensor import NestedTensor

# Exercise the routing class without starting the plugin's HTTP server routes.
tree = ast.parse((ROOT / "nodes.py").read_text(encoding="utf-8"))
route_class = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                   and node.name == "H3ConditionLatentSwitch")
scope = {"Any": Any, "control_audio": control_audio}
exec(compile(ast.Module(body=[route_class], type_ignores=[]), "nodes.py", "exec"), scope)
Switch = scope["H3ConditionLatentSwitch"]


class AudioVAE:
    audio_sample_rate = 32000

    def __init__(self, length):
        self.length = length
        self.calls = 0

    def encode(self, waveform):
        self.calls += 1
        self.waveform = waveform
        return torch.ones(1, 32, 2, self.length)


class AudioControlTests(unittest.TestCase):
    def setUp(self):
        self.video = torch.randn(1, 24, 2, 2, 2)
        self.audio = torch.zeros(1, 32, 2, 8)
        self.mask = torch.rand(1, 1, 2, 2, 2)
        self.latent = {"samples": NestedTensor((self.video, self.audio)),
                       "noise_mask": NestedTensor((self.mask, torch.ones_like(self.audio))),
                       "metadata": "keep"}
        self.source = {"waveform": torch.zeros(1, 2, 320), "sample_rate": 32000}

    def test_native_and_old_route_defaults(self):
        cond, latent, mux = Switch().route(True, image_text_conditioning=[], image_text_latent=self.latent)
        self.assertIs(latent, self.latent)
        self.assertIsNone(mux)

    def test_lock_pads_and_preserves_video_and_input(self):
        vae = AudioVAE(5)
        output = control_audio(self.latent, "lock_source", 0.8, self.source, vae)
        video, audio = output["samples"].unbind()
        video_mask, audio_mask = output["noise_mask"].unbind()
        self.assertIs(video, self.video)
        self.assertIs(video_mask, self.mask)
        self.assertEqual(output["metadata"], "keep")
        self.assertEqual(vae.calls, 1)
        self.assertEqual(tuple(vae.waveform.shape), (1, 320, 2))
        self.assertTrue(torch.all(audio[..., :5] == 1))
        self.assertTrue(torch.all(audio[..., 5:] == 0))
        self.assertTrue(torch.all(audio_mask == 0))
        self.assertTrue(torch.all(self.audio == 0))
        self.assertTrue(torch.all(self.latent["noise_mask"].unbind()[1] == 1))

    def test_remix_truncates_and_preserves_legacy_mask(self):
        self.latent["noise_mask"] = self.mask
        output = control_audio(self.latent, "remix_source", 0.35, self.source, AudioVAE(12))
        self.assertEqual(output["samples"].unbind()[1].shape, self.audio.shape)
        self.assertIs(output["noise_mask"].unbind()[0], self.mask)
        torch.testing.assert_close(output["noise_mask"].unbind()[1], torch.full_like(self.audio, 0.35))

    def test_external_branch_and_mux_priority(self):
        final = {"waveform": torch.ones(1, 2, 320), "sample_rate": 32000}
        cond = [["reference"]]
        result = Switch().route(True, external_switch=False, multi_reference_conditioning=cond,
                                multi_reference_latent=self.latent, drive_audio=self.source, final_audio=final)
        self.assertIs(result[0], cond)
        self.assertIs(result[2], final)
        result = Switch().route(False, multi_reference_conditioning=cond,
                                multi_reference_latent=self.latent, drive_audio=self.source,
                                audio_vae=AudioVAE(8), audio_mode="lock_source")
        self.assertIs(result[2], self.source)
        self.assertTrue(torch.all(result[1]["noise_mask"].unbind()[1] == 0))
        self.assertEqual(Switch().check_lazy_status(True, external_switch=False),
                         ["multi_reference_conditioning", "multi_reference_latent"])

    def test_resample_and_missing_inputs(self):
        source = {"waveform": torch.zeros(1, 2, 480), "sample_rate": 48000}
        vae = AudioVAE(8)
        control_audio(self.latent, "lock_source", 0.35, source, vae)
        self.assertEqual(vae.waveform.shape[1], 320)
        with self.assertRaisesRegex(ValueError, "drive_audio"):
            control_audio(self.latent, "lock_source")


if __name__ == "__main__":
    unittest.main()
