import importlib.util
from pathlib import Path
from types import SimpleNamespace
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('terminal_hooks', Path(__file__).resolve().parents[1] / 'hooks.py')
hooks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hooks)


class HookTests(unittest.TestCase):
    def test_pre_update_closes_only_plugin_sessions(self):
        calls = []
        runtime = SimpleNamespace(close_all_terminal_sessions=lambda: calls.append('close'))
        with patch.dict(sys.modules, {hooks.RUNTIME_MODULE_NAME: runtime}):
            hooks.pre_update()
            self.assertEqual(calls, ['close'])
            self.assertIs(sys.modules[hooks.RUNTIME_MODULE_NAME], runtime)

    def test_uninstall_closes_sessions_and_clears_only_owned_modules(self):
        calls = []
        runtime = SimpleNamespace(close_all_terminal_sessions=lambda: calls.append('close'))
        other = SimpleNamespace()
        with patch.dict(sys.modules, {hooks.RUNTIME_MODULE_NAME: runtime, 'usr.plugins.unrelated': other}):
            hooks.uninstall()
            self.assertEqual(calls, ['close'])
            self.assertNotIn(hooks.RUNTIME_MODULE_NAME, sys.modules)
            self.assertIs(sys.modules['usr.plugins.unrelated'], other)


if __name__ == '__main__': unittest.main()
