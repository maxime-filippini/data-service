This diagram includes planned ingestion. Run-based ingestion is not yet wired
to cron or HTTP. Queue delivery is implemented through the Worker consumer,
which invokes the private container; the queue does not deliver directly to
Python. See [current architecture](MARKET_DATA_ARCHITECTURE.md) and
[next steps](NEXT_STEPS_SPEC.md) for the implementation boundary.

```mermaid
sequenceDiagram
    autonumber

    participant Schedule as Daily schedule
    participant Worker as Cloudflare Worker<br/>control plane
    participant D1 as D1<br/>run and job state
    participant Provider as Market-data API
    participant Raw as R2<br/>raw-market-data
    participant Queue as Queue<br/>(future)
    participant Processor as Python container<br/>processor
    participant Processed as R2<br/>processed-market-data

    rect rgb(225, 238, 255)
        Note over Schedule,Raw: Worker deployment unit — daily ingestion
        Schedule->>Worker: Trigger daily ingestion for a symbol
        Worker->>D1: Create ingestion run (fetching)
        Worker->>Provider: HTTPS fetch daily market data
        Provider-->>Worker: Validated provider response
        Worker->>Raw: Write immutable response.json
        Raw-->>Worker: Object key and ETag
        Worker->>D1: Mark run raw_complete<br/>record object metadata
        Worker->>D1: Create processing job<br/>freeze eligible raw runs
        D1-->>Worker: Queued job with fixed manifest
    end

    alt Current manual handoff
        Note over Worker,Processor: Operator starts the container with the job ID
    else Planned automated handoff
        Worker->>Queue: Publish job ID
        Queue-->>Processor: Deliver job ID
    end

    rect rgb(226, 247, 237)
        Note over Processor,Processed: Python container deployment unit — processing
        Processor->>Worker: HTTPS claim(jobId)
        Worker->>D1: Atomically change queued to processing
        D1-->>Worker: Frozen manifest and canonical target
        Worker-->>Processor: Claimed job and immutable inputs

        Processor->>Raw: S3/R2 API read referenced raw JSON only
        Raw-->>Processor: Raw response objects

        alt Merge
            Processor->>Processed: Read current canonical Parquet if present
            Processed-->>Processor: Existing dataset
        else Rebuild
            Note over Processor: Build from frozen raw inputs only
        end

        Processor->>Processor: Normalize, deduplicate, produce Parquet
        Processor->>Processed: Overwrite canonical data.parquet
        Processed-->>Processor: Output ETag
        Processor->>Worker: HTTPS complete(jobId, outputEtag)
        Worker->>D1: Record revision and applied runs<br/>complete job and release symbol lock
    end
```
