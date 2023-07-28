import { deferred } from "https://deno.land/std@0.164.0/async/deferred.ts";
import { Deferred } from "https://deno.land/std@0.186.0/async/deferred.ts";
import { join } from "https://deno.land/std@0.187.0/path/mod.ts";
import { asChannel, Channel } from "./channel.ts";
import { denoDoc } from "./denodoc.ts";

export interface BeginDenoDocRequest {
  importMap: string;
  deploymentId: string;
  cwd: string;
}

export interface DocRequest {
  path: string;
}

export interface DocResponse {
  path: string;
  docNodes: string;
}

export interface FileContentRequest {
  path: string;
}

export interface FileContentResponse {
  path: string;
  content: string;
}

const isBeginDocRequest = (
  v: unknown | BeginDenoDocRequest,
): v is BeginDenoDocRequest => {
  return (v as BeginDenoDocRequest).deploymentId !== undefined;
};

const isFileContentResponse = (
  v: unknown | FileContentResponse,
): v is FileContentResponse => {
  return (v as FileContentResponse).content !== undefined;
};

const createIfNotExists = async (req: BeginDenoDocRequest) => {
  const folder = join("dist", req.deploymentId);
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
          parsed.imports[key] = `http://localhost:8081/${req.deploymentId}/`;
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
const clients: Record<
  string,
  Channel<DocResponse | FileContentRequest, DocRequest | FileContentResponse>
> = {};

const pending: Record<string, boolean> = {};
const fileContentChallenges: Record<string, Deferred<string>> = {};
const docCache: Record<string, Promise<string>> = {};
const useChannel = async (
  c: Channel<
    DocResponse | FileContentRequest,
    DocRequest | FileContentResponse
  >,
) => {
  const firstMessage = await c.recv();

  if (!isBeginDocRequest(firstMessage)) {
    c.close();
    return;
  }
  clients[firstMessage.deploymentId] = c;
  creating[firstMessage.deploymentId] ??= createIfNotExists(firstMessage)
    .finally(() => {
      delete creating[firstMessage.deploymentId];
    });

  const importMap = await creating[firstMessage.deploymentId];
  // http://localhost:8081/${deploymentId}/$file_path
  while (true) {
    const req = await Promise.race([c.closed.wait(), c.recv()]);
    if (req === true) {
      break;
    }

    if (isFileContentResponse(req)) {
      const chal =
        fileContentChallenges[`${firstMessage.deploymentId}_${req.path}`];
      if (chal) {
        chal.resolve(req.content);
      }
      continue;
    }
    const id = `${firstMessage.deploymentId}_${req.path}`;
    pending[id] = true;
    docCache[id] ??= denoDoc(
      req.path.replace(
        firstMessage.cwd,
        `http://localhost:8081/${firstMessage.deploymentId}`,
      ),
      importMap,
      (str: string) =>
        str.replaceAll(
          `http://localhost:8081/${firstMessage.deploymentId}`,
          firstMessage.cwd,
        ),
    );

    docCache[id].then((docNodes) => {
      if (c.closed.is_set()) {
        console.log("CLOSE IS SET");
        return;
      }
      c.send({ path: req.path, docNodes });
    }).catch((err) => {
      console.log(err, "denodoc err");
    }).finally(() => {
      delete pending[id];
      console.log(Object.keys(pending));
    });
  }
};
Deno.serve({ port: 8081 }, async (req) => {
  try {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (req.headers.get("upgrade") != "websocket") {
        return new Response(null, { status: 501 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      asChannel<
        DocResponse | FileContentRequest,
        DocRequest
      >(socket).then(useChannel).catch((e) => {
        console.log(e);
      }).finally(() => {
        console.log("CLOSED CALLED");
        socket.close();
      });
      return response;
    }
    // http://localhost:8081/$deployment_id/$file_path
    const [_, deploymentId, ...filePathRest] = url.pathname.split("/");
    const channel = clients[deploymentId];
    if (!channel) {
      return new Response(null, { status: 400 });
    }
    const filePath = filePathRest.join("/");
    const id = `${deploymentId}_${filePath}`;
    const alreadyChall = fileContentChallenges[id];
    if (alreadyChall) {
      return new Response(await alreadyChall, { status: 200 });
    }
    const response = deferred<string>();
    fileContentChallenges[id] = response;
    if (channel.closed.is_set()) {
      console.log("BAD REQUEST");
      return new Response(null, { status: 400 });
    }
    channel.send({ path: filePath });
    const content = await response;
    return new Response(content, { status: 200 });
  } catch (err) {
    console.log(err);
    return new Response(null, { status: 500 });
  }
});
