from __future__ import annotations

from fastapi import FastAPI


def test_main_module_imports_and_exposes_fastapi_app():
    import app.main as main

    assert isinstance(main.app, FastAPI)