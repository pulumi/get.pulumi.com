/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import type { Request as WorkerRequest, ExecutionContext, R2ObjectBody, R2Range } from "@cloudflare/workers-types/2023-07-01"

export interface Env {
  // Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
  // MY_KV_NAMESPACE: KVNamespace;
  //
  // Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
  // MY_DURABLE_OBJECT: DurableObjectNamespace;
  //
  // Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
  // MY_BUCKET: R2Bucket;
  //
  // Example binding to a Service. Learn more at https://developers.cloudflare.com/workers/runtime-apis/service-bindings/
  // MY_SERVICE: Fetcher;
  //
  // Example binding to a Queue. Learn more at https://developers.cloudflare.com/queues/javascript-apis/
  // MY_QUEUE: Queue;
  UPSTREAM_BUCKET: string;
  MY_BUCKET: R2Bucket;
}

// This is the same part size aws libraries use by default
const PART_SIZE = 8 * 1024 * 1024; // 8MB

function objectNotFound(objectName: string): Response {
  return new Response(`<html><body>R2 object "<b>${objectName}</b>" not found</body></html>`, {
    status: 404,
    headers: {
      'content-type': 'text/html; charset=UTF-8',
    },
  })
}

function rangeHasLength(
  object: R2Range
): object is { offset: number; length: number } {
  return (<{ offset: number; length: number }>object).length !== undefined
}

function writeHeaders(object: R2Object): Headers {
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('accept-ranges', 'bytes')
  const cacheControl = headers.get('cache-control')
  if (!cacheControl) {
    headers.set('cache-control', 'max-age=2592000')
  }
  return headers
}

function hasSuffix(range: R2Range): range is { suffix: number } {
  return (<{ suffix: number }>range).suffix !== undefined
}

function rewriteSpecialCharacters(path: string): string {
  // Rewrite '+' to '%2B' in the URL for S3
  return path.replace(/\+/g, '%2B')
}

function returnObjectHead(object: R2Object): Response {
  const headers = writeHeaders(object)
  return new Response(
    null,
	  { headers },
	)
}

function returnObject(object: R2ObjectBody, request: Request): Response {
  const headers = writeHeaders(object)
	if (object.range) {
    if (hasSuffix(object.range)) {
      headers.set(
        'content-range',
        `bytes ${object.size - object.range.suffix}-${object.size - 1}/${object.size}`);
    }
    else {
      headers.set(
        'content-range',
        `bytes ${object.range.offset ?? 0}-${object.range.length ?? object.size - 1}/${object.size}`
        )
    }
	}
	const status = object.body ? (request.headers.get('range') !== null ? 206 : 200) : 304
	return new Response(object.body, {
	  headers,
	  status,
	})
}

function s3Fetch(url: URL, request: Request): Promise<Response> {
  const urlString = rewriteSpecialCharacters(url.toString())
  if (request.headers.has('range')) {
    console.log(`Fetching ${request.headers.get('range')} from S3 ${urlString}`)
  } else {
    console.log(`Fetching from S3 ${urlString}`)
  }
  return fetch(urlString, request)
}

async function singlePartCopy(newUrl: URL, objectName: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const s3Response = await s3Fetch(newUrl, request)
  if (s3Response.status !== 200 || s3Response.body === null) {
    return s3Response
  }
  console.log(`Putting ${objectName} in R2`)
  const s3Body = s3Response.body.tee()
  ctx.waitUntil(env.MY_BUCKET.put(objectName, s3Body[0], {
      httpMetadata: s3Response.headers
  }))
  return new Response(s3Body[1], s3Response)
}

async function promisePool(poolLimit: number, array: (() => Promise<any>)[]): Promise<any[]> {
  const promises: Promise<any>[] = [];
  const executing: Promise<any>[] = [];

  for (const task of array) {
    const p = task(); // Start the task
    promises.push(p);

    // When a promise resolves, remove it from the "executing" list
    if (poolLimit <= array.length) {
      const e: Promise<any> = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= poolLimit) {
        await Promise.race(executing); // Wait for the fastest promise to resolve
      }
    }
  }
  return Promise.all(promises); // Wait for all promises to complete
}

async function multiPartCopy(newUrl: URL, objectName: string, s3Head: Response, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const fileSize = Number(s3Head.headers.get('content-length'))
  const partCount = Math.ceil(fileSize / PART_SIZE)
  const uploadId = await env.MY_BUCKET.createMultipartUpload(objectName, {httpMetadata: s3Head.headers})


  // Task factory functions
  const parts: (() => Promise<R2UploadedPart>)[] = []
  for (let i = 0; i < partCount; i++) {
    const partNumber = i + 1;
    const range = `bytes=${i * PART_SIZE}-${Math.min((i + 1) * PART_SIZE - 1, fileSize - 1)}`

    // Each task is a function that returns a promise
    parts.push(async () => {
      const response = await s3Fetch(newUrl, new Request(request, { headers: { range } }));
      if (response.status !== 206 || response.body === null) {
        throw new Error(`Failed to fetch part ${partNumber} for ${objectName}`);
      }
      return uploadId.uploadPart(partNumber, response.body);
    });
  }

  // Limit the number of simultaneous uploads (e.g., 5 concurrent requests)
  const CONCURRENCY_LIMIT = 5;
  // Complete the multipart upload
  ctx.waitUntil(uploadId.complete(await promisePool(CONCURRENCY_LIMIT, parts)));

  // We'll end up fetching the same part twice, but that's easier than trying to tee the correct response part.
  return s3Fetch(newUrl, request)
}

async function copyFromS3(objectName: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const newUrl = new URL(objectName, env.UPSTREAM_BUCKET);
  const s3Head = await s3Fetch(newUrl, new Request(request, { method: 'HEAD' }));
  s3Head.body?.cancel();
  const fileSize = Number(s3Head.headers.get('content-length'));
  if (fileSize === 0) {
    return s3Fetch(newUrl, request);
  } else if (fileSize < PART_SIZE) {
    return singlePartCopy(newUrl, objectName, request, env, ctx);
  } else {
    console.log(`Copying ${objectName} from S3 in ${PART_SIZE} byte parts`)
    return multiPartCopy(newUrl, objectName, s3Head, request, env, ctx);
  }
}

export default {
  async fetch(request: WorkerRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Proxy to origin on unhandled/uncaught exceptions
    // ctx.passThroughOnException();

    const allowedMethods = ["GET", "HEAD", "OPTIONS"];
    const url = new URL(request.url);
    const objectName = url.pathname.slice(1);
    console.log(`${request.method} object ${objectName}: ${request.url}`);

    // ## OPTIONS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: { allow: allowedMethods.join(", ") },
      });
    }

    // ## HEAD
    if (request.method === 'HEAD') {
      const objectHead = await env.MY_BUCKET.head(objectName);
      if (objectHead === null) {
        return s3Fetch(new URL(objectName, env.UPSTREAM_BUCKET), request);
      }
      return returnObjectHead(objectHead);
    }

    // ## GET
    if (request.method === 'GET') {
      const object = await env.MY_BUCKET.get(objectName, {
        range: request.headers,
        onlyIf: request.headers,
      });

      if (object === null) {
        console.log(`${objectName} not found in R2`);
        return copyFromS3(objectName, request, env, ctx);
  		}


      console.log(`object found in R2`);
      return returnObject(object, request);
  	}


    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: allowedMethods.join(", ") },
    });

  }
} satisfies ExportedHandler<Env>;
