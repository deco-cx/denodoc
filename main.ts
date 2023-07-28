import {
  crypto,
  toHashString,
} from "https://deno.land/std@0.187.0/crypto/mod.ts";
import { join } from "https://deno.land/std@0.187.0/path/mod.ts";

import { asChannel, Channel } from "./channel.ts";
import { denoDoc } from "./denodoc.ts";

export interface BeginDenoDocRequest {
  importMap: string;
  cwd: string;
}

export interface DocFileRequest {
  path: string;
  content: string;
  hash: string;
}

export interface DocHttpRequest {
  path: string;
}

const isDenoDocFileRequest = (v: DocRequest): v is DocFileRequest => {
  return (v as DocFileRequest)?.content !== undefined;
};
export type DocRequest = DocFileRequest | DocHttpRequest;

export interface DocResponse {
  path: string;
  docNodes: string;
}

const isBeginDocRequest = (
  v: unknown | BeginDenoDocRequest,
): v is BeginDenoDocRequest => {
  return (v as BeginDenoDocRequest).cwd !== undefined;
};

const createIfNotExists = async (
  req: BeginDenoDocRequest,
  importMapDigest: string,
) => {
  const folder = join("dist", importMapDigest);
  const importMap = join(folder, "import_map.json");
  try {
    await Deno.stat(importMap);
    return importMap;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      await Deno.mkdir(folder, {
        recursive: true,
      });
      const parsed: { imports: Record<string, string> } = JSON.parse(
        req.importMap,
      );
      for (const [key, value] of Object.entries(parsed?.imports ?? {})) {
        if (value === "./") {
          parsed.imports[key] = `http://localhost:8081/`;
        }
      }

      await Deno.writeTextFile(
        importMap,
        JSON.stringify(parsed),
        { create: true },
      );
      return importMap;
    }
    throw e;
  }
};
const creating: Record<string, Promise<string>> = {};

const fileContentChallenges: Record<string, string> = {};
// content addressable storage
const CAS: Record<string, Promise<string>> = {};
const httpModules: Record<string, Promise<string>> = {};
const useChannel = async (
  c: Channel<
    DocResponse,
    DocRequest
  >,
) => {
  const firstMessage = await c.recv();

  if (!isBeginDocRequest(firstMessage)) {
    c.close();
    return;
  }
  const hash = await crypto.subtle.digest(
    "MD5",
    new TextEncoder().encode(firstMessage.importMap),
  );
  const importMapHash = toHashString(hash);
  creating[importMapHash] ??= createIfNotExists(firstMessage, importMapHash);

  const importMap = await creating[importMapHash];
  // http://localhost:8081/${deploymentId}/$file_path
  while (true) {
    const req = await Promise.race([c.closed.wait(), c.recv()]);
    if (req === true) {
      break;
    }

    if (!isDenoDocFileRequest(req)) {
      httpModules[req.path] ??= denoDoc(req.path, importMap);
      httpModules[req.path].then((docNodes) => {
        if (c.closed.is_set()) {
          console.log("CLOSE IS SET HTTP");
          return;
        }
        c.send({ path: req.path, docNodes });
      });
      continue;
    }
    fileContentChallenges[req.hash] = req.content;
    CAS[req.hash] ??= denoDoc(
      `${
        req.path.replace(
          firstMessage.cwd,
          `http://localhost:8081`,
        )
      }?hash=${req.hash}`,
      importMap,
      (str: string) =>
        str.replaceAll(
          `http://localhost:8081`,
          firstMessage.cwd,
        ),
    );

    CAS[req.hash].then((docNodes) => {
      if (c.closed.is_set()) {
        console.log("CLOSE IS SET");
        return;
      }
      c.send({ path: req.path, docNodes });
    }).catch((err) => {
      console.log(err, "denodoc err");
    });
  }
};
Deno.serve({ port: 8081 }, (req) => {
  try {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (req.headers.get("upgrade") != "websocket") {
        return new Response(null, { status: 501 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.binaryType = "arraybuffer";
      asChannel<
        DocResponse,
        DocRequest
      >(socket).then(useChannel).catch((e) => {
        console.log(e);
      }).finally(() => {
        console.log("CLOSED CALLED");
        socket.close();
      });
      return response;
    }

    console.log(url.toString());
    // http://localhost:8081/$deployment_id/$file_path
    const hash = url.searchParams.get("hash");
    if (!hash) {
      return new Response(null, { status: 400 });
    }
    return new Response(fileContentChallenges[hash], { status: 200 });
  } catch (err) {
    console.log(err);
    return new Response(null, { status: 500 });
  }
});
