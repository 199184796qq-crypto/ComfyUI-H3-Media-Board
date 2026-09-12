"""Run with the ComfyUI root on PYTHONPATH."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from motion_con import nodes
from motion_con import t8_loader
from motion_con.drift_control_av import matched_noise_ratio


class PortableTests(unittest.TestCase):
    def test_installed_t8_relative_imports(self):
        sampling = t8_loader.load_t8_sampling()
        self.assertTrue(callable(sampling.setup_dual_clock_sampling))

    def test_first_segment_does_not_install_mask(self):
        sampling = t8_loader.load_t8_sampling()
        model, sampler, latent = object(), object(), {"samples": object()}
        sigmas = torch.tensor([1., .5, 0.])
        with patch.object(sampling, "setup_dual_clock_sampling", return_value=(model, sampler, sigmas)):
            with patch.object(nodes, "install_drift_control_av_model") as install:
                result = nodes.MotionConT8Wrapper().apply(
                    model, latent, 4, 12., 3., "dual_clock_euler", "native_flow", "22")
                self.assertIs(result[3], latent)
                install.assert_not_called()

    def test_no_machine_paths(self):
        for file in Path(nodes.__file__).parent.glob("*.py"):
            self.assertNotIn("E:\\AI", file.read_text(encoding="utf-8"))

    def test_schedule_ratio(self):
        self.assertEqual(matched_noise_ratio(1., [1., .5, 0.]), .5)
        self.assertEqual(matched_noise_ratio(.5, [1., .5, 0.]), 0.)


if __name__ == "__main__":
    unittest.main()
