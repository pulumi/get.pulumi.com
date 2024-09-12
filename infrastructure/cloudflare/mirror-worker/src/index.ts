/**
 * Welcome to Cloudflare Workers!
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import type { Request as WorkerRequest, ExecutionContext } from "@cloudflare/workers-types/2023-07-01"
import { Env, RequestContext } from "./types";
import { s3Fetch, s3CopyRead } from "./s3";
import { getObjectName, buildResponseFromR2 } from "./util";

async function serveFromS3(ctx: RequestContext): Promise<Response> {
  const srcURL = new URL(getObjectName(ctx), ctx.env.S3_SOURCE_BUCKET)
  return s3CopyRead(ctx, srcURL)
}

function cacheResponse(ctx: RequestContext, response: Response) : Promise<void> {
  if (response.status === 200) {
    console.log(`Caching ${ctx.request.url}`)
    const modifiedResponse = response.clone()
    return caches.default.put(ctx.request, modifiedResponse);
  }
  return Promise.resolve();
}

export default {
  async fetch(request: WorkerRequest, env: Env, execution: ExecutionContext): Promise<Response> {
    // Proxy to R2 origin on unhandled/uncaught exceptions
    // which might save us sometimes
    execution.passThroughOnException();
    console.log(`${request.method} ${request.url.toString()}`)

    const allowedMethods = ["GET", "HEAD", "OPTIONS"];
    const ctx: RequestContext = { request, env, execution };
    const objectName = getObjectName(ctx);

    // ## OPTIONS
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: { allow: allowedMethods.join(", ") },
      });
    }

    // ## HEAD
    if (request.method === 'HEAD') {
      const objectHead = await env.LINKED_R2_BUCKET.head(objectName);
      return objectHead ? buildResponseFromR2(objectHead, request) : s3Fetch(new URL(objectName, env.S3_SOURCE_BUCKET), request);
    }

    // ## GET
    if (request.method === 'GET') {
      // Check first if the request is in the cache
      const cached = await caches.default.match(request)
      if (cached) {
        // Always check if the object is unmodified in R2
        const srcObject = await env.LINKED_R2_BUCKET.head(objectName)
        if (srcObject?.httpEtag == cached.headers.get('etag')) {
          console.log(`Cache hit for ${request.url}`)
          return cached
        }
        console.log(`Cache stale for ${request.url}`)
      } else {
        console.log(`Cache miss for ${request.url}`)
      }

      const object = await env.LINKED_R2_BUCKET.get(objectName, {
        range: request.headers,
        onlyIf: request.headers,
      });

      if (object) {
        console.log(`Serving ${objectName} from R2`)
      } else {
        console.log(`Serving ${objectName} from S3`)
      }

      const response = object ? buildResponseFromR2(object, request) : serveFromS3(ctx);
      execution.waitUntil(Promise.resolve(response).then((r) => cacheResponse(ctx, r)));
      return response;
  	}

    // # Everything Else
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: allowedMethods.join(", ") },
    });

  }
} satisfies ExportedHandler<Env>
