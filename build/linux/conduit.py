import os
import subprocess

import gi

gi.require_version("Nautilus", "4.0")
from gi.repository import GObject, Nautilus

EXECUTABLE = "/usr/bin/conduit"


def enabled():
    config = os.environ.get("XDG_CONFIG_HOME", "")
    if not os.path.isabs(config):
        config = os.path.expanduser("~/.config")
    return not os.path.exists(os.path.join(config, "Conduit", "file-manager-off"))


class ConduitMenu(GObject.GObject, Nautilus.MenuProvider):
    def get_file_items(self, files):
        return self._items(files)

    def get_background_items(self, folder):
        return self._items([folder])

    def _items(self, files):
        if not enabled():
            return []
        paths = [file.get_location().get_path() for file in files]
        if not paths or not all(paths):
            return []
        item = Nautilus.MenuItem(name="Conduit::Open", label="Open in Conduit")
        item.connect("activate", self._activate, paths)
        return [item]

    def _activate(self, _item, paths):
        if enabled():
            subprocess.Popen([EXECUTABLE, *paths], shell=False, start_new_session=True)
