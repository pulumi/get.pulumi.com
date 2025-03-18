import type { Request as WorkerRequest, ExecutionContext } from "@cloudflare/workers-types/2023-07-01"

export interface Env {
    S3_SOURCE_BUCKET: string;
    LINKED_R2_BUCKET: R2Bucket;
  }

export interface RequestContext {
    request: WorkerRequest;
    env: Env;
    execution: ExecutionContext;
  }
