import {
    createExecutionContext,
    env,
    SELF,
    waitOnExecutionContext,
  } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { getObjectName } from "../src/util";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

it("get object name", async () => {
const request = new IncomingRequest("http://get.pulumi.com/releases/plugins/pulumi-resource-gcp-v3.1.0-alpha.1586885717+gf37fdb3e-linux-amd64.tar.gz");
expect(getObjectName({request, env, execution: createExecutionContext()}))
    .toBe("releases/plugins/pulumi-resource-gcp-v3.1.0-alpha.1586885717+gf37fdb3e-linux-amd64.tar.gz");
})
