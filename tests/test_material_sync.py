import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


class MaterialSyncTests(unittest.TestCase):
    def test_import_and_containment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            routes = types.SimpleNamespace(post=lambda path: lambda function: function)
            stubs = {
                "folder_paths": types.SimpleNamespace(get_input_directory=lambda: directory),
                "server": types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes))),
                "aiohttp": types.SimpleNamespace(web=types.SimpleNamespace()),
                "h3_test.nodes": types.SimpleNamespace(_h3_settings=lambda *args: {}),
            }
            spec = importlib.util.spec_from_file_location("h3_test.material_sync", Path(__file__).resolve().parents[1] / "material_sync.py")
            module = importlib.util.module_from_spec(spec)
            with patch.dict(sys.modules, stubs):
                spec.loader.exec_module(module)
            board = root / "h3_media_board"
            board.mkdir()
            source = board / "sample.png"
            source.write_bytes(b"test-media")
            manifest = {"image":[None,{"path":"h3_media_board/sample.png","name":"sample"}]}
            first = module.import_media(manifest)
            self.assertEqual(first[0]["slot"],1)
            self.assertEqual((root / first[0]["filename"]).read_bytes(), b"test-media")
            self.assertEqual(module.import_media(manifest),first)
            self.assertEqual(len(list((root / "minimax_h3_timeline_director").iterdir())),1)
            source.write_bytes(b"replacement-longer")
            self.assertNotEqual(module.import_media(manifest)[0]["filename"],first[0]["filename"])
            with self.assertRaises(ValueError):
                module.import_media({"image":[{"path":"../outside.png"}]})
            with self.assertRaises(ValueError):
                module.import_media({"image":"invalid"})
            with self.assertRaises(FileNotFoundError):
                module.import_media({"video":[{"path":"h3_media_board/missing.mp4"}]})


if __name__ == "__main__":
    unittest.main()
