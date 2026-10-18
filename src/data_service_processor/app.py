import logging

from fastapi import FastAPI, HTTPException

from .models import Manifest
from .processor import process
from .runtime import s3_client

logger = logging.getLogger(__name__)
app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/jobs")
def run_job(manifest: Manifest):
    """Process one job synchronously. The Worker records the outcome in D1.

    The container is only reachable through the Worker, so there is no auth.
    """
    try:
        with s3_client() as s3:
            output_etag = process(s3, manifest)
    except Exception as error:
        logger.exception("Job %s failed", manifest.job_id)
        raise HTTPException(500, f"{type(error).__name__}: {error}"[:500]) from error
    return {"outputEtag": output_etag}
