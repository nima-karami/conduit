import importlib.util
import json
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import patch


class MenuItem:
    def __init__(self, **props):
        assert props["label"] == "Open in Conduit"

    def connect(self, signal, callback, paths):
        assert signal == "activate"
        self.activate = lambda: callback(self, paths)


class File:
    def __init__(self, path):
        self.path = path

    def get_location(self):
        return self

    def get_path(self):
        return self.path


def require_version(name, version):
    assert (name, version) == ("Nautilus", "4.0")


gi = ModuleType("gi")
gi.require_version = require_version
repository = ModuleType("gi.repository")
repository.GObject = SimpleNamespace(GObject=type("GObject", (), {}))
repository.Nautilus = SimpleNamespace(
    MenuProvider=type("MenuProvider", (), {}), MenuItem=MenuItem
)
with patch.dict(sys.modules, {"gi": gi, "gi.repository": repository}):
    spec = importlib.util.spec_from_file_location("conduit", sys.argv[1])
    conduit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(conduit)

config = Path(sys.argv[2])
os.environ["XDG_CONFIG_HOME"] = str(config)
provider = conduit.ConduitMenu()
files = [File('/a space/é".txt'), File("/x'\nsecond")]

with patch.object(conduit.subprocess, "Popen") as popen:
    provider.get_file_items(files)[0].activate()
    provider.get_background_items(files[1])[0].activate()
    assert all(call.kwargs["shell"] is False for call in popen.call_args_list)
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps([call.args[0] for call in popen.call_args_list], ensure_ascii=False))

assert provider.get_file_items([File(None)]) == []
marker = config / "Conduit" / "file-manager-off"
marker.parent.mkdir(parents=True, exist_ok=True)
stale_item = provider.get_file_items(files)[0]
marker.touch()
with patch.object(conduit.subprocess, "Popen") as popen:
    stale_item.activate()
    popen.assert_not_called()
assert provider.get_file_items(files) == []
assert provider.get_background_items(files[1]) == []
