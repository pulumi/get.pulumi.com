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
import { Env, RequestContext } from "./types";
import { s3Fetch } from "./s3";
import { getObject } from "@pulumi/aws/s3/getObject";
import { getObjectName } from "./util";

// This is the part size that aws libraries use by default for multipart uploads
const CHUNK_ALIGNMENT = 8 * 1024 * 1024; // 8MB
// Workers are only allowed 6 active connections
const PART_COUNT = 5;

function writeHeaders(object: R2Object): Headers {
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('accept-ranges', 'bytes')
  headers.set('content-length', object.size.toString())
  headers.set('last-modified', object.uploaded.toUTCString())
  return headers
}

function logDebugHeaders(headers: Headers): void {
  for (const pair of headers.entries()) {
    console.debug(`  ${pair[0]}: ${pair[1]}`);
  }
}

// function headResponse(object: R2Object): Response {
//   const headers = writeHeaders(object)
//   return new Response(
//     null,
// 	  { headers },
// 	)
// }

function buildObjectResponse(object: R2Object | R2ObjectBody, request: Request): Response {
  const headers = writeHeaders(object)
  if (!('body' in object)) {
    return new Response(null, { headers })
  }
  if (object.range) {
    const range = ('suffix' in object.range) ?
        `bytes ${object.size - object.range.suffix}-${object.size - 1}/${object.size}` :
        `bytes ${object.range.offset ?? 0}-${object.range.length ?? object.size - 1}/${object.size}`
    headers.set('content-range', range)
	}
	const status = object.body ? (request.headers.get('range') !== null ? 206 : 200) : 304
	return new Response(object.body, {
	  headers,
	  status,
	})
}

async function s3Copy(ctx: RequestContext, newUrl: URL, objectName: string): Promise<Response> {
  const s3Response = await s3Fetch(newUrl, ctx.request)
  if (s3Response.status !== 200 || s3Response.body === null) {
    return s3Response
  }
  console.log(`Putting ${objectName} in R2`)
  const s3Body = s3Response.body.tee()
  ctx.execution.waitUntil(ctx.env.LINKED_R2_BUCKET.put(
    objectName, s3Body[0], {httpMetadata: s3Response.headers}
  ))
  return new Response(s3Body[1], s3Response)
}

function calculatePartSize(fileSize: number, partCount: number, chunkAlignment: number): number {
  if (fileSize % chunkAlignment === 0) {
    return fileSize / partCount;
  } else {
    return Math.floor(fileSize / (partCount - 1) / chunkAlignment ) * chunkAlignment;
  }
}

interface FilePart {
  objectName: string;
  partNumber: number;
  range: string;
  srcUrl: URL;
  uploadId: R2MultipartUpload;
}


async function copyPart(ctx: RequestContext, part: FilePart): Promise<R2UploadedPart> {
  const response = await s3Fetch(part.srcUrl, new Request(ctx.request, { headers: part.range }));
  if (response.status !== 206 || response.body === null) {
    throw new Error(`Failed to fetch part ${part.partNumber} for ${part.objectName}`);
  }
  return part.uploadId.uploadPart(part.partNumber, response.body);
}

async function s3MultiPartCopy(ctx: RequestContext, srcUrl: URL, objectName: string, s3Head: Response): Promise<Response> {
  const fileSize = Number(s3Head.headers.get('content-length'))
  const partSize = calculatePartSize(fileSize, PART_COUNT, CHUNK_ALIGNMENT)
  const partCount = Math.ceil(fileSize / partSize)
  const uploadId = await ctx.env.LINKED_R2_BUCKET.createMultipartUpload(objectName, {httpMetadata: s3Head.headers})

  try {
    const parts = []
    for (let i = 0; i < partCount; i++) {
      const partNumber = i + 1;
      const range = `bytes=${i * partSize}-${Math.min((i + 1) * partSize - 1, fileSize - 1)}`
      parts.push(copyPart(ctx, {uploadId, partNumber, range, objectName, srcUrl}))
    }

    ctx.execution.waitUntil(Promise.all(parts).then(
      (parts) => {uploadId.complete(parts); console.log("Finished downloading")},
      () => uploadId.abort()
    ))
  } catch (e) {
    uploadId.abort()
    throw e
  }
  return s3Fetch(srcUrl, ctx.request)
}

async function serveFromS3(ctx: RequestContext): Promise<Response> {
  const objectName = getObjectName(ctx);
  const srcURL = new URL(objectName, ctx.env.S3_SOURCE_BUCKET);
  const s3Head = await s3Fetch(srcURL, new Request(ctx.request, { method: 'HEAD' }));
  s3Head.body?.cancel();
  const fileSize = Number(s3Head.headers.get('content-length'));
  if (fileSize === 0) {
    return s3Fetch(srcURL, ctx.request);
  } else if (fileSize < CHUNK_ALIGNMENT) {
    return s3Copy(ctx, srcURL, objectName);
  } else {
    console.log(`Copying ${objectName} from S3 in ${CHUNK_ALIGNMENT} byte parts`)
    return s3MultiPartCopy(ctx, srcURL, objectName, s3Head);
  }
}

function cacheResponse(ctx: RequestContext, response: Response): Response {
  if (response.status === 200) {
    console.log(`Caching ${ctx.request.url}`)
    const cachedResponse = response.clone();
    // This will still cache it in the proxy cache, but it will be revalidated on every serve
    cachedResponse.headers.set('cache-control', 'public, no-cache, must-revalidate, no-transform');
    caches.default.put(ctx.request.url, cachedResponse);
  }
  return response;
}

export default {
  async fetch(request: WorkerRequest, env: Env, execution: ExecutionContext): Promise<Response> {
    // Proxy to R2 origin on unhandled/uncaught exceptions
    // which might save us sometimes
    execution.passThroughOnException();
    // Close out any lingering connection on the request body
    request.body?.cancel();
    console.log(`${request.method}: ${request.url.toString()}`)
    logDebugHeaders(request.headers)

    // Check first if the request is in the cache
    const cached = await caches.default.match(request)
    if (cached) {
      console.log(`Cache hit for ${request.url}`)
      return cached
    }

    const allowedMethods = ["GET", "HEAD", "OPTIONS"];
    const ctx: RequestContext = { request, env, execution };
    const objectName = getObjectName(ctx);
    console.log(`${request.method} object ${objectName}: ${request.url}`);

    // ## OPTIONS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: { allow: allowedMethods.join(", ") },
      });
    }

    // ## HEAD
    if (request.method === 'HEAD') {
      const objectHead = await env.LINKED_R2_BUCKET.head(objectName);
      return objectHead ? buildObjectResponse(objectHead, request) : s3Fetch(new URL(objectName, env.S3_SOURCE_BUCKET), request);
    }

    // ## GET
    if (request.method === 'GET') {
      const object = await env.LINKED_R2_BUCKET.get(objectName, {
        range: request.headers,
        onlyIf: request.headers,
      });

      const response = object ? buildObjectResponse(object, request) : serveFromS3(ctx);
      // if (object === null) {
      //   console.log(`${objectName} not found in R2`);
      //   return copyFromS3(objectName, request, env, ctx);
  		// }

      // console.log(`${objectName} found in R2`);
      // const response = objectResponse(object, request);
      execution.waitUntil(Promise.resolve(response).then((r) => cacheResponse(ctx, r)))
      return response;
  	}

    // # Everything Else
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: allowedMethods.join(", ") },
    });

  }
} satisfies ExportedHandler<Env>;
