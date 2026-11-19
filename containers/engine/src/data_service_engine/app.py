"""HTTP API for the uniform Python workflow operation service.

Only the Worker calls this service, so there is no auth layer here.
"""

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from .operations import runtime as operations_runtime
from .operations.registry import dispatch, operations

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/operations")
def list_operations():
    """Each workflow operation's name, description and JSON Schemas."""
    return [operation.describe() for operation in operations().values()]


@app.post("/operations/{name}")
async def invoke_operation(name: str, request: Request):
    """Run one workflow operation: `{execution, inputs, params}` in, small
    JSON out. Failures are never a 200: the body is `{error: {kind, message,
    issues}}`, `kind` telling the caller whether a retry may help."""
    body = await request.body()
    outcome = await run_in_threadpool(
        dispatch, name, body, operations_runtime.operation_storage
    )
    return JSONResponse(outcome.body, status_code=outcome.status)
