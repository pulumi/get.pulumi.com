import {
  createExecutionContext,
  env,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Worker requests", () => {
  it("responds to OPTIONS", async () => {
    const response = await SELF.fetch("https://get.pulumi.com/", { method: "OPTIONS" });
    expect(response.status).toBe(200);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("responds to HEAD", async () => {
    const response = await SELF.fetch("https://get.pulumi.com/releases/plugins/pulumi-resource-gcp-v3.1.0-alpha.1586885717+gf37fdb3e-linux-amd64.tar.gz", { method: "HEAD" });
    expect(response.status).toBe(200);
  });
});
